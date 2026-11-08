package httpapi

import (
	"context"
	"github.com/JermZone/watch-now/internal/dispatcharr"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/JermZone/watch-now/internal/cache"
	"github.com/JermZone/watch-now/internal/session"
)

func TestMetadataAdmissionBoundsWholeHandler(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := &Server{metadataRequests: make(chan struct{}, 4)}
		release := make(chan struct{})
		h := s.boundMetadata(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release; w.WriteHeader(200) }))
		var wg sync.WaitGroup
		for range 4 {
			wg.Go(func() { h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil)) })
		}
		synctest.Wait()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		if w.Code != 503 || w.Header().Get("Retry-After") == "" {
			t.Fatal("capacity did not reject promptly")
		}
		close(release)
		wg.Wait()
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		if w.Code != 200 {
			t.Fatal("capacity leaked")
		}
	})
}
func TestUnknownCookieDoesNotRevokeSharedState(t *testing.T) {
	s := &Server{sessions: session.NewStore(time.Hour, time.Hour, 10), cache: cache.New(10, 1000)}
	s.cache.Set("attacker:catalog", true, 1, time.Hour)
	r := httptest.NewRequest("GET", "/api/session", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "attacker"})
	w := httptest.NewRecorder()
	s.requireSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unknown token authenticated") })).ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if _, ok := s.cache.Get("attacker:catalog"); !ok {
		t.Fatal("anonymous token triggered shared cleanup")
	}
}
func TestItemLookupWaitersAreBounded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var group itemLookups
		var wg sync.WaitGroup
		release := make(chan struct{})
		wg.Go(func() { group.do(context.Background(), "same", func() (any, error) { <-release; return true, nil }) })
		synctest.Wait()
		for range 32 {
			wg.Go(func() {
				group.do(context.Background(), "same", func() (any, error) { t.Error("duplicate fetch"); return nil, nil })
			})
		}
		synctest.Wait()
		if _, err := group.do(context.Background(), "same", func() (any, error) { return nil, nil }); err == nil {
			t.Fatal("unbounded waiter")
		}
		close(release)
		wg.Wait()
		if group.waiters != 0 {
			t.Fatal("waiters leaked")
		}
	})
}

func TestGuideAndSearchShareCatalogAdmission(t *testing.T) {
	s := &Server{sessions: session.NewStore(time.Hour, time.Hour, 10), static: http.NotFoundHandler()}
	entry, err := s.sessions.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	handler := s.routes()
	for range cap(s.metadataRequests) {
		s.metadataRequests <- struct{}{}
	}
	for _, path := range []string{"/api/live/guide", "/api/live/programs/search"} {
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: entry.ID})
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 503 || !strings.Contains(w.Body.String(), `"metadata_busy"`) {
			t.Errorf("%s bypassed admission", path)
		}
	}
}
