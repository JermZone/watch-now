package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

type guideChannelRow struct {
	Channel  dispatcharr.Channel   `json:"channel"`
	Programs []programSearchResult `json:"programs"`
}
type tvGuideResponse struct {
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
	if e1 != nil || e2 != nil || !end.After(start) || end.Sub(start) > 3*time.Hour || start.Before(now.Add(-3*time.Hour)) || end.After(now.Add(7*24*time.Hour)) {
		writeError(w, 400, "invalid_guide_window", "Choose a guide window of up to three hours within the next seven days.")
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	if !validIdentifier(channelID) {
		writeError(w, 400, "invalid_channel", "Channel is invalid")
		return
	}
	days := 1
	if end.After(now.Add(24 * time.Hour)) {
		days = 3
	}
	if end.After(now.Add(3 * 24 * time.Hour)) {
		days = 7
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
	index, err := s.guideForViewerDays(r.Context(), viewer, channels, days)
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
	for _, field := range []string{viewer.ID, index.FetchedAt.Format(time.RFC3339Nano), start.UTC().Format(time.RFC3339), end.UTC().Format(time.RFC3339), q.categoryID, channelID} {
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
	const pageSize = 20
	offset := (q.page - 1) * pageSize
	if offset > len(selected) {
		offset = len(selected)
	}
	stop := min(offset+pageSize, len(selected))
	response := tvGuideResponse{Items: []guideChannelRow{}, Page: q.page, HasMore: stop < len(selected), Snapshot: snapshot, WindowStart: start, WindowEnd: end, FetchedAt: index.FetchedAt, RequestedThrough: index.WindowEnd}
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
