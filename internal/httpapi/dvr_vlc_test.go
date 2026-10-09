package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestVLCActiveRecordingAssetsAndRevocation(t *testing.T) {
	for _, position := range []string{"", "beginning", "latest"} {
		for _, revoke := range []string{"logout", "disconnect", "permission", "lineup", "recording"} {
			t.Run(position+"/"+revoke, func(t *testing.T) {
				var denied, hidden, completed, cleaned atomic.Bool
				var segmentCalls atomic.Int32
				now := time.Now().UTC()
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("X-API-Key") != "fixture-key" || r.URL.RawQuery != "" || r.Header.Get("Cookie") != "" {
						t.Error("incorrect upstream authentication")
					}
					if r.Method != "GET" {
						t.Error("playback mutated upstream")
					}
					switch r.URL.Path {
					case "/api/accounts/users/me/":
						access := "view"
						if denied.Load() {
							access = "none"
						}
						json.NewEncoder(w).Encode(map[string]any{"username": "viewer", "user_level": 1, "custom_properties": map[string]string{"dvr_access": access}})
					case "/api/channels/recordings/":
						if hidden.Load() {
							io.WriteString(w, "[]")
							return
						}
						status := "recording"
						file := "/api/channels/recordings/7/hls/index.m3u8"
						if completed.Load() {
							status = "completed"
							file = "/api/channels/recordings/7/file/"
						}
						json.NewEncoder(w).Encode([]any{map[string]any{"id": 7, "channel": 41, "start_time": now.Add(-time.Hour), "end_time": now.Add(time.Hour), "custom_properties": map[string]any{"status": status, "remux_success": completed.Load(), "file_url": file, "program": map[string]string{"title": "Game"}}}})
					case "/api/channels/recordings/7/hls/index.m3u8":
						if cleaned.Load() {
							http.Redirect(w, r, "/api/channels/recordings/7/file/", 302)
							return
						}
						io.WriteString(w, "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_00001.ts\n#EXTINF:4,\nseg_00002.ts\n#EXTINF:4,\nseg_00003.ts\n#EXTINF:4,\nseg_00004.ts\n#EXTINF:4,\nseg_00005.ts\n#EXTINF:4,\nseg_00006.ts\n")
						if completed.Load() {
							io.WriteString(w, "#EXT-X-ENDLIST\n")
						}
					case "/api/channels/recordings/7/hls/seg_00001.ts":
						segmentCalls.Add(1)
						w.Header().Set("Content-Type", "video/mp2t")
						io.WriteString(w, "recorded-video")
					default:
						t.Error("unexpected upstream path")
						w.WriteHeader(404)
					}
				}))
				defer upstream.Close()
				u, _ := url.Parse(upstream.URL)
				client := dispatcharr.NewClient(u, upstream.Client(), 1<<20, 1024)
				fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Fixture"}}}
				fixture := &activeDVRFixture{restDVRFixture: &restDVRFixture{fakeDispatcharr: fake, DVRAPI: client}, DVRHLSAPI: client, DVRMasterAPI: client}
				cfg := testConfig(t)
				handler := New(cfg, fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
				cookie, viewer := loginViewer(t, handler)
				call := func(method, path, body string, authenticated, csrf bool) *httptest.ResponseRecorder {
					request := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
					if authenticated {
						request.AddCookie(cookie)
					}
					if csrf {
						request.Header.Set("Origin", "http://now.test")
						request.Header.Set("X-CSRF-Token", viewer.CSRFToken)
					}
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, request)
					for _, secret := range []string{"fixture-key", upstream.URL, "X-API-Key"} {
						if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Header().Get("Location"), secret) {
							t.Fatal("private data leaked")
						}
					}
					return w
				}
				check := func(w *httptest.ResponseRecorder, code int) {
					t.Helper()
					if w.Code != code {
						t.Fatalf("got %d want %d: %s", w.Code, code, w.Body.String())
					}
				}
				check(call("POST", "/api/dvr/connection", `{"api_key":"fixture-key"}`, true, true), 200)
				check(call("POST", "/api/dvr/recordings/7/vlc", "", false, false), 401)
				check(call("POST", "/api/dvr/recordings/7/vlc", "", true, false), 403)
				for _, invalid := range []string{`{"position":"remote"}`, `{"position":0}`, `{"position":"latest","url":"https://example.com"}`} {
					check(call("POST", "/api/dvr/recordings/7/vlc", invalid, true, true), 400)
				}
				created := call("POST", "/api/dvr/recordings/7/vlc", `{"position":"`+position+`"}`, true, true)
				check(created, 201)
				var descriptor struct {
					Launch string `json:"launch_url"`
				}
				json.Unmarshal(created.Body.Bytes(), &descriptor)
				launch := call("GET", descriptor.Launch, "", false, false)
				check(launch, 302)
				manifestURL := launch.Header().Get("Location")
				if position == "beginning" {
					for range 2 {
						probe := call("GET", manifestURL, "", false, false)
						check(probe, 200)
						if strings.Contains(probe.Body.String(), "seg_00004.ts") || !strings.Contains(probe.Body.String(), "seg_00001.ts") || !strings.Contains(probe.Body.String(), "#EXT-X-START:TIME-OFFSET=0") {
							t.Fatal("beginning bootstrap incorrect")
						}
					}
				}
				if position == "latest" {
					probe := call("GET", manifestURL, "", false, false)
					if !strings.Contains(probe.Body.String(), "#EXT-X-START:TIME-OFFSET=-12") || !strings.Contains(probe.Body.String(), "seg_00006.ts") {
						t.Fatal("live offset missing")
					}
				}
				manifest := call("GET", manifestURL, "", false, false)
				check(manifest, 200)
				var segmentURL string
				for _, line := range strings.Split(manifest.Body.String(), "\n") {
					if strings.HasPrefix(line, "/api/vlc/media/") && strings.HasSuffix(line, "seg_00001.ts") {
						segmentURL = line
					}
				}
				if segmentURL == "" || !strings.Contains(manifest.Body.String(), "#EXT-X-PLAYLIST-TYPE:EVENT") {
					t.Fatal("manifest not rewritten")
				}
				for _, probeURL := range []string{manifestURL, segmentURL} {
					request := httptest.NewRequest("GET", "http://now.test"+probeURL, nil)
					request.Header.Set("Range", "bytes=0-")
					probe := httptest.NewRecorder()
					handler.ServeHTTP(probe, request)
					check(probe, 200)
					request.Header.Set("Range", "bytes=1-3")
					rejected := httptest.NewRecorder()
					handler.ServeHTTP(rejected, request)
					check(rejected, 416)
				}
				segment := call("GET", segmentURL, "", false, false)
				check(segment, 200)
				full := call("GET", manifestURL, "", false, false)
				check(full, 200)
				if !strings.Contains(full.Body.String(), "seg_00006.ts") {
					t.Fatal("full timeline not exposed after media fetch")
				}
				if segment.Body.String() != "recorded-video" {
					t.Fatal("incorrect segment")
				}
				check(call("GET", strings.Replace(segmentURL, "seg_00001.ts", "file", 1), "", false, false), 404)
				check(call("GET", strings.Replace(segmentURL, "seg_00001.ts", "other.m3u8", 1), "", false, false), 404)
				// Completion must not change the token binding or redirect an HLS
				// demuxer to MKV while retained segments can still be played.
				completed.Store(true)
				ended := call("GET", manifestURL, "", false, false)
				check(ended, 200)
				if !strings.Contains(ended.Body.String(), "#EXT-X-ENDLIST") {
					t.Fatal("end tag lost")
				}
				check(call("GET", segmentURL, "", false, false), 200)
				cleaned.Store(true)
				check(call("GET", manifestURL, "", false, false), 503)
				cleaned.Store(false)
				switch revoke {
				case "logout":
					check(call("POST", "/api/auth/logout", "", true, true), 204)
				case "disconnect":
					check(call("DELETE", "/api/dvr/connection", "", true, true), 204)
				case "permission":
					denied.Store(true)
				case "lineup":
					fake.channels = nil
				case "recording":
					hidden.Store(true)
				}
				before := segmentCalls.Load()
				check(call("GET", segmentURL, "", false, false), 404)
				check(call("GET", manifestURL, "", false, false), 404)
				if segmentCalls.Load() != before {
					t.Fatal("unauthorized segment fetched")
				}
			})
		}
	}

}

