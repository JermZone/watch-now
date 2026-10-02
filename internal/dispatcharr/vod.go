package dispatcharr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type looseString string

func (value *looseString) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*value = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*value = looseString(text)
		return nil
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err == nil {
		*value = looseString(number.String())
		return nil
	}
	// Optional XC metadata is inconsistent between providers. Treat an
	// unsupported optional value as absent rather than rejecting the catalog.
	*value = ""
	return nil
}

type rawCategory struct {
	ID   looseString `json:"category_id"`
	Name looseString `json:"category_name"`
}

type rawMovie struct {
	ID             looseString     `json:"stream_id"`
	Name           looseString     `json:"name"`
	CategoryID     looseString     `json:"category_id"`
	Year           looseString     `json:"year"`
	ReleaseDate    looseString     `json:"releasedate"`
	ReleaseDateAlt looseString     `json:"release_date"`
	Rating         looseString     `json:"rating"`
	Rating5        looseString     `json:"rating_5based"`
	Added          looseString     `json:"added"`
	Genre          looseString     `json:"genre"`
	Plot           looseString     `json:"plot"`
	Description    looseString     `json:"description"`
	StreamIcon     looseString     `json:"stream_icon"`
	Cover          looseString     `json:"cover"`
	CoverBig       looseString     `json:"cover_big"`
	MovieImage     looseString     `json:"movie_image"`
	Container      looseString     `json:"container_extension"`
	Video          json.RawMessage `json:"video"`
	Audio          json.RawMessage `json:"audio"`
	Width          json.RawMessage `json:"width"`
	Height         json.RawMessage `json:"height"`
	Resolution     json.RawMessage `json:"resolution"`
	Bitrate        json.RawMessage `json:"bitrate"`
}

type rawMovieInfo struct {
	ID             looseString     `json:"stream_id"`
	Name           looseString     `json:"name"`
	Year           looseString     `json:"year"`
	Runtime        looseString     `json:"episode_run_time"`
	Duration       looseString     `json:"duration"`
	DurationSecs   looseString     `json:"duration_secs"`
	Rating         looseString     `json:"rating"`
	Rating5        looseString     `json:"rating_5based"`
	Genre          looseString     `json:"genre"`
	Plot           looseString     `json:"plot"`
	Description    looseString     `json:"description"`
	Director       looseString     `json:"director"`
	Actors         looseString     `json:"actors"`
	Cast           looseString     `json:"cast"`
	Country        looseString     `json:"country"`
	ReleaseDate    looseString     `json:"releasedate"`
	ReleaseDateAlt looseString     `json:"release_date"`
	MovieImage     looseString     `json:"movie_image"`
	Cover          looseString     `json:"cover"`
	CoverBig       looseString     `json:"cover_big"`
	Container      looseString     `json:"container_extension"`
	Video          json.RawMessage `json:"video"`
	Audio          json.RawMessage `json:"audio"`
	Width          json.RawMessage `json:"width"`
	Height         json.RawMessage `json:"height"`
	Resolution     json.RawMessage `json:"resolution"`
	Bitrate        json.RawMessage `json:"bitrate"`
}

type rawSeries struct {
	ID             looseString `json:"series_id"`
	Name           looseString `json:"name"`
	CategoryID     looseString `json:"category_id"`
	Year           looseString `json:"year"`
	ReleaseDate    looseString `json:"releaseDate"`
	ReleaseDateAlt looseString `json:"release_date"`
	Rating         looseString `json:"rating"`
	Rating5        looseString `json:"rating_5based"`
	Genre          looseString `json:"genre"`
	Plot           looseString `json:"plot"`
	Description    looseString `json:"description"`
	Cover          looseString `json:"cover"`
	CoverBig       looseString `json:"cover_big"`
	MovieImage     looseString `json:"movie_image"`
	Director       looseString `json:"director"`
	Actors         looseString `json:"actors"`
	Cast           looseString `json:"cast"`
}

type rawSeason struct {
	Number       looseString `json:"season_number"`
	Name         looseString `json:"name"`
	EpisodeCount looseString `json:"episode_count"`
}

