package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

var (
	errMovieNotFound   = errors.New("viewer-authorized movie not found")
	errSeriesNotFound  = errors.New("viewer-authorized series not found")
	errEpisodeNotFound = errors.New("viewer-authorized episode not found")
)

type catalogPage[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

type seriesDetailResponse struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	CategoryID  string                 `json:"category_id,omitempty"`
	Year        string                 `json:"year,omitempty"`
	Rating      string                 `json:"rating,omitempty"`
	Genre       string                 `json:"genre,omitempty"`
	Plot        string                 `json:"plot,omitempty"`
	Director    string                 `json:"director,omitempty"`
	Cast        string                 `json:"cast,omitempty"`
	ReleaseDate string                 `json:"release_date,omitempty"`
	HasArtwork  bool                   `json:"has_artwork,omitempty"`
	Seasons     []seasonDetailResponse `json:"seasons"`
}

type seasonDetailResponse struct {
	Number   int                     `json:"number"`
	Name     string                  `json:"name"`
	Episodes []episodeDetailResponse `json:"episodes"`
}

type episodeDetailResponse struct {
	ID            string                  `json:"id"`
	SeasonNumber  int                     `json:"season_number"`
	EpisodeNumber int                     `json:"episode_number,omitempty"`
	Title         string                  `json:"title"`
	AirDate       string                  `json:"air_date,omitempty"`
	Duration      string                  `json:"duration,omitempty"`
	Rating        string                  `json:"rating,omitempty"`
	Plot          string                  `json:"plot,omitempty"`
	StreamInfo    *dispatcharr.StreamInfo `json:"stream_info,omitempty"`
}

func (s *Server) handleMovieCategories(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	key := viewerSession.ID + ":movie-categories"
	if cached, ok := s.cache.Get(key); ok {
		writeJSON(writer, http.StatusOK, cached)
		return
	}
	categories, err := s.dispatcharr.MovieCategories(request.Context(), viewerSession.Credentials)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	s.cacheValue(key, categories, s.cfg.CategoryCacheTTL, 0)
	writeJSON(writer, http.StatusOK, categories)
}

func (s *Server) handleMovies(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	query, ok := parseCatalogQuery(writer, request, false)
	if !ok {
		return
	}
	categoryID := query.categoryID
	if query.search != "" {
		categoryID = ""
	}
	movies, err := s.moviesForViewer(request.Context(), viewerSession, categoryID)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	filtered := filterAndSortMovies(movies, query)
	writeJSON(writer, http.StatusOK, paginate(filtered, query.page, query.pageSize))
}

func (s *Server) handleMovieDetail(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	movieID := strings.TrimSpace(request.PathValue("movie_id"))
	if movieID == "" || !validIdentifier(movieID) {
		writeError(writer, http.StatusBadRequest, "invalid_movie", "Movie ID is invalid")
		return
	}
	detail, err := s.movieDetailForViewer(request.Context(), viewerSession, movieID)
	if err != nil {
		s.writeCatalogError(writer, request, err, "movie")
		return
	}
	writeJSON(writer, http.StatusOK, detail)
}

func (s *Server) handleSeriesCategories(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	key := viewerSession.ID + ":series-categories"
	if cached, ok := s.cache.Get(key); ok {
		writeJSON(writer, http.StatusOK, cached)
		return
	}
	categories, err := s.dispatcharr.SeriesCategories(request.Context(), viewerSession.Credentials)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	s.cacheValue(key, categories, s.cfg.CategoryCacheTTL, 0)
	writeJSON(writer, http.StatusOK, categories)
}

func (s *Server) handleSeries(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	query, ok := parseCatalogQuery(writer, request, true)
	if !ok {
		return
	}
	categoryID := query.categoryID
	if query.search != "" {
		categoryID = ""
	}
	series, err := s.seriesForViewer(request.Context(), viewerSession, categoryID)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	filtered := filterAndSortSeries(series, query.search)
	writeJSON(writer, http.StatusOK, paginate(filtered, query.page, query.pageSize))
}

