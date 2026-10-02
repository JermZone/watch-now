package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/JermZone/watch-now/internal/dispatcharr"
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
)

func TestProgramSearchRealXCIsolationRevocationAndCaching(t *testing.T) {
	var revoked atomic.Bool
	var feeds atomic.Int32
	now := time.Now().UTC()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		if r.URL.Path == "/xmltv.php" {
			feeds.Add(1)
			if r.URL.Query().Get("days") != "1" || r.URL.Query().Get("prev_days") != "0" || r.URL.Query().Get("tvg_id_source") != "channel_number" {
				t.Error("unbounded guide query")
			}
			name, key := "News", "7"
			if username == "restricted" {
				name, key = "Sports", "8"
			}
			fmt.Fprintf(w, `<tv><channel id="%s"><display-name>%s</display-name></channel><programme channel="%s" start="%s" stop="%s"><title>Shared Search</title><desc>management-only</desc></programme></tv>`, key, name, key, now.Add(-time.Hour).Format("20060102150405 -0700"), now.Add(time.Hour).Format("20060102150405 -0700"))
			return
		}
		if r.URL.Path != "/player_api.php" {
			t.Error("unsupported upstream interface")
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("action") == "" {
			io.WriteString(w, `{"user_info":{"auth":1,"username":"viewer"}}`)
			return
		}
		if r.URL.Query().Get("action") != "get_live_streams" {
			t.Error("per-channel EPG fan-out")
			http.NotFound(w, r)
			return
		}
		if revoked.Load() && username == "viewer" {
			io.WriteString(w, `[]`)
			return
		}
		id, name, key := "41", "News", "7"
		if username == "restricted" {
			id, name, key = "42", "Sports", "8"
		}
		fmt.Fprintf(w, `[{"stream_id":"%s","name":"%s","num":%s,"epg_channel_id":"%s","category_id":"2"}]`, id, name, key, key)
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(base, upstream.Client(), 32<<20, 2<<20)
	cfg := testConfig(t)
	cfg.ProgramSearchEnabled = true
	handler := New(cfg, client, slog.New(slog.NewTextHandler(io.Discard, nil)))
	first, _ := loginViewer(t, handler)
	second, _ := loginViewerAs(t, handler, "restricted", "different", "192.0.2.8:1234")
	for _, item := range []struct {
		cookie *http.Cookie
		id     string
	}{{first, "41"}, {second, "42"}} {
		for range 2 {
			response := authenticatedRequest(t, handler, item.cookie, "GET", "/api/live/programs/search?search=shared&status=now", "")
			if response.Code != 200 {
				t.Fatalf("search failed: %d", response.Code)
			}
			var page catalogPage[programSearchResult]
			if json.Unmarshal(response.Body.Bytes(), &page) != nil || len(page.Items) != 1 || page.Items[0].Channel.ID != item.id {
				t.Fatal("viewer guide isolation failed")
			}
			if strings.Contains(response.Body.String(), "management-only") || strings.Contains(response.Body.String(), "epg_channel_id") {
				t.Fatal("wide upstream fields exposed")
			}
		}
	}
	for _, path := range []string{"/api/live/programs/search?search=", "/api/live/programs/search?search=shared&status=later", "/api/live/programs/search?search=shared&page=bad"} {
		response := authenticatedRequest(t, handler, first, "GET", path, "")
		if response.Code != 400 {
			t.Fatal("invalid search query accepted")
		}
	}
	responseUpcoming := authenticatedRequest(t, handler, first, "GET", "/api/live/programs/search?search=shared&status=upcoming", "")
	var upcomingPage catalogPage[programSearchResult]
	json.Unmarshal(responseUpcoming.Body.Bytes(), &upcomingPage)
	if responseUpcoming.Code != 200 || upcomingPage.Total != 0 {
		t.Fatal("current show returned as upcoming")
	}
	responseCategory := authenticatedRequest(t, handler, first, "GET", "/api/live/programs/search?search=shared&category_id=9", "")
	var categoryPage catalogPage[programSearchResult]
	json.Unmarshal(responseCategory.Body.Bytes(), &categoryPage)
	if responseCategory.Code != 200 || categoryPage.Total != 0 {
		t.Fatal("search escaped selected category")
	}
	if feeds.Load() != 2 {
		t.Fatal("guide was not cached per viewer")
	}
	revoked.Store(true)
	response := authenticatedRequest(t, handler, first, "GET", "/api/live/programs/search?search=shared&status=now", "")
	var page catalogPage[programSearchResult]
	json.Unmarshal(response.Body.Bytes(), &page)
	if response.Code != 200 || page.Total != 0 || len(page.Items) != 0 {
		t.Fatal("warm guide bypassed channel revocation")
	}
}
func TestProgramSearchOptInAndInputValidation(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{}, io.Discard)
	cookie, _ := loginViewer(t, handler)
	response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/search/capabilities", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"program_search":false`) {
		t.Fatal("search enabled without opt-in capability")
	}
	response = authenticatedRequest(t, handler, cookie, "GET", "/api/live/programs/search?search=news", "")
	if response.Code != 503 {
		t.Fatal("disabled search fetched a guide")
	}
	request := httptest.NewRequest("GET", "/api/live/programs/search?search=news", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != 401 {
		t.Fatal("anonymous program search allowed")
	}
}

