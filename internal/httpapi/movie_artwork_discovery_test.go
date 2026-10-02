package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestMovieArtworkDiscoveryThroughCachedAuthorizedDetail(t *testing.T) {
	for _, hasArtwork := range []bool{true, false} {
		name := "detail finds artwork"
		if !hasArtwork {
			name = "genuinely missing artwork"
		}
		t.Run(name, func(t *testing.T) {
			upstreamURL := ""
			if hasArtwork {
				upstreamURL = "http://dispatcharr.test:9191/api/vod/movies/298526/image?kind=movie_image"
			}
			fake := &fakeDispatcharr{
				movies:       []dispatcharr.Movie{{ID: "298526", Name: "001 Trolling - 2017"}},
				movieDetail:  dispatcharr.WithMovieDetailSource(dispatcharr.MovieDetail{ID: "298526", Name: "001 Trolling - 2017"}, "298526", "mp4", upstreamURL),
				mediaArtwork: dispatcharr.Artwork{ContentType: "image/png", Data: []byte("png")},
			}
			handler := newTestHandler(t, fake, io.Discard)
			cookie, _ := loginViewer(t, handler)
			list := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies?page=1&page_size=20", "")
			var catalog struct {
				Items []dispatcharr.Movie `json:"items"`
			}
			if err := json.Unmarshal(list.Body.Bytes(), &catalog); err != nil || list.Code != http.StatusOK || len(catalog.Items) != 1 || catalog.Items[0].HasArtwork {
				t.Fatalf("expected an authorized list item without artwork: status=%d, error=%v", list.Code, err)
			}
			before := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/298526/artwork", "")
			if before.Code != http.StatusNotFound || fake.movieDetailCalls != 0 || fake.mediaArtworkCalls != 0 {
				t.Fatal("artwork without a source should return 404 without fetching details or an image")
			}
			for range 2 {
				detail := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/298526", "")
				var payload struct {
					HasArtwork bool `json:"has_artwork"`
				}
				if err := json.Unmarshal(detail.Body.Bytes(), &payload); err != nil || detail.Code != http.StatusOK || payload.HasArtwork != hasArtwork {
					t.Fatalf("detail artwork mismatch: status=%d, error=%v", detail.Code, err)
				}
				if strings.Contains(detail.Body.String(), "dispatcharr.test") || strings.Contains(detail.Body.String(), "movie_image") || strings.Contains(list.Body.String(), "dispatcharr.test") {
					t.Fatal("viewer JSON exposed the upstream artwork source")
				}
				artwork := authenticatedRequest(t, handler, cookie, http.MethodGet, "/api/movies/298526/artwork", "")
				if hasArtwork {
					if artwork.Code != http.StatusOK || artwork.Body.String() != "png" || fake.lastArtworkURL != upstreamURL {
						t.Fatal("cached detail did not enable the authorized artwork proxy")
					}
				} else if artwork.Code != http.StatusNotFound {
					t.Fatalf("missing artwork status = %d", artwork.Code)
				}
			}
			wantImageCalls := 0
			if hasArtwork {
				wantImageCalls = 1
			}
			if fake.movieDetailCalls != 2 || fake.mediaArtworkCalls != wantImageCalls || fake.movieCalls != 4 {
				t.Fatalf("cache not reused: catalogs=%d details=%d images=%d", fake.movieCalls, fake.movieDetailCalls, fake.mediaArtworkCalls)
			}

			// The warmed detail/image cache must not grant another viewer access.
			fake.movies = nil
			otherCookie, _ := loginViewerAs(t, handler, "other", "different", "192.0.2.6:1234")
			for _, target := range []string{"/api/movies/298526", "/api/movies/298526/artwork"} {
				other := authenticatedRequest(t, handler, otherCookie, http.MethodGet, target, "")
				if other.Code != http.StatusNotFound {
					t.Fatalf("other viewer status = %d", other.Code)
				}
				anonymous := httptest.NewRecorder()
				handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, target, nil))
				if anonymous.Code != http.StatusUnauthorized {
					t.Fatalf("anonymous status = %d", anonymous.Code)
				}
			}
			if fake.movieDetailCalls != 3 || fake.mediaArtworkCalls != wantImageCalls {
				t.Fatal("unauthorized request reached upstream detail or artwork")
			}
		})
	}
}
