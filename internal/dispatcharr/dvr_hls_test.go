package dispatcharr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func recordingHLSClient(t *testing.T, handler http.HandlerFunc, basePath string) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	base, err := url.Parse(server.URL + basePath)
	if err != nil {
		t.Fatal(err)
	}
	return NewClient(base, server.Client(), 8<<20, 1024), server
}

func TestDVRHLSManifestSanitizesCurrentRecordingAndPreservesEvent(t *testing.T) {
	var origin string
	client, server := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dispatch/api/channels/recordings/7/hls/index.m3u8" ||
			r.URL.RawQuery != "" || r.Header.Get("X-API-Key") != "viewer-key" ||
			r.Header.Get("Accept") != "*/*" {
			t.Error("incorrect authenticated manifest request")
		}
		w.Header().Set("Content-Type", "application/x-mpegURL")
		fmt.Fprintf(w, "#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:4\r\n#EXT-X-MEDIA-SEQUENCE:0\r\n#EXT-X-PLAYLIST-TYPE:EVENT\r\n#EXT-X-INDEPENDENT-SEGMENTS\r\n#EXT-X-PROGRAM-DATE-TIME:2026-10-08T19:00:00Z\r\n#EXTINF:4.0,upstream-secret-title\r\n%s/dispatch/api/channels/recordings/7/hls/seg_00000.ts\r\n#EXT-X-DISCONTINUITY\r\n#EXTINF:3.5,\r\n/dispatch/api/channels/recordings/7/hls/seg_00001.ts\r\n#EXTINF:4.0,\r\nseg_00002.ts\r\n#EXT-X-ENDLIST\r\n", origin)
	}, "/dispatch")
	origin = server.URL
	result, err := client.DVRHLSManifest(context.Background(), "viewer-key", "7")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Ended || len(result.Segments) != 3 ||
		strings.Join(result.Segments, ",") != "seg_00000.ts,seg_00001.ts,seg_00002.ts" {
		t.Fatalf("unexpected recording playlist %#v", result)
	}
	if strings.Contains(result.Playlist, origin) || strings.Contains(result.Playlist, "/api/") ||
		strings.Contains(result.Playlist, "secret") ||
		!strings.Contains(result.Playlist, "#EXT-X-PLAYLIST-TYPE:EVENT\n") ||
		!strings.Contains(result.Playlist, "#EXT-X-DISCONTINUITY\n") ||
		!strings.HasSuffix(result.Playlist, "#EXT-X-ENDLIST\n") {
		t.Fatal("unsafe or altered media playlist")
	}
}

func TestDVRHLSRejectsDangerousURIsAndUnsupportedTags(t *testing.T) {
	client, _ := recordingHLSClient(t, func(http.ResponseWriter, *http.Request) {}, "")
	for _, uri := range []string{
		"http://evil.test/api/channels/recordings/7/hls/seg_1.ts",
		"//evil.test/api/channels/recordings/7/hls/seg_1.ts",
		"/api/channels/recordings/8/hls/seg_1.ts",
		"/api/channels/recordings/7/hls/seg_1.ts?token=secret",
		"/api/channels/recordings/7/hls/seg_1.ts?",
		"/api/channels/recordings/7/hls/seg_1.ts#secret",
		"/api/channels/recordings/7/hls/seg_1.ts#",
		"/api/channels/recordings/7/hls/%73eg_1.ts",
		"/api/channels/recordings/7/hls/../hls/seg_1.ts",
		"/api/channels/recordings/7/hls/sub/seg_1.ts",
		"../seg_1.ts", "seg_1.ts?api_key=secret", "seg_1.ts/extra",
		"seg_1.m4s", "seg_-1.ts", " seg_1.ts", "seg_1.ts\t",
	} {
		t.Run(uri, func(t *testing.T) {
			_, err := client.parseRecordingPlaylist("#EXTM3U\n#EXTINF:4,\n"+uri+"\n", "7")
			if !errors.Is(err, ErrInvalidResponse) || strings.Contains(err.Error(), "secret") {
				t.Fatal("unsafe segment URI accepted")
			}
		})
	}
	for _, tag := range []string{
		"#EXT-X-STREAM-INF:BANDWIDTH=1000", "#EXT-X-I-FRAME-STREAM-INF:URI=\"secret\"",
		"#EXT-X-MEDIA:TYPE=AUDIO,URI=\"secret\"", "#EXT-X-KEY:METHOD=AES-128,URI=\"secret\"",
		"#EXT-X-MAP:URI=\"secret\"", "#EXT-X-DATERANGE:URI=\"secret\"",
		"#EXT-X-BYTERANGE:10@0", "#a-secret-comment", "#EXT-X-TARGETDURATION:4 URI=secret",
		"#EXT-X-PLAYLIST-TYPE:EVENT,URI=secret", "#EXT-X-ENDLIST:URI=secret",
		"#EXT-X-PROGRAM-DATE-TIME:not-a-time", "#EXT-X-VERSION:0",
	} {
		t.Run(tag, func(t *testing.T) {
			_, err := client.parseRecordingPlaylist("#EXTM3U\n"+tag+"\n#EXTINF:4,\nseg_1.ts\n", "7")
			if !errors.Is(err, ErrInvalidResponse) {
				t.Fatal("unsupported playlist tag accepted")
			}
		})
	}
	for _, body := range []string{
		"", "not a playlist", "#EXTM3U\nseg_1.ts\n",
		"#EXTM3U\n#EXTINF:4,\n", "#EXTM3U\n#EXTINF:4,\n#EXTINF:4,\nseg_1.ts\n",
		"#EXTM3U\n#EXT-X-ENDLIST\n#EXTINF:4,\nseg_1.ts\n",
		"#EXTM3U\n#EXTINF:4,\nseg_1.ts\n#EXTM3U\n",
		"#EXTM3U\n#EXTINF:NaN,\nseg_1.ts\n", "#EXTM3U\n#EXTINF:0,\nseg_1.ts\n",
		"#EXTM3U\n#EXTINF:4,\nseg_1.ts\n\x00",
		"#EXTM3U\n#EXTINF:4,\nseg_1.ts\n\xff",
	} {
		if _, err := client.parseRecordingPlaylist(body, "7"); !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("malformed playlist accepted: %v", err)
		}
	}
}

