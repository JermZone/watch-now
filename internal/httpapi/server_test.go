package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/config"
	"github.com/JermZone/watch-now/internal/dispatcharr"
)

type fakeDispatcharr struct {
	mu                sync.Mutex
	authError         error
	categoryError     error
	epgError          error
	artworkError      error
	streamError       error
	diagnostics       dispatcharr.Diagnostics
	categories        []dispatcharr.Category
	channels          []dispatcharr.Channel
	programs          []dispatcharr.Program
	artwork           dispatcharr.Artwork
	streamBody        io.ReadCloser
	movieCategories   []dispatcharr.Category
	movies            []dispatcharr.Movie
	movieDetail       dispatcharr.MovieDetail
	movieDetailError  error
	seriesCategories  []dispatcharr.Category
	seriesItems       []dispatcharr.Series
	seriesDetail      dispatcharr.SeriesDetail
	mediaArtwork      dispatcharr.Artwork
	mediaStream       dispatcharr.MediaStream
	mediaError        error
	openMedia         func(context.Context, dispatcharr.Credentials, dispatcharr.MediaKind, string, string, string, string) (dispatcharr.MediaStream, error)
	openLiveStream    func(context.Context, dispatcharr.Credentials, string) (dispatcharr.LiveStream, error)
	liveChannels      func(context.Context, dispatcharr.Credentials, string) ([]dispatcharr.Channel, error)
	categoryCalls     int
	channelCalls      int
	epgCalls          int
	artworkCalls      int
	streamCalls       int
	lastCredentials   dispatcharr.Credentials
	lastCategoryID    string
	mediaCalls        int
	movieCalls        int
	movieDetailCalls  int
	seriesCalls       int
	seriesDetailCalls int
	mediaArtworkCalls int
	lastMediaKind     dispatcharr.MediaKind
	lastMediaID       string
	lastExtension     string
	lastRange         string
	lastRelayID       string
	lastArtworkURL    string
}

type pacedStreamBody struct {
	ctx      context.Context
	canceled chan struct{}
	once     sync.Once
}

func (body *pacedStreamBody) Read(destination []byte) (int, error) {
	timer := time.NewTimer(5 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-body.ctx.Done():
		body.once.Do(func() {
			if body.canceled != nil {
				close(body.canceled)
			}
		})
		return 0, body.ctx.Err()
	case <-timer.C:
		return copy(destination, "ts"), nil
	}
}

func (body *pacedStreamBody) Close() error { return nil }

func (fake *fakeDispatcharr) OpenLiveStream(ctx context.Context, credentials dispatcharr.Credentials, channelID string) (dispatcharr.LiveStream, error) {
	fake.mu.Lock()
	fake.lastCredentials = credentials
	fake.lastCategoryID = channelID
	fake.streamCalls++
	open := fake.openLiveStream
	streamError := fake.streamError
	body := fake.streamBody
	fake.mu.Unlock()
	if open != nil {
		return open(ctx, credentials, channelID)
	}
	if streamError != nil {
		return dispatcharr.LiveStream{}, streamError
	}
	if body == nil {
		body = io.NopCloser(strings.NewReader("mpeg-ts-data"))
	}
	return dispatcharr.LiveStream{Body: body}, nil
}

func (fake *fakeDispatcharr) LiveEPG(_ context.Context, credentials dispatcharr.Credentials, channelID string) ([]dispatcharr.Program, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.lastCategoryID = channelID
	fake.epgCalls++
	return fake.programs, fake.epgError
}

func (fake *fakeDispatcharr) ChannelArtwork(_ context.Context, _ dispatcharr.Channel) (dispatcharr.Artwork, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.artworkCalls++
	return fake.artwork, fake.artworkError
}

func (fake *fakeDispatcharr) Diagnostics(context.Context) dispatcharr.Diagnostics {
	return fake.diagnostics
}

func (fake *fakeDispatcharr) Authenticate(_ context.Context, credentials dispatcharr.Credentials) (dispatcharr.Account, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	if fake.authError != nil {
		return dispatcharr.Account{}, fake.authError
	}
	return dispatcharr.Account{Username: credentials.Username, Status: "Active"}, nil
}

