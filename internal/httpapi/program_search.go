package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

type guideFailure struct{ err error }
type programSearchResult struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	Subtitle    string              `json:"subtitle,omitempty"`
	Description string              `json:"description,omitempty"`
	MatchField  string              `json:"match_field"`
	Start       time.Time           `json:"start"`
	End         time.Time           `json:"end"`
	Channel     dispatcharr.Channel `json:"channel"`
}

func (s *Server) programSearchEnabled() bool {
	_, ok := s.dispatcharr.(dispatcharr.GuideAPI)
	return s.cfg.ProgramSearchEnabled && ok
}
func (s *Server) handleSearchCapabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"program_search": s.programSearchEnabled(), "dvr": s.dvrEnabled(), "guide": s.extendedGuideEnabled()})
}
func (s *Server) handleProgramSearch(w http.ResponseWriter, r *http.Request) {
	if !s.programSearchEnabled() {
		writeError(w, http.StatusServiceUnavailable, "program_search_disabled", "Show search is not enabled. Search channels instead.")
		return
	}
	q, ok := parseCatalogQuery(w, r, false)
	if !ok {
		return
	}
	if q.search == "" {
		writeError(w, http.StatusBadRequest, "invalid_search", "Enter a show title, episode, or description")
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "now"
	}
	if status != "now" && status != "upcoming" && status != "all" {
		writeError(w, http.StatusBadRequest, "invalid_status", "Search scope is invalid")
		return
	}
	q.pageSize = min(q.pageSize, 50)
	viewer := sessionFromContext(r.Context())
	// Every search intersects a fresh authorized lineup, including warm indexes.
	channels, err := s.dispatcharr.LiveChannels(r.Context(), viewer.Credentials, "")
	if err != nil {
		s.writeDispatcharrError(w, r, err, false)
		return
	}
	index, err := s.guideForViewer(r.Context(), viewer, channels)
	if err != nil {
		if errors.Is(err, dispatcharr.ErrUnauthorized) {
			s.writeDispatcharrError(w, r, err, false)
			return
		}
		writeError(w, http.StatusServiceUnavailable, "program_search_unavailable", "Show search is unavailable for this guide. Search channels instead.")
		return
	}
	if _, alive := s.sessions.Get(viewer.ID); !alive {
		writeError(w, http.StatusUnauthorized, "session_expired", "Sign in again")
		return
	}
	current := make(map[string]dispatcharr.Channel, len(channels))
	for _, ch := range channels {
		current[ch.ID] = ch
	}
	now := time.Now()
	horizon := now.Add(24 * time.Hour)
	query := strings.ToLower(strings.Join(strings.Fields(q.search), " "))
	results := []programSearchResult{}
	total := 0
	start := (q.page - 1) * q.pageSize
	for _, field := range []string{"title", "subtitle", "description"} {
		for _, p := range index.Programs {
			ch, allowed := current[p.ChannelID]
			if !allowed || ch.EPGChannelID() != p.ChannelKey || ch.Name != p.ChannelName || q.categoryID != "" && ch.CategoryID != q.categoryID {
				continue
			}
			if !p.End.After(now) || !p.Start.Before(horizon) || status == "now" && p.Start.After(now) || status == "upcoming" && !p.Start.After(now) {
				continue
			}
			if programMatchField(p, query) != field {
				continue
			}
			total++
			if total <= start || len(results) >= q.pageSize {
				continue
			}
			id := programResultID(p)
			results = append(results, programSearchResult{ID: id, Title: p.Title, Subtitle: p.Subtitle, Description: p.Description, MatchField: field, Start: p.Start, End: p.End, Channel: ch})
		}
	}
	writeJSON(w, http.StatusOK, catalogPage[programSearchResult]{Items: results, Total: total, Page: q.page, PageSize: q.pageSize})
}
func (s *Server) guideForViewer(ctx context.Context, viewer session.Session, channels []dispatcharr.Channel) (dispatcharr.GuideIndex, error) {
	return s.guideForViewerDays(ctx, viewer, channels, 1)
}
func (s *Server) guideForViewerDays(ctx context.Context, viewer session.Session, channels []dispatcharr.Channel, days int) (dispatcharr.GuideIndex, error) {
	key := viewer.ID + ":program-guide"
	if days != 1 {
		key += ":" + strconv.Itoa(days)
	}
	value, err := s.lookups.do(ctx, key, func() (any, error) {
		if cached, ok := s.cache.Get(key); ok {
			return cached, nil
		}
		select {
		case s.guideFills <- struct{}{}:
			defer func() { <-s.guideFills }()
		default:
			return nil, dispatcharr.ErrUnavailable
		}
		fillStarted := time.Now()
		var index dispatcharr.GuideIndex
		var err error
		if days == 1 {
			index, err = s.dispatcharr.(dispatcharr.GuideAPI).LiveGuide(ctx, viewer.Credentials, channels)
		} else if api, ok := s.dispatcharr.(dispatcharr.ExtendedGuideAPI); ok {
			index, err = api.LiveGuideDays(ctx, viewer.Credentials, channels, days)
		} else {
			return nil, dispatcharr.ErrUnavailable
		}
		if err == nil && index.FetchedAt.IsZero() {
			index.FetchedAt = fillStarted
			index.WindowEnd = fillStarted.Add(time.Duration(days) * 24 * time.Hour)
		}
		if _, alive := s.sessions.Get(viewer.ID); !alive {
			return nil, dispatcharr.ErrUnauthorized
		}
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, dispatcharr.ErrUnauthorized) {
				ttl := time.Minute
				if errors.Is(err, dispatcharr.ErrGuideLimit) {
					ttl = 5 * time.Minute
				}
				s.cache.Set(key, guideFailure{err}, 256, ttl)
			}
			return nil, err
		}
		if index.Bytes > dispatcharr.MaxGuideIndexBytes {
			return nil, dispatcharr.ErrGuideLimit
		}
		s.logger.Info("program guide indexed", "transfer_bytes", index.TransferBytes, "index_bytes", index.Bytes, "lineup_channels", len(channels), "mapped_channels", index.MappedChannels, "scanned_programs", index.ScannedPrograms, "retained_programs", len(index.Programs), "duration_ms", time.Since(fillStarted).Milliseconds())
		s.cache.Set(key, index, index.Bytes+128, 5*time.Minute)
		return index, nil
	})
	if err != nil {
		return dispatcharr.GuideIndex{}, err
	}
	if failed, ok := value.(guideFailure); ok {
		return dispatcharr.GuideIndex{}, failed.err
	}
	return value.(dispatcharr.GuideIndex), nil
}

func programMatchField(p dispatcharr.GuideProgram, query string) string {
	if strings.Contains(strings.ToLower(p.Title), query) {
		return "title"
	}
	if strings.Contains(strings.ToLower(p.Subtitle), query) {
		return "subtitle"
	}
	if strings.Contains(strings.ToLower(p.Description), query) {
		return "description"
	}
	return ""
}

func programResultID(p dispatcharr.GuideProgram) string {
	sum := sha256.Sum256([]byte(p.ChannelID + "\x00" + p.Start.UTC().Format(time.RFC3339) + "\x00" + p.End.UTC().Format(time.RFC3339) + "\x00" + p.Title))
	return hex.EncodeToString(sum[:16])
}