type rawEpisodeInfo struct {
	AirDate      looseString     `json:"air_date"`
	ReleaseDate  looseString     `json:"release_date"`
	Duration     looseString     `json:"duration"`
	DurationSecs looseString     `json:"duration_secs"`
	Rating       looseString     `json:"rating"`
	Plot         looseString     `json:"plot"`
	Overview     looseString     `json:"overview"`
	Description  looseString     `json:"description"`
	Container    looseString     `json:"container_extension"`
	Video        json.RawMessage `json:"video"`
	Audio        json.RawMessage `json:"audio"`
	Width        json.RawMessage `json:"width"`
	Height       json.RawMessage `json:"height"`
	Resolution   json.RawMessage `json:"resolution"`
	Bitrate      json.RawMessage `json:"bitrate"`
}

func (value *rawEpisodeInfo) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		*value = rawEpisodeInfo{}
		return nil
	}
	type episodeInfoAlias rawEpisodeInfo
	return json.Unmarshal(data, (*episodeInfoAlias)(value))
}

type rawEpisode struct {
	ID          looseString     `json:"id"`
	Name        looseString     `json:"title"`
	NameAlt     looseString     `json:"name"`
	Season      looseString     `json:"season"`
	Episode     looseString     `json:"episode_num"`
	Container   looseString     `json:"container_extension"`
	Added       looseString     `json:"added"`
	Video       json.RawMessage `json:"video"`
	Audio       json.RawMessage `json:"audio"`
	Width       json.RawMessage `json:"width"`
	Height      json.RawMessage `json:"height"`
	Resolution  json.RawMessage `json:"resolution"`
	Bitrate     json.RawMessage `json:"bitrate"`
	Information rawEpisodeInfo  `json:"info"`
}

func (value rawMovie) streamMetadata() rawStreamMetadata {
	return rawStreamMetadata{
		Video: value.Video, Audio: value.Audio, Width: value.Width, Height: value.Height,
		Resolution: value.Resolution, Bitrate: value.Bitrate,
	}
}

func (value rawMovieInfo) streamMetadata() rawStreamMetadata {
	return rawStreamMetadata{
		Video: value.Video, Audio: value.Audio, Width: value.Width, Height: value.Height,
		Resolution: value.Resolution, Bitrate: value.Bitrate,
	}
}

func (value rawEpisode) streamMetadata() rawStreamMetadata {
	return rawStreamMetadata{
		Video: value.Video, Audio: value.Audio, Width: value.Width, Height: value.Height,
		Resolution: value.Resolution, Bitrate: value.Bitrate,
	}
}

func (value rawEpisodeInfo) streamMetadata() rawStreamMetadata {
	return rawStreamMetadata{
		Video: value.Video, Audio: value.Audio, Width: value.Width, Height: value.Height,
		Resolution: value.Resolution, Bitrate: value.Bitrate,
	}
}

func (c *Client) MovieCategories(ctx context.Context, credentials Credentials) ([]Category, error) {
	return c.mediaCategories(ctx, credentials, "get_vod_categories")
}

func (c *Client) SeriesCategories(ctx context.Context, credentials Credentials) ([]Category, error) {
	return c.mediaCategories(ctx, credentials, "get_series_categories")
}

func (c *Client) mediaCategories(ctx context.Context, credentials Credentials, action string) ([]Category, error) {
	query := credentialValues(credentials)
	query.Set("action", action)
	var payload []rawCategory
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	categories := make([]Category, 0, len(payload))
	for _, raw := range payload {
		id := clean(raw.ID)
		name := clean(raw.Name)
		if id == "" || name == "" {
			return nil, fmt.Errorf("%w: media category missing category_id or category_name", ErrInvalidResponse)
		}
		categories = append(categories, Category{ID: id, Name: name})
	}
	return categories, nil
}

