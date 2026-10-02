package dispatcharr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

type Credentials struct {
	Username string
	Password string
}

type Account struct {
	Username string `json:"username"`
	Status   string `json:"status"`
}

type Diagnostics struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Category struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Channel struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ChannelNumber string `json:"channel_number,omitempty"`
	CategoryID    string `json:"category_id,omitempty"`
	HasArtwork    bool   `json:"has_artwork,omitempty"`
	artworkURL    string
	epgID         string
}

// Movie is the narrow, viewer-facing representation of an XC VOD title. The
// upstream artwork location and container extension remain process-private so
// callers cannot accidentally serialize either value to the browser.
type Movie struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CategoryID string `json:"category_id,omitempty"`
	Year       string `json:"year,omitempty"`
	Rating     string `json:"rating,omitempty"`
	Added      string `json:"added,omitempty"`
	Genre      string `json:"genre,omitempty"`
	Plot       string `json:"plot,omitempty"`
	HasArtwork bool   `json:"has_artwork,omitempty"`
	artworkURL string
	container  string
}

type MovieDetail struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	CategoryID  string      `json:"category_id,omitempty"`
	Year        string      `json:"year,omitempty"`
	Runtime     string      `json:"runtime,omitempty"`
	Duration    string      `json:"duration,omitempty"`
	Rating      string      `json:"rating,omitempty"`
	Added       string      `json:"added,omitempty"`
	Genre       string      `json:"genre,omitempty"`
	Plot        string      `json:"plot,omitempty"`
	Director    string      `json:"director,omitempty"`
	Cast        string      `json:"cast,omitempty"`
	Country     string      `json:"country,omitempty"`
	ReleaseDate string      `json:"release_date,omitempty"`
	HasArtwork  bool        `json:"has_artwork,omitempty"`
	StreamInfo  *StreamInfo `json:"stream_info,omitempty"`
	artworkURL  string
	streamID    string
	container   string
}

