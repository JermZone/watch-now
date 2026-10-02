package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

type minuteBody struct {
	ctx       context.Context
	remaining int
}

func (b *minuteBody) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		return 0, io.EOF
	}
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-time.After(time.Minute):
		b.remaining--
		return copy(p, "x"), nil
	}
}
func (b *minuteBody) Close() error { return nil }

func TestVLCActiveBytesKeepOwnerUsableForSeekAfter35Minutes(t *testing.T) {
	for _, finish := range []string{"idle", "logout", "hard expiry"} {
		t.Run(finish, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				fake := movieFake()
				minutes := 35
				if finish == "hard expiry" {
					minutes = 361
				}
				fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, _ dispatcharr.MediaKind, _, _, byteRange, _ string) (dispatcharr.MediaStream, error) {
					if byteRange != "" {
						return dispatcharr.MediaStream{Body: io.NopCloser(strings.NewReader("part")), StatusCode: 206, ContentLength: 4, ContentRange: "bytes 0-3/100"}, nil
					}
					return dispatcharr.MediaStream{Body: &minuteBody{ctx: ctx, remaining: minutes}, StatusCode: 200, ContentLength: -1}, nil
				}
				cfg := testConfig(t)
				cfg.SessionIdleTimeout = 30 * time.Minute
				cfg.SessionAbsoluteTTL = 12 * time.Hour
				handler := New(cfg, fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
				cookie, viewer := loginViewer(t, handler)
				created := authenticatedRequest(t, handler, cookie, "POST", "/api/movies/41/vlc", viewer.CSRFToken)
				var payload struct {
					LaunchURL string `json:"launch_url"`
				}
				if json.Unmarshal(created.Body.Bytes(), &payload) != nil || created.Code != 201 {
					t.Fatal("handoff failed")
				}
				launch := httptest.NewRecorder()
				handler.ServeHTTP(launch, httptest.NewRequest("GET", payload.LaunchURL, nil))
				mediaURL := launch.Header().Get("Location")
				first := httptest.NewRecorder()
				start := time.Now()
				handler.ServeHTTP(first, httptest.NewRequest("GET", mediaURL, nil))
				if finish == "hard expiry" {
					if time.Since(start) != 6*time.Hour || first.Body.Len() >= minutes {
						t.Fatal("active relay exceeded hard lifetime")
					}
				} else {
					if time.Since(start) != 35*time.Minute || first.Body.Len() != 35 {
						t.Fatal("active transfer ended early")
					}
					rangeRequest := httptest.NewRequest("GET", mediaURL, nil)
					rangeRequest.Header.Set("Range", "bytes=0-3")
					seek := httptest.NewRecorder()
					handler.ServeHTTP(seek, rangeRequest)
					if seek.Code != 206 || seek.Body.String() != "part" {
						t.Fatalf("seek after 35 minutes: %d", seek.Code)
					}
					if finish == "logout" {
						if authenticatedRequest(t, handler, cookie, "POST", "/api/auth/logout", viewer.CSRFToken).Code != 204 {
							t.Fatal("logout failed")
						}
					} else {
						time.Sleep(31 * time.Minute)
						if authenticatedRequest(t, handler, cookie, "GET", "/api/session", "").Code != http.StatusUnauthorized {
							t.Fatal("stopped transfer permanently extended owner session")
						}
					}
				}
				expired := httptest.NewRecorder()
				handler.ServeHTTP(expired, httptest.NewRequest("GET", mediaURL, nil))
				if expired.Code != 404 {
					t.Fatalf("expired/revoked token status: %d", expired.Code)
				}
			})
		})
	}
}

func TestStalledMediaBodyIsCanceled(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake := movieFake()
		fake.openMedia = func(ctx context.Context, _ dispatcharr.Credentials, _ dispatcharr.MediaKind, _, _, _, _ string) (dispatcharr.MediaStream, error) {
			reader, writer := io.Pipe()
			go func() { <-ctx.Done(); _ = writer.CloseWithError(ctx.Err()) }()
			return dispatcharr.MediaStream{Body: reader, StatusCode: 200, ContentLength: -1}, nil
		}
		cfg := testConfig(t)
		cfg.SessionIdleTimeout = 30 * time.Minute
		cfg.SessionAbsoluteTTL = 12 * time.Hour
		handler := New(cfg, fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
		cookie, _ := loginViewer(t, handler)
		start := time.Now()
		_ = authenticatedRequest(t, handler, cookie, "GET", "/api/movies/41/stream", "")
		if time.Since(start) != 2*time.Minute {
			t.Fatal("stalled relay did not terminate at idle deadline")
		}
	})
}

func TestStalledLiveBodyReleasesPlaybackAndResumesIdleExpiry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "1", Name: "Live"}}}
		fake.openLiveStream = func(ctx context.Context, _ dispatcharr.Credentials, _ string) (dispatcharr.LiveStream, error) {
			reader, writer := io.Pipe()
			go func() { <-ctx.Done(); _ = writer.CloseWithError(ctx.Err()) }()
			return dispatcharr.LiveStream{Body: reader}, nil
		}
		cfg := testConfig(t)
		cfg.SessionIdleTimeout = 30 * time.Minute
		handler := New(cfg, fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
		cookie, _ := loginViewer(t, handler)
		start := time.Now()
		_ = authenticatedRequest(t, handler, cookie, "GET", "/api/live/channels/1/stream", "")
		if time.Since(start) != 2*time.Minute {
			t.Fatal("stalled Live relay survived idle deadline")
		}
		time.Sleep(31 * time.Minute)
		if response := authenticatedRequest(t, handler, cookie, "GET", "/api/session", ""); response.Code != 401 {
			t.Fatal("stalled playback kept session active")
		}
	})
}
