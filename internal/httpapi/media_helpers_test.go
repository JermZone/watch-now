package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/cache"
	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
	vlcstore "github.com/JermZone/watch-now/internal/vlc"
)

func TestAcceptedRangeAllowsOnlyOneWellFormedByteRange(t *testing.T) {
	for _, value := range []string{"", "bytes=0-", "bytes=100-199", "bytes=-500"} {
		writer := httptest.NewRecorder()
		if got, ok := acceptedRange(writer, value); !ok || got != value {
			t.Errorf("acceptedRange(%q) = %q, %v", value, got, ok)
		}
	}
	for _, value := range []string{"items=0-1", "bytes=", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0", "bytes=1-x", "bytes=" + strings.Repeat("1", 129) + "-"} {
		writer := httptest.NewRecorder()
		if _, ok := acceptedRange(writer, value); ok {
			t.Errorf("acceptedRange(%q) accepted malformed input", value)
		}
		if writer.Code != http.StatusRequestedRangeNotSatisfiable {
			t.Errorf("acceptedRange(%q) status = %d", value, writer.Code)
		}
	}
}

func TestSafeLogPathRedactsOpaqueVLCTokens(t *testing.T) {
	for _, value := range []string{
		"/api/vlc/media/secret-token",
		"/api//vlc/media/secret-token",
		"//api/vlc/launch/secret-token",
		"/api/other/../vlc/media/secret-token",
		"/api/vlc/media/secret-token/../../../other",
	} {
		if got := safeLogPath(value); got != "/api/vlc/{redacted}" {
			t.Errorf("safeLogPath(%q) = %q", value, got)
		}
	}
	if got := safeLogPath("/api/movies/42"); got != "/api/movies/42" {
		t.Fatalf("ordinary path changed to %q", got)
	}
}

func TestPartialContentMetadataMustBeInternallyConsistent(t *testing.T) {
	for _, value := range []struct {
		raw       string
		length    int64
		requested string
	}{
		{"bytes 10-14/100", 5, "bytes=10-14"},
		{"bytes 0-0/*", 1, "bytes=0-0"},
		{"bytes 90-99/100", -1, "bytes=90-999"},
		{"bytes 95-99/100", 5, "bytes=-5"},
	} {
		if !validPartialContentRange(value.raw, value.length, value.requested) {
			t.Errorf("valid range rejected: %#v", value)
		}
	}
	for _, value := range []struct {
		raw    string
		length int64
	}{
		{"bytes 14-10/100", 5},
		{"bytes 0-100/100", 101},
		{"bytes 10-14/100", 4},
		{"items 0-1/2", 2},
	} {
		if validPartialContentRange(value.raw, value.length, "bytes=10-14") {
			t.Errorf("invalid range accepted: %#v", value)
		}
	}
	for _, mismatch := range []struct {
		response string
		request  string
	}{
		{"bytes 0-499/1000", "bytes=500-999"},
		{"bytes 500-999/1000", "bytes=0-499"},
		{"bytes 10-12/100", "bytes=10-14"},
		{"bytes 10-14/100", "bytes=10-"},
		{"bytes 90-99/100", "bytes=-5"},
	} {
		if validPartialContentRange(mismatch.response, -1, mismatch.request) {
			t.Errorf("mismatched response accepted: %#v", mismatch)
		}
	}
}

