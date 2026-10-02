package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestMovieCatalogSearchAndPagination(t *testing.T) {
	movies := []dispatcharr.Movie{
		{ID: "1", Name: "Zulu", Year: "2020", Rating: "8.1", Added: "100"},
		{ID: "2", Name: "Alpha", Year: "2024", Rating: "9.0", Added: "300"},
		{ID: "3", Name: "Alpha Two", Year: "2022", Rating: "7.5", Added: "200"},
		{ID: "4", Name: "No metadata"},
	}
	query := catalogQuery{search: "alpha", page: 1, pageSize: 1}
	filtered := filterAndSortMovies(movies, query)
	if len(filtered) != 2 || filtered[0].ID != "2" || filtered[1].ID != "3" {
		t.Fatalf("filtered movies = %#v", filtered)
	}
	first := paginate(filtered, 1, 1)
	second := paginate(filtered, 2, 1)
	if first.Total != 2 || len(first.Items) != 1 || first.Items[0].ID != "2" || len(second.Items) != 1 || second.Items[0].ID != "3" {
		t.Fatalf("pages = %#v / %#v", first, second)
	}
}

func TestMovieCatalogAlwaysSortsTitleAscendingWithIDTieBreak(t *testing.T) {
	movies := []dispatcharr.Movie{
		{ID: "4", Name: "Zulu"},
		{ID: "9", Name: "alpha"},
		{ID: "3", Name: "Bravo"},
		{ID: "2", Name: "Alpha"},
	}
	filtered := filterAndSortMovies(movies, catalogQuery{})
	want := []string{"2", "9", "3", "4"}
	for index, movie := range filtered {
		if movie.ID != want[index] {
			t.Fatalf("IDs = %#v, want %v", filtered, want)
		}
	}
}

func TestCompletedGlobalSearchesReuseViewerCatalogCaches(t *testing.T) {
	fake := &fakeDispatcharr{
		movies: []dispatcharr.Movie{
			{ID: "1", Name: "Alpha"},
			{ID: "2", Name: "Bravo"},
		},
		seriesItems: []dispatcharr.Series{
			{ID: "3", Name: "Charlie"},
			{ID: "4", Name: "Delta"},
		},
	}
	handler := newTestHandler(t, fake, io.Discard)
	cookie, _ := loginViewer(t, handler)

	for _, target := range []string{
		"/api/movies?search=alpha&page=1&page_size=20",
		"/api/movies?search=bravo&page=1&page_size=20",
		"/api/series?search=charlie&page=1&page_size=20",
		"/api/series?search=delta&page=1&page_size=20",
	} {
		response := authenticatedRequest(t, handler, cookie, http.MethodGet, target, "")
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, body = %s", target, response.Code, response.Body.String())
		}
	}

	fake.mu.Lock()
	movieCalls, seriesCalls := fake.movieCalls, fake.seriesCalls
	fake.mu.Unlock()
	if movieCalls != 1 || seriesCalls != 1 {
		t.Fatalf("global catalog calls: movies=%d series=%d, want one each", movieCalls, seriesCalls)
	}
}

func TestParseCatalogQueryRejectsAbusiveValues(t *testing.T) {
	for name, rawURL := range map[string]string{
		"page size": "/api/movies?page_size=1000",
		"category":  "/api/movies?category_id=../bad",
	} {
		t.Run(name, func(t *testing.T) {
			writer := httptest.NewRecorder()
			request := httptest.NewRequest("GET", rawURL, nil)
			if _, ok := parseCatalogQuery(writer, request, false); ok {
				t.Fatal("query unexpectedly accepted")
			}
			if writer.Code != 400 {
				t.Fatalf("status = %d", writer.Code)
			}
		})
	}
}

func TestParseSeriesCatalogQueryPreservesSortValidationOrder(t *testing.T) {
	for name, test := range map[string]struct {
		rawURL   string
		wantCode string
	}{
		"invalid sort":          {rawURL: "/api/series?sort=newest", wantCode: "invalid_sort"},
		"invalid catalog first": {rawURL: "/api/series?category_id=../bad&sort=newest", wantCode: "invalid_catalog_query"},
	} {
		t.Run(name, func(t *testing.T) {
			writer := httptest.NewRecorder()
			request := httptest.NewRequest("GET", test.rawURL, nil)
			if _, ok := parseCatalogQuery(writer, request, true); ok {
				t.Fatal("query unexpectedly accepted")
			}
			var response errorResponse
			if err := json.NewDecoder(writer.Body).Decode(&response); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if response.Error.Code != test.wantCode {
				t.Fatalf("error code = %q, want %q", response.Error.Code, test.wantCode)
			}
		})
	}
}

func TestPaginateHandlesUntrustedExtremeValuesWithoutOverflow(t *testing.T) {
	maximumInt := int(^uint(0) >> 1)
	page := paginate([]int{1, 2, 3}, maximumInt, maximumInt)
	if len(page.Items) != 0 || page.Total != 3 {
		t.Fatalf("page = %#v", page)
	}
}

func TestSeriesDetailGroupsSpecialsAndOrdersEpisodes(t *testing.T) {
	streamInfo := &dispatcharr.StreamInfo{Container: "MP4", VideoCodec: "H.264", AudioCodec: "AAC"}
	detail := dispatcharr.SeriesDetail{
		ID: "series", Name: "Example", HasArtwork: true,
		Seasons: []dispatcharr.Season{{Number: 1}, {Number: 0}},
		Episodes: []dispatcharr.Episode{
			{ID: "later", Name: "Later", SeasonNumber: 1, EpisodeNumber: 2},
			{ID: "special", Name: "Special", SeasonNumber: 0, EpisodeNumber: 1},
			{ID: "first", Name: "First", SeasonNumber: 1, EpisodeNumber: 1, StreamInfo: streamInfo},
		},
	}
	response := newSeriesDetailResponse(detail)
	if len(response.Seasons) != 2 || response.Seasons[0].Number != 0 || response.Seasons[0].Name != "Specials" {
		t.Fatalf("seasons = %#v", response.Seasons)
	}
	if got := response.Seasons[1].Episodes; len(got) != 2 || got[0].ID != "first" || got[1].ID != "later" {
		t.Fatalf("ordered episodes = %#v", got)
	} else if got[0].StreamInfo != streamInfo {
		t.Fatalf("episode stream info = %#v", got[0].StreamInfo)
	}
}
