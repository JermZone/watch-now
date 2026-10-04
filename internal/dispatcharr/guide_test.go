package dispatcharr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func guideXML(now time.Time, count int) string {
	var b strings.Builder
	b.WriteString(`<tv><channel id="7"><display-name>News</display-name></channel>`)
	for i := 0; i < count; i++ {
		fmt.Fprintf(&b, `<programme channel="7" start="%s" stop="%s"><title>News %d</title><desc>%s</desc></programme>`, now.Add(time.Duration(i)*time.Minute-time.Minute).Format("20060102150405 -0700"), now.Add(time.Duration(i)*time.Minute+time.Hour).Format("20060102150405 -0700"), i, strings.Repeat("x", 512))
	}
	b.WriteString(`</tv>`)
	return b.String()
}
func TestGuideMappingBoundsAndNarrowTitleIndex(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	channel := Channel{ID: "41", Name: "News", epgID: "7"}
	index, err := parseGuide(context.Background(), strings.NewReader(guideXML(now, 3)), []Channel{channel}, now)
	if err != nil || len(index.Programs) != 3 {
		t.Fatalf("guide parsing failed: %v", err)
	}
	if index.Programs[0].ChannelID != "41" || index.Programs[0].ChannelKey != "7" || strings.Contains(index.Programs[0].Title, "xxx") {
		t.Fatal("unexpected source mapping or title")
	}
	collision := Channel{ID: "42", Name: "News", epgID: "7"}
	_, err = parseGuide(context.Background(), strings.NewReader(guideXML(now, 3)), []Channel{channel, collision}, now)
	if !errors.Is(err, ErrGuideMapping) {
		t.Fatal("ambiguous channel key accepted")
	}
	_, err = parseGuide(context.Background(), strings.NewReader(guideXML(now, 3)), []Channel{{ID: "41", Name: "Other", epgID: "7"}}, now)
	if !errors.Is(err, ErrGuideMapping) {
		t.Fatal("mismatched channel name accepted")
	}
}
func TestGuideRejectsMalformedDirectivesAndCanceledReads(t *testing.T) {
	for _, raw := range []string{"<tv>", "<html></html>", "<!DOCTYPE tv><tv></tv>", "<tv></tv><tv></tv>"} {
		if _, err := parseGuide(context.Background(), strings.NewReader(raw), nil, time.Now()); err == nil {
			t.Fatal("invalid feed accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := parseGuide(ctx, strings.NewReader("<tv></tv>"), nil, time.Now()); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation ignored")
	}
}
func TestGuideWindowAndDuplicatePrograms(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	raw := guideXML(now, 1)
	program := raw[strings.Index(raw, "<programme") : strings.Index(raw, "</programme>")+len("</programme>")]
	raw = strings.Replace(raw, "</tv>", program+"</tv>", 1)
	index, err := parseGuide(context.Background(), strings.NewReader(raw), []Channel{{ID: "1", Name: "News", epgID: "7"}}, now)
	if err != nil || len(index.Programs) != 1 {
		t.Fatal("duplicate program retained")
	}
	index, err = parseGuide(context.Background(), strings.NewReader(raw), []Channel{{ID: "1", Name: "News", epgID: "7"}}, now.Add(2*time.Hour))
	if err != nil || len(index.Programs) != 0 {
		t.Fatal("expired program retained")
	}
}
func BenchmarkGuideParser190Channels(b *testing.B) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	var xml strings.Builder
	xml.WriteString("<tv>")
	channels := make([]Channel, 190)
	for i := range channels {
		key := fmt.Sprint(i + 1)
		channels[i] = Channel{ID: key, Name: "Channel " + key, epgID: key}
		fmt.Fprintf(&xml, `<channel id="%s"><display-name>Channel %s</display-name></channel>`, key, key)
	}
	for i := range channels {
		for j := 0; j < 48; j++ {
			start := now.Add(time.Duration(j) * 30 * time.Minute)
			fmt.Fprintf(&xml, `<programme channel="%s" start="%s" stop="%s"><title>Program %d</title><desc>%s</desc></programme>`, channels[i].epgID, start.Format("20060102150405 -0700"), start.Add(30*time.Minute).Format("20060102150405 -0700"), j, strings.Repeat("x", 512))
		}
	}
	xml.WriteString("</tv>")
	data := xml.String()
	b.SetBytes(int64(len(data)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		index, err := parseGuide(context.Background(), strings.NewReader(data), channels, now)
		if err != nil || len(index.Programs) != 9120 {
			b.Fatal(err)
		}
		b.ReportMetric(float64(len(data)), "feed_bytes")
		b.ReportMetric(float64(index.Bytes), "index_bytes")
	}
}

func TestGuideHTTPBudgetRedirectAndCredentialSafety(t *testing.T) {
	for _, scenario := range []string{"declared-size", "streamed-size", "redirect", "unauthorized"} {
		t.Run(scenario, func(t *testing.T) {
			followed := false
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/redirect-target" {
					followed = true
					return
				}
				switch scenario {
				case "declared-size":
					w.Header().Set("Content-Length", "1024")
					w.WriteHeader(200)
				case "streamed-size":
					w.(http.Flusher).Flush()
					io.WriteString(w, "<tv>"+strings.Repeat(" ", 1024)+"</tv>")
				case "redirect":
					http.Redirect(w, r, "/redirect-target", 302)
				case "unauthorized":
					http.Error(w, "secret-password", 401)
				}
			}))
			defer upstream.Close()
			base, _ := url.Parse(upstream.URL)
			client := NewClient(base, upstream.Client(), 128, 128)
			_, err := client.LiveGuide(context.Background(), Credentials{Username: "viewer", Password: "secret-password"}, nil)
			expected := ErrGuideLimit
			if scenario == "redirect" {
				expected = ErrUnavailable
			}
			if scenario == "unauthorized" {
				expected = ErrUnauthorized
			}
			if !errors.Is(err, expected) || followed || strings.Contains(err.Error(), "secret-password") {
				t.Fatal("guide HTTP limits, redirects or credential redaction failed")
			}
		})
	}
}

func TestGuideDescriptionAndSubtitleAreBounded(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	raw := strings.Replace(guideXML(now, 1), "</title>", "</title><sub-title>  Playoff   final </sub-title>", 1)
	raw = strings.Replace(raw, strings.Repeat("x", 512), strings.Repeat("é", 2048), 1)
	index, err := parseGuide(context.Background(), strings.NewReader(raw), []Channel{{ID: "41", Name: "News", epgID: "7"}}, now)
	if err != nil {
		t.Fatal(err)
	}
	p := index.Programs[0]
	if p.Subtitle != "Playoff final" || len([]rune(p.Description)) != 1024 {
		t.Fatal("metadata normalization or bounds failed")
	}
	if index.Bytes < int64(len(p.Description)) {
		t.Fatal("description missing from memory accounting")
	}
}
