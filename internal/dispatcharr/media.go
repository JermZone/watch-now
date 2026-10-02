package dispatcharr

import (
	"context"
	"crypto/sha256"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	mediaIDPattern          = regexp.MustCompile(`^[0-9]{1,20}$`)
	extensionPattern        = regexp.MustCompile(`^[A-Za-z0-9]{1,10}$`)
	byteRangePattern        = regexp.MustCompile(`^bytes=([0-9]*)-([0-9]*)$`)
	contentRangePattern     = regexp.MustCompile(`^bytes [0-9]+-[0-9]+/([0-9]+|\*)$`)
	unsatisfiedRangePattern = regexp.MustCompile(`^bytes \*/[0-9]+$`)
	mediaSessionPattern     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
)

const (
	mediaSessionCacheLimit = 2048
	mediaSessionIdleTTL    = 10 * time.Minute
	mediaSessionHardTTL    = 6 * time.Hour
)

type mediaSessionRecord struct {
	id          string
	expiresAt   time.Time
	hardExpires time.Time
}

type mediaSessionStore struct {
	mu    sync.Mutex
	items map[[sha256.Size]byte]mediaSessionRecord
	gates map[[sha256.Size]byte]*mediaSessionGate
	now   func() time.Time
	limit int
}

type mediaSessionGate struct {
	token chan struct{}
	refs  int
}

func newMediaSessionStore() *mediaSessionStore {
	return &mediaSessionStore{
		items: make(map[[sha256.Size]byte]mediaSessionRecord),
		gates: make(map[[sha256.Size]byte]*mediaSessionGate),
		now:   time.Now,
		limit: mediaSessionCacheLimit,
	}
}

func (c *Client) OpenMedia(ctx context.Context, credentials Credentials, kind MediaKind, streamID, extension, rangeHeader, relayID string) (MediaStream, error) {
	if kind != MediaKindMovie && kind != MediaKindSeries {
		return MediaStream{}, fmt.Errorf("%w: unsupported media kind", ErrInvalidMedia)
	}
	streamID = strings.TrimSpace(streamID)
	extension = normalizedExtension(extension)
	if !mediaIDPattern.MatchString(streamID) || extension == "" {
		return MediaStream{}, fmt.Errorf("%w: invalid stream identifier or container extension", ErrInvalidMedia)
	}
	if !validByteRange(rangeHeader) {
		return MediaStream{}, ErrInvalidRange
	}

	requestURL := *c.baseURL
	escapedPath := strings.TrimRight(c.baseURL.EscapedPath(), "/") + "/" + string(kind) + "/" +
		url.PathEscape(credentials.Username) + "/" + url.PathEscape(credentials.Password) + "/" +
		url.PathEscape(streamID) + "." + extension
	decodedPath, err := url.PathUnescape(escapedPath)
	if err != nil {
		return MediaStream{}, fmt.Errorf("%w: construct media path", ErrInvalidMedia)
	}
	requestURL.Path = decodedPath
	requestURL.RawPath = escapedPath
	requestURL.RawQuery = ""
	sessionKey := mediaSessionKey(credentials, kind, streamID, extension, relayID)
	releaseSessionGate, acquired := c.mediaSessions.acquire(ctx, sessionKey)
	if !acquired {
		return MediaStream{}, ctx.Err()
	}
	defer releaseSessionGate()
	if sessionID, ok := c.mediaSessions.get(sessionKey); ok {
		query := url.Values{}
		query.Set("session_id", sessionID)
		requestURL.RawQuery = query.Encode()
	}

	mediaClient := *c.httpClient
	mediaClient.Timeout = 0
	mediaClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}

	var response *http.Response
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
		if err != nil {
			return MediaStream{}, fmt.Errorf("%w: create media request", ErrUnavailable)
		}
		request.Header.Set("Accept-Encoding", "identity")
		request.Header.Set("User-Agent", "Dispatcharr-Now/vod")
		if rangeHeader != "" {
			request.Header.Set("Range", rangeHeader)
		}
		response, err = mediaClient.Do(request)
		if err != nil {
			return MediaStream{}, fmt.Errorf("%w: media request failed", ErrUnavailable)
		}
		if response.StatusCode < 300 || response.StatusCode >= 400 {
			break
		}
		next, ok := safeMediaSessionRedirect(request.URL, response)
		response.Body.Close()
		if !ok || attempt != 0 {
			c.mediaSessions.delete(sessionKey)
			return MediaStream{}, ErrRedirect
		}
		c.mediaSessions.put(sessionKey, next.Query().Get("session_id"))
		requestURL = *next
	}
	if response == nil {
		return MediaStream{}, ErrUnavailable
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		response.Body.Close()
		c.mediaSessions.delete(sessionKey)
		return MediaStream{}, ErrUnauthorized
	}
	if response.StatusCode == http.StatusNotFound {
		response.Body.Close()
		c.mediaSessions.delete(sessionKey)
		return MediaStream{}, ErrNotFound
	}
	if response.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		contentRange := safeUnsatisfiedContentRange(response.Header.Get("Content-Range"))
		response.Body.Close()
		if contentRange != "" {
			return MediaStream{}, &RangeRejectedError{contentRange: contentRange}
		}
		return MediaStream{}, ErrRangeRejected
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		response.Body.Close()
		return MediaStream{}, fmt.Errorf("%w: media HTTP %d", ErrUnavailable, response.StatusCode)
	}

	contentRange := safeContentRange(response.Header.Get("Content-Range"))
	if response.StatusCode == http.StatusPartialContent && contentRange == "" {
		response.Body.Close()
		return MediaStream{}, fmt.Errorf("%w: partial media response omitted a valid Content-Range", ErrInvalidResponse)
	}
	return MediaStream{
		Body:          response.Body,
		StatusCode:    response.StatusCode,
		ContentType:   safeMediaType(response.Header.Get("Content-Type")),
		ContentLength: response.ContentLength,
		ContentRange:  contentRange,
		AcceptRanges:  safeAcceptRanges(response.Header.Get("Accept-Ranges")),
	}, nil
}