func (c *Client) Movies(ctx context.Context, credentials Credentials, categoryID string) ([]Movie, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_vod_streams")
	if categoryID != "" {
		query.Set("category_id", categoryID)
	}
	var payload []rawMovie
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	movies := make([]Movie, 0, len(payload))
	for _, raw := range payload {
		id := clean(raw.ID)
		name := clean(raw.Name)
		if id == "" || name == "" {
			continue
		}
		artworkURL := c.firstSafeArtwork(raw.StreamIcon, raw.MovieImage, raw.CoverBig, raw.Cover)
		movies = append(movies, Movie{
			ID:         id,
			Name:       name,
			CategoryID: clean(raw.CategoryID),
			Year:       first(clean(raw.Year), yearFromDate(first(clean(raw.ReleaseDate), clean(raw.ReleaseDateAlt)))),
			Rating:     first(clean(raw.Rating), clean(raw.Rating5)),
			Added:      clean(raw.Added),
			Genre:      clean(raw.Genre),
			Plot:       first(clean(raw.Plot), clean(raw.Description)),
			HasArtwork: artworkURL != "",
			artworkURL: artworkURL,
			container:  normalizedExtension(clean(raw.Container)),
		})
	}
	return movies, nil
}

func (c *Client) MovieDetails(ctx context.Context, credentials Credentials, movieID string) (MovieDetail, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_vod_info")
	query.Set("vod_id", movieID)
	var payload struct {
		Information rawMovieInfo `json:"info"`
		Movie       rawMovie     `json:"movie_data"`
	}
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return MovieDetail{}, err
	}
	reportedID := first(clean(payload.Movie.ID), clean(payload.Information.ID))
	name := first(clean(payload.Information.Name), clean(payload.Movie.Name))
	if reportedID != "" && movieID != "" && reportedID != movieID {
		return MovieDetail{}, fmt.Errorf("%w: movie detail missing or mismatched stream_id or name", ErrInvalidResponse)
	}
	streamID := first(reportedID, movieID)
	if streamID == "" || name == "" {
		return MovieDetail{}, fmt.Errorf("%w: movie detail missing or mismatched stream_id or name", ErrInvalidResponse)
	}
	releaseDate := first(clean(payload.Information.ReleaseDate), clean(payload.Information.ReleaseDateAlt), clean(payload.Movie.ReleaseDate), clean(payload.Movie.ReleaseDateAlt))
	artworkURL := c.firstSafeArtwork(payload.Information.MovieImage, payload.Information.CoverBig, payload.Information.Cover, payload.Movie.StreamIcon)
	movieContainer := clean(payload.Movie.Container)
	infoContainer := clean(payload.Information.Container)
	container := firstPlayableExtension(movieContainer, infoContainer)
	return MovieDetail{
		ID:          streamID,
		Name:        name,
		CategoryID:  clean(payload.Movie.CategoryID),
		Year:        first(clean(payload.Information.Year), clean(payload.Movie.Year), yearFromDate(releaseDate)),
		Runtime:     clean(payload.Information.Runtime),
		Duration:    first(clean(payload.Information.Duration), clean(payload.Information.DurationSecs)),
		Rating:      first(clean(payload.Information.Rating), clean(payload.Information.Rating5), clean(payload.Movie.Rating), clean(payload.Movie.Rating5)),
		Added:       clean(payload.Movie.Added),
		Genre:       first(clean(payload.Information.Genre), clean(payload.Movie.Genre)),
		Plot:        first(clean(payload.Information.Plot), clean(payload.Information.Description), clean(payload.Movie.Plot), clean(payload.Movie.Description)),
		Director:    clean(payload.Information.Director),
		Cast:        first(clean(payload.Information.Cast), clean(payload.Information.Actors)),
		Country:     clean(payload.Information.Country),
		ReleaseDate: releaseDate,
		HasArtwork:  artworkURL != "",
		StreamInfo:  normalizeStreamInfo(container, payload.Information.streamMetadata(), payload.Movie.streamMetadata()),
		artworkURL:  artworkURL,
		streamID:    streamID,
		container:   normalizedExtension(container),
	}, nil
}

