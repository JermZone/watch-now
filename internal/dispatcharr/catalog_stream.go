package dispatcharr

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"reflect"
	"strings"
)

const (
	maxCatalogItems         = 100000
	maxCatalogRetainedBytes = 16 << 20
	maxCatalogItemBytes     = 256 << 10
)

// Decode one upstream item at a time. The configured wire limit remains in
// force; per-item structural budgets precede typed decoding, and retained
// narrow fields and slice storage have a separate aggregate memory budget.
func readCatalog[Wire, Item any](ctx context.Context, c *Client, query url.Values, narrow func(Wire) (Item, bool), retain func(*Item) int64) ([]Item, error) {
	if err := c.acquireMetadata(ctx); err != nil {
		return nil, err
	}
	defer c.releaseMetadata()
	response, err := c.openJSON(ctx, "player_api.php", query)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	limit := min(c.maxResponse, int64(32<<20))
	if response.ContentLength > limit {
		return nil, ErrResponseTooBig
	}
	wire := &io.LimitedReader{R: response.Body, N: limit + 1}
	window := &catalogWindow{source: wire}
	decoder := json.NewDecoder(window)
	failure := func(err error) error {
		if wire.N == 0 || errors.Is(err, ErrResponseTooBig) {
			return ErrResponseTooBig
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrInvalidResponse
	}
	token, err := decoder.Token()
	window.completed = decoder.InputOffset()
	if err != nil {
		return nil, failure(err)
	}
	result := []Item{}
	if token != nil && token != json.Delim('[') {
		return nil, ErrInvalidResponse
	}
	count := 0
	var retainedStrings int64
	itemSize := int64(reflect.TypeFor[Item]().Size())
	if token != nil {
		for decoder.More() {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			count++
			if count > maxCatalogItems {
				return nil, ErrResponseTooBig
			}
			var data json.RawMessage
			if err := decoder.Decode(&data); err != nil {
				return nil, failure(err)
			}
			window.completed = decoder.InputOffset()
			if wire.N == 0 {
				return nil, ErrResponseTooBig
			}
			if err := validateJSONBudget(data, 20000); err != nil {
				return nil, err
			}
			var raw Wire
			if json.Unmarshal(data, &raw) != nil {
				return nil, ErrInvalidResponse
			}
			item, ok := narrow(raw)
			if !ok {
				continue
			}
			retainedStrings += retain(&item)
			capacity := cap(result)
			if len(result) == capacity {
				capacity = min(maxCatalogItems, capacity+1024)
			}
			if retainedStrings+int64(capacity)*itemSize > maxCatalogRetainedBytes {
				return nil, ErrResponseTooBig
			}
			if capacity != cap(result) {
				next := make([]Item, len(result), capacity)
				copy(next, result)
				result = next
			}
			result = append(result, item)
		}
		end, err := decoder.Token()
		window.completed = decoder.InputOffset()
		if err != nil {
			return nil, failure(err)
		}
		if end != json.Delim(']') {
			return nil, ErrInvalidResponse
		}
	}
	// Reject trailing JSON or truncated transport, never return a partial list.
	var extra json.RawMessage
	err = decoder.Decode(&extra)
	if wire.N == 0 {
		return nil, ErrResponseTooBig
	}
	if err != io.EOF {
		return nil, failure(err)
	}
	return result, nil
}

type catalogWindow struct {
	source          io.Reader
	read, completed int64
}

func (r *catalogWindow) Read(p []byte) (int, error) {
	remaining := int64(maxCatalogItemBytes) - (r.read - r.completed)
	if remaining <= 0 {
		return 0, ErrResponseTooBig
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := r.source.Read(p)
	r.read += int64(n)
	return n, err
}

// Clone retained strings so trimmed fields and derived years cannot retain a
// large backing allocation that the narrow-field budget would undercount.
func compactStrings(fields ...*string) int64 {
	var size int64
	for _, field := range fields {
		*field = strings.Clone(*field)
		size += int64(len(*field))
	}
	return size
}
func compactMovie(m *Movie) int64 {
	return compactStrings(&m.ID, &m.Name, &m.CategoryID, &m.Year, &m.Rating, &m.Added, &m.Genre, &m.Plot, &m.artworkURL, &m.container)
}
func compactSeries(s *Series) int64 {
	return compactStrings(&s.ID, &s.Name, &s.CategoryID, &s.Year, &s.Rating, &s.Genre, &s.Plot, &s.artworkURL)
}
func compactChannel(c *Channel) int64 {
	return compactStrings(&c.ID, &c.Name, &c.ChannelNumber, &c.CategoryID, &c.artworkURL, &c.epgID)
}