func (s *Server) handleSeriesDetail(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	seriesID := strings.TrimSpace(request.PathValue("series_id"))
	if seriesID == "" || !validIdentifier(seriesID) {
		writeError(writer, http.StatusBadRequest, "invalid_series", "Series ID is invalid")
		return
	}
	detail, err := s.seriesDetailForViewer(request.Context(), viewerSession, seriesID)
	if err != nil {
		s.writeCatalogError(writer, request, err, "series")
		return
	}
	writeJSON(writer, http.StatusOK, newSeriesDetailResponse(detail))
}

func (s *Server) moviesForViewer(ctx context.Context, viewerSession session.Session, categoryID string) ([]dispatcharr.Movie, error) {
	key := viewerSession.ID + ":movies:" + categoryID
	if cached, ok := s.cache.Get(key); ok {
		return cached.([]dispatcharr.Movie), nil
	}
	movies, err := s.dispatcharr.Movies(ctx, viewerSession.Credentials, categoryID)
	if err != nil {
		return nil, err
	}
	extra := 0
	for _, movie := range movies {
		extra += len(movie.ArtworkURL()) + len(movie.ContainerExtension())
	}
	s.cacheValue(key, movies, s.cfg.CatalogCacheTTL, extra)
	return movies, nil
}

// Artwork eligibility comes from a fresh XC listing, never a display cache.
// A cached category is only a request hint. Missing/moved items fail closed.
func (s *Server) movieForViewer(ctx context.Context, viewerSession session.Session, movieID string) (dispatcharr.Movie, error) {
	categoryID := ""
	if hint, ok := s.cachedMovieForViewer(viewerSession.ID, movieID); ok {
		categoryID = hint.CategoryID
	}
	value, err := s.lookups.do(ctx, viewerSession.ID+":movie-artwork-list:"+categoryID, func() (any, error) {
		return s.dispatcharr.Movies(ctx, viewerSession.Credentials, categoryID)
	})
	if err != nil {
		return dispatcharr.Movie{}, err
	}
	if _, alive := s.sessions.Get(viewerSession.ID); !alive {
		return dispatcharr.Movie{}, dispatcharr.ErrUnauthorized
	}
	if movie, ok := findMovie(value.([]dispatcharr.Movie), movieID); ok {
		return movie, nil
	}
	return dispatcharr.Movie{}, errMovieNotFound
}

func (s *Server) cachedMovieForViewer(sessionID, movieID string) (dispatcharr.Movie, bool) {
	if cached, ok := s.cache.Get(sessionID + ":movies:"); ok {
		if movie, found := findMovie(cached.([]dispatcharr.Movie), movieID); found {
			return movie, true
		}
	}
	cachedCategories, ok := s.cache.Get(sessionID + ":movie-categories")
	if !ok {
		return dispatcharr.Movie{}, false
	}
	for _, category := range cachedCategories.([]dispatcharr.Category) {
		if cached, found := s.cache.Get(sessionID + ":movies:" + category.ID); found {
			if movie, matched := findMovie(cached.([]dispatcharr.Movie), movieID); matched {
				return movie, true
			}
		}
	}
	return dispatcharr.Movie{}, false
}

func findMovie(movies []dispatcharr.Movie, movieID string) (dispatcharr.Movie, bool) {
	for _, movie := range movies {
		if movie.ID == movieID {
			return movie, true
		}
	}
	return dispatcharr.Movie{}, false
}

