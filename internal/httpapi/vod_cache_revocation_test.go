package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestVODWarmCachesCannotAuthorizeDetailsPostersOrRemovedEpisodes(t *testing.T) {
	var revoked, removed atomic.Bool
	var movieDetails, seriesDetails, images, scopedMovieLists, scopedSeriesLists atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/player_api.php" {
			images.Add(1)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\n"))
			return
		}
		q := r.URL.Query()
		switch q.Get("action") {
		case "":
			_ = json.NewEncoder(w).Encode(map[string]any{"user_info": map[string]any{"auth": 1, "username": q.Get("username")}})
		case "get_vod_streams", "get_series":
			if q.Get("action") == "get_vod_streams" && q.Get("category_id") == "9" {
				scopedMovieLists.Add(1)
			}
			if q.Get("action") == "get_series" && q.Get("category_id") == "8" {
				scopedSeriesLists.Add(1)
			}
			if revoked.Load() || q.Get("username") != "viewer" {
				_, _ = io.WriteString(w, `[]`)
				return
			}
			if q.Get("action") == "get_vod_streams" {
				_, _ = io.WriteString(w, `[{"stream_id":41,"name":"Movie","category_id":9,"stream_icon":"/api/vod/movies/41/image"}]`)
			} else {
				_, _ = io.WriteString(w, `[{"series_id":51,"name":"Show","category_id":8,"cover":"/api/vod/series/51/image"}]`)
			}
		case "get_vod_info", "get_series_info":
			if revoked.Load() || q.Get("username") != "viewer" {
				w.WriteHeader(404)
				return
			}
			if q.Get("action") == "get_vod_info" {
				movieDetails.Add(1)
				_, _ = io.WriteString(w, `{"movie_data":{"stream_id":41,"name":"Movie","container_extension":"mp4"},"info":{"movie_image":"/api/vod/movies/41/image"}}`)
			} else {
				seriesDetails.Add(1)
				episodes := []any{map[string]any{"id": 971, "title": "Pilot", "episode_num": 1, "container_extension": "mp4"}}
				if !removed.Load() {
					episodes = append(episodes, map[string]any{"id": 972, "title": "Removed episode", "episode_num": 2, "container_extension": "mp4"})
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"info": map[string]any{"name": "Show", "cover": "/api/vod/series/51/image"}, "episodes": map[string]any{"1": episodes}})
			}
		default:
			t.Error("unexpected XC action")
			w.WriteHeader(400)
		}
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(base, upstream.Client(), 1024*1024, 1024)
	handler := New(testConfig(t), client, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	for _, target := range []string{"/api/movies", "/api/series", "/api/movies/41", "/api/series/51"} {
		if response := authenticatedRequest(t, handler, cookie, "GET", target, ""); response.Code != 200 {
			t.Fatalf("warmup %s: %d", target, response.Code)
		}
	}
	for range 2 {
		for _, target := range []string{"/api/movies/41/artwork", "/api/series/51/artwork"} {
			response := authenticatedRequest(t, handler, cookie, "GET", target, "")
			if response.Code != 200 || response.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("poster %s: %d", target, response.Code)
			}
		}
	}
	if movieDetails.Load() != 1 || seriesDetails.Load() != 1 || images.Load() != 2 || scopedMovieLists.Load() != 2 || scopedSeriesLists.Load() != 2 {
		t.Fatal("poster checks must use scoped current lists, reuse image bytes, and make no detail requests")
	}
	removed.Store(true)
	updated := authenticatedRequest(t, handler, cookie, "GET", "/api/series/51", "")
	if updated.Code != 200 || strings.Contains(updated.Body.String(), "Removed episode") || !strings.Contains(updated.Body.String(), "Pilot") {
		t.Fatal("removed episode survived the detail cache")
	}
	missing := authenticatedRequest(t, handler, cookie, "GET", "/api/series/51/episodes/972/stream", "")
	if missing.Code != 404 || images.Load() != 2 {
		t.Fatal("removed episode reached upstream media")
	}
	revoked.Store(true)
	beforeMovie, beforeSeries, beforeImages := movieDetails.Load(), seriesDetails.Load(), images.Load()
	for _, target := range []string{"/api/movies/41/artwork", "/api/series/51/artwork", "/api/movies/41", "/api/series/51", "/api/movies/41/download", "/api/series/51/episodes/971/stream"} {
		if response := authenticatedRequest(t, handler, cookie, "GET", target, ""); response.Code != 404 {
			t.Fatalf("warm revoked %s: %d", target, response.Code)
		}
	}
	for _, target := range []string{"/api/movies/41/vlc", "/api/series/51/episodes/971/vlc"} {
		if response := authenticatedRequest(t, handler, cookie, "POST", target, viewer.CSRFToken); response.Code != 404 {
			t.Fatalf("revoked handoff %s: %d", target, response.Code)
		}
	}
	if movieDetails.Load() != beforeMovie || seriesDetails.Load() != beforeSeries || images.Load() != beforeImages {
		t.Fatal("revoked requests fetched protected content")
	}
}

// A page's overlapping posters share the category fetch, but later requests
// must observe a changed permission instead of reusing the previous result.
type posterLookupFake struct {
	*fakeDispatcharr
	calls   atomic.Int32
	revoked atomic.Bool
}