func (fake *fakeDispatcharr) LiveCategories(_ context.Context, credentials dispatcharr.Credentials) ([]dispatcharr.Category, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.categoryCalls++
	if fake.categoryError != nil {
		return nil, fake.categoryError
	}
	return fake.categories, nil
}

func (fake *fakeDispatcharr) LiveChannels(ctx context.Context, credentials dispatcharr.Credentials, categoryID string) ([]dispatcharr.Channel, error) {
	fake.mu.Lock()
	fake.lastCredentials = credentials
	fake.lastCategoryID = categoryID
	fake.channelCalls++
	liveChannels := fake.liveChannels
	channels := fake.channels
	fake.mu.Unlock()
	if liveChannels != nil {
		return liveChannels(ctx, credentials, categoryID)
	}
	return channels, nil
}

func (fake *fakeDispatcharr) MovieCategories(_ context.Context, credentials dispatcharr.Credentials) ([]dispatcharr.Category, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	return fake.movieCategories, nil
}

func (fake *fakeDispatcharr) Movies(_ context.Context, credentials dispatcharr.Credentials, categoryID string) ([]dispatcharr.Movie, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.lastCategoryID = categoryID
	fake.movieCalls++
	return fake.movies, nil
}

func (fake *fakeDispatcharr) MovieDetails(_ context.Context, credentials dispatcharr.Credentials, id string) (dispatcharr.MovieDetail, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.movieDetailCalls++
	if _, ok := findMovie(fake.movies, id); !ok {
		return dispatcharr.MovieDetail{}, dispatcharr.ErrNotFound
	}
	if fake.movieDetailError != nil {
		return dispatcharr.MovieDetail{}, fake.movieDetailError
	}
	return fake.movieDetail, nil
}

func (fake *fakeDispatcharr) SeriesCategories(_ context.Context, credentials dispatcharr.Credentials) ([]dispatcharr.Category, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	return fake.seriesCategories, nil
}

func (fake *fakeDispatcharr) Series(_ context.Context, credentials dispatcharr.Credentials, categoryID string) ([]dispatcharr.Series, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.lastCategoryID = categoryID
	fake.seriesCalls++
	return fake.seriesItems, nil
}

func (fake *fakeDispatcharr) SeriesDetails(_ context.Context, credentials dispatcharr.Credentials, id string) (dispatcharr.SeriesDetail, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.lastCredentials = credentials
	fake.seriesDetailCalls++
	if _, ok := findSeries(fake.seriesItems, id); !ok {
		return dispatcharr.SeriesDetail{}, dispatcharr.ErrNotFound
	}
	return fake.seriesDetail, nil
}

func (fake *fakeDispatcharr) MediaArtwork(_ context.Context, upstreamURL string) (dispatcharr.Artwork, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.mediaArtworkCalls++
	fake.lastArtworkURL = upstreamURL
	return fake.mediaArtwork, fake.artworkError
}

func (fake *fakeDispatcharr) OpenMedia(ctx context.Context, credentials dispatcharr.Credentials, kind dispatcharr.MediaKind, streamID string, extension string, rangeHeader string, relayID string) (dispatcharr.MediaStream, error) {
	fake.mu.Lock()
	fake.lastCredentials = credentials
	fake.mediaCalls++
	fake.lastMediaKind = kind
	fake.lastMediaID = streamID
	fake.lastExtension = extension
	fake.lastRange = rangeHeader
	fake.lastRelayID = relayID
	open := fake.openMedia
	mediaError := fake.mediaError
	stream := fake.mediaStream
	fake.mu.Unlock()
	if open != nil {
		return open(ctx, credentials, kind, streamID, extension, rangeHeader, relayID)
	}
	if mediaError != nil {
		return dispatcharr.MediaStream{}, mediaError
	}
	if stream.Body == nil {
		stream = dispatcharr.MediaStream{Body: io.NopCloser(strings.NewReader("media-data")), StatusCode: http.StatusOK, ContentType: "video/mp4", ContentLength: int64(len("media-data")), AcceptRanges: "bytes"}
	}
	return stream, nil
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	baseURL, _ := url.Parse("http://dispatcharr.test:9191")
	return config.Config{
		DispatcharrURL:      baseURL,
		WebRoot:             t.TempDir(),
		CookieSecure:        "auto",
		SessionIdleTimeout:  time.Hour,
		SessionAbsoluteTTL:  12 * time.Hour,
		SessionLimit:        8,
		UpstreamTimeout:     time.Second,
		UpstreamMaxBytes:    1024 * 1024,
		ArtworkMaxBytes:     1024,
		CacheEntries:        8,
		CacheMaxBytes:       1024 * 1024,
		CategoryCacheTTL:    time.Minute,
		ChannelCacheTTL:     time.Minute,
		EPGCacheTTL:         time.Minute,
		ArtworkCacheTTL:     time.Minute,
		CatalogCacheTTL:     time.Minute,
		DetailCacheTTL:      time.Minute,
		DiagnosticCacheTTL:  time.Minute,
		VLCSessionLimit:     8,
		LoginRateLimit:      3,
		LoginRateWindow:     time.Minute,
		LoginRateLimitPeers: 8,
	}
}