func TestDVRHLSURIHonorsConfiguredOriginAndBasePath(t *testing.T) {
	client, server := recordingHLSClient(t, func(http.ResponseWriter, *http.Request) {}, "/dispatch")
	for _, uri := range []string{
		server.URL + "/api/channels/recordings/7/hls/seg_1.ts",
		"/api/channels/recordings/7/hls/seg_1.ts",
		server.URL + "/other/api/channels/recordings/7/hls/seg_1.ts",
		strings.Replace(server.URL, "http:", "https:", 1) + "/dispatch/api/channels/recordings/7/hls/seg_1.ts",
		"http://user:secret@" + strings.TrimPrefix(server.URL, "http://") + "/dispatch/api/channels/recordings/7/hls/seg_1.ts",
	} {
		if _, ok := client.recordingSegment(uri, "7"); ok {
			t.Fatal("segment escaped configured origin or base path")
		}
	}
}

func TestDVRHLSManifestBounds(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"body", strings.Repeat("x", maxRecordingPlaylistBytes+1)},
		{"line", "#EXTM3U\n#EXTINF:4," + strings.Repeat("x", maxRecordingPlaylistLine) + "\nseg_1.ts\n"},
		{"segments", "#EXTM3U\n" + strings.Repeat("#EXTINF:4,\nseg_1.ts\n", maxRecordingSegments+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, _ := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, tc.body) }, "")
			_, err := client.DVRHLSManifest(context.Background(), "key", "7")
			if !errors.Is(err, ErrResponseTooBig) {
				t.Fatalf("playlist limit not enforced: %v", err)
			}
		})
	}
	client, _ := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "#EXTM3U\n#EXTINF:4,\nseg_1.ts\n")
	}, "")
	client.maxResponse = 10
	if _, err := client.DVRHLSManifest(context.Background(), "key", "7"); !errors.Is(err, ErrResponseTooBig) {
		t.Fatal("configured metadata limit ignored")
	}
	maximum := "#EXTM3U\n" + strings.Repeat("#EXTINF:4,\nseg_1.ts\n", maxRecordingSegments)
	if result, err := client.parseRecordingPlaylist(maximum, "7"); err != nil || len(result.Segments) != maxRecordingSegments {
		t.Fatal("valid maximum segment count rejected")
	}
	if result, err := client.parseRecordingPlaylist("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n", "7"); err != nil || result.Ended || result.Segments == nil {
		t.Fatal("empty growing playlist rejected")
	}
}

