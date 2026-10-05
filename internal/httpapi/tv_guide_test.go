package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/cache"
	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

func TestTVGuideRealXCWindowsPagingAndRevocation(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	var revoked atomic.Bool
	var limitWide atomic.Bool
	var feeds atomic.Int32
	var requestedDays atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/xmltv.php" {
			feeds.Add(1)
			days := r.URL.Query().Get("days")
			if days == "7" {
				requestedDays.Store(7)
			} else if days == "3" {
				requestedDays.Store(3)
			} else if days == "1" {
				requestedDays.Store(1)
			} else {
				t.Errorf("unexpected days: %s", days)
			}
			if limitWide.Load() && days != "1" {
				w.Header().Set("Content-Length", "33554433")
				w.WriteHeader(200)
				return
			}
			io.WriteString(w, `<tv>`)
			for i := 1; i <= 21; i++ {
				fmt.Fprintf(w, `<channel id="%d"><display-name>Channel %d</display-name></channel>`, i, i)
			}
			for _, offset := range []time.Duration{0, 5 * 24 * time.Hour} {
				for i := 1; i <= 21; i++ {
					fmt.Fprintf(w, `<programme channel="%d" start="%s" stop="%s"><title>Show %d</title><desc>Details</desc></programme>`, i, now.Add(offset-time.Hour).Format("20060102150405 -0700"), now.Add(offset+time.Hour).Format("20060102150405 -0700"), i)
				}
			}
			io.WriteString(w, `</tv>`)
			return
		}
		if r.URL.Query().Get("action") == "" {
			io.WriteString(w, `{"user_info":{"auth":1,"username":"viewer"}}`)
			return
		}
		if r.URL.Query().Get("action") != "get_live_streams" {
			t.Error("unexpected upstream request")
			http.NotFound(w, r)
			return
		}
		if revoked.Load() {
			io.WriteString(w, `[]`)
			return
		}
		io.WriteString(w, `[`)
		for i := 1; i <= 21; i++ {
			if i > 1 {
				io.WriteString(w, ",")
			}
			fmt.Fprintf(w, `{"stream_id":"%d","name":"Channel %d","num":%d,"epg_channel_id":"%d","category_id":"2"}`, i, i, i, i)
		}
		io.WriteString(w, `]`)
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(base, upstream.Client(), 32<<20, 1024)
	cfg := testConfig(t)
	cfg.ProgramSearchEnabled = true
	handler := New(cfg, client, slog.New(slog.NewTextHandler(io.Discard, nil)))
	cookie, _ := loginViewer(t, handler)
	path := func(start time.Time) string {
		return "/api/live/guide?start=" + url.QueryEscape(start.Format(time.RFC3339)) + "&end=" + url.QueryEscape(start.Add(3*time.Hour).Format(time.RFC3339))
	}
	firstPath := path(now)
	request := func(p string) *httptest.ResponseRecorder {
		return authenticatedRequest(t, handler, cookie, "GET", p, "")
	}
	response := request(firstPath)
	var first tvGuideResponse
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &first) != nil || len(first.Items) != 20 || !first.HasMore || len(first.Items[0].Programs) != 1 {
		t.Fatalf("first guide page failed: %d", response.Code)
	}
	if len(first.AvailableDates) < 2 {
		t.Fatal("multi-day coverage missing")
	}
	if request(firstPath+"&timezone=invalid_zone").Code != 400 {
		t.Fatal("invalid timezone accepted")
	}
	if first.Items[0].Programs[0].Start.After(now) {
		t.Fatal("overlapping program omitted")
	}
	if strings.Contains(response.Body.String(), "epg_channel_id") {
		t.Fatal("upstream fields leaked")
	}
	response = request(firstPath + "&page=2&snapshot=" + first.Snapshot)
	var second tvGuideResponse
	json.Unmarshal(response.Body.Bytes(), &second)
	if response.Code != 200 || len(second.Items) != 1 || second.HasMore || feeds.Load() != 1 {
		t.Fatal("cached pagination failed")
	}
	if request(firstPath+"&page=2&snapshot=invalid").Code != 409 {
		t.Fatal("stale page accepted")
	}
	if request(firstPath+"&category_id=other&page=2&snapshot="+first.Snapshot).Code != 409 {
		t.Fatal("snapshot escaped filters")
	}
	response = request(path(now.Add(5 * 24 * time.Hour)))
	var future tvGuideResponse
	json.Unmarshal(response.Body.Bytes(), &future)
	if response.Code != 200 || requestedDays.Load() != 7 || len(future.Items[0].Programs) != 1 {
		t.Fatal("extended range unavailable")
	}
	if request(path(now.Add(8*24*time.Hour))).Code != 400 {
		t.Fatal("unbounded range accepted")
	}
	if request("/api/live/guide?start=bad&end=bad").Code != 400 {
		t.Fatal("invalid window accepted")
	}
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	dayPath := "/api/live/guide?start=" + url.QueryEscape(dayStart.Format(time.RFC3339)) + "&end=" + url.QueryEscape(dayStart.AddDate(0, 0, 1).Format(time.RFC3339))
	response = request(dayPath)
	var dayPage tvGuideResponse
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &dayPage) != nil || len(dayPage.Items) != 5 || !dayPage.HasMore {
		t.Fatalf("calendar day did not use bounded channel pages: %d", response.Code)
	}
	response = request(dayPath + "&page=2&snapshot=" + dayPage.Snapshot)
	var dayNext tvGuideResponse
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &dayNext) != nil || len(dayNext.Items) != 5 || dayNext.Items[0].Channel.ID != "6" {
		t.Fatal("calendar day pagination failed")
	}
	if request(dayPath+"&page=2&snapshot="+first.Snapshot).Code != 409 {
		t.Fatal("three-hour snapshot reused for calendar day")
	}
	// Access is rechecked even when the same guide generation is cached.
	revoked.Store(true)
	response = request(firstPath)
	var denied tvGuideResponse
	json.Unmarshal(response.Body.Bytes(), &denied)
	if response.Code != 200 || len(denied.Items) != 0 || len(denied.AvailableDates) != 0 {
		t.Fatal("warm guide bypassed revocation")
	}
	if request(firstPath+"&channel_id=1").Code != 404 {
		t.Fatal("restricted channel schedule exposed")
	}
	if request(firstPath+"&page=2&snapshot="+first.Snapshot).Code != 409 {
		t.Fatal("old lineup pagination accepted")
	}

	revoked.Store(false)
	limitWide.Store(true)
	cookie, _ = loginViewer(t, handler)
	before := feeds.Load()
	response = request(firstPath)
	if response.Code != 200 || requestedDays.Load() != 1 || feeds.Load()-before != 3 {
		t.Fatal("oversized feeds did not fall back to one day")
	}
	before = feeds.Load()
	if request(firstPath).Code != 200 || feeds.Load() != before {
		t.Fatal("fallback failed to reuse cached results")
	}
}

