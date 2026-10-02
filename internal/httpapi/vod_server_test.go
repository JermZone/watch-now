package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

func movieFake() *fakeDispatcharr {
	movie := dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Film/Name", Year: "2024", Rating: "8.5"}, "", "mkv")
	detail := dispatcharr.WithMovieDetailSource(dispatcharr.MovieDetail{ID: "41", Name: "Film/Name", Year: "2024"}, "901", "mkv", "")
	return &fakeDispatcharr{movies: []dispatcharr.Movie{movie}, movieDetail: detail}
}

func episodeFake() *fakeDispatcharr {
	episode := dispatcharr.WithEpisodeSource(dispatcharr.Episode{Name: "Example - S01E02 - Pilot", SeasonNumber: 1, EpisodeNumber: 2}, "971", "mp4")
	return &fakeDispatcharr{
		seriesItems:  []dispatcharr.Series{{ID: "51", Name: "Example"}},
		seriesDetail: dispatcharr.SeriesDetail{ID: "51", Name: "Example", Episodes: []dispatcharr.Episode{episode}},
	}
}

func authenticatedRequest(t *testing.T, handler http.Handler, cookie *http.Cookie, method, target string, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	request.AddCookie(cookie)
	if csrf != "" {
		request.Header.Set("Origin", "http://example.com")
		request.Header.Set("X-CSRF-Token", csrf)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestMovieMediaRequiresAuthenticationAndCatalogAuthorization(t *testing.T) {
	fake := movieFake()
	handler := newTestHandler(t, fake, io.Discard)
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", unauthenticated.Code)
	}

	cookie, _ := loginViewer(t, handler)
	unknown := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/999/stream", "")
	if unknown.Code != http.StatusNotFound || fake.mediaCalls != 0 {
		t.Fatalf("unknown response = %d, media calls = %d", unknown.Code, fake.mediaCalls)
	}
}

func TestMovieMediaRelaysSingleRangeUsingOnlyAuthorizedMetadata(t *testing.T) {
	fake := movieFake()
	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("slice")), StatusCode: http.StatusPartialContent,
		ContentType: "video/x-matroska", ContentLength: 5,
		ContentRange: "bytes 10-14/100", AcceptRanges: "bytes",
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=10-14")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusPartialContent || response.Body.String() != "slice" {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if fake.lastCredentials.Username != "viewer" || fake.lastCredentials.Password != "top-secret" ||
		fake.lastMediaKind != dispatcharr.MediaKindMovie || fake.lastMediaID != "901" ||
		fake.lastExtension != "mkv" || fake.lastRange != "bytes=10-14" {
		t.Fatalf("upstream request = creds %#v, kind %q, id %q, ext %q, range %q", fake.lastCredentials, fake.lastMediaKind, fake.lastMediaID, fake.lastExtension, fake.lastRange)
	}
	if response.Header().Get("Content-Range") != "bytes 10-14/100" || response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("range headers = %#v", response.Header())
	}
}

func TestEpisodeMediaMatchesMovieAuthorizationRangeAndErrorPolicy(t *testing.T) {
	fake := episodeFake()
	handler := newTestHandler(t, fake, io.Discard)
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/series/51/episodes/971/stream", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", unauthenticated.Code)
	}
	cookie, _ := loginViewer(t, handler)
	unknown := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51/episodes/999/stream", "")
	if unknown.Code != http.StatusNotFound || fake.mediaCalls != 0 {
		t.Fatalf("unknown response = %d, media calls = %d", unknown.Code, fake.mediaCalls)
	}

	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("part")), StatusCode: http.StatusPartialContent,
		ContentType: "video/mp4", ContentLength: 4, ContentRange: "bytes 20-23/100", AcceptRanges: "bytes",
	}
	request := httptest.NewRequest(http.MethodGet, "/api/series/51/episodes/971/stream", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=20-23")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "part" {
		t.Fatalf("range response = %d %q", response.Code, response.Body.String())
	}
	if fake.lastMediaKind != dispatcharr.MediaKindSeries || fake.lastMediaID != "971" || fake.lastExtension != "mp4" || fake.lastRange != "bytes=20-23" {
		t.Fatalf("upstream episode request = kind %q, id %q, ext %q, range %q", fake.lastMediaKind, fake.lastMediaID, fake.lastExtension, fake.lastRange)
	}

	fake.mediaError = fmt.Errorf("%w: https://provider.invalid/username/password", dispatcharr.ErrRedirect)
	failed := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51/episodes/971/stream", "")
	if failed.Code != http.StatusBadGateway || strings.Contains(failed.Body.String(), "provider.invalid") || strings.Contains(failed.Body.String(), "password") {
		t.Fatalf("sanitized failure = %d %q", failed.Code, failed.Body.String())
	}
}