func (s *Server) movieDetailForViewer(ctx context.Context, viewerSession session.Session, movieID string) (dispatcharr.MovieDetail, error) {
	// Stock XC checks current item access; it may refresh stale provider metadata.
	// Share overlapping calls only, never completed authorization decisions.
	value, err := s.lookups.do(ctx, viewerSession.ID+":movie:"+movieID, func() (any, error) {
		return s.dispatcharr.MovieDetails(ctx, viewerSession.Credentials, movieID)
	})
	if err != nil {
		return dispatcharr.MovieDetail{}, err
	}
	detail := value.(dispatcharr.MovieDetail)
	if detail.ID != movieID {
		return dispatcharr.MovieDetail{}, errMovieNotFound
	}
	if _, alive := s.sessions.Get(viewerSession.ID); !alive {
		return dispatcharr.MovieDetail{}, dispatcharr.ErrUnauthorized
	}
	if movie, ok := s.cachedMovieForViewer(viewerSession.ID, movieID); ok && detail.ArtworkURL() == "" {
		detail = dispatcharr.WithMovieDetailSource(detail, detail.StreamID(), detail.ContainerExtension(), movie.ArtworkURL())
	}
	// Keep display-only artwork metadata. This is never returned as a detail
	// response or accepted as proof of access; artwork rechecks the current list.
	s.cacheValue(viewerSession.ID+":movie-detail:"+movieID, detail, s.cfg.DetailCacheTTL, len(detail.ArtworkURL())+len(detail.ContainerExtension()))
	return detail, nil
}

func (s *Server) seriesForViewer(ctx context.Context, viewerSession session.Session, categoryID string) ([]dispatcharr.Series, error) {
	key := viewerSession.ID + ":series:" + categoryID
	if cached, ok := s.cache.Get(key); ok {
		return cached.([]dispatcharr.Series), nil
	}
	items, err := s.dispatcharr.Series(ctx, viewerSession.Credentials, categoryID)
	if err != nil {
		return nil, err
	}
	extra := 0
	for _, item := range items {
		extra += len(item.ArtworkURL())
	}
	s.cacheValue(key, items, s.cfg.CatalogCacheTTL, extra)
	return items, nil
}

func (s *Server) seriesForViewerByID(ctx context.Context, viewerSession session.Session, seriesID string) (dispatcharr.Series, error) {
	categoryID := ""
	if hint, ok := s.cachedSeriesForViewer(viewerSession.ID, seriesID); ok {
		categoryID = hint.CategoryID
	}
	value, err := s.lookups.do(ctx, viewerSession.ID+":series-artwork-list:"+categoryID, func() (any, error) {
		return s.dispatcharr.Series(ctx, viewerSession.Credentials, categoryID)
	})
	if err != nil {
		return dispatcharr.Series{}, err
	}
	if _, alive := s.sessions.Get(viewerSession.ID); !alive {
		return dispatcharr.Series{}, dispatcharr.ErrUnauthorized
	}
	if item, ok := findSeries(value.([]dispatcharr.Series), seriesID); ok {
		return item, nil
	}
	return dispatcharr.Series{}, errSeriesNotFound
}

func (s *Server) cachedSeriesForViewer(sessionID, seriesID string) (dispatcharr.Series, bool) {
	if cached, ok := s.cache.Get(sessionID + ":series:"); ok {
		if item, found := findSeries(cached.([]dispatcharr.Series), seriesID); found {
			return item, true
		}
	}
	cachedCategories, ok := s.cache.Get(sessionID + ":series-categories")
	if !ok {
		return dispatcharr.Series{}, false
	}
	for _, category := range cachedCategories.([]dispatcharr.Category) {
		if cached, found := s.cache.Get(sessionID + ":series:" + category.ID); found {
			if item, matched := findSeries(cached.([]dispatcharr.Series), seriesID); matched {
				return item, true
			}
		}
	}
	return dispatcharr.Series{}, false
}

func findSeries(items []dispatcharr.Series, seriesID string) (dispatcharr.Series, bool) {
	for _, item := range items {
		if item.ID == seriesID {
			return item, true
		}
	}
	return dispatcharr.Series{}, false
}