func newTestHandler(t *testing.T, fake *fakeDispatcharr, logOutput io.Writer) http.Handler {
	t.Helper()
	return New(testConfig(t), fake, slog.New(slog.NewJSONHandler(logOutput, nil)))
}

func loginViewer(t *testing.T, handler http.Handler) (*http.Cookie, sessionResponse) {
	return loginViewerAs(t, handler, "viewer", "top-secret", "192.0.2.5:1234")
}

func loginViewerAs(t *testing.T, handler http.Handler, username, password, remoteAddress string) (*http.Cookie, sessionResponse) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	request := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/login", bytes.NewReader(body))
	request.Host = "now.test"
	request.Header.Set("Origin", "http://now.test")
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = remoteAddress
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response sessionResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %d", len(cookies))
	}
	return cookies[0], response
}

func TestLivenessDoesNotDependOnDispatcharr(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/health/live", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"status":"ok"`) {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Security-Policy") == "" || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("security headers = %#v", recorder.Header())
	}
}

func TestStaticHandlerServesSPAWithoutAnApplicationRuntime(t *testing.T) {
	cfg := testConfig(t)
	if err := os.WriteFile(filepath.Join(cfg.WebRoot, "index.html"), []byte("<main>Watch Now</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := New(cfg, &fakeDispatcharr{}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	request := httptest.NewRequest(http.MethodGet, "http://now.test/viewer/route", nil)
	request.Header.Set("Accept", "text/html")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "Watch Now") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	// Live playback uses a MediaSource blob URL; allow it only for media.
	const wantPolicy = "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
	if got := recorder.Header().Get("Content-Security-Policy"); got != wantPolicy {
		t.Fatalf("Content-Security-Policy = %q, want %q", got, wantPolicy)
	}
}

func TestNewerDiagnosticVersionDoesNotGateAuthentication(t *testing.T) {
	fake := &fakeDispatcharr{diagnostics: dispatcharr.Diagnostics{Reachable: true, Version: "12.0.0"}}
	handler := newTestHandler(t, fake, io.Discard)

	cookie, _ := loginViewer(t, handler)
	diagnosticRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/diagnostics/dispatcharr", nil)
	diagnosticRequest.AddCookie(cookie)
	diagnosticRecorder := httptest.NewRecorder()
	handler.ServeHTTP(diagnosticRecorder, diagnosticRequest)
	if diagnosticRecorder.Code != http.StatusOK || !strings.Contains(diagnosticRecorder.Body.String(), "12.0.0") {
		t.Fatalf("diagnostics status = %d, body = %s", diagnosticRecorder.Code, diagnosticRecorder.Body.String())
	}

	loginViewer(t, handler)
}

func TestLoginCreatesOpaqueSecureSessionWithoutCredentialLeak(t *testing.T) {
	fake := &fakeDispatcharr{}
	var logs bytes.Buffer
	handler := newTestHandler(t, fake, &logs)
	cookie, response := loginViewer(t, handler)

	if cookie.Name != sessionCookieName || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie = %#v", cookie)
	}
	if cookie.Secure {
		t.Fatal("auto secure cookie should be false for plain HTTP")
	}
	if strings.Contains(cookie.Value, "viewer") || strings.Contains(cookie.Value, "secret") || len(cookie.Value) < 40 {
		t.Fatalf("cookie is not opaque: %q", cookie.Value)
	}
	if response.User.Username != "viewer" || response.CSRFToken == "" {
		t.Fatalf("response = %#v", response)
	}
	if strings.Contains(logs.String(), "top-secret") || strings.Contains(logs.String(), "viewer") {
		t.Fatalf("credentials leaked in logs: %s", logs.String())
	}
	if fake.lastCredentials.Password != "top-secret" {
		t.Fatal("credentials were not sent to adapter")
	}
}