func (c *Client) Series(ctx context.Context, credentials Credentials, categoryID string) ([]Series, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_series")
	if categoryID != "" {
		query.Set("category_id", categoryID)
	}
	var payload []rawSeries
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	series := make([]Series, 0, len(payload))
	for _, raw := range payload {
		id := clean(raw.ID)
		name := clean(raw.Name)
		if id == "" || name == "" {
			continue
		}
		artworkURL := c.firstSafeArtwork(raw.MovieImage, raw.CoverBig, raw.Cover)
		series = append(series, Series{
			ID:         id,
			Name:       name,
			CategoryID: clean(raw.CategoryID),
			Year:       first(clean(raw.Year), yearFromDate(first(clean(raw.ReleaseDate), clean(raw.ReleaseDateAlt)))),
			Rating:     first(clean(raw.Rating), clean(raw.Rating5)),
			Genre:      clean(raw.Genre),
			Plot:       first(clean(raw.Plot), clean(raw.Description)),
			HasArtwork: artworkURL != "",
			artworkURL: artworkURL,
		})
	}
	return series, nil
}

func (c *Client) SeriesDetails(ctx context.Context, credentials Credentials, seriesID string) (SeriesDetail, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_series_info")
	query.Set("series_id", seriesID)
	var payload struct {
		Information rawSeries       `json:"info"`
		Seasons     []rawSeason     `json:"seasons"`
		Episodes    json.RawMessage `json:"episodes"`
	}
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return SeriesDetail{}, err
	}
	responseID := clean(payload.Information.ID)
	if responseID != "" && seriesID != "" && responseID != seriesID {
		return SeriesDetail{}, fmt.Errorf("%w: series detail returned a mismatched series_id", ErrInvalidResponse)
	}
	if responseID == "" {
		responseID = strings.TrimSpace(seriesID)
	}
	name := clean(payload.Information.Name)
	if responseID == "" || name == "" {
		return SeriesDetail{}, fmt.Errorf("%w: series detail missing series_id or name", ErrInvalidResponse)
	}
	episodes, err := parseEpisodes(payload.Episodes)
	if err != nil {
		return SeriesDetail{}, err
	}
	seasons := mergeSeasons(payload.Seasons, episodes)
	releaseDate := first(clean(payload.Information.ReleaseDate), clean(payload.Information.ReleaseDateAlt))
	artworkURL := c.firstSafeArtwork(payload.Information.MovieImage, payload.Information.CoverBig, payload.Information.Cover)
	return SeriesDetail{
		ID:          responseID,
		Name:        name,
		CategoryID:  clean(payload.Information.CategoryID),
		Year:        first(clean(payload.Information.Year), yearFromDate(releaseDate)),
		Rating:      first(clean(payload.Information.Rating), clean(payload.Information.Rating5)),
		Genre:       clean(payload.Information.Genre),
		Plot:        first(clean(payload.Information.Plot), clean(payload.Information.Description)),
		Director:    clean(payload.Information.Director),
		Cast:        first(clean(payload.Information.Cast), clean(payload.Information.Actors)),
		ReleaseDate: releaseDate,
		HasArtwork:  artworkURL != "",
		Seasons:     seasons,
		Episodes:    episodes,
		artworkURL:  artworkURL,
	}, nil
}