func (s *Server) seriesDetailForViewer(ctx context.Context, viewerSession session.Session, seriesID string) (dispatcharr.SeriesDetail, error) {
	value, err := s.lookups.do(ctx, viewerSession.ID+":series:"+seriesID, func() (any, error) {
		return s.dispatcharr.SeriesDetails(ctx, viewerSession.Credentials, seriesID)
	})
	if err != nil {
		return dispatcharr.SeriesDetail{}, err
	}
	detail := value.(dispatcharr.SeriesDetail)
	if detail.ID != seriesID {
		return dispatcharr.SeriesDetail{}, errSeriesNotFound
	}
	if _, alive := s.sessions.Get(viewerSession.ID); !alive {
		return dispatcharr.SeriesDetail{}, dispatcharr.ErrUnauthorized
	}
	if item, ok := s.cachedSeriesForViewer(viewerSession.ID, seriesID); ok && detail.ArtworkURL() == "" {
		detail = dispatcharr.WithSeriesDetailArtwork(detail, item.ArtworkURL())
	}
	extra := len(detail.ArtworkURL())
	for _, episode := range detail.Episodes {
		extra += len(episode.ContainerExtension())
	}
	// Display-only metadata for the poster fallback; episode access always uses
	// a new detail response, so removed episodes cannot survive in this cache.
	s.cacheValue(viewerSession.ID+":series-detail:"+seriesID, detail, s.cfg.DetailCacheTTL, extra)
	return detail, nil
}

func episodeForViewer(detail dispatcharr.SeriesDetail, episodeID string) (dispatcharr.Episode, error) {
	for _, episode := range detail.Episodes {
		if episode.ID == episodeID {
			return episode, nil
		}
	}
	return dispatcharr.Episode{}, errEpisodeNotFound
}

func (s *Server) cacheValue(key string, value any, ttl time.Duration, extra int) {
	// Kept as a small helper so private process-only URLs/extensions are included
	// in cache byte accounting even though JSON intentionally omits them.
	payload, _ := json.Marshal(value)
	s.cache.Set(key, value, int64(len(payload)+extra), ttl)
}

type catalogQuery struct {
	categoryID string
	search     string
	page       int
	pageSize   int
}

func parseCatalogQuery(writer http.ResponseWriter, request *http.Request, validateSeriesSort bool) (catalogQuery, bool) {
	values := request.URL.Query()
	result := catalogQuery{
		categoryID: strings.TrimSpace(values.Get("category_id")),
		search:     strings.TrimSpace(values.Get("search")),
		page:       1,
		pageSize:   20,
	}
	if !validIdentifier(result.categoryID) || len(result.search) > 256 {
		writeError(writer, http.StatusBadRequest, "invalid_catalog_query", "Catalog query is invalid")
		return catalogQuery{}, false
	}
	if requestedSort := strings.TrimSpace(values.Get("sort")); validateSeriesSort && requestedSort != "" && requestedSort != "title_asc" {
		writeError(writer, http.StatusBadRequest, "invalid_sort", "Series sort is invalid")
		return catalogQuery{}, false
	}
	var err error
	if result.page, err = optionalPositiveInt(values.Get("page"), 1, 1, 1_000_000); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_page", "Page is invalid")
		return catalogQuery{}, false
	}
	if result.pageSize, err = optionalPositiveInt(values.Get("page_size"), 20, 1, 100); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_page_size", "Page size is invalid")
		return catalogQuery{}, false
	}
	return result, true
}

func optionalPositiveInt(raw string, fallback, minimum, maximum int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, errors.New("integer outside accepted range")
	}
	return value, nil
}

func filterAndSortMovies(source []dispatcharr.Movie, query catalogQuery) []dispatcharr.Movie {
	items := make([]dispatcharr.Movie, 0, len(source))
	needle := strings.ToLower(query.search)
	for _, movie := range source {
		if needle != "" && !strings.Contains(strings.ToLower(movie.Name), needle) {
			continue
		}
		items = append(items, movie)
	}
	sort.SliceStable(items, func(i, j int) bool {
		leftName := strings.ToLower(items[i].Name)
		rightName := strings.ToLower(items[j].Name)
		if leftName != rightName {
			return leftName < rightName
		}
		return items[i].ID < items[j].ID
	})
	return items
}

