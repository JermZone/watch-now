package dispatcharr

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// DVRHLSAPI is optional so completed-recording adapters remain compatible.
type DVRHLSAPI interface {
	DVRHLSManifest(context.Context, string, string) (RecordingPlaylist, error)
	DVRHLSSegment(context.Context, string, string, string) (MediaStream, error)
}

// RecordingPlaylist contains no upstream locations or credentials. Segment
// basenames refer only to this recording and are rewritten by the Now relay.
type RecordingPlaylist struct {
	Playlist       string
	Segments       []string
	Ended          bool
	TargetDuration uint32
}

var ErrRecordingFinalized = errors.New("recording HLS has been finalized")

const (
	maxRecordingPlaylistBytes  = 1 << 20
	maxRecordingSegments       = 10000
	maxRecordingPlaylistLine   = 1024
	maxRecordingTargetDuration = 24 * 60 * 60
)

var recordingSegmentPattern = regexp.MustCompile(`^seg_[0-9]+\.ts$`)

// ValidDVRHLSSegment permits only stock Dispatcharr's TS segment filenames.
func ValidDVRHLSSegment(segment string) bool {
	return len(segment) <= 64 && recordingSegmentPattern.MatchString(segment)
}

// recordingURIPath validates a location without resolving relative paths.
// Escapes, queries and credentials are unnecessary in the supported DVR API.
func (c *Client) recordingURIPath(raw string) (string, bool) {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\\\r\n\x00#") {
		return "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		u.EscapedPath() != u.Path || u.Opaque != "" {
		return "", false
	}
	if u.IsAbs() {
		if u.Scheme != c.baseURL.Scheme || u.Host != c.baseURL.Host {
			return "", false
		}
	} else if u.Host != "" {
		return "", false
	}
	return u.Path, true
}

func (c *Client) canonicalRecordingPath(id, suffix string) string {
	return strings.TrimRight(c.baseURL.Path, "/") + "/api/channels/recordings/" + id + suffix
}

func (c *Client) recordingFileReady(raw, id string) bool {
	// Dispatcharr stores this root-relative canonical path, even when its
	// reverse proxy is mounted under a configured base path.
	if raw == "/api/channels/recordings/"+id+"/file/" {
		return true
	}
	path, ok := c.recordingURIPath(raw)
	return ok && path == c.canonicalRecordingPath(id, "/file/")
}

func (c *Client) recordingSegment(raw, id string) (string, bool) {
	if ValidDVRHLSSegment(raw) {
		return raw, true
	}
	path, ok := c.recordingURIPath(raw)
	prefix := c.canonicalRecordingPath(id, "/hls/")
	if !ok || !strings.HasPrefix(path, prefix) {
		return "", false
	}
	segment := strings.TrimPrefix(path, prefix)
	return segment, ValidDVRHLSSegment(segment)
}

func (c *Client) DVRHLSManifest(ctx context.Context, key, id string) (RecordingPlaylist, error) {
	if !mediaIDPattern.MatchString(id) {
		return RecordingPlaylist{}, ErrNotFound
	}
	req, err := c.dvrRequest(ctx, key, http.MethodGet, "/api/channels/recordings/"+id+"/hls/index.m3u8", nil)
	if err != nil {
		return RecordingPlaylist{}, err
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "identity")
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return RecordingPlaylist{}, ErrUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusFound {
		path, ok := c.recordingURIPath(resp.Header.Get("Location"))
		if ok && path == c.canonicalRecordingPath(id, "/file/") {
			return RecordingPlaylist{}, ErrRecordingFinalized
		}
	}
	if err := recordingHTTPError(resp.StatusCode); err != nil {
		return RecordingPlaylist{}, err
	}
	limit := int64(maxRecordingPlaylistBytes)
	if c.maxResponse > 0 && c.maxResponse < limit {
		limit = c.maxResponse
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return RecordingPlaylist{}, ErrUnavailable
	}
	if int64(len(body)) > limit {
		return RecordingPlaylist{}, ErrResponseTooBig
	}
	return c.parseRecordingPlaylist(string(body), id)
}

func recordingHTTPError(status int) error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrUnauthorized
	case status == http.StatusNotFound:
		return ErrNotFound
	case status >= 300 && status < 400:
		return ErrRedirect
	case status != http.StatusOK:
		return ErrUnavailable
	default:
		return nil
	}
}