func parseEpisodes(data json.RawMessage) ([]Episode, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 || bytes.Equal(data, []byte("null")) || bytes.Equal(data, []byte("[]")) || bytes.Equal(data, []byte("{}")) {
		return []Episode{}, nil
	}
	type episodeGroup struct {
		season string
		items  []rawEpisode
	}
	groups := make([]episodeGroup, 0)
	if data[0] == '{' {
		var mapped map[string][]rawEpisode
		if err := json.Unmarshal(data, &mapped); err != nil {
			return nil, fmt.Errorf("%w: invalid series episodes", ErrInvalidResponse)
		}
		keys := make([]string, 0, len(mapped))
		for key := range mapped {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool { return integer(keys[i], 0) < integer(keys[j], 0) })
		for _, key := range keys {
			groups = append(groups, episodeGroup{season: key, items: mapped[key]})
		}
	} else if data[0] == '[' {
		var flat []rawEpisode
		if err := json.Unmarshal(data, &flat); err == nil {
			groups = append(groups, episodeGroup{items: flat})
		} else {
			var seasonSlots []json.RawMessage
			if err := json.Unmarshal(data, &seasonSlots); err != nil {
				return nil, fmt.Errorf("%w: invalid series episodes", ErrInvalidResponse)
			}
			for index, slot := range seasonSlots {
				slot = bytes.TrimSpace(slot)
				if len(slot) == 0 || bytes.Equal(slot, []byte("null")) {
					continue
				}
				var items []rawEpisode
				if err := json.Unmarshal(slot, &items); err != nil {
					continue
				}
				groups = append(groups, episodeGroup{season: strconv.Itoa(index), items: items})
			}
		}
	} else {
		return nil, fmt.Errorf("%w: invalid series episodes", ErrInvalidResponse)
	}

	episodes := make([]Episode, 0)
	for _, group := range groups {
		for _, raw := range group.items {
			id := clean(raw.ID)
			name := first(clean(raw.Name), clean(raw.NameAlt))
			if id == "" || name == "" {
				continue
			}
			season := integer(first(clean(raw.Season), group.season), 0)
			episodeContainer := clean(raw.Container)
			infoContainer := clean(raw.Information.Container)
			container := firstPlayableExtension(episodeContainer, infoContainer)
			episodes = append(episodes, Episode{
				ID:            id,
				Name:          name,
				SeasonNumber:  max(0, season),
				EpisodeNumber: max(0, integer(clean(raw.Episode), 0)),
				AirDate:       first(clean(raw.Information.AirDate), clean(raw.Information.ReleaseDate)),
				Duration:      first(clean(raw.Information.Duration), clean(raw.Information.DurationSecs)),
				Rating:        clean(raw.Information.Rating),
				Plot:          first(clean(raw.Information.Plot), clean(raw.Information.Overview), clean(raw.Information.Description)),
				StreamInfo:    normalizeStreamInfo(container, raw.Information.streamMetadata(), raw.streamMetadata()),
				container:     normalizedExtension(container),
			})
		}
	}
	sort.SliceStable(episodes, func(i, j int) bool {
		if episodes[i].SeasonNumber != episodes[j].SeasonNumber {
			return episodes[i].SeasonNumber < episodes[j].SeasonNumber
		}
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
		return episodes[i].Name < episodes[j].Name
	})
	return episodes, nil
}

func mergeSeasons(rawSeasons []rawSeason, episodes []Episode) []Season {
	byNumber := make(map[int]Season)
	for _, raw := range rawSeasons {
		number := integer(clean(raw.Number), -1)
		if number < 0 {
			continue
		}
		byNumber[number] = Season{Number: number, Name: clean(raw.Name), EpisodeCount: max(0, integer(clean(raw.EpisodeCount), 0))}
	}
	actualCounts := make(map[int]int)
	for _, episode := range episodes {
		actualCounts[episode.SeasonNumber]++
		if _, ok := byNumber[episode.SeasonNumber]; !ok {
			byNumber[episode.SeasonNumber] = Season{Number: episode.SeasonNumber}
		}
	}
	seasons := make([]Season, 0, len(byNumber))
	for number, season := range byNumber {
		if actualCounts[number] > 0 {
			season.EpisodeCount = actualCounts[number]
		}
		seasons = append(seasons, season)
	}
	sort.Slice(seasons, func(i, j int) bool { return seasons[i].Number < seasons[j].Number })
	return seasons
}

func (c *Client) firstSafeArtwork(values ...looseString) string {
	for _, value := range values {
		if approved := c.safeArtworkURL(clean(value)); approved != "" {
			return approved
		}
	}
	return ""
}

func clean(value looseString) string { return strings.TrimSpace(string(value)) }

func first(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstPlayableExtension(values ...string) string {
	for _, value := range values {
		if normalizedExtension(value) != "" {
			return value
		}
	}
	return ""
}

func yearFromDate(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 4 {
		if year, err := strconv.Atoi(value[:4]); err == nil && year >= 1800 && year <= 3000 {
			return value[:4]
		}
	}
	return ""
}

func integer(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}