func filterAndSortSeries(source []dispatcharr.Series, search string) []dispatcharr.Series {
	needle := strings.ToLower(search)
	items := make([]dispatcharr.Series, 0, len(source))
	for _, item := range source {
		if needle == "" || strings.Contains(strings.ToLower(item.Name), needle) {
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name) })
	return items
}

func paginate[T any](items []T, page, pageSize int) catalogPage[T] {
	result := catalogPage[T]{Items: []T{}, Total: len(items), Page: page, PageSize: pageSize}
	if page <= 0 || pageSize <= 0 || len(items) == 0 || page > (len(items)-1)/pageSize+1 {
		return result
	}
	start := (page - 1) * pageSize
	end := min(len(items), start+pageSize)
	result.Items = items[start:end]
	return result
}

func newSeriesDetailResponse(detail dispatcharr.SeriesDetail) seriesDetailResponse {
	bySeason := make(map[int][]episodeDetailResponse, len(detail.Seasons))
	for _, episode := range detail.Episodes {
		bySeason[episode.SeasonNumber] = append(bySeason[episode.SeasonNumber], episodeDetailResponse{
			ID: episode.ID, SeasonNumber: episode.SeasonNumber, EpisodeNumber: episode.EpisodeNumber,
			Title: episode.Name, AirDate: episode.AirDate, Duration: episode.Duration, Rating: episode.Rating, Plot: episode.Plot,
			StreamInfo: episode.StreamInfo,
		})
	}
	seasonNames := make(map[int]string, len(detail.Seasons))
	for _, season := range detail.Seasons {
		seasonNames[season.Number] = season.Name
	}
	numbers := make([]int, 0, len(bySeason)+len(seasonNames))
	seen := make(map[int]bool)
	for number := range seasonNames {
		numbers = append(numbers, number)
		seen[number] = true
	}
	for number := range bySeason {
		if !seen[number] {
			numbers = append(numbers, number)
		}
	}
	sort.Ints(numbers)
	seasons := make([]seasonDetailResponse, 0, len(numbers))
	for _, number := range numbers {
		episodes := bySeason[number]
		sort.SliceStable(episodes, func(i, j int) bool {
			left, right := episodes[i].EpisodeNumber, episodes[j].EpisodeNumber
			if left == 0 && right != 0 {
				return false
			}
			if left != 0 && right == 0 {
				return true
			}
			if left != right {
				return left < right
			}
			return strings.ToLower(episodes[i].Title) < strings.ToLower(episodes[j].Title)
		})
		name := seasonNames[number]
		if number == 0 {
			name = "Specials"
		} else if name == "" {
			name = "Season " + strconv.Itoa(number)
		}
		seasons = append(seasons, seasonDetailResponse{Number: number, Name: name, Episodes: episodes})
	}
	return seriesDetailResponse{
		ID: detail.ID, Name: detail.Name, CategoryID: detail.CategoryID, Year: detail.Year,
		Rating: detail.Rating, Genre: detail.Genre, Plot: detail.Plot, Director: detail.Director,
		Cast: detail.Cast, ReleaseDate: detail.ReleaseDate, HasArtwork: detail.HasArtwork, Seasons: seasons,
	}
}

func (s *Server) writeCatalogError(writer http.ResponseWriter, request *http.Request, err error, kind string) {
	if errors.Is(err, errMovieNotFound) || errors.Is(err, errSeriesNotFound) || errors.Is(err, errEpisodeNotFound) || errors.Is(err, dispatcharr.ErrNotFound) || errors.Is(err, dispatcharr.ErrInvalidMedia) {
		label := map[string]string{"movie": "Movie", "series": "Series", "episode": "Episode"}[kind]
		if label == "" {
			label = "Media"
		}
		writeError(writer, http.StatusNotFound, kind+"_not_found", label+" is not available to this viewer")
		return
	}
	s.writeDispatcharrError(writer, request, err, false)
}