func (store *mediaSessionStore) acquire(ctx context.Context, key [sha256.Size]byte) (func(), bool) {
	store.mu.Lock()
	gate := store.gates[key]
	if gate == nil {
		gate = &mediaSessionGate{token: make(chan struct{}, 1)}
		gate.token <- struct{}{}
		store.gates[key] = gate
	}
	gate.refs++
	store.mu.Unlock()

	select {
	case <-ctx.Done():
		store.releaseGateReference(key, gate)
		return nil, false
	case <-gate.token:
	}
	return func() {
		gate.token <- struct{}{}
		store.releaseGateReference(key, gate)
	}, true
}

func (store *mediaSessionStore) releaseGateReference(key [sha256.Size]byte, gate *mediaSessionGate) {
	store.mu.Lock()
	gate.refs--
	if gate.refs == 0 {
		delete(store.gates, key)
	}
	store.mu.Unlock()
}

func mediaSessionKey(credentials Credentials, kind MediaKind, streamID, extension, relayID string) [sha256.Size]byte {
	hash := sha256.New()
	for _, value := range []string{credentials.Username, credentials.Password, string(kind), streamID, extension, relayID} {
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0})
	}
	var key [sha256.Size]byte
	copy(key[:], hash.Sum(nil))
	return key
}

func (store *mediaSessionStore) get(key [sha256.Size]byte) (string, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.now()
	store.removeExpiredLocked(now)
	record, ok := store.items[key]
	if !ok {
		return "", false
	}
	record.expiresAt = earlierTime(now.Add(mediaSessionIdleTTL), record.hardExpires)
	store.items[key] = record
	return record.id, true
}