// StreamInfo is a narrow, normalized subset of optional XC media metadata.
// Values are allowlisted or bounded before they reach this type so arbitrary
// provider strings, URLs, and implementation details cannot be serialized to
// a viewer.
type StreamInfo struct {
	Container     string `json:"container,omitempty"`
	VideoCodec    string `json:"video_codec,omitempty"`
	AudioCodec    string `json:"audio_codec,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	Resolution    string `json:"resolution,omitempty"`
	AudioChannels string `json:"audio_channels,omitempty"`
	Bitrate       int64  `json:"bitrate,omitempty"`
}

type Series struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CategoryID string `json:"category_id,omitempty"`
	Year       string `json:"year,omitempty"`
	Rating     string `json:"rating,omitempty"`
	Genre      string `json:"genre,omitempty"`
	Plot       string `json:"plot,omitempty"`
	HasArtwork bool   `json:"has_artwork,omitempty"`
	artworkURL string
}

type Season struct {
	Number       int    `json:"number"`
	Name         string `json:"name,omitempty"`
	EpisodeCount int    `json:"episode_count,omitempty"`
}

type Episode struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	SeasonNumber  int         `json:"season_number"`
	EpisodeNumber int         `json:"episode_number,omitempty"`
	AirDate       string      `json:"air_date,omitempty"`
	Duration      string      `json:"duration,omitempty"`
	Rating        string      `json:"rating,omitempty"`
	Plot          string      `json:"plot,omitempty"`
	StreamInfo    *StreamInfo `json:"stream_info,omitempty"`
	container     string
}

type SeriesDetail struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	CategoryID  string    `json:"category_id,omitempty"`
	Year        string    `json:"year,omitempty"`
	Rating      string    `json:"rating,omitempty"`
	Genre       string    `json:"genre,omitempty"`
	Plot        string    `json:"plot,omitempty"`
	Director    string    `json:"director,omitempty"`
	Cast        string    `json:"cast,omitempty"`
	ReleaseDate string    `json:"release_date,omitempty"`
	HasArtwork  bool      `json:"has_artwork,omitempty"`
	Seasons     []Season  `json:"seasons"`
	Episodes    []Episode `json:"episodes"`
	artworkURL  string
}

type Program struct {
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
}

type Artwork struct {
	ContentType string
	Data        []byte
}

type LiveStream struct {
	Body io.ReadCloser
}

type MediaKind string

const (
	MediaKindMovie  MediaKind = "movie"
	MediaKindSeries MediaKind = "series"
)

// MediaStream contains only response metadata that is safe and useful to a
// Now relay. Redirect locations and arbitrary upstream headers are never
// exposed.
type MediaStream struct {
	Body          io.ReadCloser
	StatusCode    int
	ContentType   string
	ContentLength int64
	ContentRange  string
	AcceptRanges  string
}

func (channel Channel) ArtworkURL() string {
	return channel.artworkURL
}

func (movie Movie) ArtworkURL() string         { return movie.artworkURL }
func (movie Movie) StreamID() string           { return movie.ID }
func (movie Movie) ContainerExtension() string { return movie.container }

func (movie MovieDetail) ArtworkURL() string { return movie.artworkURL }
func (movie MovieDetail) StreamID() string {
	if movie.streamID != "" {
		return movie.streamID
	}
	return movie.ID
}
func (movie MovieDetail) ContainerExtension() string { return movie.container }

func (series Series) ArtworkURL() string       { return series.artworkURL }
func (series SeriesDetail) ArtworkURL() string { return series.artworkURL }

func (episode Episode) StreamID() string {
	if episode.ID != "" {
		return episode.ID
	}
	return ""
}
func (episode Episode) ContainerExtension() string { return episode.container }

// Source-binding helpers keep sensitive upstream metadata out of JSON while
// allowing other packages to construct narrow fixtures and adapters without
// reflection. Production callers should only bind already-authorized sources.
func WithMovieSource(movie Movie, artworkURL, containerExtension string) Movie {
	movie.artworkURL = artworkURL
	movie.container = normalizedExtension(containerExtension)
	movie.HasArtwork = artworkURL != ""
	return movie
}

func WithMovieDetailSource(detail MovieDetail, streamID, containerExtension, artworkURL string) MovieDetail {
	detail.streamID = streamID
	detail.container = normalizedExtension(containerExtension)
	detail.artworkURL = artworkURL
	detail.HasArtwork = artworkURL != ""
	return detail
}

func WithSeriesArtwork(series Series, artworkURL string) Series {
	series.artworkURL = artworkURL
	series.HasArtwork = artworkURL != ""
	return series
}

func WithSeriesDetailArtwork(detail SeriesDetail, artworkURL string) SeriesDetail {
	detail.artworkURL = artworkURL
	detail.HasArtwork = artworkURL != ""
	return detail
}

func WithEpisodeSource(episode Episode, streamID, containerExtension string) Episode {
	episode.ID = streamID
	episode.container = normalizedExtension(containerExtension)
	return episode
}

type flexibleString string

func (s *flexibleString) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*s = ""
		return nil
	}

	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*s = flexibleString(text)
		return nil
	}

	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err == nil {
		*s = flexibleString(number.String())
		return nil
	}

	return fmt.Errorf("expected a string or number")
}

type flexibleAuth bool

func (a *flexibleAuth) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("true")) || bytes.Equal(data, []byte("1")) || bytes.Equal(data, []byte(`"1"`)) {
		*a = true
		return nil
	}
	if bytes.Equal(data, []byte("false")) || bytes.Equal(data, []byte("0")) || bytes.Equal(data, []byte(`"0"`)) || bytes.Equal(data, []byte("null")) {
		*a = false
		return nil
	}
	return fmt.Errorf("expected an XC auth flag")
}

// EPGChannelID is server-only join metadata, never viewer-facing JSON.
func (channel Channel) EPGChannelID() string { return channel.epgID }