type extendedGuideStub struct {
	*guideStub
	days int
}

func (g *extendedGuideStub) LiveGuideDays(ctx context.Context, _ dispatcharr.Credentials, _ []dispatcharr.Channel, days int) (dispatcharr.GuideIndex, error) {
	g.days = days
	return g.fetch(ctx)
}
func TestDVRCanonicalAiringBeyond24Hours(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	ch := dispatcharr.Channel{ID: "41", Name: "News", ChannelNumber: "7"}
	program := dispatcharr.GuideProgram{ChannelID: ch.ID, ChannelKey: ch.EPGChannelID(), ChannelName: ch.Name, Title: "Later program", Start: now.Add(5 * 24 * time.Hour), End: now.Add(5*24*time.Hour + time.Hour)}
	fixture := &extendedGuideStub{guideStub: &guideStub{fakeDispatcharr: &fakeDispatcharr{}, fetch: func(context.Context) (dispatcharr.GuideIndex, error) {
		return dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{program}}, nil
	}}}
	cfg := testConfig(t)
	cfg.ProgramSearchEnabled = true
	server := &Server{cfg: cfg, dispatcharr: fixture, cache: cache.New(cfg.CacheEntries, cfg.CacheMaxBytes), sessions: session.NewStore(cfg.SessionIdleTimeout, cfg.SessionAbsoluteTTL, cfg.SessionLimit), guideFills: make(chan struct{}, 2), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	viewer, err := server.sessions.Create(dispatcharr.Credentials{Username: "viewer", Password: "test"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	got, ok := server.dvrProgram(context.Background(), viewer, []dispatcharr.Channel{ch}, ch, program.Start, program.End)
	if !ok || got.Title != program.Title || fixture.days != 7 {
		t.Fatal("later canonical airing was not verified")
	}
	if _, ok = server.dvrProgram(context.Background(), viewer, []dispatcharr.Channel{ch}, ch, program.Start.Add(time.Minute), program.End); ok {
		t.Fatal("altered airing accepted")
	}
	if _, ok = server.dvrProgram(context.Background(), viewer, []dispatcharr.Channel{ch}, ch, now.Add(8*24*time.Hour), now.Add(8*24*time.Hour+time.Hour)); ok {
		t.Fatal("out-of-range airing accepted")
	}
}

func TestDVRRecordingAtWarmHorizonBoundary(t *testing.T) {
	for _, boundary := range []struct{ days, wider int }{{1, 3}, {3, 7}} {
		t.Run(fmt.Sprintf("%d-day", boundary.days), func(t *testing.T) {
			now := time.Now().UTC()
			ch := dispatcharr.Channel{ID: "41", Name: "News", ChannelNumber: "7"}
			program := dispatcharr.GuideProgram{ChannelID: ch.ID, ChannelKey: ch.EPGChannelID(), ChannelName: ch.Name, Title: "Tomorrow", Start: now.Add(time.Duration(boundary.days)*24*time.Hour - 2*time.Minute), End: now.Add(time.Duration(boundary.days)*24*time.Hour + time.Hour)}
			fixture := &extendedGuideStub{guideStub: &guideStub{fakeDispatcharr: &fakeDispatcharr{}, fetch: func(context.Context) (dispatcharr.GuideIndex, error) {
				return dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{program}}, nil
			}}}
			cfg := testConfig(t)
			cfg.ProgramSearchEnabled = true
			server := &Server{cfg: cfg, dispatcharr: fixture, cache: cache.New(cfg.CacheEntries, cfg.CacheMaxBytes), sessions: session.NewStore(cfg.SessionIdleTimeout, cfg.SessionAbsoluteTTL, cfg.SessionLimit), guideFills: make(chan struct{}, 2), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			viewer, _ := server.sessions.Create(dispatcharr.Credentials{Username: "viewer", Password: "test"}, "viewer")
			// A still-valid cache filled four minutes ago cannot include this airing.
			key := viewer.ID + ":program-guide"
			if boundary.days != 1 {
				key += fmt.Sprintf(":%d", boundary.days)
			}
			server.cache.Set(key, dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{}, FetchedAt: now.Add(-4 * time.Minute), WindowEnd: now.Add(time.Duration(boundary.days)*24*time.Hour - 4*time.Minute)}, 128, time.Minute)
			// The wider Guide snapshot contains the exact airing displayed to the user.
			index, err := server.guideForViewerDays(context.Background(), viewer, []dispatcharr.Channel{ch}, boundary.wider)
			if err != nil || len(index.Programs) != 1 {
				t.Fatal("invalid setup")
			}
			if _, ok := server.dvrProgram(context.Background(), viewer, []dispatcharr.Channel{ch}, ch, program.Start, program.End); !ok {
				t.Fatal("a displayed valid airing is rejected because DVR chooses a shorter cached horizon")
			}
			if _, ok := server.dvrProgram(context.Background(), viewer, []dispatcharr.Channel{ch}, ch, program.Start.Add(time.Second), program.End); ok {
				t.Fatal("altered airing accepted")
			}
		})
	}
}

func TestGuideAvailableDatesRespectsLineupAndLocalMidnight(t *testing.T) {
	location, err := time.LoadLocation("America/Denver")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, location)
	ch := dispatcharr.Channel{ID: "41", Name: "News", ChannelNumber: "7"}
	// A program ending exactly at local midnight must not advertise the next day.
	p := dispatcharr.GuideProgram{ChannelID: ch.ID, ChannelKey: ch.EPGChannelID(), ChannelName: ch.Name, Start: now.Add(23 * time.Hour), End: now.AddDate(0, 0, 1)}
	index := dispatcharr.GuideIndex{Programs: []dispatcharr.GuideProgram{p}}
	dates := guideAvailableDates(index, []dispatcharr.Channel{ch}, now, location)
	if len(dates) != 1 || dates[0] != "2026-11-01" {
		t.Fatalf("unexpected dates: %v", dates)
	}
	index.Programs[0].End = p.End.Add(time.Minute)
	dates = guideAvailableDates(index, []dispatcharr.Channel{ch}, now, location)
	if len(dates) != 2 || dates[1] != "2026-11-02" {
		t.Fatalf("midnight coverage missing: %v", dates)
	}
	ch.Name = "Changed"
	if len(guideAvailableDates(index, []dispatcharr.Channel{ch}, now, location)) != 0 {
		t.Fatal("stale lineup coverage leaked")
	}
	if len(guideAvailableDates(index, nil, now, location)) != 0 {
		t.Fatal("unauthorized coverage leaked")
	}
}

func TestGuideCalendarWindows(t *testing.T) {
	zone, err := time.LoadLocation("America/Denver")
	if err != nil {
		t.Fatal(err)
	}
	for _, date := range []string{"2026-03-08", "2026-11-01", "2026-10-05"} {
		start, _ := time.ParseInLocation("2006-01-02", date, zone)
		end := start.AddDate(0, 0, 1)
		now := start.Add(12 * time.Hour)
		day, valid := guideWindow(start, end, now, zone)
		if !day || !valid {
			t.Fatalf("local day rejected: %s", date)
		}
		if _, valid := guideWindow(start, end.Add(time.Hour), now, zone); valid {
			t.Fatal("oversized day accepted")
		}
		if _, valid := guideWindow(start.AddDate(0, 0, -1), start, now, zone); valid {
			t.Fatal("past day accepted")
		}
		if _, valid := guideWindow(start.AddDate(0, 0, 8), end.AddDate(0, 0, 8), now, zone); valid {
			t.Fatal("out of horizon day accepted")
		}
	}
}