func TestVLCBeginningPlaylistRetainsSequenceAndCompletion(t *testing.T) {
	p := dispatcharr.RecordingPlaylist{TargetDuration: 4, Ended: true, Segments: []string{"seg_00100.ts", "seg_00101.ts", "seg_00102.ts", "seg_00103.ts"}, Playlist: "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-DISCONTINUITY-SEQUENCE:9\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_00100.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nseg_00101.ts\n#EXTINF:4,\nseg_00102.ts\n#EXTINF:4,\nseg_00103.ts\n#EXT-X-ENDLIST\n"}
	bootstrap := vlcRecordingPlaylist(p, "beginning", false)
	for _, want := range []string{"#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-MEDIA-SEQUENCE:100", "#EXT-X-DISCONTINUITY-SEQUENCE:9", "#EXT-X-DISCONTINUITY\n", "seg_00100.ts", "seg_00102.ts"} {
		if !strings.Contains(bootstrap, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(bootstrap, "ENDLIST") || strings.Contains(bootstrap, "seg_00103.ts") {
		t.Fatal("bootstrap closed early or includes later media")
	}
	full := vlcRecordingPlaylist(p, "beginning", true)
	if !strings.Contains(full, "seg_00103.ts") || !strings.Contains(full, "#EXT-X-ENDLIST") {
		t.Fatal("completion not retained")
	}
}