func TestDVRHLSManifestRedirectsDoNotFollowOrExposeUpstream(t *testing.T) {
	for _, tc := range []struct {
		name, location string
		status         int
		want           error
	}{
		{"finalized relative", "/dispatch/api/channels/recordings/7/file/", 302, ErrRecordingFinalized},
		{"finalized absolute", "ABS/dispatch/api/channels/recordings/7/file/", 302, ErrRecordingFinalized},
		{"other recording", "/dispatch/api/channels/recordings/8/file/", 302, ErrRedirect},
		{"wrong base", "/api/channels/recordings/7/file/", 302, ErrRedirect},
		{"external", "http://evil.test/dispatch/api/channels/recordings/7/file/", 302, ErrRedirect},
		{"query", "/dispatch/api/channels/recordings/7/file/?token=secret", 302, ErrRedirect},
		{"traversal", "../file/", 302, ErrRedirect},
		{"encoded", "/dispatch/api/channels/recordings/7/%66ile/", 302, ErrRedirect},
		{"fragment", "/dispatch/api/channels/recordings/7/file/#", 302, ErrRedirect},
		{"permanent", "/dispatch/api/channels/recordings/7/file/", 301, ErrRedirect},
		{"temporary", "/dispatch/api/channels/recordings/7/file/", 307, ErrRedirect},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var origin string
			followed := false
			client, server := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/hls/index.m3u8") {
					followed = true
				}
				if r.Header.Get("X-API-Key") != "private-key" {
					t.Error("manifest omitted credential")
				}
				w.Header().Set("Location", strings.Replace(tc.location, "ABS", origin, 1))
				w.WriteHeader(tc.status)
				io.WriteString(w, "private upstream body")
			}, "/dispatch")
			origin = server.URL
			_, err := client.DVRHLSManifest(context.Background(), "private-key", "7")
			if !errors.Is(err, tc.want) || followed || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), origin) {
				t.Fatalf("unsafe redirect result %v, followed=%t", err, followed)
			}
		})
	}
}

func TestDVRHLSSegmentStreamsWithoutTotalBufferingOrTimeout(t *testing.T) {
	release := make(chan struct{})
	client, _ := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channels/recordings/7/hls/seg_00001.ts" ||
			r.URL.RawQuery != "" || r.Header.Get("X-API-Key") != "private-key" ||
			r.Header.Get("Accept") != "*/*" {
			t.Error("incorrect authenticated segment request")
		}
		w.Header().Set("Content-Type", "video/mp2t")
		io.WriteString(w, "a")
		w.(http.Flusher).Flush()
		<-release
		io.WriteString(w, "bc")
	}, "")
	client.httpClient.Timeout = 5 * time.Millisecond
	stream, err := client.DVRHLSSegment(context.Background(), "private-key", "7", "seg_00001.ts")
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	defer stream.Body.Close()
	time.Sleep(20 * time.Millisecond)
	close(release)
	data, err := io.ReadAll(stream.Body)
	if err != nil || string(data) != "abc" || stream.ContentType != "video/mp2t" {
		t.Fatalf("segment was buffered or interrupted: %q, %v", data, err)
	}
}

func TestDVRHLSSegmentValidatesInputsAndRejectsRedirects(t *testing.T) {
	requests := 0
	client, _ := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Location", "/api/channels/recordings/7/file/?secret")
		w.WriteHeader(302)
	}, "")
	for _, segment := range []string{"../seg_1.ts", "seg_1.ts?key=secret", "seg_1.ts#x", "seg_1.ts/extra", "seg_a.ts", "seg_1.m4s", "seg_" + strings.Repeat("1", 60) + ".ts", "/seg_1.ts"} {
		_, err := client.DVRHLSSegment(context.Background(), "key", "7", segment)
		if !errors.Is(err, ErrNotFound) {
			t.Fatal("invalid segment accepted")
		}
	}
	if requests != 0 {
		t.Fatal("invalid segments reached upstream")
	}
	if _, err := client.DVRHLSSegment(context.Background(), "key", "../7", "seg_1.ts"); !errors.Is(err, ErrNotFound) {
		t.Fatal("invalid recording ID accepted")
	}
	if _, err := client.DVRHLSSegment(context.Background(), "bad key", "7", "seg_1.ts"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("invalid API key accepted")
	}
	if _, err := client.DVRHLSSegment(context.Background(), "key", "7", "seg_1.ts"); !errors.Is(err, ErrRedirect) || requests != 1 {
		t.Fatal("segment redirect followed")
	}
}

func TestDVRHLSHTTPFailuresStayNarrow(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   error
	}{
		{401, ErrUnauthorized}, {403, ErrUnauthorized}, {404, ErrNotFound}, {206, ErrUnavailable}, {500, ErrUnavailable},
	} {
		client, _ := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			io.WriteString(w, "secret upstream body")
		}, "")
		if _, err := client.DVRHLSManifest(context.Background(), "key", "7"); !errors.Is(err, tc.want) {
			t.Fatalf("manifest error %v", err)
		}
		if _, err := client.DVRHLSSegment(context.Background(), "key", "7", "seg_1.ts"); !errors.Is(err, tc.want) {
			t.Fatalf("segment error %v", err)
		}
	}
}