func TestEpisodeBrowserCancellationStopsUpstream(t *testing.T) {
	fake := episodeFake()
	started := make(chan struct{})
	canceled := make(chan struct{})
	fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, kind dispatcharr.MediaKind, _ string, _ string, _ string, _ string) (dispatcharr.MediaStream, error) {
		if kind != dispatcharr.MediaKindSeries {
			t.Fatalf("media kind = %q", kind)
		}
		close(started)
		return dispatcharr.MediaStream{Body: &pacedStreamBody{ctx: ctx, canceled: canceled}, StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: -1}, nil
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/series/51/episodes/971/stream", nil).WithContext(ctx)
	request.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	awaitSignal(t, started, "episode stream start")
	cancel()
	awaitSignal(t, canceled, "episode upstream cancellation")
	awaitSignal(t, done, "episode handler completion")
}

func TestMalformedRangeIsRejectedBeforeUpstream(t *testing.T) {
	fake := movieFake()
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=0-1,4-5")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestedRangeNotSatisfiable || fake.mediaCalls != 0 {
		t.Fatalf("response = %d, media calls = %d", response.Code, fake.mediaCalls)
	}
}

func TestMediaHEADNeverOpensAnUpstreamGET(t *testing.T) {
	fake := movieFake()
	fake.channels = []dispatcharr.Channel{{ID: "7", Name: "Live"}}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	for _, target := range []string{"/api/movies/41/stream", "/api/movies/41/download", "/api/live/channels/7/stream"} {
		request := httptest.NewRequest(http.MethodHead, target, nil)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
			t.Errorf("HEAD %s = %d, Allow %q", target, response.Code, response.Header().Get("Allow"))
		}
	}
	if fake.mediaCalls != 0 || fake.streamCalls != 0 {
		t.Fatalf("HEAD opened upstream media: VOD=%d live=%d", fake.mediaCalls, fake.streamCalls)
	}
}

func TestMismatchedUpstreamContentRangeFailsClosed(t *testing.T) {
	fake := movieFake()
	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("wrong")), StatusCode: http.StatusPartialContent,
		ContentType: "video/mp4", ContentLength: 5, ContentRange: "bytes 0-4/100",
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=10-14")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "wrong") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
}

func TestPartialRelayIsBoundedByValidatedContentRange(t *testing.T) {
	fake := movieFake()
	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("12345unexpected")), StatusCode: http.StatusPartialContent,
		ContentType: "video/mp4", ContentLength: -1, ContentRange: "bytes 10-14/100", AcceptRanges: "bytes",
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=10-14")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "12345" {
		t.Fatalf("partial response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Length") != "5" {
		t.Fatalf("content length = %q", response.Header().Get("Content-Length"))
	}
}

func TestMovieAndEpisodeDownloadsUseSafeHumanReadableNames(t *testing.T) {
	for _, test := range []struct {
		name         string
		fake         *fakeDispatcharr
		path         string
		wantFilename string
	}{
		{"movie", movieFake(), "/api/movies/41/download", "Film_Name.mkv"},
		{"episode", episodeFake(), "/api/series/51/episodes/971/download", "Example - S01E02 - Pilot.mp4"},
	} {
		t.Run(test.name, func(t *testing.T) {
			handler := newTestHandler(t, test.fake, io.Discard)
			cookie, _ := loginViewer(t, handler)
			response := authenticatedRequest(t, handler, cookie, http.MethodGet, test.path, "")
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			disposition, parameters, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
			if err != nil || disposition != "attachment" || parameters["filename"] != test.wantFilename {
				t.Fatalf("Content-Disposition = %q, want filename %q (error %v)", response.Header().Get("Content-Disposition"), test.wantFilename, err)
			}
		})
	}
}

