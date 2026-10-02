package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

// Exercise the real XC adapter and viewer API together. Any image, HEAD,
// range, download, or playback request fails the test: compatibility consumes
// only authorized catalog/detail metadata, never media bytes.
func TestCompatibilityMetadataFromXCToAuthorizedViewer(t *testing.T) {
	for _, kind := range []string{"movie", "episode"} {
		for _, test := range []struct {
			name  string
			video any
			want  map[string]any
		}{
			{"explicit resolution", "1080p", map[string]any{"container": "MP4", "resolution": "1080p", "height": float64(1080)}},
			{"reported dimensions", map[string]any{"width": 1920, "height": 1040}, map[string]any{"container": "MP4", "resolution": "1920x1040", "width": float64(1920), "height": float64(1040)}},
			{"codec without resolution", map[string]any{"codec_name": "h264"}, map[string]any{"container": "MP4", "video_codec": "H.264"}},
			{"missing at source", map[string]any{}, map[string]any{"container": "MP4"}},
		} {
			t.Run(kind+"/"+test.name, func(t *testing.T) {
				detailCalls := 0
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != "/player_api.php" {
						t.Error("unexpected media/probe request")
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					query := r.URL.Query()
					if query.Get("username") == "" || query.Get("password") == "" {
						t.Error("XC credentials were not preserved")
					}
					var payload any
					switch query.Get("action") {
					case "":
						payload = map[string]any{"user_info": map[string]any{"auth": 1, "username": query.Get("username")}}
					case "get_vod_streams", "get_series":
						payload = []any{}
						if query.Get("username") == "viewer" {
							payload = []any{map[string]any{"stream_id": 41, "series_id": 41, "name": "Film 1080p"}}
						}
					case "get_vod_info", "get_series_info":
						if query.Get("username") != "viewer" {
							w.WriteHeader(http.StatusNotFound)
							return
						}
						detailCalls++
						info := map[string]any{
							"name": "Film 1080p", "video": test.video,
							// Unsupported size fields cannot be treated as verified
							// whole-file byte counts or serialized to the viewer.
							"file_size": 123456, "size": "123 KB", "duration_secs": 3600,
							"provider_url": "https://provider.invalid/private",
						}
						if kind == "movie" {
							payload = map[string]any{"info": info, "movie_data": map[string]any{"stream_id": 41, "container_extension": "mp4"}}
						} else {
							payload = map[string]any{"info": map[string]any{"name": "Show"}, "episodes": map[string]any{"1": []any{
								map[string]any{"id": 501, "title": "Pilot", "container_extension": "mp4", "info": info},
							}}}
						}
					default:
						t.Error("unexpected XC request")
					}
					_ = json.NewEncoder(w).Encode(payload)
				}))
				defer upstream.Close()
				baseURL, _ := url.Parse(upstream.URL)
				client := dispatcharr.NewClient(baseURL, upstream.Client(), 1024*1024, 1024)
				handler := New(testConfig(t), client, slog.New(slog.NewTextHandler(io.Discard, nil)))
				cookie, _ := loginViewer(t, handler)
				target := "/api/movies/41"
				if kind == "episode" {
					target = "/api/series/41"
				}
				for range 2 {
					response := authenticatedRequest(t, handler, cookie, http.MethodGet, target, "")
					var payload struct {
						StreamInfo map[string]any `json:"stream_info"`
						Seasons    []struct {
							Episodes []struct {
								StreamInfo map[string]any `json:"stream_info"`
							} `json:"episodes"`
						} `json:"seasons"`
					}
					if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil {
						t.Fatalf("detail status = %d", response.Code)
					}
					got := payload.StreamInfo
					if kind == "episode" {
						if len(payload.Seasons) != 1 || len(payload.Seasons[0].Episodes) != 1 {
							t.Fatal("expected one authorized episode")
						}
						got = payload.Seasons[0].Episodes[0].StreamInfo
					}
					if !reflect.DeepEqual(got, test.want) {
						t.Fatalf("normalized metadata = %#v, want %#v", got, test.want)
					}
				}
				otherCookie, _ := loginViewerAs(t, handler, "other", "different", "192.0.2.6:1234")
				if response := authenticatedRequest(t, handler, otherCookie, http.MethodGet, target, ""); response.Code != http.StatusNotFound {
					t.Fatalf("other viewer status = %d", response.Code)
				}
				anonymous := httptest.NewRecorder()
				handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, target, nil))
				if anonymous.Code != http.StatusUnauthorized || detailCalls != 2 {
					t.Fatalf("anonymous status = %d, upstream detail requests = %d", anonymous.Code, detailCalls)
				}
			})
		}
	}
}
