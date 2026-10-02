package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func liveVLCFake() *fakeDispatcharr {
	return &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "World News"}}}
}

func createLiveHandoff(t *testing.T, handler http.Handler, cookie *http.Cookie, csrf string) (string, string) {
	t.Helper()
	created := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/live/channels/41/vlc", csrf)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var payload struct {
		LaunchURL string `json:"launch_url"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(payload.LaunchURL, "/api/vlc/launch/") || !strings.HasSuffix(payload.LaunchURL, "/World-News.ts") || strings.Contains(created.Body.String(), "top-secret") {
		t.Fatal("handoff did not use a titled, opaque Now URL")
	}
	launch := httptest.NewRecorder()
	handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, payload.LaunchURL, nil))
	if launch.Code != http.StatusFound {
		t.Fatalf("launch status = %d", launch.Code)
	}
	return payload.LaunchURL, launch.Header().Get("Location")
}

func TestLiveVLCRequiresSessionOriginCSRFAndCurrentChannelAccess(t *testing.T) {
	fake := liveVLCFake()
	handler := newTestHandler(t, fake, io.Discard)
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodPost, "/api/live/channels/41/vlc", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d", unauthenticated.Code)
	}
	cookie, viewer := loginViewer(t, handler)
	for _, csrf := range []string{"", "wrong-csrf"} {
		response := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/live/channels/41/vlc", csrf)
		if response.Code != http.StatusForbidden {
			t.Fatalf("invalid CSRF = %d", response.Code)
		}
	}
	wrongOrigin := httptest.NewRequest(http.MethodPost, "/api/live/channels/41/vlc", nil)
	wrongOrigin.AddCookie(cookie)
	wrongOrigin.Header.Set("X-CSRF-Token", viewer.CSRFToken)
	wrongOrigin.Header.Set("Origin", "https://untrusted.test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, wrongOrigin)
	if response.Code != http.StatusForbidden {
		t.Fatalf("invalid origin = %d", response.Code)
	}
	// Warm browsing data, then remove the channel: the handoff must fetch the
	// current viewer lineup rather than trusting that cached listing.
	authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/live/channels", "")
	fake.mu.Lock()
	fake.channels = nil
	fake.mu.Unlock()
	response = authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/live/channels/41/vlc", viewer.CSRFToken)
	if response.Code != http.StatusNotFound || fake.streamCalls != 0 {
		t.Fatalf("removed channel = %d, stream calls = %d", response.Code, fake.streamCalls)
	}
}

func TestLiveVLCRelaysWithoutBrowserCookiesAndDoesNotInventSeeking(t *testing.T) {
	fake := liveVLCFake()
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	_, mediaURL := createLiveHandoff(t, handler, cookie, viewer.CSRFToken)
	if fake.streamCalls != 0 {
		t.Fatal("creating or redeeming a handoff opened an upstream stream")
	}
	request := httptest.NewRequest(http.MethodGet, mediaURL, nil)
	request.Header.Set("Range", "bytes=0-")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "mpeg-ts-data" || !response.Flushed {
		t.Fatalf("relay = %d, body %q, flushed %v", response.Code, response.Body.String(), response.Flushed)
	}
	if response.Header().Get("Content-Type") != "video/mp2t" || response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("relay headers = %#v", response.Header())
	}
	for _, header := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"} {
		if response.Header().Get(header) != "" {
			t.Fatalf("unexpected live header %s", header)
		}
	}
	if fake.streamCalls != 1 || fake.mediaCalls != 0 || fake.lastCredentials.Username != "viewer" || fake.lastCredentials.Password != "top-secret" || fake.lastCategoryID != "41" {
		t.Fatal("live relay did not use the authorized server-side XC channel")
	}
	wrongName := httptest.NewRecorder()
	handler.ServeHTTP(wrongName, httptest.NewRequest(http.MethodGet, strings.TrimSuffix(mediaURL, "World-News.ts")+"Other.ts", nil))
	if wrongName.Code != http.StatusNotFound || fake.streamCalls != 1 {
		t.Fatal("incorrect filename opened a stream")
	}
	invalid := httptest.NewRecorder()
	handler.ServeHTTP(invalid, httptest.NewRequest(http.MethodGet, "/api/vlc/media/invalid", nil))
	if invalid.Code != http.StatusNotFound {
		t.Fatalf("invalid media token = %d", invalid.Code)
	}
}

func TestLiveVLCRechecksAccessAndRevokesOnLogout(t *testing.T) {
	for _, scenario := range []string{"removed", "credentials revoked", "logout"} {
		t.Run(scenario, func(t *testing.T) {
			fake := liveVLCFake()
			handler := newTestHandler(t, fake, io.Discard)
			cookie, viewer := loginViewer(t, handler)
			launchURL, mediaURL := createLiveHandoff(t, handler, cookie, viewer.CSRFToken)
			switch scenario {
			case "removed":
				fake.channels = nil
			case "credentials revoked":
				fake.liveChannels = func(context.Context, dispatcharr.Credentials, string) ([]dispatcharr.Channel, error) {
					return nil, dispatcharr.ErrUnauthorized
				}
			case "logout":
				authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/auth/logout", viewer.CSRFToken)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, mediaURL, nil))
			if response.Code != http.StatusNotFound || fake.streamCalls != 0 {
				t.Fatalf("revoked relay = %d, stream calls = %d", response.Code, fake.streamCalls)
			}
			launch := httptest.NewRecorder()
			handler.ServeHTTP(launch, httptest.NewRequest(http.MethodGet, launchURL, nil))
			if launch.Code != http.StatusNotFound {
				t.Fatalf("revoked launch = %d", launch.Code)
			}
		})
	}
}

func TestLiveVLCRetainsHandoffAfterTemporaryLineupFailure(t *testing.T) {
	fake := liveVLCFake()
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	_, mediaURL := createLiveHandoff(t, handler, cookie, viewer.CSRFToken)
	fake.liveChannels = func(context.Context, dispatcharr.Credentials, string) ([]dispatcharr.Channel, error) {
		return nil, dispatcharr.ErrUnavailable
	}
	failed := httptest.NewRecorder()
	handler.ServeHTTP(failed, httptest.NewRequest(http.MethodGet, mediaURL, nil))
	if failed.Code != http.StatusServiceUnavailable || fake.streamCalls != 0 {
		t.Fatalf("temporary failure = %d", failed.Code)
	}
	fake.liveChannels = nil
	retry := httptest.NewRecorder()
	handler.ServeHTTP(retry, httptest.NewRequest(http.MethodGet, mediaURL, nil))
	if retry.Code != http.StatusOK {
		t.Fatalf("recovery = %d", retry.Code)
	}
}

func TestLiveVLCStopsBrowserRelayAndLogoutStopsExternalRelay(t *testing.T) {
	fake := liveVLCFake()
	browserStarted, browserCanceled, browserDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	vlcStarted, vlcCanceled, vlcDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	fake.openLiveStream = func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
		if calls.Add(1) == 1 {
			close(browserStarted)
			return dispatcharr.LiveStream{Body: &pacedStreamBody{ctx: ctx, canceled: browserCanceled}}, nil
		}
		close(vlcStarted)
		return dispatcharr.LiveStream{Body: &pacedStreamBody{ctx: ctx, canceled: vlcCanceled}}, nil
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, viewer := loginViewer(t, handler)
	_, mediaURL := createLiveHandoff(t, handler, cookie, viewer.CSRFToken)
	browserRequest := httptest.NewRequest(http.MethodGet, "/api/live/channels/41/stream", nil)
	browserRequest.AddCookie(cookie)
	go func() {
		defer close(browserDone)
		handler.ServeHTTP(httptest.NewRecorder(), browserRequest)
	}()
	awaitSignal(t, browserStarted, "browser relay start")
	go func() {
		defer close(vlcDone)
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, mediaURL, nil))
	}()
	awaitSignal(t, vlcStarted, "VLC relay start")
	awaitSignal(t, browserCanceled, "browser relay cancellation")
	awaitSignal(t, browserDone, "browser relay completion")
	logout := authenticatedRequest(t, handler, cookie, http.MethodPost, "/api/auth/logout", viewer.CSRFToken)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout = %d", logout.Code)
	}
	awaitSignal(t, vlcCanceled, "VLC relay cancellation")
	awaitSignal(t, vlcDone, "VLC relay completion")
}

func TestLiveVLCRejectsUpstreamRedirectAndRevokedCredentials(t *testing.T) {
	for _, upstreamErr := range []error{dispatcharr.ErrRedirect, dispatcharr.ErrUnauthorized} {
		t.Run(upstreamErr.Error(), func(t *testing.T) {
			fake := liveVLCFake()
			fake.streamError = upstreamErr
			handler := newTestHandler(t, fake, io.Discard)
			cookie, viewer := loginViewer(t, handler)
			_, mediaURL := createLiveHandoff(t, handler, cookie, viewer.CSRFToken)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, mediaURL, nil))
			want := http.StatusBadGateway
			if errors.Is(upstreamErr, dispatcharr.ErrUnauthorized) {
				want = http.StatusNotFound
			}
			if response.Code != want {
				t.Fatalf("upstream rejection = %d, want %d", response.Code, want)
			}
		})
	}
}