func TestVLCHandoffUsesOnlyOpaqueNowURLsAndLogoutRevokesIt(t *testing.T) {
	fake := movieFake()
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	created := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/movies/41/vlc", viewer.CSRFToken)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var payload struct {
		LaunchURL string `json:"launch_url"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(payload.LaunchURL, "/api/vlc/launch/") || !strings.HasSuffix(payload.LaunchURL, "/Film_Name.mkv") || strings.Contains(created.Body.String(), "top-secret") || strings.Contains(created.Body.String(), "dispatcharr.test") {
		t.Fatalf("unsafe VLC payload = %s", created.Body.String())
	}
	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	if launch.Code != http.StatusFound || !strings.HasPrefix(launch.Header().Get("Location"), "/api/vlc/media/") || !strings.HasSuffix(launch.Header().Get("Location"), "/Film_Name.mkv") {
		t.Fatalf("launch response = %d %#v", launch.Code, launch.Header())
	}
	wrongName := httptest.NewRecorder()
	handler.ServeHTTP(wrongName, httptest.NewRequest(http.MethodGet, strings.TrimSuffix(payload.LaunchURL, "Film_Name.mkv")+"Wrong.mkv", nil))
	if wrongName.Code != http.StatusNotFound {
		t.Fatalf("wrong filename launch status = %d", wrongName.Code)
	}

	logout := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/auth/logout", viewer.CSRFToken)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", logout.Code)
	}
	revoked := httptest.NewRecorder()
	handler.ServeHTTP(revoked, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	if revoked.Code != http.StatusNotFound {
		t.Fatalf("revoked launch status = %d", revoked.Code)
	}
}

func TestVLCMediaSupportsRangeWithoutViewerCookie(t *testing.T) {
	fake := movieFake()
	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("part")), StatusCode: http.StatusPartialContent,
		ContentType: "video/mp4", ContentLength: 4, ContentRange: "bytes 0-3/40", AcceptRanges: "bytes",
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	created := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/movies/41/vlc", viewer.CSRFToken)
	var payload struct {
		LaunchURL string `json:"launch_url"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &payload)
	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	mediaRequest := httptest.NewRequest(http.MethodGet, launch.Header().Get("Location"), nil)
	mediaRequest.Header.Set("Range", "bytes=0-3")
	media := httptest.NewRecorder()
	handler.ServeHTTP(media, mediaRequest)
	if media.Code != http.StatusPartialContent || media.Body.String() != "part" || fake.lastRange != "bytes=0-3" {
		t.Fatalf("VLC media = %d %q, range %q", media.Code, media.Body.String(), fake.lastRange)
	}
	wrongName := httptest.NewRecorder()
	handler.ServeHTTP(wrongName, httptest.NewRequest(http.MethodGet, strings.TrimSuffix(launch.Header().Get("Location"), "Film_Name.mkv")+"Wrong.mkv", nil))
	if wrongName.Code != http.StatusNotFound {
		t.Fatalf("wrong filename media status = %d", wrongName.Code)
	}
}

