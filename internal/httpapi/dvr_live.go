package httpapi

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

// liveRecording is intentionally smaller than the DVR library row: Live needs
// active capture metadata and an opaque recording ID, never file information.
type liveRecording struct {
	ID             string    `json:"id"`
	ChannelID      string    `json:"channel_id"`
	Title          string    `json:"title"`
	Start          time.Time `json:"start"`
	End            time.Time `json:"end"`
	Status         string    `json:"status"`
	CanWatchActive bool      `json:"can_watch_active"`
}

type liveRecordingsResponse struct {
	Items  []liveRecording `json:"items"`
	Access string          `json:"access"`
}

const liveRecordingLimit = 20

// handleLiveRecordings is an optional channel detail lookup. DVR failures never
// alter the Live browsing cache or revoke an otherwise valid viewer session.
func (s *Server) handleLiveRecordings(w http.ResponseWriter, r *http.Request) {
	viewer := sessionFromContext(r.Context())
	channelID := strings.TrimSpace(r.PathValue("channel_id"))
	if channelID == "" || !validIdentifier(channelID) {
		writeError(w, http.StatusBadRequest, "invalid_channel", "Channel ID is invalid")
		return
	}
	if allowed, _ := s.liveDVRLimiter.Allow(viewer.ID); !allowed {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many recording lookups. Try again shortly.")
		return
	}
	select {
	case s.dvrRequests <- struct{}{}:
		defer func() { <-s.dvrRequests }()
	default:
		writeError(w, http.StatusServiceUnavailable, "dvr_busy", "DVR is busy. Try again shortly.")
		return
	}

	// Do not inherit eligibility from a cached channel list.
	if _, err := s.currentChannelForViewer(r.Context(), viewer, channelID, ""); err != nil {
		if errors.Is(err, errChannelNotFound) {
			writeError(w, http.StatusNotFound, "channel_not_found", "Channel is not available to this viewer")
		} else {
			s.writeDispatcharrError(w, r, err, false)
		}
		return
	}
	response := liveRecordingsResponse{Items: []liveRecording{}, Access: "none"}
	writeResponse := func() {
		current, alive := s.sessions.Get(viewer.ID)
		if !alive {
			writeError(w, http.StatusUnauthorized, "session_expired", "Sign in again")
			return
		}
		if current.DVRKey != viewer.DVRKey {
			writeError(w, http.StatusConflict, "dvr_connection_changed", "DVR connection changed. Refresh and try again.")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
	api, supported := s.dispatcharr.(dispatcharr.DVRAPI)
	if !supported || s.dvrKey(viewer) == "" {
		writeResponse()
		return
	}
	identity, err := s.dvrViewerIdentity(r.Context(), viewer)
	if err != nil {
		s.dvrError(w, r, err)
		return
	}
	if identity.Username != viewer.Username {
		s.dvrError(w, r, dispatcharr.ErrUnauthorized)
		return
	}
	if identity.Access != "view" && identity.Access != "manage" {
		writeResponse()
		return
	}
	recordings, err := api.DVRRecordings(r.Context(), s.dvrKey(viewer))
	if err != nil {
		s.dvrError(w, r, err)
		return
	}
	response.Access = identity.Access
	// Dispatcharr can leave status recording set after capture/remux finishes
	// while it waits for HLS viewers. A canonical ready file is no longer live.
	for _, recording := range recordings {
		if recording.ChannelID != channelID || recording.Status != "recording" || !recording.CanWatchActive || recording.ReadyFile {
			continue
		}
		response.Items = append(response.Items, liveRecording{
			ID: recording.ID, ChannelID: recording.ChannelID, Title: recording.Title,
			Start: recording.Start, End: recording.End, Status: recording.Status,
			CanWatchActive: recording.CanWatchActive,
		})
		// Keep at most the earliest 20 captures; pad/overlapping recordings may
		// legitimately produce several choices for the same channel.
		sort.Slice(response.Items, func(i, j int) bool {
			a, b := response.Items[i], response.Items[j]
			if !a.Start.Equal(b.Start) {
				return a.Start.Before(b.Start)
			}
			// Numeric IDs can exceed uint64. Compare decimal length and text,
			// retaining an unambiguous order for leading-zero representations.
			aID, bID := strings.TrimLeft(a.ID, "0"), strings.TrimLeft(b.ID, "0")
			if len(aID) != len(bID) {
				return len(aID) < len(bID)
			}
			if aID != bID {
				return aID < bID
			}
			return a.ID < b.ID
		})
		if len(response.Items) > liveRecordingLimit {
			response.Items = response.Items[:liveRecordingLimit]
		}
	}
	writeResponse()
}
