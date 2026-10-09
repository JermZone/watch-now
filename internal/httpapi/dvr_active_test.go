package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

type activeDVRFixture struct {
	*restDVRFixture
	dispatcharr.DVRHLSAPI
	dispatcharr.DVRMasterAPI
}

func TestActiveRecordingLeasePermissionsAndCompletion(t *testing.T) {
	var allowed atomic.Bool
	allowed.Store(true)
	var ready atomic.Bool
	var segmentCalls atomic.Int32
	now := time.Now().UTC()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "fixture-key" || r.URL.RawQuery != "" {
			t.Error("missing key or leaked query")
		}
		switch r.URL.Path {
		case "/api/accounts/users/me/":
			io.WriteString(w, `{"username":"viewer","user_level":1,"custom_properties":{"dvr_access":"view"}}`)
		case "/api/channels/recordings/":
			fileURL := "/api/channels/recordings/7/hls/index.m3u8"
			if ready.Load() {
				fileURL = "/api/channels/recordings/7/file/"
			}
			records := []any{map[string]any{"id": 7, "channel": 41, "start_time": now.Add(-time.Hour), "end_time": now.Add(time.Hour), "custom_properties": map[string]any{"status": "recording", "file_url": fileURL, "program": map[string]string{"title": "Fixture game"}}}}
			if !allowed.Load() {
				records = []any{}
			}
			json.NewEncoder(w).Encode(records)
		case "/api/channels/recordings/7/hls/index.m3u8":
			if ready.Load() {
				w.Header().Set("Location", "/api/channels/recordings/7/file/")
				w.WriteHeader(302)
				return
			}
			io.WriteString(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\nseg_00001.ts\n")
		case "/api/channels/recordings/7/hls/seg_00001.ts":
			segmentCalls.Add(1)
			w.Header().Set("Content-Type", "video/mp2t")
			io.WriteString(w, "transport-stream")
		case "/api/channels/recordings/7/file/":
			if !ready.Load() {
				t.Error("file opened while remux unfinished")
			}
			w.Header().Set("Content-Type", "video/x-matroska")
			w.Header().Set("Accept-Ranges", "bytes")
			if r.Header.Get("Range") == "bytes=1-3" {
				w.Header().Set("Content-Range", "bytes 1-3/6")
				w.Header().Set("Content-Length", "3")
				w.WriteHeader(206)
				io.WriteString(w, "bcd")
				return
			}
			io.WriteString(w, "abcdef")
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(u, upstream.Client(), 1<<20, 1024)
	fixture := &activeDVRFixture{restDVRFixture: &restDVRFixture{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Fixture"}}}, DVRAPI: client}, DVRHLSAPI: client, DVRMasterAPI: client}
	handler := New(testConfig(t), fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(method, path, body string, csrf bool, who *http.Cookie, byteRange string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
		req.AddCookie(who)
		req.Header.Set("Origin", "http://now.test")
		if csrf {
			req.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		}
		if byteRange != "" {
			req.Header.Set("Range", byteRange)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	check := func(w *httptest.ResponseRecorder, want int) {
		t.Helper()
		if w.Code != want {
			t.Fatalf("got %d want %d: %s", w.Code, want, w.Body.String())
		}
		for _, secret := range []string{"fixture-key", upstream.URL, "file_url", "X-API-Key"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("private upstream information leaked")
			}
		}
	}
	check(call("POST", "/api/dvr/connection", `{"api_key":"fixture-key"}`, true, cookie, ""), 200)
	check(call("POST", "/api/dvr/recordings/7/active-playback", "", false, cookie, ""), 403)
	start := call("POST", "/api/dvr/recordings/7/active-playback", "", true, cookie, "")
	check(start, 201)
	var descriptor struct {
		Manifest string `json:"manifest_url"`
		Status   string `json:"status_url"`
		Stop     string `json:"stop_url"`
	}
	json.Unmarshal(start.Body.Bytes(), &descriptor)
	check(call("GET", descriptor.Manifest, "", false, cookie, ""), 200)
	playlist := call("GET", descriptor.Manifest, "", false, cookie, "")
	if !strings.Contains(playlist.Body.String(), "#EXT-X-PLAYLIST-TYPE:EVENT") {
		t.Fatal("event tag lost")
	}
	base := strings.TrimSuffix(descriptor.Manifest, "index.m3u8")
	if !strings.Contains(playlist.Body.String(), base+"seg_00001.ts") {
		t.Fatal("playlist was not rewritten")
	}
	check(call("GET", base+"file", "", false, cookie, ""), 409)
	check(call("GET", "/api/dvr/recordings/7/download", "", false, cookie, ""), 409)
	// A single fresh segment is not enough to launch the external player.
	check(call("POST", "/api/dvr/recordings/7/vlc", "", true, cookie, ""), 409)

	// Multiple GETs attach to one playback generation and do not cancel siblings.
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := call("GET", base+"seg_00001.ts", "", false, cookie, "")
			if w.Code != 200 || w.Body.String() != "transport-stream" {
				t.Errorf("segment failed %d", w.Code)
			}
		}()
	}
	wg.Wait()
	if segmentCalls.Load() != 2 {
		t.Fatal("segments not relayed")
	}
	other, _ := loginViewerAs(t, handler, "viewer", "password", "192.0.2.8:1234")
	check(call("GET", descriptor.Manifest, "", false, other, ""), 410)

	ready.Store(true)
	check(call("GET", descriptor.Manifest, "", false, cookie, ""), 409)
	status := call("GET", descriptor.Status, "", false, cookie, "")
	check(status, 200)
	if !strings.Contains(status.Body.String(), `"mode":"file"`) || !strings.Contains(status.Body.String(), base+"file") {
		t.Fatal("finalized descriptor wrong")
	}
	completed := call("GET", base+"file", "", false, cookie, "bytes=1-3")
	check(completed, 206)
	if completed.Body.String() != "bcd" {
		t.Fatal("range relay failed")
	}

	next := call("POST", "/api/dvr/recordings/7/active-playback", "", true, cookie, "")
	check(next, 201)
	check(call("POST", descriptor.Stop, "", true, cookie, ""), 410)
	json.Unmarshal(next.Body.Bytes(), &descriptor)
	check(call("GET", descriptor.Status, "", false, cookie, ""), 200)
	allowed.Store(false)
	check(call("GET", descriptor.Status, "", false, cookie, ""), 404)
	check(call("GET", descriptor.Manifest, "", false, cookie, ""), 410)
}

func TestRecordingRequestsShareContextAndOldStopCannotCancelNew(t *testing.T) {
	registry := newPlaybackRegistry()
	viewer := session.Session{ID: "viewer", CreatedAt: time.Now(), LastSeenAt: time.Now()}
	first, old := registry.startRecording(viewer, time.Hour, "7")
	ctx, ok := registry.recording(viewer.ID, "7", old)
	if !ok || ctx != first {
		t.Fatal("request detached from recording lease")
	}
	if _, ok := registry.recording(viewer.ID, "8", old); ok {
		t.Fatal("lease allowed another recording")
	}
	if _, ok := registry.recording("other", "7", old); ok {
		t.Fatal("lease crossed viewer boundary")
	}
	second, newer := registry.startRecording(viewer, time.Hour, "7")
	if first.Err() == nil {
		t.Fatal("old recording not canceled")
	}
	if registry.finish(viewer.ID, old) || second.Err() != nil {
		t.Fatal("old stop canceled newer recording")
	}
	registry.stop(viewer.ID)
	if second.Err() == nil {
		t.Fatal("logout did not cancel generation")
	}
	if _, ok := registry.recording(viewer.ID, "7", newer); ok {
		t.Fatal("canceled lease still usable")
	}
}

func TestRecordingPlaybackCapStartsAtPlaybackAndRespectsSessionExpiry(t *testing.T) {
	registry := newPlaybackRegistry()
	now := time.Now()
	viewer := session.Session{ID: "old-valid-viewer", CreatedAt: now.Add(-7 * time.Hour)}
	ctx, generation := registry.startRecording(viewer, 12*time.Hour, "7")
	defer registry.finish(viewer.ID, generation)
	if ctx.Err() != nil {
		t.Fatal("valid session older than six hours denied playback")
	}
	deadline, _ := ctx.Deadline()
	if deadline.Before(now.Add(4*time.Hour+59*time.Minute)) || deadline.After(now.Add(5*time.Hour+time.Minute)) {
		t.Fatal("session absolute expiry ignored")
	}
	fresh := session.Session{ID: "fresh-viewer", CreatedAt: now}
	ctx, newer := registry.startRecording(fresh, 12*time.Hour, "7")
	defer registry.finish(fresh.ID, newer)
	deadline, _ = ctx.Deadline()
	if deadline.Before(now.Add(5*time.Hour+59*time.Minute)) || deadline.After(now.Add(6*time.Hour+time.Minute)) {
		t.Fatal("six-hour playback limit not applied")
	}
}

type pendingActiveDVRFixture struct {
	*fakeDVR
	dispatcharr.DVRHLSAPI
	ready bool
}

func (f *pendingActiveDVRFixture) DVRRecordings(context.Context, string) ([]dispatcharr.Recording, error) {
	return []dispatcharr.Recording{{ID: "7", ChannelID: "1", Status: "recording", CanWatchActive: true, ReadyFile: f.ready}}, nil
}
func (f *pendingActiveDVRFixture) DVROpen(context.Context, string, string, string) (dispatcharr.MediaStream, error) {
	return dispatcharr.MediaStream{Body: io.NopCloser(strings.NewReader("bcdEXTRA")), StatusCode: 206, ContentLength: -1, ContentRange: "bytes 1-3/6", ContentType: "video/x-matroska", AcceptRanges: "bytes"}, nil
}

func TestActiveRecordingLogoutAndDisconnectCancelPendingBody(t *testing.T) {
	for _, action := range []string{"logout", "disconnect"} {
		t.Run(action, func(t *testing.T) {
			opened := make(chan struct{})
			canceled := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "video/mp2t")
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				close(opened)
				<-r.Context().Done()
				close(canceled)
			}))
			defer upstream.Close()
			u, _ := url.Parse(upstream.URL)
			client := dispatcharr.NewClient(u, upstream.Client(), 1<<20, 1024)
			fixture := &pendingActiveDVRFixture{fakeDVR: &fakeDVR{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "1", Name: "Fixture"}}}}, DVRHLSAPI: client}
			handler := New(testConfig(t), fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
			cookie, viewer := loginViewer(t, handler)
			call := func(method, path, body string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
				r.AddCookie(cookie)
				r.Header.Set("Origin", "http://now.test")
				r.Header.Set("X-CSRF-Token", viewer.CSRFToken)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}
			if w := call("POST", "/api/dvr/connection", `{"api_key":"test-key"}`); w.Code != 200 {
				t.Fatal("could not connect fixture")
			}
			started := call("POST", "/api/dvr/recordings/7/active-playback", "")
			var descriptor struct {
				Manifest string `json:"manifest_url"`
			}
			json.Unmarshal(started.Body.Bytes(), &descriptor)
			if started.Code != 201 {
				t.Fatalf("start failed %d", started.Code)
			}
			finished := make(chan struct{})
			go func() {
				call("GET", strings.TrimSuffix(descriptor.Manifest, "index.m3u8")+"seg_00001.ts", "")
				close(finished)
			}()
			select {
			case <-opened:
			case <-time.After(time.Second):
				t.Fatal("upstream body not opened")
			}
			if action == "logout" {
				call("POST", "/api/auth/logout", "")
			} else {
				call("DELETE", "/api/dvr/connection", "")
			}
			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Fatal("upstream pending body not canceled")
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("relay did not end")
			}
		})
	}
}

