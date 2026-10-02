package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestItemActionsUseCurrentXCEligibilityWithoutWholeCatalog(t *testing.T) {
	var revoked atomic.Bool
	var catalogs, protected atomic.Int32
	// A realistic response-size failure in the global catalog must not affect
	// item actions. This is synthetic data, never a live provider response.
	oversized := `[{"stream_id":41,"name":"` + strings.Repeat("x", 33*1024*1024) + `"}]`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/player_api.php" {
			protected.Add(1)
			_, _ = w.Write([]byte("media"))
			return
		}
		switch q.Get("action") {
		case "":
			_ = json.NewEncoder(w).Encode(map[string]any{"user_info": map[string]any{"auth": 1, "username": q.Get("username")}})
		case "get_vod_streams", "get_series":
			catalogs.Add(1)
			_, _ = io.WriteString(w, oversized)
		case "get_vod_categories", "get_series_categories":
			_, _ = io.WriteString(w, `[{"category_id":9,"category_name":"Films"}]`)
		case "get_vod_info", "get_series_info":
			if revoked.Load() || q.Get("username") != "viewer" {
				w.WriteHeader(404)
				return
			}
			if q.Get("action") == "get_vod_info" {
				_, _ = io.WriteString(w, `{"movie_data":{"stream_id":41,"name":"Movie","container_extension":"mp4"},"info":{"movie_image":"/api/vod/movies/41/image"}}`)
			} else {
				_, _ = io.WriteString(w, `{"info":{"name":"Show","series_id":51,"cover":"/api/vod/series/51/image"},"episodes":{"1":[{"id":971,"title":"Show - S01E01 - Pilot","episode_num":1,"container_extension":"mp4"}]}}`)
			}
		default:
			t.Error("unexpected XC action")
			w.WriteHeader(400)
		}
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(base, upstream.Client(), 32*1024*1024, 1024)
	cfg := testConfig(t)
	cfg.CategoryCacheTTL = time.Nanosecond
	cfg.CatalogCacheTTL = time.Nanosecond
	handler := New(cfg, client, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	other, otherViewer := loginViewerAs(t, handler, "restricted", "different", "192.0.2.7:1234")
	for _, target := range []string{"/api/movies/categories", "/api/series/categories"} {
		_ = authenticatedRequest(t, handler, cookie, "GET", target, "")
	}
	// Prove the oversized catalog actually exceeds the configured decoder cap.
	if response := authenticatedRequest(t, handler, cookie, "GET", "/api/movies", ""); response.Code != 502 {
		t.Fatalf("oversized catalog status = %d", response.Code)
	}
	for _, item := range []struct{ target, method string }{
		{"/api/movies/41", "GET"}, {"/api/series/51", "GET"},
		{"/api/movies/41/stream", "GET"}, {"/api/movies/41/download", "GET"},
		{"/api/series/51/episodes/971/stream", "GET"}, {"/api/series/51/episodes/971/download", "GET"},
		{"/api/movies/41/vlc", "POST"}, {"/api/series/51/episodes/971/vlc", "POST"},
	} {
		response := authenticatedRequest(t, handler, cookie, item.method, item.target, viewer.CSRFToken)
		if response.Code != 200 && response.Code != 201 {
			t.Fatalf("authorized %s = %d", item.target, response.Code)
		}
		if denied := authenticatedRequest(t, handler, other, item.method, item.target, otherViewer.CSRFToken); denied.Code != 404 {
			t.Fatalf("restricted %s = %d", item.target, denied.Code)
		}
	}
	if catalogs.Load() != 1 {
		t.Fatal("item actions fetched the global catalog")
	}
	before := protected.Load()
	revoked.Store(true)
	for _, target := range []string{"/api/movies/41", "/api/series/51", "/api/movies/41/download", "/api/series/51/episodes/971/stream"} {
		if response := authenticatedRequest(t, handler, cookie, "GET", target, ""); response.Code != 404 {
			t.Fatalf("revoked %s = %d", target, response.Code)
		}
	}
	if catalogs.Load() != 1 || protected.Load() != before {
		t.Fatal("stale authorization reached a catalog, image or media endpoint")
	}
}