func TestViewerRelayLimiterBoundsGlobalAccountAndSessionConcurrency(t *testing.T) {
	limiter := newViewerRelayLimiter()
	releases := make([]func(), 0, maxConcurrentViewerRelays)
	for index := range maxConcurrentViewerRelaysPerSession {
		release, ok := limiter.acquire("viewer", "account-one", func() {})
		if !ok {
			t.Fatalf("per-session reservation %d rejected", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.acquire("viewer", "account-one", func() {}); ok {
		t.Fatal("per-session download limit was not enforced")
	}
	for index := len(releases); index < maxConcurrentViewerRelaysPerAccount; index++ {
		release, ok := limiter.acquire("viewer-"+strconv.Itoa(index), "account-one", func() {})
		if !ok {
			t.Fatalf("account reservation %d rejected early", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.acquire("extra-session", "account-one", func() {}); ok {
		t.Fatal("per-account download limit was not enforced across sessions")
	}
	for index := len(releases); index < maxConcurrentViewerRelays; index++ {
		release, ok := limiter.acquire("other-viewer-"+strconv.Itoa(index), "account-two", func() {})
		if !ok {
			t.Fatalf("global reservation %d rejected early", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.acquire("overflow", "account-three", func() {}); ok {
		t.Fatal("global download limit was not enforced")
	}
	releases[0]()
	releases[0]()
	if release, ok := limiter.acquire("viewer", "account-one", func() {}); !ok {
		t.Fatal("released reservation was not reusable")
	} else {
		release()
	}
	for _, release := range releases[1:] {
		release()
	}
}

func TestViewerRelayLimiterStopRetainsCapacityUntilRelease(t *testing.T) {
	limiter := newViewerRelayLimiter()
	canceled := make(chan struct{}, maxConcurrentViewerRelaysPerSession)
	releases := make([]func(), 0, maxConcurrentViewerRelaysPerAccount)
	for range maxConcurrentViewerRelaysPerSession {
		release, ok := limiter.acquire("viewer", "account-one", func() { canceled <- struct{}{} })
		if !ok {
			t.Fatal("reservation was unexpectedly rejected")
		}
		releases = append(releases, release)
	}
	for index := len(releases); index < maxConcurrentViewerRelaysPerAccount; index++ {
		release, ok := limiter.acquire("viewer-"+strconv.Itoa(index), "account-one", func() {})
		if !ok {
			t.Fatalf("account reservation %d rejected early", index)
		}
		releases = append(releases, release)
	}

	limiter.stop("viewer")
	for range maxConcurrentViewerRelaysPerSession {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("session stop did not cancel every reservation")
		}
	}
	if _, ok := limiter.acquire("new-session", "account-one", func() {}); ok {
		t.Fatal("stopped requests freed account capacity before their handlers exited")
	}
	if release, ok := limiter.acquire("other-session", "account-two", func() {}); !ok {
		t.Fatal("another account could not use its available capacity")
	} else {
		release()
	}
	limiter.stop("viewer")
	select {
	case <-canceled:
		t.Fatal("stop canceled a reservation more than once")
	default:
	}
	releases[0]()
	releases[0]()
	if release, ok := limiter.acquire("new-session", "account-one", func() {}); !ok {
		t.Fatal("released account capacity was not reusable")
	} else {
		release()
	}
	for _, release := range releases[1:] {
		release()
	}
}

func TestBrowserAndDownloadRoutesShareAccountRelayLimit(t *testing.T) {
	limiter := newViewerRelayLimiter()
	server := &Server{viewerRelays: limiter, playbacks: newPlaybackRegistry()}
	releases := make([]func(), 0, maxConcurrentViewerRelaysPerAccount)
	for index := range maxConcurrentViewerRelaysPerAccount {
		release, ok := limiter.acquire("session-"+strconv.Itoa(index), "viewer", func() {})
		if !ok {
			t.Fatalf("setup reservation %d rejected", index)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()

	viewer := session.Session{ID: "new-session", Username: "viewer", CreatedAt: time.Now()}
	for _, test := range []struct {
		name    string
		path    string
		values  map[string]string
		code    string
		handler func(*Server, http.ResponseWriter, *http.Request)
	}{
		{"live", "/api/live/channels/41/stream", map[string]string{"channel_id": "41"}, "playback_limit", (*Server).handleLiveStream},
		{"movie", "/api/movies/41/stream", map[string]string{"movie_id": "41"}, "playback_limit", (*Server).handleMovieStream},
		{"episode", "/api/series/51/episodes/971/stream", map[string]string{"series_id": "51", "episode_id": "971"}, "playback_limit", (*Server).handleEpisodeStream},
		{"movie download", "/api/movies/41/download", map[string]string{"movie_id": "41"}, "download_limit", (*Server).handleMovieDownload},
		{"episode download", "/api/series/51/episodes/971/download", map[string]string{"series_id": "51", "episode_id": "971"}, "download_limit", (*Server).handleEpisodeDownload},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			for key, value := range test.values {
				request.SetPathValue(key, value)
			}
			request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, viewer))
			writer := httptest.NewRecorder()
			test.handler(server, writer, request)
			if writer.Code != http.StatusTooManyRequests || !strings.Contains(writer.Body.String(), `"`+test.code+`"`) {
				t.Fatalf("response = %d %q", writer.Code, writer.Body.String())
			}
		})
	}
	if len(server.playbacks.bySession) != 0 {
		t.Fatal("a denied browser request replaced an active playback")
	}
}

func TestRevocationRemovesSessionBeforeCancelingRelays(t *testing.T) {
	sessions := session.NewStore(time.Hour, time.Hour, 8)
	viewer, err := sessions.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	limiter := newViewerRelayLimiter()
	canceling := make(chan struct{})
	allowCancel := make(chan struct{})
	var unblockOnce sync.Once
	unblock := func() { unblockOnce.Do(func() { close(allowCancel) }) }
	release, ok := limiter.acquire(viewer.ID, viewer.Username, func() {
		close(canceling)
		<-allowCancel
	})
	if !ok {
		t.Fatal("setup reservation was rejected")
	}
	defer release()
	defer unblock()
	server := &Server{
		sessions:     sessions,
		viewerRelays: limiter,
		playbacks:    newPlaybackRegistry(),
		vlc:          vlcstore.NewStore(8),
		cache:        cache.New(8, 1024),
	}
	done := make(chan struct{})
	go func() {
		server.revokeViewerState(viewer.ID)
		close(done)
	}()
	select {
	case <-canceling:
	case <-time.After(time.Second):
		t.Fatal("revocation did not reach the active relay")
	}
	if _, alive := sessions.Get(viewer.ID); alive {
		t.Error("revocation canceled relays before removing session admission")
	}
	unblock()
	<-done
}

func TestMediaResponseMetadataIsNarrow(t *testing.T) {
	if got := safeMediaType("video/mp4; codecs=avc1"); got != "video/mp4" {
		t.Fatalf("safeMediaType(video) = %q", got)
	}
	if got := safeMediaType("text/html"); got != "application/octet-stream" {
		t.Fatalf("safeMediaType(html) = %q", got)
	}
	if got := withExtension("Movie.mp4", "mp4"); got != "Movie.mp4" {
		t.Fatalf("withExtension duplicate = %q", got)
	}
}
