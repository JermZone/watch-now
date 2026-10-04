package dispatcharr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

var ErrDVRRejected = errors.New("Dispatcharr rejected the DVR operation")

// DVRAPI uses the viewer's separate REST credential. XC credentials never
// become management credentials and upstream custom properties stay private.
type DVRAPI interface {
	DVRIdentity(context.Context, string) (DVRIdentity, error)
	DVRRecordings(context.Context, string) ([]Recording, error)
	DVRCreate(context.Context, string, RecordingRequest) (Recording, error)
	DVRAction(context.Context, string, string, string) error
	DVROpen(context.Context, string, string, string) (MediaStream, error)
}

// DVRMasterAPI resolves permissions for an exact viewer through the supported
// administrator users endpoint. It never impersonates that viewer upstream.
type DVRMasterAPI interface {
	DVRViewerIdentity(context.Context, string, string) (DVRIdentity, error)
}
type dvrUserWire struct {
	Username   string `json:"username"`
	Level      *int   `json:"user_level"`
	Active     *bool  `json:"is_active"`
	Properties struct {
		Access string `json:"dvr_access"`
	} `json:"custom_properties"`
}

func (raw dvrUserWire) identity() (DVRIdentity, error) {
	if raw.Username == "" || raw.Level == nil {
		return DVRIdentity{}, ErrInvalidResponse
	}
	access := "none"
	if raw.Active == nil || *raw.Active {
		if *raw.Level >= 10 {
			access = "manage"
		} else if *raw.Level >= 1 {
			access = raw.Properties.Access
			if access == "" {
				access = "view"
			}
			if access != "view" && access != "manage" {
				access = "none"
			}
		}
	}
	return DVRIdentity{Username: raw.Username, Access: access}, nil
}