func TestVLCMediaRetainsHandoffAfterTemporaryDetailFailure(t *testing.T) {
	fake := movieFake()
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	created := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/movies/41/vlc", viewer.CSRFToken)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d", created.Code)
	}
	var payload struct {
		LaunchURL string `json:"launch_url"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	mediaURL := launch.Header().Get("Location")

	fake.mu.Lock()
	fake.movieDetailError = dispatcharr.ErrUnavailable
	fake.mu.Unlock()
	failed := httptest.NewRecorder()
	handler.ServeHTTP(failed, httptest.NewRequest(http.MethodGet, mediaURL, nil))
	if failed.Code != http.StatusServiceUnavailable || fake.mediaCalls != 0 {
		t.Fatalf("temporary detail failure = %d, media calls = %d", failed.Code, fake.mediaCalls)
	}

	fake.mu.Lock()
	fake.movieDetailError = nil
	fake.mu.Unlock()
	retried := httptest.NewRecorder()
	handler.ServeHTTP(retried, httptest.NewRequest(http.MethodGet, mediaURL, nil))
	if retried.Code != http.StatusOK || retried.Body.String() != "media-data" {
		t.Fatalf("recovered VLC media = %d %q", retried.Code, retried.Body.String())
	}
}

func TestLiveToMovieAndMovieToEpisodeCancelPriorBrowserPlayback(t *testing.T) {
	t.Run("live to movie", func(t *testing.T) {
		fake := movieFake()
		fake.channels = []dispatcharr.Channel{{ID: "7", Name: "Live"}}
		started := make(chan struct{})
		canceled := make(chan struct{})
		fake.openLiveStream = func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			close(started)
			return dispatcharr.LiveStream{Body: &pacedStreamBody{ctx: ctx, canceled: canceled}}, nil
		}
		handler := newTestHandler(t, fake, io.Discard)
		cookie, _ := loginViewer(t, handler)
		liveDone := make(chan struct{})
		go func() {
			defer close(liveDone)
			request := httptest.NewRequest(http.MethodGet, "/api/live/channels/7/stream", nil)
			request.AddCookie(cookie)
			handler.ServeHTTP(httptest.NewRecorder(), request)
		}()
		awaitSignal(t, started, "live stream start")
		movie := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/41/stream", "")
		if movie.Code != http.StatusOK || movie.Body.String() != "media-data" {
			t.Fatalf("movie response = %d %q", movie.Code, movie.Body.String())
		}
		awaitSignal(t, canceled, "live stream cancellation")
		awaitSignal(t, liveDone, "live handler completion")
	})

	t.Run("movie to episode", func(t *testing.T) {
		fake := movieFake()
		episode := episodeFake()
		fake.seriesItems, fake.seriesDetail = episode.seriesItems, episode.seriesDetail
		movieStarted := make(chan struct{})
		movieCanceled := make(chan struct{})
		fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, kind dispatcharr.MediaKind, _ string, _ string, _ string, _ string) (dispatcharr.MediaStream, error) {
			if kind == dispatcharr.MediaKindMovie {
				close(movieStarted)
				return dispatcharr.MediaStream{Body: &pacedStreamBody{ctx: ctx, canceled: movieCanceled}, StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: -1}, nil
			}
			return dispatcharr.MediaStream{Body: io.NopCloser(strings.NewReader("episode")), StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: 7}, nil
		}
		handler := newTestHandler(t, fake, io.Discard)
		cookie, _ := loginViewer(t, handler)
		movieDone := make(chan struct{})
		go func() {
			defer close(movieDone)
			request := httptest.NewRequest(http.MethodGet, "/api/movies/41/stream", nil)
			request.AddCookie(cookie)
			handler.ServeHTTP(httptest.NewRecorder(), request)
		}()
		awaitSignal(t, movieStarted, "movie stream start")
		episodeResponse := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51/episodes/971/stream", "")
		if episodeResponse.Code != http.StatusOK || episodeResponse.Body.String() != "episode" {
			t.Fatalf("episode response = %d %q", episodeResponse.Code, episodeResponse.Body.String())
		}
		awaitSignal(t, movieCanceled, "movie stream cancellation")
		awaitSignal(t, movieDone, "movie handler completion")
	})
}

func TestActiveVLCRelayIsCanceledByLogout(t *testing.T) {
	fake := movieFake()
	mediaStarted := make(chan struct{})
	mediaCanceled := make(chan struct{})
	fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, _ dispatcharr.MediaKind, _ string, _ string, _ string, _ string) (dispatcharr.MediaStream, error) {
		close(mediaStarted)
		return dispatcharr.MediaStream{Body: &pacedStreamBody{ctx: ctx, canceled: mediaCanceled}, StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: -1}, nil
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	created := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/movies/41/vlc", viewer.CSRFToken)
	var payload struct {
		LaunchURL string `json:"launch_url"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	mediaDone := make(chan struct{})
	go func() {
		defer close(mediaDone)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, launch.Header().Get("Location"), nil))
	}()
	awaitSignal(t, mediaStarted, "VLC relay start")
	logout := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/auth/logout", viewer.CSRFToken)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", logout.Code)
	}
	awaitSignal(t, mediaCanceled, "VLC relay cancellation")
	awaitSignal(t, mediaDone, "VLC handler completion")
}

func TestActiveDownloadIsCanceledByLogout(t *testing.T) {
	fake := movieFake()
	mediaStarted := make(chan struct{})
	mediaCanceled := make(chan struct{})
	fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, _ dispatcharr.MediaKind, _ string, _ string, _ string, _ string) (dispatcharr.MediaStream, error) {
		close(mediaStarted)
		return dispatcharr.MediaStream{Body: &pacedStreamBody{ctx: ctx, canceled: mediaCanceled}, StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: -1}, nil
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	downloadDone := make(chan struct{})
	go func() {
		defer close(downloadDone)
		request := httptest.NewRequest(http.MethodGet, "/api/movies/41/download", nil)
		request.AddCookie(cookie)
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	awaitSignal(t, mediaStarted, "download relay start")
	logout := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/auth/logout", viewer.CSRFToken)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", logout.Code)
	}
	awaitSignal(t, mediaCanceled, "download relay cancellation")
	awaitSignal(t, downloadDone, "download handler completion")
}