func TestActiveRecordingChunkedRangeCannotRelayExtraBytes(t *testing.T) {
	u, _ := url.Parse("http://unused.test")
	fixture := &pendingActiveDVRFixture{fakeDVR: &fakeDVR{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "1", Name: "Fixture"}}}}, DVRHLSAPI: dispatcharr.NewClient(u, http.DefaultClient, 1<<20, 1024), ready: true}
	handler := New(testConfig(t), fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(method, path, body, byteRange string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
		r.AddCookie(cookie)
		r.Header.Set("Origin", "http://now.test")
		r.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		if byteRange != "" {
			r.Header.Set("Range", byteRange)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	call("POST", "/api/dvr/connection", `{"api_key":"test-key"}`, "")
	started := call("POST", "/api/dvr/recordings/7/active-playback", "", "")
	var descriptor struct {
		Manifest string `json:"manifest_url"`
		Stop     string `json:"stop_url"`
	}
	json.Unmarshal(started.Body.Bytes(), &descriptor)
	w := call("GET", strings.TrimSuffix(descriptor.Manifest, "index.m3u8")+"file", "", "bytes=1-3")
	if w.Code != 206 || w.Body.String() != "bcd" || w.Header().Get("Content-Length") != "3" {
		t.Fatal("chunked range escaped declared bounds")
	}
	call("POST", descriptor.Stop, "", "")
}

func TestCanceledRecordingGETDoesNotEndSiblingLease(t *testing.T) {
	store := session.NewStore(time.Hour, 12*time.Hour, 10)
	viewer, err := store.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	registry := newPlaybackRegistry()
	_, gen := registry.startRecording(viewer, 12*time.Hour, "7")
	defer registry.finish(viewer.ID, gen)
	server := &Server{sessions: store, playbacks: registry}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("GET", "http://now.test/status", nil)
	w := httptest.NewRecorder()
	if server.activeRecordingStillOwned(w, r, viewer, "7", gen, ctx) {
		t.Fatal("canceled request considered live")
	}
	if _, owned := registry.recording(viewer.ID, "7", gen); !owned {
		t.Fatal("individual GET canceled sibling playback")
	}
	w = httptest.NewRecorder()
	if !server.activeRecordingStillOwned(w, r, viewer, "7", gen, context.Background()) {
		t.Fatal("later sibling request cannot proceed")
	}
}

// Readiness uses stock HLS HTTP responses while the fixture's recording row
// already says recording. It never needs to fetch or decode segment bytes.
type readinessDVRFixture struct {
	*fakeDVR
	dispatcharr.DVRHLSAPI
	ready atomic.Bool
}

func (f *readinessDVRFixture) DVRRecordings(context.Context, string) ([]dispatcharr.Recording, error) {
	return []dispatcharr.Recording{{ID: "7", ChannelID: "1", Status: "recording", CanWatchActive: true, ReadyFile: f.ready.Load()}}, nil
}

type readinessDescriptor struct {
	Generation string `json:"generation"`
	Manifest   string `json:"manifest_url"`
	Status     string `json:"status_url"`
	Stop       string `json:"stop_url"`
}

func newReadinessTrial(t *testing.T, manifest http.HandlerFunc) (*readinessDVRFixture, func(string, string) *httptest.ResponseRecorder, readinessDescriptor) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channels/recordings/7/hls/index.m3u8" || r.URL.RawQuery != "" || r.Header.Get("X-API-Key") != "fixture-key" {
			t.Error("readiness requested an unexpected endpoint or omitted its credential")
			w.WriteHeader(500)
			return
		}
		manifest(w, r)
	}))
	t.Cleanup(upstream.Close)
	u, _ := url.Parse(upstream.URL)
	fixture := &readinessDVRFixture{
		fakeDVR:   &fakeDVR{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "1", Name: "Fixture"}}}},
		DVRHLSAPI: dispatcharr.NewClient(u, upstream.Client(), 1<<20, 1024),
	}
	cfg := testConfig(t)
	cfg.DVRAPIKeys = map[string]string{"viewer": "fixture-key"}
	handler := New(cfg, fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://now.test"+path, nil)
		r.AddCookie(cookie)
		r.Header.Set("Origin", "http://now.test")
		r.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		for _, secret := range []string{"fixture-key", upstream.URL, "secret upstream body", "file_url", "X-API-Key"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Error("readiness response leaked upstream information")
			}
		}
		return w
	}
	start := call("POST", "/api/dvr/recordings/7/active-playback")
	var descriptor readinessDescriptor
	if start.Code != 201 || json.Unmarshal(start.Body.Bytes(), &descriptor) != nil || descriptor.Generation == "" || descriptor.Status == "" {
		t.Fatal("readiness trial could not start playback")
	}
	t.Cleanup(func() { call("POST", descriptor.Stop) })
	return fixture, call, descriptor
}