func (c *Client) parseRecordingPlaylist(body, id string) (RecordingPlaylist, error) {
	if len(body) > maxRecordingPlaylistBytes {
		return RecordingPlaylist{}, ErrResponseTooBig
	}
	if body == "" || !utf8.ValidString(body) {
		return RecordingPlaylist{}, ErrInvalidResponse
	}
	result := RecordingPlaylist{Segments: make([]string, 0)}
	var output strings.Builder
	pendingSegment := false
	for i, remaining := 0, body; remaining != ""; i++ {
		raw, next, _ := strings.Cut(remaining, "\n")
		remaining = next
		line := strings.TrimSuffix(raw, "\r")
		if len(line) > maxRecordingPlaylistLine {
			return RecordingPlaylist{}, ErrResponseTooBig
		}
		if strings.ContainsAny(line, "\r\x00") {
			return RecordingPlaylist{}, ErrInvalidResponse
		}
		if i == 0 {
			if line != "#EXTM3U" {
				return RecordingPlaylist{}, ErrInvalidResponse
			}
		} else if line == "" {
			continue
		} else if strings.HasPrefix(line, "#") {
			if result.Ended || line == "#EXTM3U" {
				return RecordingPlaylist{}, ErrInvalidResponse
			}
			safe, valid, duration := safeRecordingTag(line)
			if !valid || (duration && pendingSegment) {
				return RecordingPlaylist{}, ErrInvalidResponse
			}
			line = safe
			if strings.HasPrefix(line, "#EXT-X-TARGETDURATION:") {
				n, _ := strconv.ParseUint(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:"), 10, 32)
				result.TargetDuration = uint32(n)
			}
			if duration {
				pendingSegment = true
			}
			if line == "#EXT-X-ENDLIST" {
				if pendingSegment {
					return RecordingPlaylist{}, ErrInvalidResponse
				}
				result.Ended = true
			}
		} else {
			segment, valid := c.recordingSegment(line, id)
			if !valid || !pendingSegment || result.Ended {
				return RecordingPlaylist{}, ErrInvalidResponse
			}
			if len(result.Segments) >= maxRecordingSegments {
				return RecordingPlaylist{}, ErrResponseTooBig
			}
			result.Segments = append(result.Segments, segment)
			line = segment
			pendingSegment = false
		}
		output.WriteString(line)
		output.WriteByte('\n')
	}
	if pendingSegment {
		return RecordingPlaylist{}, ErrInvalidResponse
	}
	result.Playlist = output.String()
	return result, nil
}

// Allow only the media tags emitted by the stock TS DVR pipeline. A strict
// allowlist excludes master playlists, key/map URLs and arbitrary comments.
func safeRecordingTag(line string) (string, bool, bool) {
	name, value, hasValue := strings.Cut(line, ":")
	switch name {
	case "#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-GAP":
		return line, !hasValue, false
	case "#EXT-X-PLAYLIST-TYPE":
		return line, hasValue && (value == "EVENT" || value == "VOD"), false
	case "#EXT-X-ALLOW-CACHE":
		return line, hasValue && (value == "YES" || value == "NO"), false
	case "#EXT-X-VERSION", "#EXT-X-TARGETDURATION", "#EXT-X-MEDIA-SEQUENCE", "#EXT-X-DISCONTINUITY-SEQUENCE":
		if !hasValue || value == "" {
			return "", false, false
		}
		for _, ch := range value {
			if ch < '0' || ch > '9' {
				return "", false, false
			}
		}
		n, err := strconv.ParseUint(value, 10, 64)
		positive := name == "#EXT-X-VERSION" || name == "#EXT-X-TARGETDURATION"
		bounded := name != "#EXT-X-TARGETDURATION" || n <= maxRecordingTargetDuration
		return line, err == nil && (!positive || n > 0) && bounded, false
	case "#EXT-X-PROGRAM-DATE-TIME":
		_, err := time.Parse(time.RFC3339Nano, value)
		return line, hasValue && err == nil, false
	case "#EXTINF":
		duration, _, comma := strings.Cut(value, ",")
		if !hasValue || !comma || duration == "" {
			return "", false, false
		}
		for _, ch := range duration {
			if (ch < '0' || ch > '9') && ch != '.' {
				return "", false, false
			}
		}
		n, err := strconv.ParseFloat(duration, 64)
		// Segment titles are unnecessary here and may contain upstream URLs.
		return name + ":" + duration + ",", err == nil && n > 0 && !math.IsInf(n, 0) && !math.IsNaN(n), true
	default:
		return "", false, false
	}
}

func (c *Client) DVRHLSSegment(ctx context.Context, key, id, segment string) (MediaStream, error) {
	if !mediaIDPattern.MatchString(id) || !ValidDVRHLSSegment(segment) {
		return MediaStream{}, ErrNotFound
	}
	req, err := c.dvrRequest(ctx, key, http.MethodGet, "/api/channels/recordings/"+id+"/hls/"+segment, nil)
	if err != nil {
		return MediaStream{}, err
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Encoding", "identity")
	client := *c.httpClient
	client.Timeout = 0
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return MediaStream{}, ErrUnavailable
	}
	if err := recordingHTTPError(resp.StatusCode); err != nil {
		resp.Body.Close()
		return MediaStream{}, err
	}
	return MediaStream{
		Body: resp.Body, StatusCode: resp.StatusCode, ContentType: "video/mp2t",
		ContentLength: resp.ContentLength,
	}, nil
}