func TestActiveDownloadIsCanceledBySessionExpiry(t *testing.T) {
	fake := movieFake()
	mediaStarted := make(chan struct{})
	mediaCanceled := make(chan struct{})
	fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, _ dispatcharr.MediaKind, _ string, _ string, _ string, _ string) (dispatcharr.MediaStream, error) {
		close(mediaStarted)
		return dispatcharr.MediaStream{Body: &pacedStreamBody{ctx: ctx, canceled: mediaCanceled}, StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: -1}, nil
	}
	cfg := testConfig(t)
	cfg.SessionIdleTimeout = 75 * time.Millisecond
	handler := New(cfg, fake, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, _ := loginViewer(t, handler)
	downloadDone := make(chan struct{})
	go func() {
		defer close(downloadDone)
		request := httptest.NewRequest(http.MethodGet, "/api/movies/41/download", nil)
		request.AddCookie(cookie)
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	awaitSignal(t, mediaStarted, "download relay start")
	time.Sleep(3 * cfg.SessionIdleTimeout)
	expired := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/session", "")
	if expired.Code != http.StatusUnauthorized {
		t.Fatalf("expired session status = %d", expired.Code)
	}
	awaitSignal(t, mediaCanceled, "expired download relay cancellation")
	awaitSignal(t, downloadDone, "expired download handler completion")
}

func TestDownloadAuthRangeAndSanitizedMediaErrors(t *testing.T) {
	fake := movieFake()
	handler := newTestHandler(t, fake, io.Discard)
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/movies/41/download", nil))
	if unauthenticated.Code != http.StatusUnauthorized || fake.mediaCalls != 0 {
		t.Fatalf("unauthenticated download = %d, media calls %d", unauthenticated.Code, fake.mediaCalls)
	}
	cookie, _ := loginViewer(t, handler)
	fake.mediaStream = dispatcharr.MediaStream{
		Body: io.NopCloser(strings.NewReader("part")), StatusCode: http.StatusPartialContent,
		ContentType: "video/mp4", ContentLength: 4, ContentRange: "bytes 4-7/100", AcceptRanges: "bytes",
	}
	request := httptest.NewRequest(http.MethodGet, "/api/movies/41/download", nil)
	request.AddCookie(cookie)
	request.Header.Set("Range", "bytes=4-7")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "part" || fake.lastRange != "bytes=4-7" {
		t.Fatalf("range download = %d %q, upstream range %q", response.Code, response.Body.String(), fake.lastRange)
	}

	fake.mediaError = errors.New("provider https://provider.invalid/secret")
	fake.mediaStream = dispatcharr.MediaStream{}
	failed := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/41/stream", "")
	if failed.Code != http.StatusBadGateway || strings.Contains(failed.Body.String(), "provider.invalid") {
		t.Fatalf("unsafe media error = %d %q", failed.Code, failed.Body.String())
	}
}

func TestVODArtworkUsesCachedListingAuthorizationAndSessionIsolation(t *testing.T) {
	fake := movieFake()
	fake.movieCategories = []dispatcharr.Category{{ID: "9", Name: "Films"}}
	fake.movies = []dispatcharr.Movie{dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Film", CategoryID: "9"}, "http://dispatcharr.test:9191/api/vod/movies/41/image", "mkv")}
	fake.mediaArtwork = dispatcharr.Artwork{ContentType: "image/png", Data: []byte("png")}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	_ = authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/categories", "")
	_ = authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies?category_id=9", "")
	for range 2 {
		artwork := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/41/artwork", "")
		if artwork.Code != http.StatusOK || artwork.Body.String() != "png" {
			t.Fatalf("artwork = %d %q", artwork.Code, artwork.Body.String())
		}
	}
	if fake.movieDetailCalls != 0 || fake.movieCalls != 3 || fake.mediaArtworkCalls != 1 {
		t.Fatalf("calls: movies=%d detail=%d artwork=%d", fake.movieCalls, fake.movieDetailCalls, fake.mediaArtworkCalls)
	}
	otherCookie, _ := loginViewerAs(t, handler, "other", "different", "192.0.2.6:1234")
	otherArtwork := authenticatedRequest(t, handler, otherCookie, http.MethodGet, "/api/movies/41/artwork", "")
	if otherArtwork.Code != http.StatusOK || fake.mediaArtworkCalls != 2 {
		t.Fatalf("isolated artwork = %d, upstream calls=%d", otherArtwork.Code, fake.mediaArtworkCalls)
	}
}

func TestSparseDetailsPreserveAuthorizedListingArtwork(t *testing.T) {
	fake := movieFake()
	movieArtwork := "http://dispatcharr.test:9191/api/vod/movies/41/image"
	seriesArtwork := "http://dispatcharr.test:9191/api/vod/series/51/image"
	fake.movies = []dispatcharr.Movie{dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Film"}, movieArtwork, "mkv")}
	fake.movieDetail = dispatcharr.WithMovieDetailSource(dispatcharr.MovieDetail{ID: "41", Name: "Film"}, "901", "mkv", "")
	fake.seriesItems = []dispatcharr.Series{dispatcharr.WithSeriesArtwork(dispatcharr.Series{ID: "51", Name: "Show"}, seriesArtwork)}
	fake.seriesDetail = dispatcharr.SeriesDetail{ID: "51", Name: "Show", Episodes: []dispatcharr.Episode{{ID: "971", Name: "Pilot"}}}
	fake.mediaArtwork = dispatcharr.Artwork{ContentType: "image/png", Data: []byte("png")}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	// The UI loads its catalog before opening an item. Cached list metadata is
	// a display fallback only; the detail request performs fresh XC authorization.
	for _, target := range []string{"/api/movies", "/api/series"} {
		if response := authenticatedRequest(t, handler, cookie, http.MethodGet, target, ""); response.Code != http.StatusOK {
			t.Fatal("catalog warmup failed")
		}
	}

	for _, target := range []string{"/api/movies/41", "/api/series/51"} {
		response := authenticatedRequest(t, handler, cookie, http.MethodGet, target, "")
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", target, response.Code)
		}
		var payload struct {
			HasArtwork bool `json:"has_artwork"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || !payload.HasArtwork {
			t.Fatalf("%s payload = %s, error = %v", target, response.Body.String(), err)
		}
	}

	for _, test := range []struct {
		target string
		want   string
	}{
		{target: "/api/movies/41/artwork", want: movieArtwork},
		{target: "/api/series/51/artwork", want: seriesArtwork},
	} {
		response := authenticatedRequest(t, handler, cookie, http.MethodGet, test.target, "")
		if response.Code != http.StatusOK || fake.lastArtworkURL != test.want {
			t.Fatalf("%s status = %d, upstream artwork = %q", test.target, response.Code, fake.lastArtworkURL)
		}
	}
}

func TestEmptySeriesDetailIsRevalidatedForExplicitRetry(t *testing.T) {
	emptyArtwork := "http://dispatcharr.test:9191/api/vod/series/51/image"
	fake := &fakeDispatcharr{
		seriesItems:  []dispatcharr.Series{{ID: "51", Name: "Show"}},
		seriesDetail: dispatcharr.WithSeriesDetailArtwork(dispatcharr.SeriesDetail{ID: "51", Name: "Show"}, emptyArtwork),
		mediaArtwork: dispatcharr.Artwork{ContentType: "image/png", Data: []byte("png")},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	first := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51", "")
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	artwork := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51/artwork", "")
	if artwork.Code != http.StatusOK || fake.lastArtworkURL != emptyArtwork || fake.seriesDetailCalls != 1 {
		t.Fatalf("empty detail artwork = %d, upstream = %q, detail calls = %d", artwork.Code, fake.lastArtworkURL, fake.seriesDetailCalls)
	}
	fake.mu.Lock()
	fake.seriesDetail = dispatcharr.SeriesDetail{ID: "51", Name: "Show", Episodes: []dispatcharr.Episode{{ID: "971", Name: "Pilot"}}}
	fake.mu.Unlock()
	second := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/series/51", "")
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "Pilot") || fake.seriesDetailCalls != 2 {
		t.Fatalf("retry response = %d %q, detail calls = %d", second.Code, second.Body.String(), fake.seriesDetailCalls)
	}
}

func TestBoundedDownloadContextHonorsExpiredViewerAbsoluteDeadline(t *testing.T) {
	viewer := session.Session{CreatedAt: time.Now().Add(-time.Hour)}
	ctx, cancel := boundedDownloadContext(context.Background(), viewer, time.Minute)
	defer cancel()
	select {
	case <-ctx.Done():
	case <-time.After(100 * time.Millisecond):
		t.Fatal("download context survived the viewer absolute deadline")
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}