func readinessPlaylist(segments int, ended bool) string {
	body := "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n"
	for i := 0; i < segments; i++ {
		body += fmt.Sprintf("#EXTINF:4,\nseg_%05d.ts\n", i)
	}
	if ended {
		body += "#EXT-X-ENDLIST\n"
	}
	return body
}

func TestActiveRecordingStatusWaitsForPublishedLiveBuffer(t *testing.T) {
	var phase atomic.Int32
	var manifestCalls atomic.Int32
	fixture, call, descriptor := newReadinessTrial(t, func(w http.ResponseWriter, r *http.Request) {
		manifestCalls.Add(1)
		switch phase.Load() {
		case -1:
			w.WriteHeader(404)
			io.WriteString(w, "secret upstream body")
		case 4:
			io.WriteString(w, readinessPlaylist(1, true))
		case 5:
			w.Header().Set("Location", "/api/channels/recordings/7/file/")
			w.WriteHeader(302)
		case 6:
			io.WriteString(w, readinessPlaylist(0, true))
		default:
			io.WriteString(w, readinessPlaylist(int(phase.Load()), false))
		}
	})
	for _, tc := range []struct {
		phase     int32
		mode      string
		recording bool
		holdback  bool
	}{
		{-1, "waiting", true, false},
		{0, "waiting", true, true},
		{1, "waiting", true, true},
		{2, "waiting", true, true},
		{3, "hls", true, true},
		{4, "hls", false, true},
		{5, "waiting", false, false},
		{6, "waiting", false, true},
	} {
		phase.Store(tc.phase)
		w := call("GET", descriptor.Status)
		var value map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &value) != nil {
			t.Fatalf("phase %d returned %d instead of readiness", tc.phase, w.Code)
		}
		if value["mode"] != tc.mode || value["recording"] != tc.recording {
			t.Fatalf("phase %d returned incorrect readiness: %#v", tc.phase, value)
		}
		wantFields := 2
		if tc.holdback {
			wantFields++
			if value["live_delay_seconds"] != float64(12) {
				t.Fatal("readiness omitted target-duration holdback")
			}
		}
		if len(value) != wantFields {
			t.Fatal("readiness exposed unexpected metadata")
		}
	}
	before := manifestCalls.Load()
	fixture.ready.Store(true)
	w := call("GET", descriptor.Status)
	var completed struct {
		Mode      string `json:"mode"`
		Stream    string `json:"stream_url"`
		Recording bool   `json:"recording"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &completed) != nil || completed.Mode != "file" ||
		completed.Stream != strings.TrimSuffix(descriptor.Manifest, "index.m3u8")+"file" || completed.Recording {
		t.Fatal("ready file did not take precedence in the same playback generation")
	}
	if manifestCalls.Load() != before {
		t.Fatal("completed recording unnecessarily requested HLS")
	}
}

func TestActiveRecordingReadinessErrorsPreserveAuthorizationAndRecovery(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		body     string
		want     int
		terminal bool
	}{
		{"unauthorized", 401, "secret upstream body", 403, true},
		{"forbidden", 403, "secret upstream body", 403, true},
		{"temporary upstream failure", 500, "secret upstream body", 502, false},
		{"invalid playlist", 200, "#EXTM3U\n#EXT-X-MAP:URI=secret\n", 502, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var recover atomic.Bool
			_, call, descriptor := newReadinessTrial(t, func(w http.ResponseWriter, r *http.Request) {
				if recover.Load() {
					io.WriteString(w, readinessPlaylist(3, false))
					return
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			if w := call("GET", descriptor.Status); w.Code != tc.want {
				t.Fatalf("readiness error returned %d, want %d", w.Code, tc.want)
			}
			recover.Store(true)
			w := call("GET", descriptor.Status)
			if tc.terminal {
				if w.Code != 410 {
					t.Fatal("denied media access did not cancel the playback generation")
				}
			} else if w.Code != 200 || !strings.Contains(w.Body.String(), `"mode":"hls"`) {
				t.Fatal("transient readiness failure ended a recoverable playback generation")
			}
		})
	}
}

func TestActiveRecordingReadinessRechecksOwnershipAfterManifestRead(t *testing.T) {
	for _, action := range []string{"logout", "disconnect", "new playback"} {
		t.Run(action, func(t *testing.T) {
			opened := make(chan struct{})
			var requests atomic.Int32
			_, call, descriptor := newReadinessTrial(t, func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 {
					close(opened)
					<-r.Context().Done()
					return
				}
				io.WriteString(w, readinessPlaylist(3, false))
			})
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- call("GET", descriptor.Status) }()
			select {
			case <-opened:
			case <-time.After(time.Second):
				t.Fatal("readiness did not begin its upstream read")
			}
			var newer readinessDescriptor
			switch action {
			case "logout":
				if w := call("POST", "/api/auth/logout"); w.Code != 204 {
					t.Fatalf("logout failed: %d", w.Code)
				}
			case "disconnect":
				if w := call("DELETE", "/api/dvr/connection"); w.Code != 204 {
					t.Fatalf("disconnect failed: %d", w.Code)
				}
			case "new playback":
				w := call("POST", "/api/dvr/recordings/7/active-playback")
				if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &newer) != nil || newer.Generation == descriptor.Generation {
					t.Fatal("replacement playback did not start")
				}
				defer call("POST", newer.Stop)
			}
			select {
			case w := <-result:
				if w.Code != 410 || strings.Contains(w.Body.String(), `"mode"`) {
					t.Fatalf("retired playback received readiness after cancellation: %d", w.Code)
				}
			case <-time.After(time.Second):
				t.Fatal("retired readiness read did not cancel")
			}
			if action == "new playback" {
				if w := call("GET", newer.Status); w.Code != 200 || !strings.Contains(w.Body.String(), `"mode":"hls"`) {
					t.Fatal("retired readiness request canceled the replacement playback")
				}
			}
		})
	}
}

func TestActiveRecordingNativeBeginningHintRetainsTimeline(t *testing.T) {
	_, call, descriptor := newReadinessTrial(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, readinessPlaylist(12, false))
	})
	for _, query := range []string{"", "?start=beginning", "?start=latest", "?start=beginning"} {
		response := call("GET", descriptor.Manifest+query)
		if response.Code != http.StatusOK {
			t.Fatalf("playlist status = %d", response.Code)
		}
		body := response.Body.String()
		want := 0
		if query == "?start=beginning" {
			want = 1
		}
		if strings.Count(body, "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES") != want {
			t.Fatal("native start preference was not applied exclusively to beginning requests")
		}
		if strings.Count(body, "#EXTINF:") != 12 || strings.Contains(body, "#EXT-X-ENDLIST") || !strings.Contains(body, "#EXT-X-PLAYLIST-TYPE:EVENT") {
			t.Fatal("native hint changed the growing recording timeline")
		}
		if !strings.Contains(body, strings.TrimSuffix(descriptor.Manifest, "index.m3u8")+"seg_00011.ts") {
			t.Fatal("native playlist did not retain authorized local segment paths")
		}
	}
}
