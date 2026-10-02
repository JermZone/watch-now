package httpapi

import (
	"context"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestLiveProtectedActionsRevalidateProfilesDespiteWarmCaches(t *testing.T) {
	allowed := true
	fake := &fakeDispatcharr{
		programs: []dispatcharr.Program{{Title: "Shared EPG", Start: time.Now().Add(-time.Minute), End: time.Now().Add(time.Hour)}},
		liveChannels: func(_ context.Context, credentials dispatcharr.Credentials, _ string) ([]dispatcharr.Channel, error) {
			if credentials.Username == "viewer" && allowed {
				return []dispatcharr.Channel{{ID: "1", Name: "First"}}, nil
			}
			return []dispatcharr.Channel{{ID: "2", Name: "Restricted lineup"}}, nil
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	first, _ := loginViewer(t, handler)
	second, _ := loginViewerAs(t, handler, "restricted", "different", "192.0.2.8:1234")
	for _, item := range []struct {
		cookie *http.Cookie
		id     string
	}{{first, "1"}, {second, "2"}} {
		_ = authenticatedRequest(t, handler, item.cookie, "GET", "/api/live/channels", "")
		if response := authenticatedRequest(t, handler, item.cookie, "GET", "/api/live/channels/"+item.id+"/epg", ""); response.Code != 200 {
			t.Fatal("eligible shared guide unavailable")
		}
	}
	if response := authenticatedRequest(t, handler, second, "GET", "/api/live/channels/1/epg", ""); response.Code != 404 {
		t.Fatal("shared EPG bypassed viewer channel eligibility")
	}
	allowed = false
	for _, action := range []string{"epg", "stream", "artwork"} {
		if response := authenticatedRequest(t, handler, first, "GET", "/api/live/channels/1/"+action, ""); response.Code != 404 {
			t.Fatalf("stale cache authorized %s", action)
		}
	}
	if fake.epgCalls != 2 || fake.streamCalls != 0 || fake.artworkCalls != 0 {
		t.Fatal("revoked channel reached guide, image or playback upstream")
	}
}

func TestLiveArtworkRevalidatesBeforeUsingCachedBytes(t *testing.T) {
	allowed := true
	fake := &fakeDispatcharr{
		artwork: dispatcharr.Artwork{ContentType: "image/png", Data: []byte("image")},
		liveChannels: func(_ context.Context, _ dispatcharr.Credentials, _ string) ([]dispatcharr.Channel, error) {
			if allowed {
				return []dispatcharr.Channel{{ID: "1", Name: "First", HasArtwork: true}}, nil
			}
			return nil, nil
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)
	for range 2 {
		response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/channels/1/artwork", "")
		if response.Code != 200 || response.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("eligible artwork response: %d %q", response.Code, response.Header().Get("Cache-Control"))
		}
	}
	if fake.artworkCalls != 1 {
		t.Fatal("eligible artwork bytes were not cached")
	}
	allowed = false
	response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/channels/1/artwork", "")
	if response.Code != 404 || fake.artworkCalls != 1 {
		t.Fatal("cached artwork bypassed current channel eligibility")
	}
}

func TestConcurrentLiveActionsShareOnlyInFlightEligibility(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var allowed atomic.Bool
		allowed.Store(true)
		var calls atomic.Int32
		fake := &fakeDispatcharr{
			liveChannels: func(ctx context.Context, _ dispatcharr.Credentials, _ string) ([]dispatcharr.Channel, error) {
				calls.Add(1)
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(time.Second):
				}
				if allowed.Load() {
					return []dispatcharr.Channel{{ID: "1", Name: "First"}}, nil
				}
				return nil, nil
			},
		}
		handler := newTestHandler(t, fake, io.Discard)
		cookie, _ := loginViewer(t, handler)
		var wg sync.WaitGroup
		for range 32 {
			wg.Go(func() {
				response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/channels/1/epg", "")
				if response.Code != 200 {
					t.Errorf("eligible guide status: %d", response.Code)
				}
			})
		}
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("overlapping eligibility checks were not shared")
		}
		time.Sleep(time.Second)
		wg.Wait()
		allowed.Store(false)
		response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/channels/1/epg", "")
		if response.Code != 404 || calls.Load() != 2 {
			t.Fatal("completed eligibility reused after revocation")
		}
	})
}