func (f *posterLookupFake) Movies(_ context.Context, _ dispatcharr.Credentials, _ string) ([]dispatcharr.Movie, error) {
	f.calls.Add(1)
	time.Sleep(time.Second)
	if f.revoked.Load() {
		return nil, nil
	}
	return f.movies, nil
}
func TestPosterEligibilitySharesOnlyOverlappingCategoryRequests(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fake := &posterLookupFake{fakeDispatcharr: &fakeDispatcharr{
			movies:       []dispatcharr.Movie{dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Film", CategoryID: "9"}, "http://dispatcharr.test:9191/api/vod/movies/41/image", "mp4")},
			mediaArtwork: dispatcharr.Artwork{ContentType: "image/png", Data: []byte("png")},
		}}
		handler := New(testConfig(t), fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
		cookie, _ := loginViewer(t, handler)
		if response := authenticatedRequest(t, handler, cookie, "GET", "/api/movies", ""); response.Code != 200 {
			t.Fatal("list warmup failed")
		}
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				if response := authenticatedRequest(t, handler, cookie, "GET", "/api/movies/41/artwork", ""); response.Code != 200 {
					t.Errorf("poster status %d", response.Code)
				}
			})
		}
		wg.Wait()
		if fake.calls.Load() != 2 {
			t.Fatalf("8 overlapping posters made %d category requests after one list warmup", fake.calls.Load()-1)
		}
		fake.revoked.Store(true)
		for range 2 {
			if response := authenticatedRequest(t, handler, cookie, "GET", "/api/movies/41/artwork", ""); response.Code != 404 {
				t.Fatal("completed category lookup authorized a revoked poster")
			}
		}
		if fake.calls.Load() != 4 || fake.movieDetailCalls != 0 {
			t.Fatal("poster checks reused authorization or fetched details")
		}
	})
}

type logoutVODFake struct {
	*fakeDispatcharr
	artwork bool
	started chan struct{}
	release chan struct{}
}

func (f *logoutVODFake) Movies(ctx context.Context, c dispatcharr.Credentials, category string) ([]dispatcharr.Movie, error) {
	if f.artwork {
		close(f.started)
		<-f.release
	}
	return f.fakeDispatcharr.Movies(ctx, c, category)
}
func (f *logoutVODFake) MovieDetails(ctx context.Context, c dispatcharr.Credentials, id string) (dispatcharr.MovieDetail, error) {
	if !f.artwork {
		close(f.started)
		<-f.release
	}
	return f.fakeDispatcharr.MovieDetails(ctx, c, id)
}
func TestVODChecksCannotReturnContentAfterLogoutDuringLookup(t *testing.T) {
	for _, artwork := range []bool{false, true} {
		name := "details"
		if artwork {
			name = "artwork"
		}
		t.Run(name, func(t *testing.T) {
			fake := &logoutVODFake{fakeDispatcharr: movieFake(), artwork: artwork, started: make(chan struct{}), release: make(chan struct{})}
			fake.movies = []dispatcharr.Movie{dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Movie"}, "http://dispatcharr.test:9191/api/vod/movies/41/image", "mp4")}
			handler := New(testConfig(t), fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
			cookie, viewer := loginViewer(t, handler)
			target := "/api/movies/41"
			if artwork {
				target += "/artwork"
			}
			done := make(chan int, 1)
			go func() { done <- authenticatedRequest(t, handler, cookie, "GET", target, "").Code }()
			<-fake.started
			defer func() {
				select {
				case <-fake.release:
				default:
					close(fake.release)
				}
			}()
			if response := authenticatedRequest(t, handler, cookie, "POST", "/api/auth/logout", viewer.CSRFToken); response.Code != http.StatusNoContent {
				t.Fatalf("logout status = %d", response.Code)
			}
			close(fake.release)
			if status := <-done; status != 401 {
				t.Fatalf("completed lookup after logout: %d", status)
			}
			if fake.mediaArtworkCalls != 0 {
				t.Fatal("revoked session fetched image bytes")
			}
		})
	}
}

type logoutArtworkFake struct {
	*fakeDispatcharr
	started chan struct{}
	release chan struct{}
}

func (f *logoutArtworkFake) MediaArtwork(ctx context.Context, source string) (dispatcharr.Artwork, error) {
	close(f.started)
	<-f.release
	return f.fakeDispatcharr.MediaArtwork(ctx, source)
}
func TestLogoutDuringPosterFetchCannotReturnImage(t *testing.T) {
	fake := &logoutArtworkFake{fakeDispatcharr: movieFake(), started: make(chan struct{}), release: make(chan struct{})}
	fake.movies = []dispatcharr.Movie{dispatcharr.WithMovieSource(dispatcharr.Movie{ID: "41", Name: "Movie"}, "http://dispatcharr.test:9191/api/vod/movies/41/image", "mp4")}
	server := New(testConfig(t), fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, server)
	done := make(chan int, 1)
	go func() { done <- authenticatedRequest(t, server, cookie, "GET", "/api/movies/41/artwork", "").Code }()
	<-fake.started
	response := authenticatedRequest(t, server, cookie, "POST", "/api/auth/logout", viewer.CSRFToken)
	close(fake.release)
	if response.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d", response.Code)
	}
	if status := <-done; status != http.StatusUnauthorized {
		t.Fatalf("poster after logout = %d", status)
	}
}
