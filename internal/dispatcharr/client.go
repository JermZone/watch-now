package dispatcharr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrUnauthorized    = errors.New("Dispatcharr rejected the viewer credentials")
	ErrUnavailable     = errors.New("Dispatcharr is unavailable")
	ErrInvalidResponse = errors.New("Dispatcharr returned an unsupported response")
	ErrResponseTooBig  = errors.New("Dispatcharr response exceeded the configured limit")
	ErrArtworkMissing  = errors.New("Dispatcharr did not provide usable artwork")
	ErrNotFound        = errors.New("Dispatcharr resource was not found")
	ErrRedirect        = errors.New("Dispatcharr media response redirected")
	ErrInvalidMedia    = errors.New("invalid media request")
	ErrInvalidRange    = errors.New("invalid byte range")
	ErrRangeRejected   = errors.New("Dispatcharr rejected the byte range")
)

// RangeRejectedError carries only a validated RFC Content-Range value. It
// never contains an upstream URL, response body, or arbitrary header data.
type RangeRejectedError struct {
	contentRange string
}

func (err *RangeRejectedError) Error() string        { return ErrRangeRejected.Error() }
func (err *RangeRejectedError) Unwrap() error        { return ErrRangeRejected }
func (err *RangeRejectedError) ContentRange() string { return err.contentRange }

var artworkPathPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^/api/channels/logos/[0-9]+/cache/?$`),
	regexp.MustCompile(`^/api/vod/vodlogos/[0-9]+/cache/?$`),
	regexp.MustCompile(`^/api/vod/(movies|series|episodes)/[0-9]+/image/?$`),
}

type API interface {
	Diagnostics(context.Context) Diagnostics
	Authenticate(context.Context, Credentials) (Account, error)
	LiveCategories(context.Context, Credentials) ([]Category, error)
	LiveChannels(context.Context, Credentials, string) ([]Channel, error)
	LiveEPG(context.Context, Credentials, string) ([]Program, error)
	ChannelArtwork(context.Context, Channel) (Artwork, error)
	OpenLiveStream(context.Context, Credentials, string) (LiveStream, error)
	MovieCategories(context.Context, Credentials) ([]Category, error)
	Movies(context.Context, Credentials, string) ([]Movie, error)
	MovieDetails(context.Context, Credentials, string) (MovieDetail, error)
	SeriesCategories(context.Context, Credentials) ([]Category, error)
	Series(context.Context, Credentials, string) ([]Series, error)
	SeriesDetails(context.Context, Credentials, string) (SeriesDetail, error)
	MediaArtwork(context.Context, string) (Artwork, error)
	OpenMedia(context.Context, Credentials, MediaKind, string, string, string, string) (MediaStream, error)
}

func (c *Client) OpenLiveStream(ctx context.Context, credentials Credentials, channelID string) (LiveStream, error) {
	requestURL := *c.baseURL
	escapedPath := strings.TrimRight(c.baseURL.EscapedPath(), "/") + "/live/" +
		url.PathEscape(credentials.Username) + "/" + url.PathEscape(credentials.Password) + "/" +
		url.PathEscape(channelID) + ".ts"
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil {
		return LiveStream{}, fmt.Errorf("%w: construct live stream path", ErrInvalidResponse)
	}
	requestURL.Path = decodedPath
	requestURL.RawPath = escapedPath
	requestURL.RawQuery = ""

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return LiveStream{}, fmt.Errorf("%w: create live stream request", ErrUnavailable)
	}
	request.Header.Set("User-Agent", "Dispatcharr-Now/phase3a")

	// Live streams have no fixed completion time. Retain the transport's
	// response-header timeout, but do not apply the JSON client's total timeout.
	streamClient := *c.httpClient
	streamClient.Timeout = 0
	streamClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := streamClient.Do(request)
	if err != nil {
		return LiveStream{}, fmt.Errorf("%w: live stream request failed", ErrUnavailable)
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		response.Body.Close()
		return LiveStream{}, ErrRedirect
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		response.Body.Close()
		return LiveStream{}, ErrUnauthorized
	}
	if response.StatusCode == http.StatusNotFound {
		response.Body.Close()
		return LiveStream{}, ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return LiveStream{}, fmt.Errorf("%w: live stream HTTP %d", ErrUnavailable, response.StatusCode)
	}
	return LiveStream{Body: response.Body}, nil
}

type Client struct {
	baseURL       *url.URL
	httpClient    *http.Client
	maxResponse   int64
	maxArtwork    int64
	mediaSessions *mediaSessionStore
}

func NewClient(baseURL *url.URL, httpClient *http.Client, maxResponse, maxArtwork int64) *Client {
	copyURL := *baseURL
	return &Client{
		baseURL: &copyURL, httpClient: httpClient, maxResponse: maxResponse,
		maxArtwork: maxArtwork, mediaSessions: newMediaSessionStore(),
	}
}

func (c *Client) Diagnostics(ctx context.Context) Diagnostics {
	var payload struct {
		Version   flexibleString `json:"version"`
		Timestamp flexibleString `json:"timestamp"`
	}
	if err := c.getJSON(ctx, "api/core/version/", nil, &payload); err != nil {
		return Diagnostics{Reachable: false, Error: publicError(err)}
	}
	return Diagnostics{
		Reachable: true,
		Version:   string(payload.Version),
		Timestamp: string(payload.Timestamp),
	}
}

func (c *Client) Authenticate(ctx context.Context, credentials Credentials) (Account, error) {
	var payload struct {
		UserInfo struct {
			Username flexibleString `json:"username"`
			Auth     flexibleAuth   `json:"auth"`
			Status   flexibleString `json:"status"`
		} `json:"user_info"`
	}
	if err := c.getJSON(ctx, "player_api.php", credentialValues(credentials), &payload); err != nil {
		return Account{}, err
	}
	if !bool(payload.UserInfo.Auth) {
		return Account{}, ErrUnauthorized
	}
	username := strings.TrimSpace(string(payload.UserInfo.Username))
	if username == "" {
		username = credentials.Username
	}
	return Account{Username: username, Status: string(payload.UserInfo.Status)}, nil
}

func (c *Client) LiveCategories(ctx context.Context, credentials Credentials) ([]Category, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_live_categories")
	var payload []struct {
		ID   flexibleString `json:"category_id"`
		Name flexibleString `json:"category_name"`
	}
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	categories := make([]Category, 0, len(payload))
	for _, raw := range payload {
		id := strings.TrimSpace(string(raw.ID))
		name := strings.TrimSpace(string(raw.Name))
		if id == "" || name == "" {
			return nil, fmt.Errorf("%w: live category missing category_id or category_name", ErrInvalidResponse)
		}
		categories = append(categories, Category{ID: id, Name: name})
	}
	return categories, nil
}

func (c *Client) LiveChannels(ctx context.Context, credentials Credentials, categoryID string) ([]Channel, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_live_streams")
	if categoryID != "" {
		query.Set("category_id", categoryID)
	}
	var payload []struct {
		ID         flexibleString `json:"stream_id"`
		Name       flexibleString `json:"name"`
		Number     flexibleString `json:"num"`
		CategoryID flexibleString `json:"category_id"`
		StreamIcon flexibleString `json:"stream_icon"`
		EPGID      flexibleString `json:"epg_channel_id"`
	}
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	channels := make([]Channel, 0, len(payload))
	for _, raw := range payload {
		id := strings.TrimSpace(string(raw.ID))
		name := strings.TrimSpace(string(raw.Name))
		if id == "" || name == "" {
			return nil, fmt.Errorf("%w: live stream missing stream_id or name", ErrInvalidResponse)
		}
		channel := Channel{
			ID:            id,
			Name:          name,
			ChannelNumber: string(raw.Number),
			CategoryID:    string(raw.CategoryID),
			epgID:         strings.TrimSpace(string(raw.EPGID)),
		}
		if artworkURL := c.safeArtworkURL(string(raw.StreamIcon)); artworkURL != "" {
			channel.HasArtwork = true
			channel.artworkURL = artworkURL
		}
		channels = append(channels, channel)
	}
	return channels, nil
}

func (c *Client) LiveEPG(ctx context.Context, credentials Credentials, channelID string) ([]Program, error) {
	query := credentialValues(credentials)
	query.Set("action", "get_short_epg")
	query.Set("stream_id", channelID)
	query.Set("limit", "6")
	var payload struct {
		Listings []struct {
			EPGID          flexibleString `json:"epg_id"`
			Title          flexibleString `json:"title"`
			Description    flexibleString `json:"description"`
			Start          flexibleString `json:"start"`
			End            flexibleString `json:"end"`
			StartTimestamp flexibleString `json:"start_timestamp"`
			StopTimestamp  flexibleString `json:"stop_timestamp"`
		} `json:"epg_listings"`
	}
	if err := c.getJSON(ctx, "player_api.php", query, &payload); err != nil {
		return nil, err
	}
	programs := make([]Program, 0, len(payload.Listings))
	for _, raw := range payload.Listings {
		// Dispatcharr uses EPG ID zero for its generated no-guide fallback.
		if strings.TrimSpace(string(raw.EPGID)) == "0" {
			continue
		}
		start, startOK := parseEPGTime(string(raw.StartTimestamp), string(raw.Start))
		end, endOK := parseEPGTime(string(raw.StopTimestamp), string(raw.End))
		if !startOK || !endOK || !end.After(start) {
			continue
		}
		programs = append(programs, Program{
			Title:       decodeEPGText(string(raw.Title)),
			Description: decodeEPGText(string(raw.Description)),
			Start:       start,
			End:         end,
		})
	}
	return programs, nil
}

func (c *Client) ChannelArtwork(ctx context.Context, channel Channel) (Artwork, error) {
	return c.MediaArtwork(ctx, channel.ArtworkURL())
}

func (c *Client) MediaArtwork(ctx context.Context, rawURL string) (Artwork, error) {
	artworkURL := c.safeArtworkURL(rawURL)
	if artworkURL == "" {
		return Artwork{}, ErrArtworkMissing
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artworkURL, nil)
	if err != nil {
		return Artwork{}, ErrArtworkMissing
	}
	request.Header.Set("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8")
	request.Header.Set("User-Agent", "Dispatcharr-Now/1.0.0")
	artworkClient := *c.httpClient
	artworkClient.CheckRedirect = func(redirected *http.Request, via []*http.Request) error {
		if len(via) >= 3 || c.safeArtworkURL(redirected.URL.String()) == "" {
			return http.ErrUseLastResponse
		}
		return nil
	}
	response, err := artworkClient.Do(request)
	if err != nil {
		return Artwork{}, fmt.Errorf("%w: artwork request failed", ErrUnavailable)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return Artwork{}, ErrArtworkMissing
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Artwork{}, fmt.Errorf("%w: artwork HTTP %d", ErrUnavailable, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, c.maxArtwork+1))
	if err != nil {
		return Artwork{}, fmt.Errorf("%w: read artwork", ErrUnavailable)
	}
	if int64(len(data)) > c.maxArtwork {
		return Artwork{}, ErrResponseTooBig
	}
	contentType := safeImageType(response.Header.Get("Content-Type"), data)
	if contentType == "" {
		return Artwork{}, ErrArtworkMissing
	}
	return Artwork{ContentType: contentType, Data: data}, nil
}

func (c *Client) safeArtworkURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.Fragment != "" || len(parsed.RawQuery) > 512 {
		return ""
	}
	if parsed.Scheme == "" && parsed.Host == "" {
		base := *c.baseURL
		if !strings.HasPrefix(parsed.Path, "/") {
			base.Path = strings.TrimRight(base.Path, "/") + "/"
		}
		parsed = base.ResolveReference(parsed)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if !strings.EqualFold(parsed.Scheme, c.baseURL.Scheme) || !strings.EqualFold(parsed.Host, c.baseURL.Host) {
		return ""
	}
	artworkPath := parsed.EscapedPath()
	basePath := strings.TrimRight(c.baseURL.EscapedPath(), "/")
	if basePath != "" && strings.HasPrefix(artworkPath, basePath+"/") {
		artworkPath = strings.TrimPrefix(artworkPath, basePath)
	}
	allowedPath := false
	for _, pattern := range artworkPathPatterns {
		if pattern.MatchString(artworkPath) {
			allowedPath = true
			break
		}
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil || !allowedPath || !safeArtworkQuery(query) {
		return ""
	}
	return parsed.String()
}

func safeArtworkQuery(query url.Values) bool {
	for key, values := range query {
		switch key {
		case "kind", "index", "m3u_account_id", "v":
		default:
			return false
		}
		if len(values) != 1 || len(values[0]) > 128 || strings.ContainsAny(values[0], "\x00\r\n") {
			return false
		}
	}
	return true
}

func parseEPGTime(timestamp, formatted string) (time.Time, bool) {
	if seconds, err := strconv.ParseInt(strings.TrimSpace(timestamp), 10, 64); err == nil && seconds > 0 {
		return time.Unix(seconds, 0).UTC(), true
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", strings.TrimSpace(formatted), time.UTC)
	return parsed, err == nil
}

func decodeEPGText(value string) string {
	value = strings.TrimSpace(value)
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err == nil && utf8.Valid(decoded) {
		text := strings.TrimSpace(string(decoded))
		if text != "" {
			return text
		}
	}
	return value
}

func safeImageType(upstreamType string, data []byte) string {
	detected := http.DetectContentType(data)
	switch detected {
	case "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp", "image/vnd.microsoft.icon", "image/x-icon":
		return detected
	}
	mediaType, _, _ := mime.ParseMediaType(upstreamType)
	trimmed := bytes.ToLower(bytes.TrimSpace(data))
	if strings.EqualFold(mediaType, "image/svg+xml") && (bytes.HasPrefix(trimmed, []byte("<svg")) || (bytes.HasPrefix(trimmed, []byte("<?xml")) && bytes.Contains(trimmed[:min(len(trimmed), 1024)], []byte("<svg")))) {
		return "image/svg+xml"
	}
	return ""
}

func (c *Client) getJSON(ctx context.Context, endpoint string, query url.Values, destination any) error {
	requestURL := *c.baseURL
	requestURL.Path = path.Join(c.baseURL.Path, endpoint)
	if strings.HasSuffix(endpoint, "/") && !strings.HasSuffix(requestURL.Path, "/") {
		requestURL.Path += "/"
	}
	requestURL.RawQuery = query.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return fmt.Errorf("create Dispatcharr request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Dispatcharr-Now/1.0.0")

	jsonClient := *c.httpClient
	jsonClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := jsonClient.Do(request)
	if err != nil {
		return fmt.Errorf("%w: request failed", ErrUnavailable)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return ErrUnauthorized
	}
	if response.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%w: HTTP %d", ErrUnavailable, response.StatusCode)
	}

	limited := io.LimitReader(response.Body, c.maxResponse+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("%w: read response", ErrUnavailable)
	}
	if int64(len(data)) > c.maxResponse {
		return ErrResponseTooBig
	}
	if err := json.Unmarshal(data, destination); err != nil {
		return fmt.Errorf("%w: invalid JSON", ErrInvalidResponse)
	}
	return nil
}

func credentialValues(credentials Credentials) url.Values {
	return url.Values{
		"username": []string{credentials.Username},
		"password": []string{credentials.Password},
	}
}

func publicError(err error) string {
	switch {
	case errors.Is(err, ErrUnauthorized):
		return "authentication required"
	case errors.Is(err, ErrInvalidResponse):
		return "version response was not understood"
	case errors.Is(err, ErrResponseTooBig):
		return "version response was too large"
	default:
		return "connection failed"
	}
}
