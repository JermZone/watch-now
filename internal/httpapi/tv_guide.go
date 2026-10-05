package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
	_ "time/tzdata"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

type guideChannelRow struct {
	Channel  dispatcharr.Channel   `json:"channel"`
	Programs []programSearchResult `json:"programs"`
}
type tvGuideResponse struct {
	AvailableDates   []string          `json:"available_dates"`
	Items            []guideChannelRow `json:"items"`
	Page             int               `json:"page"`
	HasMore          bool              `json:"has_more"`
	Snapshot         string            `json:"snapshot"`
	WindowStart      time.Time         `json:"window_start"`
	WindowEnd        time.Time         `json:"window_end"`
	FetchedAt        time.Time         `json:"fetched_at"`
	RequestedThrough time.Time         `json:"requested_through"`
	ObservedThrough  *time.Time        `json:"observed_through"`
}

func (s *Server) extendedGuideEnabled() bool {
	_, ok := s.dispatcharr.(dispatcharr.ExtendedGuideAPI)
	return s.programSearchEnabled() && ok
}

// The browser receives a bounded channel/time slice of a viewer-local snapshot.
// XMLTV is fetched once per horizon, never once per row or pagination request.
func (s *Server) handleTVGuide(w http.ResponseWriter, r *http.Request) {
	if !s.extendedGuideEnabled() {
		writeError(w, 503, "guide_unavailable", "The extended guide is unavailable. Browse channels instead.")
		return
	}
	q, ok := parseCatalogQuery(w, r, false)
	if !ok {
		return
	}
	start, e1 := time.Parse(time.RFC3339, r.URL.Query().Get("start"))
	end, e2 := time.Parse(time.RFC3339, r.URL.Query().Get("end"))
	now := time.Now()
	channelID := r.URL.Query().Get("channel_id")
	if !validIdentifier(channelID) {
		writeError(w, 400, "invalid_channel", "Channel is invalid")
		return
	}
	zone := r.URL.Query().Get("timezone")
	if zone == "" {
		zone = "UTC"
	}
	if len(zone) > 128 {
		writeError(w, 400, "invalid_timezone", "Timezone is invalid")
		return
	}
	location, zoneErr := time.LoadLocation(zone)
	if zoneErr != nil {
		writeError(w, 400, "invalid_timezone", "Timezone is invalid")
		return
	}
	fullDay, validWindow := guideWindow(start, end, now, location)
	if e1 != nil || e2 != nil || !validWindow {
		writeError(w, 400, "invalid_guide_window", "Choose a calendar day or a window of up to three hours within the next seven days.")
		return
	}
	viewer := sessionFromContext(r.Context())
	channels, err := s.dispatcharr.LiveChannels(r.Context(), viewer.Credentials, "")
	if err != nil {
		s.writeDispatcharrError(w, r, err, false)
		return
	}
	selected := make([]dispatcharr.Channel, 0, len(channels))
	for _, ch := range channels {
		if (q.categoryID == "" || ch.CategoryID == q.categoryID) && (channelID == "" || ch.ID == channelID) {
			selected = append(selected, ch)
		}
	}
	if channelID != "" && len(selected) == 0 {
		writeError(w, 404, "channel_not_found", "Channel is not available to this viewer")
		return
	}
	index, err := s.guideForViewerDays(r.Context(), viewer, channels, 7)
	// Fall back only for bounded-feed limits, never authorization failures.
	for _, days := range []int{3, 1} {
		if !errors.Is(err, dispatcharr.ErrGuideLimit) {
			break
		}
		index, err = s.guideForViewerDays(r.Context(), viewer, channels, days)
	}
	if err != nil {
		if errors.Is(err, dispatcharr.ErrUnauthorized) {
			s.writeDispatcharrError(w, r, err, false)
			return
		}
		writeError(w, 503, "guide_unavailable", "This guide range could not be loaded. Retry or choose a nearer date.")
		return
	}
	if _, alive := s.sessions.Get(viewer.ID); !alive {
		writeError(w, 401, "session_expired", "Sign in again")
		return
	}
	// Bind pagination to both the guide generation and the fresh authorized lineup.
	hash := sha256.New()
	for _, field := range []string{viewer.ID, index.FetchedAt.Format(time.RFC3339Nano), start.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339), q.categoryID, channelID, zone} {
		hash.Write([]byte(field))
		hash.Write([]byte{0})
	}
	for _, ch := range selected {
		for _, field := range []string{ch.ID, ch.Name, ch.EPGChannelID()} {
			hash.Write([]byte(field))
			hash.Write([]byte{0})
		}
	}
	snapshot := hex.EncodeToString(hash.Sum(nil)[:16])
	if (q.page > 1 || r.URL.Query().Get("snapshot") != "") && r.URL.Query().Get("snapshot") != snapshot {
		writeError(w, 409, "guide_changed", "The guide changed. Refresh the schedule before loading more.")
		return
	}
	pageSize := 20
	if fullDay {
		pageSize = 5
	}
	offset := (q.page - 1) * pageSize
	if offset > len(selected) {
		offset = len(selected)
	}
	stop := min(offset+pageSize, len(selected))
	response := tvGuideResponse{AvailableDates: guideAvailableDates(index, selected, now, location), Items: []guideChannelRow{}, Page: q.page, HasMore: stop < len(selected), Snapshot: snapshot, WindowStart: start, WindowEnd: end, FetchedAt: index.FetchedAt, RequestedThrough: index.WindowEnd}
	rows := make(map[string]int, stop-offset)
	for _, ch := range selected[offset:stop] {
		rows[ch.ID] = len(response.Items)
		response.Items = append(response.Items, guideChannelRow{Channel: ch, Programs: []programSearchResult{}})
	}
	count := 0
	for _, p := range index.Programs {
		rowIndex, found := rows[p.ChannelID]
		if !found {
			continue
		}
		row := &response.Items[rowIndex]
		if row.Channel.EPGChannelID() != p.ChannelKey || row.Channel.Name != p.ChannelName {
			continue
		}
		if response.ObservedThrough == nil || p.End.After(*response.ObservedThrough) {
			t := p.End
			response.ObservedThrough = &t
		}
		if !p.Start.Before(end) || !p.End.After(start) {
			continue
		}
		count++
		if count > 500 {
			writeError(w, 503, "guide_dense", "This guide window has too many listings. Choose a shorter time window.")
			return
		}
		row.Programs = append(row.Programs, programSearchResult{ID: programResultID(p), Title: p.Title, Subtitle: p.Subtitle, Description: p.Description, Start: p.Start, End: p.End, Channel: row.Channel})
	}
	data, err := json.Marshal(response)
	if err != nil || len(data) > 1<<20 {
		writeError(w, 503, "guide_large", "This guide window is too large. Choose a shorter time window.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

// Coverage spans the entire filtered, currently authorized lineup, not one page.
func guideAvailableDates(index dispatcharr.GuideIndex, channels []dispatcharr.Channel, now time.Time, location *time.Location) []string {
	allowed := make(map[string]dispatcharr.Channel, len(channels))
	for _, ch := range channels {
		allowed[ch.ID] = ch
	}
	local := now.In(location)
	first := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	var present [8]bool
	for _, p := range index.Programs {
		ch, ok := allowed[p.ChannelID]
		if !ok || ch.Name != p.ChannelName || ch.EPGChannelID() != p.ChannelKey || !p.End.After(now) {
			continue
		}
		for i := range present {
			day := first.AddDate(0, 0, i)
			if day.Before(now.Add(7*24*time.Hour)) && p.Start.Before(day.AddDate(0, 0, 1)) && p.End.After(day) {
				present[i] = true
			}
		}
	}
	dates := []string{}
	for i, ok := range present {
		if ok {
			dates = append(dates, first.AddDate(0, 0, i).Format("2006-01-02"))
		}
	}
	return dates
}

// Calendar days may span 23 or 25 hours at daylight-saving transitions.
func guideWindow(start, end, now time.Time, location *time.Location) (bool, bool) {
	localNow := now.In(location)
	today := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	localStart := start.In(location)
	midnight := time.Date(localStart.Year(), localStart.Month(), localStart.Day(), 0, 0, 0, 0, location)
	fullDay := start.Equal(midnight) && end.Equal(midnight.AddDate(0, 0, 1))
	validDay := fullDay && !start.Before(today) && start.Before(now.Add(7*24*time.Hour))
	validWindow := end.After(start) && end.Sub(start) <= 3*time.Hour && !start.Before(now.Add(-3*time.Hour)) && !end.After(now.Add(7*24*time.Hour))
	return fullDay, validDay || validWindow
}