type DVRIdentity struct {
	Username string
	Access   string
}
type Recording struct {
	ID          string    `json:"id"`
	ChannelID   string    `json:"channel_id"`
	Title       string    `json:"title"`
	Subtitle    string    `json:"subtitle,omitempty"`
	Description string    `json:"description,omitempty"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
	Status      string    `json:"status"`
	Playable    bool      `json:"playable"`
	AiringID    string    `json:"-"`
}
type RecordingRequest struct {
	ChannelID  string              `json:"channel"`
	Start      time.Time           `json:"start_time"`
	End        time.Time           `json:"end_time"`
	Properties RecordingProperties `json:"custom_properties"`
}
type RecordingProperties struct {
	Program struct {
		Title       string `json:"title"`
		Subtitle    string `json:"sub_title,omitempty"`
		Description string `json:"description,omitempty"`
	} `json:"program"`
	AiringID string `json:"watch_now_airing,omitempty"`
}
type recordingWire struct {
	ID         flexibleString `json:"id"`
	Channel    flexibleString `json:"channel"`
	Start      time.Time      `json:"start_time"`
	End        time.Time      `json:"end_time"`
	Properties struct {
		RecordingProperties
		Status       string `json:"status"`
		RemuxSuccess bool   `json:"remux_success"`
	} `json:"custom_properties"`
}

func (r recordingWire) narrow() (Recording, error) {
	if !mediaIDPattern.MatchString(string(r.ID)) || !mediaIDPattern.MatchString(string(r.Channel)) || r.Start.IsZero() || !r.End.After(r.Start) {
		return Recording{}, ErrInvalidResponse
	}
	status := "attention"
	switch r.Properties.Status {
	case "recording":
		status = "recording"
	case "completed", "stopped":
		if r.Properties.RemuxSuccess {
			status = "recorded"
		}
	case "", "scheduled", "pending":
		if r.End.After(time.Now()) {
			status = "scheduled"
		}
	}
	return Recording{ID: string(r.ID), ChannelID: string(r.Channel), Title: firstGuideText([]string{r.Properties.Program.Title, "Recording"}, 160), Subtitle: firstGuideText([]string{r.Properties.Program.Subtitle}, 160), Description: firstGuideText([]string{r.Properties.Program.Description}, 1024), Start: r.Start, End: r.End, Status: status, Playable: status == "recorded", AiringID: firstGuideText([]string{r.Properties.AiringID}, 64)}, nil
}
func ValidDVRKey(key string) bool {
	if len(key) < 1 || len(key) > 512 {
		return false
	}
	for _, ch := range key {
		if ch < 33 || ch > 126 {
			return false
		}
	}
	return true
}
func (c *Client) dvrRequest(ctx context.Context, key, method, endpoint string, body any) (*http.Request, error) {
	if !ValidDVRKey(key) {
		return nil, ErrUnauthorized
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, ErrInvalidResponse
		}
		reader = bytes.NewReader(data)
	}
	u := *c.baseURL
	u.Path = strings.TrimRight(u.Path, "/") + endpoint
	u.RawPath = ""
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, ErrUnavailable
	}
	req.Header.Set("X-API-Key", key)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}
func (c *Client) dvrJSON(ctx context.Context, key, method, endpoint string, body, target any) error {
	req, err := c.dvrRequest(ctx, key, method, endpoint, body)
	if err != nil {
		return err
	}
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return ErrUnauthorized
	}
	if resp.StatusCode == 404 {
		return ErrNotFound
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return ErrRedirect
	}
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		return ErrDVRRejected
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ErrUnavailable
	}
	if target == nil {
		return nil
	}
	limit := min(c.maxResponse, int64(8<<20))
	if limit <= 0 {
		limit = 8 << 20
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return ErrUnavailable
	}
	if int64(len(data)) > limit {
		return ErrResponseTooBig
	}
	if json.Unmarshal(data, target) != nil {
		return ErrInvalidResponse
	}
	return nil
}
func (c *Client) DVRIdentity(ctx context.Context, key string) (DVRIdentity, error) {
	var raw dvrUserWire
	if err := c.dvrJSON(ctx, key, "GET", "/api/accounts/users/me/", nil, &raw); err != nil {
		return DVRIdentity{}, err
	}
	return raw.identity()
}
func (c *Client) DVRViewerIdentity(ctx context.Context, key, username string) (DVRIdentity, error) {
	var owner dvrUserWire
	if err := c.dvrJSON(ctx, key, "GET", "/api/accounts/users/me/", nil, &owner); err != nil {
		return DVRIdentity{}, err
	}
	if owner.Level == nil || *owner.Level < 10 || (owner.Active != nil && !*owner.Active) {
		return DVRIdentity{}, ErrUnauthorized
	}
	var users []dvrUserWire
	if err := c.dvrJSON(ctx, key, "GET", "/api/accounts/users/", nil, &users); err != nil {
		return DVRIdentity{}, err
	}
	if users == nil || len(users) > 5000 {
		return DVRIdentity{}, ErrInvalidResponse
	}
	var match *dvrUserWire
	for i := range users {
		if users[i].Username == username {
			if match != nil {
				return DVRIdentity{}, ErrInvalidResponse
			}
			match = &users[i]
		}
	}
	if match == nil {
		return DVRIdentity{}, ErrUnauthorized
	}
	return match.identity()
}

func (c *Client) DVRRecordings(ctx context.Context, key string) ([]Recording, error) {
	var raw []recordingWire
	if err := c.dvrJSON(ctx, key, "GET", "/api/channels/recordings/", nil, &raw); err != nil {
		return nil, err
	}
	if raw == nil || len(raw) > 5000 {
		return nil, ErrInvalidResponse
	}
	result := make([]Recording, 0, len(raw))
	for _, r := range raw {
		item, err := r.narrow()
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}
func (c *Client) DVRCreate(ctx context.Context, key string, input RecordingRequest) (Recording, error) {
	input.Properties.Program.Title = firstGuideText([]string{input.Properties.Program.Title}, 160)
	input.Properties.Program.Subtitle = firstGuideText([]string{input.Properties.Program.Subtitle}, 160)
	input.Properties.Program.Description = firstGuideText([]string{input.Properties.Program.Description}, 1024)
	var raw recordingWire
	err := c.dvrJSON(ctx, key, "POST", "/api/channels/recordings/", input, &raw)
	if err != nil {
		return Recording{}, err
	}
	return raw.narrow()
}
func (c *Client) DVRAction(ctx context.Context, key, id, action string) error {
	if !mediaIDPattern.MatchString(id) {
		return ErrNotFound
	}
	endpoint := "/api/channels/recordings/" + id + "/"
	method := "POST"
	var body any
	switch action {
	case "delete":
		method = "DELETE"
	case "stop":
		endpoint += "stop/"
	case "extend":
		endpoint += "extend/"
		body = map[string]int{"extra_minutes": 30}
	default:
		return ErrDVRRejected
	}
	return c.dvrJSON(ctx, key, method, endpoint, body, nil)
}
func (c *Client) DVROpen(ctx context.Context, key, id, byteRange string) (MediaStream, error) {
	if !mediaIDPattern.MatchString(id) {
		return MediaStream{}, ErrNotFound
	}
	if byteRange != "" && !byteRangePattern.MatchString(byteRange) {
		return MediaStream{}, ErrInvalidRange
	}
	req, err := c.dvrRequest(ctx, key, "GET", "/api/channels/recordings/"+id+"/file/", nil)
	if err != nil {
		return MediaStream{}, err
	}
	// DRF negotiates its API renderer before invoking the file action. A
	// video-only Accept header is rejected with 406 even though the action
	// ultimately returns a video FileResponse/StreamingHttpResponse.
	req.Header.Set("Accept", "*/*")
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
	}
	client := *c.httpClient
	client.Timeout = 0
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return MediaStream{}, ErrUnavailable
	}
	var failure error
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		failure = ErrUnauthorized
	case resp.StatusCode == 404:
		failure = ErrNotFound
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		failure = ErrRedirect
	case resp.StatusCode == 416:
		failure = &RangeRejectedError{contentRange: safeContentRange(resp.Header.Get("Content-Range"))}
	case resp.StatusCode != 200 && resp.StatusCode != 206:
		failure = ErrUnavailable
	}
	if failure != nil {
		resp.Body.Close()
		return MediaStream{}, failure
	}
	return MediaStream{Body: resp.Body, StatusCode: resp.StatusCode, ContentType: safeMediaType(resp.Header.Get("Content-Type")), ContentLength: resp.ContentLength, ContentRange: safeContentRange(resp.Header.Get("Content-Range")), AcceptRanges: safeAcceptRanges(resp.Header.Get("Accept-Ranges"))}, nil
}
