package dispatcharr

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxGuideBytes int64 = 32 << 20
const MaxGuideIndexBytes int64 = 8 << 20
const maxGuidePrograms = 50000
const maxScannedPrograms = 200000

var ErrGuideLimit = errors.New("program guide exceeds search limits")
var ErrGuideMapping = errors.New("program guide channel mapping is unsupported")

type GuideProgram struct {
	ChannelID, ChannelKey, ChannelName, Title string
	Start, End                                time.Time
}
type GuideIndex struct {
	Programs        []GuideProgram
	Bytes           int64
	TransferBytes   int64
	MappedChannels  int
	ScannedPrograms int
}

// Optional capability keeps clients without bulk XMLTV support usable.
type GuideAPI interface {
	LiveGuide(context.Context, Credentials, []Channel) (GuideIndex, error)
}

func (c *Client) LiveGuide(ctx context.Context, credentials Credentials, channels []Channel) (GuideIndex, error) {
	requestURL := *c.baseURL
	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/xmltv.php"
	requestURL.RawPath = ""
	query := credentialValues(credentials)
	query.Set("days", "1")
	query.Set("prev_days", "0")
	query.Set("tvg_id_source", "channel_number")
	requestURL.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return GuideIndex{}, ErrUnavailable
	}
	request.Header.Set("User-Agent", "Dispatcharr-Now/guide-search")
	client := *c.httpClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return GuideIndex{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return GuideIndex{}, ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return GuideIndex{}, ErrUnavailable
	}
	limit := min(c.maxResponse, MaxGuideBytes)
	if response.ContentLength > limit {
		return GuideIndex{}, ErrGuideLimit
	}
	reader := &io.LimitedReader{R: response.Body, N: limit + 1}
	index, err := parseGuide(ctx, reader, channels, time.Now())
	if reader.N == 0 {
		return GuideIndex{}, ErrGuideLimit
	}
	if err == nil {
		index.TransferBytes = limit + 1 - reader.N
	}
	return index, err
}

func parseGuide(ctx context.Context, reader io.Reader, channels []Channel, now time.Time) (GuideIndex, error) {
	allowed := make(map[string]Channel)
	ambiguous := make(map[string]bool)
	for _, channel := range channels {
		key := channel.EPGChannelID()
		if key == "" || len(key) > 128 || len(channel.Name) > 512 || ambiguous[key] {
			continue
		}
		if _, found := allowed[key]; found {
			delete(allowed, key)
			ambiguous[key] = true
			continue
		}
		allowed[key] = channel
	}
	mapped := make(map[string]Channel)
	defined := make(map[string]bool)
	decoder := xml.NewDecoder(reader)
	index := GuideIndex{Programs: []GuideProgram{}}
	horizon := now.Add(24 * time.Hour)
	scanned := 0
	var stringBytes int64
	rootSeen, rootClosed := false, false
	depth := 0
	for {
		if err := ctx.Err(); err != nil {
			return GuideIndex{}, err
		}
		token, err := decoder.Token()
		if err == io.EOF {
			if !rootSeen || !rootClosed {
				return GuideIndex{}, ErrInvalidResponse
			}
			break
		}
		if err != nil {
			return GuideIndex{}, ErrInvalidResponse
		}
		switch node := token.(type) {
		case xml.Directive:
			return GuideIndex{}, ErrInvalidResponse
		case xml.StartElement:
			if depth == 0 {
				if rootSeen || node.Name.Local != "tv" {
					return GuideIndex{}, ErrInvalidResponse
				}
				rootSeen = true
				depth++
				continue
			}
			if depth != 1 {
				depth++
				continue
			}
			switch node.Name.Local {
			case "channel":
				var raw struct {
					ID    string   `xml:"id,attr"`
					Names []string `xml:"display-name"`
				}
				if decoder.DecodeElement(&raw, &node) != nil {
					return GuideIndex{}, ErrInvalidResponse
				}
				if defined[raw.ID] {
					delete(mapped, raw.ID)
					ambiguous[raw.ID] = true
					continue
				}
				defined[raw.ID] = true
				channel, ok := allowed[raw.ID]
				if !ok || ambiguous[raw.ID] {
					continue
				}
				for _, name := range raw.Names {
					if normalizedGuideText(name) == normalizedGuideText(channel.Name) {
						mapped[raw.ID] = channel
						break
					}
				}
			case "programme":
				scanned++
				if scanned > maxScannedPrograms {
					return GuideIndex{}, ErrGuideLimit
				}
				var raw struct {
					Channel string   `xml:"channel,attr"`
					Start   string   `xml:"start,attr"`
					End     string   `xml:"stop,attr"`
					Titles  []string `xml:"title"`
				}
				if decoder.DecodeElement(&raw, &node) != nil {
					return GuideIndex{}, ErrInvalidResponse
				}
				channel, ok := mapped[raw.Channel]
				if !ok || ambiguous[raw.Channel] {
					continue
				}
				start, err := time.Parse("20060102150405 -0700", strings.TrimSpace(raw.Start))
				if err != nil {
					continue
				}
				end, err := time.Parse("20060102150405 -0700", strings.TrimSpace(raw.End))
				if err != nil || !end.After(start) || !end.After(now) || !start.Before(horizon) {
					continue
				}
				title := ""
				for _, t := range raw.Titles {
					title = normalizedGuideText(t)
					if title != "" {
						break
					}
				}
				if title == "" || !utf8.ValidString(title) || utf8.RuneCountInString(title) > 160 {
					continue
				}
				program := GuideProgram{ChannelID: channel.ID, ChannelKey: raw.Channel, ChannelName: channel.Name, Title: title, Start: start.UTC(), End: end.UTC()}
				stringBytes += int64(len(program.ChannelID) + len(program.ChannelKey) + len(program.ChannelName) + len(title))
				if len(index.Programs) >= maxGuidePrograms {
					return GuideIndex{}, ErrGuideLimit
				}
				index.Programs = append(index.Programs, program)
				index.Bytes = stringBytes + int64(cap(index.Programs))*160
				if index.Bytes > MaxGuideIndexBytes {
					return GuideIndex{}, ErrGuideLimit
				}
			default:
				if decoder.Skip() != nil {
					return GuideIndex{}, ErrInvalidResponse
				}
			}
		case xml.EndElement:
			depth--
			if depth == 0 {
				rootClosed = true
			}
		}
	}
	if len(channels) > 0 && len(mapped) == 0 {
		return GuideIndex{}, ErrGuideMapping
	}
	// Duplicate declarations invalidate already retained records as well.
	safe := index.Programs[:0]
	for _, program := range index.Programs {
		if !ambiguous[program.ChannelKey] {
			safe = append(safe, program)
		}
	}
	index.Programs = safe
	sort.Slice(index.Programs, func(i, j int) bool {
		a, b := index.Programs[i], index.Programs[j]
		if !a.Start.Equal(b.Start) {
			return a.Start.Before(b.Start)
		}
		if a.ChannelID != b.ChannelID {
			return a.ChannelID < b.ChannelID
		}
		if !a.End.Equal(b.End) {
			return a.End.Before(b.End)
		}
		return a.Title < b.Title
	})
	unique := index.Programs[:0]
	for _, p := range index.Programs {
		if len(unique) == 0 || unique[len(unique)-1] != p {
			unique = append(unique, p)
		}
	}
	index.Programs = unique
	index.MappedChannels = len(mapped)
	index.ScannedPrograms = scanned
	return index, nil
}
func normalizedGuideText(text string) string { return strings.Join(strings.Fields(text), " ") }