func TestDVRActiveCapabilityAndPrivateCanonicalReadyFile(t *testing.T) {
	for _, tc := range []struct {
		name, status, location         string
		remux, active, playable, ready bool
	}{
		{"growing", "recording", "/api/channels/recordings/7/hls/index.m3u8", false, true, false, false},
		{"remux ready while status pending", "recording", "/api/channels/recordings/7/file/", false, true, false, true},
		{"recorded", "completed", "/api/channels/recordings/7/file/", true, false, true, true},
		{"recorded absolute", "completed", "ABS/dispatch/api/channels/recordings/7/file/", true, false, true, true},
		{"wrong recording", "recording", "/api/channels/recordings/8/file/", false, true, false, false},
		{"external", "recording", "http://evil.test/api/channels/recordings/7/file/", false, true, false, false},
		{"query", "recording", "/api/channels/recordings/7/file/?token=secret", false, true, false, false},
		{"encoded", "recording", "/api/channels/recordings/7/%66ile/", false, true, false, false},
		{"unremuxed completed gate", "completed", "/api/channels/recordings/7/file/", false, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var origin string
			client, server := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `[{"id":7,"channel":42,"start_time":"2026-10-08T19:00:00Z","end_time":"2026-10-08T20:00:00Z","custom_properties":{"status":%q,"remux_success":%t,"file_url":%q}}]`, tc.status, tc.remux, strings.Replace(tc.location, "ABS", origin, 1))
			}, "/dispatch")
			origin = server.URL
			items, err := client.DVRRecordings(context.Background(), "key")
			if err != nil || len(items) != 1 {
				t.Fatalf("recordings %v", err)
			}
			item := items[0]
			if item.CanWatchActive != tc.active || item.Playable != tc.playable || item.ReadyFile != tc.ready {
				t.Fatalf("incorrect recording capability %#v", item)
			}
			data, err := json.Marshal(item)
			if err != nil || strings.Contains(string(data), "file_url") || strings.Contains(string(data), "ReadyFile") ||
				strings.Contains(string(data), "ready_file") || strings.Contains(string(data), "secret") ||
				strings.Contains(string(data), origin) || !strings.Contains(string(data), "\"can_watch_active\":") {
				t.Fatal("upstream readiness/location leaked")
			}
		})
	}
}

func TestDVRCreateAlsoNarrowsActiveCapabilityAndReadyFile(t *testing.T) {
	var origin string
	client, server := recordingHLSClient(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"id":7,"channel":42,"start_time":"2026-10-08T19:00:00Z","end_time":"2026-10-08T20:00:00Z","custom_properties":{"status":"recording","file_url":%q}}`, origin+"/dispatch/api/channels/recordings/7/file/")
	}, "/dispatch")
	origin = server.URL
	item, err := client.DVRCreate(context.Background(), "key", RecordingRequest{})
	if err != nil || !item.CanWatchActive || !item.ReadyFile || item.Playable {
		t.Fatalf("created capability %#v, %v", item, err)
	}
}

func TestDVRHLSExtractsBoundedTargetDuration(t *testing.T) {
	client, _ := recordingHLSClient(t, func(http.ResponseWriter, *http.Request) {}, "")
	for _, tc := range []struct {
		body string
		want uint32
	}{
		{"#EXTM3U\n#EXTINF:4,\nseg_1.ts\n", 0},
		{"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_1.ts\n", 4},
		{"#EXTM3U\n#EXT-X-TARGETDURATION:86400\n#EXTINF:4,\nseg_1.ts\n", 86400},
	} {
		playlist, err := client.parseRecordingPlaylist(tc.body, "7")
		if err != nil || playlist.TargetDuration != tc.want {
			t.Fatalf("target duration metadata %d, want %d; error %v", playlist.TargetDuration, tc.want, err)
		}
		if playlist.Playlist != tc.body {
			t.Fatal("target duration metadata extraction changed the media playlist")
		}
	}
	for _, target := range []string{"0", "86401", "18446744073709551615", "18446744073709551616", "-1", "4.5"} {
		if _, err := client.parseRecordingPlaylist("#EXTM3U\n#EXT-X-TARGETDURATION:"+target+"\n#EXTINF:4,\nseg_1.ts\n", "7"); !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("unsafe target duration %s accepted", target)
		}
	}
}