type guideStub struct {
	*fakeDispatcharr
	calls atomic.Int32
	fetch func(context.Context) (dispatcharr.GuideIndex, error)
}

func (g *guideStub) LiveGuide(ctx context.Context, _ dispatcharr.Credentials, _ []dispatcharr.Channel) (dispatcharr.GuideIndex, error) {
	g.calls.Add(1)
	return g.fetch(ctx)
}
func newGuideTestHandler(t *testing.T, g *guideStub) http.Handler {
	cfg := testConfig(t)
	cfg.ProgramSearchEnabled = true
	return New(cfg, g, slog.New(slog.NewTextHandler(io.Discard, nil)))
}
func TestGuideFailureCooldownAndFillConcurrency(t *testing.T) {
	g := &guideStub{fakeDispatcharr: &fakeDispatcharr{}, fetch: func(context.Context) (dispatcharr.GuideIndex, error) {
		return dispatcharr.GuideIndex{}, dispatcharr.ErrGuideLimit
	}}
	handler := newGuideTestHandler(t, g)
	cookie, _ := loginViewer(t, handler)
	for range 3 {
		if response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/programs/search?search=news", ""); response.Code != 503 {
			t.Fatal("oversized guide reported usable results")
		}
	}
	if g.calls.Load() != 1 {
		t.Fatal("failed guide was retried on each query")
	}
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	g = &guideStub{fakeDispatcharr: &fakeDispatcharr{}, fetch: func(ctx context.Context) (dispatcharr.GuideIndex, error) {
		started <- struct{}{}
		select {
		case <-release:
			return dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{}}, nil
		case <-ctx.Done():
			return dispatcharr.GuideIndex{}, ctx.Err()
		}
	}}
	handler = newGuideTestHandler(t, g)
	first, _ := loginViewer(t, handler)
	second, _ := loginViewerAs(t, handler, "second", "test", "192.0.2.8:1234")
	third, _ := loginViewerAs(t, handler, "third", "test", "192.0.2.9:1234")
	var wg sync.WaitGroup
	for _, cookie := range []*http.Cookie{first, second} {
		wg.Go(func() {
			if response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/programs/search?search=news", ""); response.Code != 200 {
				t.Error("permitted fill failed")
			}
		})
		<-started
	}
	if response := authenticatedRequest(t, handler, third, "GET", "/api/live/programs/search?search=news", ""); response.Code != 503 {
		t.Fatal("unbounded concurrent guide fills")
	}
	if g.calls.Load() != 2 {
		t.Fatal("extra guide transfer started beyond concurrency budget")
	}
	close(release)
	wg.Wait()
	if response := authenticatedRequest(t, handler, third, "GET", "/api/live/programs/search?search=news", ""); response.Code != 200 {
		t.Fatal("overload incorrectly prevented retry")
	}
}
func TestLogoutDuringGuideFillCannotRestoreViewerData(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	g := &guideStub{fakeDispatcharr: &fakeDispatcharr{}, fetch: func(context.Context) (dispatcharr.GuideIndex, error) {
		close(started)
		<-release
		return dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{}}, nil
	}}
	handler := newGuideTestHandler(t, g)
	cookie, viewer := loginViewer(t, handler)
	done := make(chan int, 1)
	go func() {
		done <- authenticatedRequest(t, handler, cookie, "GET", "/api/live/programs/search?search=news", "").Code
	}()
	<-started
	request := httptest.NewRequest("POST", "http://now.test/api/auth/logout", nil)
	request.AddCookie(cookie)
	request.Header.Set("Origin", "http://now.test")
	request.Header.Set("X-CSRF-Token", viewer.CSRFToken)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != 204 {
		t.Fatal("logout failed")
	}
	close(release)
	if status := <-done; status != 401 {
		t.Fatal("completed guide fill returned after logout")
	}
	if response := authenticatedRequest(t, handler, cookie, "GET", "/api/live/programs/search?search=news", ""); response.Code != 401 {
		t.Fatal("revoked session searched cached guide")
	}
}