func (store *mediaSessionStore) put(key [sha256.Size]byte, sessionID string) {
	if !mediaSessionPattern.MatchString(sessionID) {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	now := store.now()
	store.removeExpiredLocked(now)
	if _, exists := store.items[key]; !exists && len(store.items) >= store.limit {
		var oldestKey [sha256.Size]byte
		var oldest time.Time
		for candidate, record := range store.items {
			if oldest.IsZero() || record.expiresAt.Before(oldest) {
				oldestKey, oldest = candidate, record.expiresAt
			}
		}
		delete(store.items, oldestKey)
	}
	store.items[key] = mediaSessionRecord{
		id: sessionID, expiresAt: now.Add(mediaSessionIdleTTL), hardExpires: now.Add(mediaSessionHardTTL),
	}
}

func (store *mediaSessionStore) delete(key [sha256.Size]byte) {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.items, key)
}

func (store *mediaSessionStore) removeExpiredLocked(now time.Time) {
	for key, record := range store.items {
		if !now.Before(record.expiresAt) || !now.Before(record.hardExpires) {
			delete(store.items, key)
		}
	}
}

func earlierTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}

func safeMediaSessionRedirect(current *url.URL, response *http.Response) (*url.URL, bool) {
	if response.StatusCode != http.StatusMovedPermanently &&
		response.StatusCode != http.StatusFound &&
		response.StatusCode != http.StatusTemporaryRedirect &&
		response.StatusCode != http.StatusPermanentRedirect {
		return nil, false
	}
	next, err := response.Location()
	if err != nil || next.User != nil || next.Fragment != "" ||
		!strings.EqualFold(next.Scheme, current.Scheme) ||
		!strings.EqualFold(next.Host, current.Host) || next.Path != current.Path {
		return nil, false
	}
	query, err := url.ParseQuery(next.RawQuery)
	if err != nil || len(query) != 1 {
		return nil, false
	}
	values, ok := query["session_id"]
	if !ok || len(values) != 1 || !mediaSessionPattern.MatchString(values[0]) {
		return nil, false
	}
	return next, true
}

func normalizedExtension(value string) string {
	value = strings.TrimSpace(value)
	if !extensionPattern.MatchString(value) {
		return ""
	}
	return strings.ToLower(value)
}

func validByteRange(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > 128 {
		return false
	}
	parts := byteRangePattern.FindStringSubmatch(value)
	if parts == nil || (parts[1] == "" && parts[2] == "") {
		return false
	}
	if parts[1] != "" {
		start, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			return false
		}
		if parts[2] != "" {
			end, err := strconv.ParseUint(parts[2], 10, 64)
			if err != nil || start > end {
				return false
			}
		}
		return true
	}
	suffix, err := strconv.ParseUint(parts[2], 10, 64)
	return err == nil && suffix > 0
}

func safeContentRange(value string) string {
	value = strings.TrimSpace(value)
	if !contentRangePattern.MatchString(value) {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(value, "bytes "), "/")
	bounds := strings.Split(parts[0], "-")
	start, startErr := strconv.ParseUint(bounds[0], 10, 64)
	end, endErr := strconv.ParseUint(bounds[1], 10, 64)
	if startErr != nil || endErr != nil || start > end {
		return ""
	}
	if parts[1] != "*" {
		total, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil || total == 0 || end >= total {
			return ""
		}
	}
	return value
}

func safeUnsatisfiedContentRange(value string) string {
	value = strings.TrimSpace(value)
	if !unsatisfiedRangePattern.MatchString(value) {
		return ""
	}
	if _, err := strconv.ParseUint(strings.TrimPrefix(value, "bytes */"), 10, 63); err != nil {
		return ""
	}
	return value
}

func safeAcceptRanges(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "bytes") {
		return "bytes"
	}
	return ""
}

func safeMediaType(value string) string {
	mediaType, parameters, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil || strings.ContainsAny(mediaType, "\x00\r\n") ||
		(!strings.HasPrefix(mediaType, "video/") && !strings.HasPrefix(mediaType, "audio/") && mediaType != "application/octet-stream") {
		return ""
	}
	return mime.FormatMediaType(mediaType, parameters)
}