func TestLoginRejectsCrossOriginRequest(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	request := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/login", strings.NewReader(`{"username":"viewer","password":"secret"}`))
	request.Host = "now.test"
	request.Header.Set("Origin", "https://attacker.test")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestHTTPSLoginSetsSecureCookie(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	request := httptest.NewRequest(http.MethodPost, "https://now.test/api/auth/login", strings.NewReader(`{"username":"viewer","password":"secret"}`))
	request.Host = "now.test"
	request.Header.Set("Origin", "https://now.test")
	request.RemoteAddr = "192.0.2.5:1234"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if cookies := recorder.Result().Cookies(); len(cookies) != 1 || !cookies[0].Secure {
		t.Fatalf("cookies = %#v", cookies)
	}
}

func TestLoginRejectsOversizedOrTrailingJSON(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	for name, body := range map[string]string{
		"trailing JSON": `{"username":"viewer","password":"secret"}{}`,
		"oversized":     `{"username":"viewer","password":"` + strings.Repeat("x", 17*1024) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/login", strings.NewReader(body))
			request.Host = "now.test"
			request.Header.Set("Origin", "http://now.test")
			request.RemoteAddr = "192.0.2.40:1234"
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestLogoutRequiresCSRFAndRevokesSession(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	cookie, sessionData := loginViewer(t, handler)

	badRequest := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/logout", nil)
	badRequest.Host = "now.test"
	badRequest.Header.Set("Origin", "http://now.test")
	badRequest.AddCookie(cookie)
	badRecorder := httptest.NewRecorder()
	handler.ServeHTTP(badRecorder, badRequest)
	if badRecorder.Code != http.StatusForbidden {
		t.Fatalf("logout without CSRF status = %d", badRecorder.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/logout", nil)
	request.Host = "now.test"
	request.Header.Set("Origin", "http://now.test")
	request.Header.Set("X-CSRF-Token", sessionData.CSRFToken)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	sessionRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	sessionRequest.AddCookie(cookie)
	sessionRecorder := httptest.NewRecorder()
	handler.ServeHTTP(sessionRecorder, sessionRequest)
	if sessionRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status = %d", sessionRecorder.Code)
	}
}

func TestViewerCatalogIsNarrowAuthorizedAndCachedPerSession(t *testing.T) {
	fake := &fakeDispatcharr{
		categories: []dispatcharr.Category{{ID: "2", Name: "News"}},
		channels:   []dispatcharr.Channel{{ID: "41", Name: "World News", ChannelNumber: "7", CategoryID: "2"}},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/categories", nil)
		request.AddCookie(cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Body.String() != "[{\"id\":\"2\",\"name\":\"News\"}]\n" {
			t.Fatalf("category status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
	}

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels?category_id=2", nil)
		request.AddCookie(cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || strings.Contains(recorder.Body.String(), "top-secret") {
			t.Fatalf("channel status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
	}

	if fake.categoryCalls != 1 || fake.channelCalls != 1 {
		t.Fatalf("adapter calls = categories %d, channels %d", fake.categoryCalls, fake.channelCalls)
	}
	if fake.lastCategoryID != "2" || fake.lastCredentials.Username != "viewer" {
		t.Fatalf("category = %q, credentials = %#v", fake.lastCategoryID, fake.lastCredentials)
	}
}

func TestEPGIsAuthorizedNarrowAndCachedPerViewerSession(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}},
		programs: []dispatcharr.Program{
			{Title: "Current", Description: "Viewer-safe description", Start: now.Add(-15 * time.Minute), End: now.Add(15 * time.Minute)},
			{Title: "Upcoming", Start: now.Add(15 * time.Minute), End: now.Add(45 * time.Minute)},
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/epg", nil)
		request.AddCookie(cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"title":"Current"`) || !strings.Contains(recorder.Body.String(), `"title":"Upcoming"`) {
			t.Fatalf("EPG status = %d, body = %s", recorder.Code, recorder.Body.String())
		}
		if strings.Contains(recorder.Body.String(), "top-secret") {
			t.Fatalf("EPG leaked credentials: %s", recorder.Body.String())
		}
	}
	if fake.epgCalls != 1 {
		t.Fatalf("EPG calls = %d", fake.epgCalls)
	}

	otherCookie, _ := loginViewerAs(t, handler, "other-viewer", "other-secret", "192.0.2.6:1234")
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/epg", nil)
	request.AddCookie(otherCookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || fake.epgCalls != 2 {
		t.Fatalf("isolated EPG status = %d, calls = %d", recorder.Code, fake.epgCalls)
	}
}

func TestEPGRejectsChannelOutsideViewerCatalog(t *testing.T) {
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}}}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/99/epg", nil)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || fake.epgCalls != 0 {
		t.Fatalf("status = %d, EPG calls = %d, body = %s", recorder.Code, fake.epgCalls, recorder.Body.String())
	}
}

func TestArtworkIsAuthorizedProxiedAndCachedPerSession(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nartwork")
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News", HasArtwork: true}},
		artwork:  dispatcharr.Artwork{ContentType: "image/png", Data: png},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/artwork", nil)
		request.AddCookie(cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "image/png" || !bytes.Equal(recorder.Body.Bytes(), png) {
			t.Fatalf("artwork status = %d, headers = %#v, body = %q", recorder.Code, recorder.Header(), recorder.Body.Bytes())
		}
		if !strings.HasPrefix(recorder.Header().Get("Cache-Control"), "private") {
			t.Fatalf("cache control = %q", recorder.Header().Get("Cache-Control"))
		}
	}
	if fake.artworkCalls != 1 {
		t.Fatalf("artwork calls = %d", fake.artworkCalls)
	}
	otherCookie, _ := loginViewerAs(t, handler, "other-viewer", "other-secret", "192.0.2.6:1234")
	isolatedRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/artwork", nil)
	isolatedRequest.AddCookie(otherCookie)
	isolatedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(isolatedRecorder, isolatedRequest)
	if isolatedRecorder.Code != http.StatusOK || fake.artworkCalls != 2 {
		t.Fatalf("isolated artwork status = %d, calls = %d", isolatedRecorder.Code, fake.artworkCalls)
	}

	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/99/artwork", nil)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || fake.artworkCalls != 2 {
		t.Fatalf("unauthorized artwork status = %d, calls = %d", recorder.Code, fake.artworkCalls)
	}
}

func TestMissingArtworkReturnsNarrowNotFound(t *testing.T) {
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}}}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/artwork", nil)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || strings.Contains(recorder.Body.String(), "dispatcharr.test") {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestRejectedUpstreamCredentialsRevokeLocalSession(t *testing.T) {
	fake := &fakeDispatcharr{}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	fake.categoryError = dispatcharr.ErrUnauthorized

	catalogRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/categories", nil)
	catalogRequest.AddCookie(cookie)
	catalogRecorder := httptest.NewRecorder()
	handler.ServeHTTP(catalogRecorder, catalogRequest)
	if catalogRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("catalog status = %d", catalogRecorder.Code)
	}
	if cookies := catalogRecorder.Result().Cookies(); len(cookies) != 1 || cookies[0].MaxAge >= 0 {
		t.Fatalf("expired cookies = %#v", cookies)
	}

	sessionRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	sessionRequest.AddCookie(cookie)
	sessionRecorder := httptest.NewRecorder()
	handler.ServeHTTP(sessionRecorder, sessionRequest)
	if sessionRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status = %d", sessionRecorder.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	fake := &fakeDispatcharr{authError: dispatcharr.ErrUnauthorized}
	handler := newTestHandler(t, fake, io.Discard)
	for attempt := 1; attempt <= 4; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/login", strings.NewReader(`{"username":"viewer","password":"wrong"}`))
		request.Host = "now.test"
		request.Header.Set("Origin", "http://now.test")
		request.RemoteAddr = "192.0.2.20:2222"
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if attempt <= 3 && recorder.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d", attempt, recorder.Code)
		}
		if attempt == 4 && recorder.Code != http.StatusTooManyRequests {
			t.Fatalf("attempt %d status = %d", attempt, recorder.Code)
		}
	}
}

func TestLiveStreamRequiresSessionAndViewerAuthorization(t *testing.T) {
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}}}
	handler := newTestHandler(t, fake, io.Discard)

	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	cookie, _ := loginViewer(t, handler)
	request = httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/99/stream", nil)
	request.AddCookie(cookie)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound || !strings.Contains(recorder.Body.String(), "channel_not_found") {
		t.Fatalf("unauthorized channel status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if fake.streamCalls != 0 {
		t.Fatalf("OpenLiveStream calls = %d, want 0", fake.streamCalls)
	}
}

func TestAuthorizedLiveStreamUsesSessionCredentialsAndRelaysBytes(t *testing.T) {
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}}}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream?username=attacker&password=wrong&url=http://evil.test", nil)
	request.AddCookie(cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || recorder.Body.String() != "mpeg-ts-data" {
		t.Fatalf("status = %d, body = %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "video/mp2t" {
		t.Fatalf("content type = %q", recorder.Header().Get("Content-Type"))
	}
	if fake.lastCredentials != (dispatcharr.Credentials{Username: "viewer", Password: "top-secret"}) {
		t.Fatalf("credentials = %#v", fake.lastCredentials)
	}
	if fake.lastCategoryID != "41" {
		t.Fatalf("stream ID = %q", fake.lastCategoryID)
	}
}

func TestLiveStreamRejectsRedirectAndSanitizesUpstreamErrors(t *testing.T) {
	for _, test := range []struct {
		name     string
		err      error
		wantCode string
	}{
		{name: "redirect", err: dispatcharr.ErrRedirect, wantCode: "upstream_redirect_rejected"},
		{name: "credential-bearing error", err: fmt.Errorf("request to http://viewer:top-secret@provider.test failed"), wantCode: "dispatcharr_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			fake := &fakeDispatcharr{
				channels:    []dispatcharr.Channel{{ID: "41", Name: "World News"}},
				streamError: test.err,
			}
			handler := newTestHandler(t, fake, &logs)
			cookie, _ := loginViewer(t, handler)
			request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil)
			request.AddCookie(cookie)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), test.wantCode) {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			combined := recorder.Body.String() + logs.String()
			if strings.Contains(combined, "top-secret") || strings.Contains(combined, "provider.test") {
				t.Fatalf("sensitive upstream detail leaked: %s", combined)
			}
			if recorder.Header().Get("Location") != "" {
				t.Fatalf("redirect location leaked: %q", recorder.Header().Get("Location"))
			}
		})
	}
}

func TestLiveStreamCancellationCancelsUpstream(t *testing.T) {
	opened := make(chan struct{})
	canceled := make(chan struct{})
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}},
		openLiveStream: func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			close(opened)
			<-ctx.Done()
			close(canceled)
			return dispatcharr.LiveStream{}, ctx.Err()
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil).WithContext(ctx)
	request.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	<-opened
	cancel()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("upstream context was not canceled")
	}
	<-done
}

func TestLogoutCancelsActiveLiveStream(t *testing.T) {
	opened := make(chan struct{})
	canceled := make(chan struct{})
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}},
		openLiveStream: func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			close(opened)
			<-ctx.Done()
			close(canceled)
			return dispatcharr.LiveStream{}, ctx.Err()
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, session := loginViewer(t, handler)
	streamRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil)
	streamRequest.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), streamRequest)
		close(done)
	}()
	<-opened

	logoutRequest := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/logout", nil)
	logoutRequest.Host = "now.test"
	logoutRequest.Header.Set("Origin", "http://now.test")
	logoutRequest.Header.Set("X-CSRF-Token", session.CSRFToken)
	logoutRequest.AddCookie(cookie)
	logoutRecorder := httptest.NewRecorder()
	handler.ServeHTTP(logoutRecorder, logoutRequest)
	if logoutRecorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, body = %s", logoutRecorder.Code, logoutRecorder.Body.String())
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("logout did not cancel the upstream stream")
	}
	<-done
}

func TestLogoutDuringPlaybackAuthorizationCannotStartOrphanedStream(t *testing.T) {
	authorizing := make(chan struct{})
	authorizationCanceled := make(chan struct{})
	fake := &fakeDispatcharr{
		liveChannels: func(ctx context.Context, _ dispatcharr.Credentials, _ string) ([]dispatcharr.Channel, error) {
			close(authorizing)
			<-ctx.Done()
			close(authorizationCanceled)
			return nil, ctx.Err()
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, session := loginViewer(t, handler)
	streamRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil)
	streamRequest.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), streamRequest)
		close(done)
	}()
	<-authorizing

	logoutRequest := httptest.NewRequest(http.MethodPost, "http://now.test/api/auth/logout", nil)
	logoutRequest.Host = "now.test"
	logoutRequest.Header.Set("Origin", "http://now.test")
	logoutRequest.Header.Set("X-CSRF-Token", session.CSRFToken)
	logoutRequest.AddCookie(cookie)
	logoutRecorder := httptest.NewRecorder()
	handler.ServeHTTP(logoutRecorder, logoutRequest)
	if logoutRecorder.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", logoutRecorder.Code)
	}
	select {
	case <-authorizationCanceled:
	case <-time.After(time.Second):
		t.Fatal("logout did not cancel playback authorization")
	}
	<-done
	if fake.streamCalls != 0 {
		t.Fatalf("OpenLiveStream calls = %d, want 0", fake.streamCalls)
	}
}

func TestActiveLiveStreamSurvivesIdleAndIdleResumesAfterEnd(t *testing.T) {
	opened := make(chan struct{})
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}},
		openLiveStream: func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			close(opened)
			return dispatcharr.LiveStream{Body: &pacedStreamBody{ctx: ctx}}, nil
		},
	}
	cfg := testConfig(t)
	cfg.SessionIdleTimeout = 75 * time.Millisecond
	cfg.SessionAbsoluteTTL = 2 * time.Second
	handler := New(cfg, fake, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, _ := loginViewer(t, handler)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil).WithContext(ctx)
	request.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("upstream stream did not open before the session deadline")
	}
	time.Sleep(3 * cfg.SessionIdleTimeout)
	sessionRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	sessionRequest.AddCookie(cookie)
	sessionRecorder := httptest.NewRecorder()
	handler.ServeHTTP(sessionRecorder, sessionRequest)
	if sessionRecorder.Code != http.StatusOK {
		t.Fatalf("active session status after idle timeout = %d, body = %s", sessionRecorder.Code, sessionRecorder.Body.String())
	}

	cancel()
	<-done
	time.Sleep(cfg.SessionIdleTimeout + 25*time.Millisecond)
	expiredRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	expiredRequest.AddCookie(cookie)
	expiredRecorder := httptest.NewRecorder()
	handler.ServeHTTP(expiredRecorder, expiredRequest)
	if expiredRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("session status after playback idle timeout = %d, body = %s", expiredRecorder.Code, expiredRecorder.Body.String())
	}
}

func TestAbsoluteSessionDeadlineCancelsActiveLiveStream(t *testing.T) {
	opened := make(chan struct{})
	canceled := make(chan struct{})
	fake := &fakeDispatcharr{
		channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}},
		openLiveStream: func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			close(opened)
			return dispatcharr.LiveStream{Body: &pacedStreamBody{ctx: ctx, canceled: canceled}}, nil
		},
	}
	cfg := testConfig(t)
	cfg.SessionIdleTimeout = 50 * time.Millisecond
	cfg.SessionAbsoluteTTL = 300 * time.Millisecond
	handler := New(cfg, fake, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, _ := loginViewer(t, handler)
	request := httptest.NewRequest(http.MethodGet, "http://now.test/api/live/channels/41/stream", nil)
	request.AddCookie(cookie)
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("upstream stream did not open")
	}
	time.Sleep(3 * cfg.SessionIdleTimeout)
	sessionRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	sessionRequest.AddCookie(cookie)
	sessionRecorder := httptest.NewRecorder()
	handler.ServeHTTP(sessionRecorder, sessionRequest)
	if sessionRecorder.Code != http.StatusOK {
		t.Fatalf("active session expired at idle timeout: status = %d", sessionRecorder.Code)
	}
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("absolute session deadline did not cancel the upstream stream")
	}
	<-done
	expiredRequest := httptest.NewRequest(http.MethodGet, "http://now.test/api/session", nil)
	expiredRequest.AddCookie(cookie)
	expiredRecorder := httptest.NewRecorder()
	handler.ServeHTTP(expiredRecorder, expiredRequest)
	if expiredRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("session survived absolute timeout: status = %d", expiredRecorder.Code)
	}
}
