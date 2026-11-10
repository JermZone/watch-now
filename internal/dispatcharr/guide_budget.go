package dispatcharr

import (
	"context"
	"encoding/xml"
	"io"
	"time"
)

// Bound decoder read-ahead relative to the last completed token. In particular,
// a single text, attribute, comment or directive cannot grow the XML decoder's
// internal buffer to the full transport limit before a Token call returns.
type xmlWindowReader struct {
	source    io.Reader
	completed int64
	read      int64
	exceeded  bool
}

func (r *xmlWindowReader) Read(p []byte) (int, error) {
	remaining := int64(64<<10) - (r.read - r.completed)
	if remaining <= 0 {
		r.exceeded = true
		return 0, ErrGuideLimit
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := r.source.Read(p)
	r.read += int64(n)
	return n, err
}

type guideTokens struct {
	window                                             *xmlWindowReader
	decoder                                            *xml.Decoder
	depth, tokens, recordTokens, recordBytes, channels int
	exceeded                                           bool
}

func (g *guideTokens) Token() (xml.Token, error) {
	token, err := g.decoder.Token()
	g.window.completed = g.decoder.InputOffset()
	if err != nil {
		return nil, err
	}
	g.tokens++
	g.recordTokens++
	switch t := token.(type) {
	case xml.StartElement:
		g.depth++
		if g.depth == 2 {
			g.recordTokens, g.recordBytes = 1, 0
			if t.Name.Local == "channel" {
				g.channels++
			}
		}
		g.recordBytes += len(t.Name.Local)
		for _, a := range t.Attr {
			g.recordBytes += len(a.Name.Local) + len(a.Value)
		}
	case xml.EndElement:
		g.depth--
	case xml.CharData:
		g.recordBytes += len(t)
	case xml.Comment:
		g.recordBytes += len(t)
	case xml.Directive:
		return nil, ErrInvalidResponse
	}
	if g.depth > 16 || g.tokens > 2000000 || g.recordTokens > 256 || g.recordBytes > 64<<10 || g.channels > 20000 {
		g.exceeded = true
		return nil, ErrGuideLimit
	}
	return token, nil
}
func parseGuideDays(ctx context.Context, reader io.Reader, channels []Channel, now time.Time, days int) (GuideIndex, error) {
	window := &xmlWindowReader{source: reader}
	guard := &guideTokens{decoder: xml.NewDecoder(window), window: window}
	index, err := parseGuideDocument(ctx, xml.NewTokenDecoder(guard), channels, now, days)
	if window.exceeded || guard.exceeded {
		return GuideIndex{}, ErrGuideLimit
	}
	return index, err
}
