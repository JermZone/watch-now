package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

type dvrRow struct {
	dispatcharr.Recording
	Channel dispatcharr.Channel `json:"channel"`
}

func (s *Server) dvrEnabled() bool { _, ok := s.dispatcharr.(dispatcharr.DVRAPI); return ok }
func (s *Server) dvrError(w http.ResponseWriter, r *http.Request, err error) {
	viewer := sessionFromContext(r.Context())
	if s.cfg.DVRMasterAPIKey != "" && (errors.Is(err, dispatcharr.ErrUnauthorized) || r.URL.Path == "/api/dvr/connection") {
		writeError(w, 503, "dvr_service_unavailable", "Server-managed DVR is unavailable or access could not be verified. Ask the Watch Now administrator to check the configuration.")
		return
	}
	switch {
	case errors.Is(err, dispatcharr.ErrUnauthorized):
		s.sessions.SetDVRKey(viewer.ID, viewer.DVRKey, "")
		writeError(w, 403, "dvr_reconnect_required", "DVR access was rejected. Reconnect your own Dispatcharr API key.")
	case errors.Is(err, dispatcharr.ErrNotFound):
		writeError(w, 404, "recording_not_found", "Recording is not available to this viewer")
	case errors.Is(err, dispatcharr.ErrRedirect):
		writeError(w, 409, "recording_file_not_ready", "Dispatcharr redirected to an unfinished recording stream. Wait for processing to finish, then refresh DVR.")
	case errors.Is(err, dispatcharr.ErrDVRRejected):
		writeError(w, 409, "dvr_rejected", "Dispatcharr rejected this change. Refresh DVR before trying again.")
	default:
		if r.Method == http.MethodGet && (r.PathValue("resource") == "stream" || r.PathValue("resource") == "download") {
			writeError(w, 502, "recording_playback_unavailable", "Dispatcharr could not serve this recording. Refresh DVR and try again; if it still fails, check playback in Dispatcharr.")
		} else {
			writeError(w, 502, "dvr_unavailable", "DVR could not complete the request. Refresh DVR before retrying a recording change.")
		}
	}
}
func (s *Server) handleDVR(w http.ResponseWriter, r *http.Request) {
	api, ok := s.dispatcharr.(dispatcharr.DVRAPI)
	if !ok {
		writeError(w, 503, "dvr_unavailable", "DVR is unavailable")
		return
	}
	viewer := sessionFromContext(r.Context())
	mutation := r.Method != "GET"
	if mutation {
		if !s.validOrigin(r) || !validCSRF(r.Header.Get("X-CSRF-Token"), viewer.CSRFToken) {
			writeError(w, 403, "invalid_csrf", "Request was not accepted")
			return
		}
		if allowed, _ := s.dvrLimiter.Allow(viewer.ID); !allowed {
			writeError(w, 429, "rate_limited", "Too many DVR changes. Try again shortly.")
			return
		}
		select {
		case s.dvrWrites <- struct{}{}:
			defer func() { <-s.dvrWrites }()
		default:
			writeError(w, 409, "dvr_busy", "Another DVR change is in progress. Refresh and try again.")
			return
		}
	}
	select {
	case s.dvrRequests <- struct{}{}:
		defer func() { <-s.dvrRequests }()
	default:
		writeError(w, 503, "dvr_busy", "DVR is busy. Try again shortly.")
		return
	}
	if r.URL.Path == "/api/dvr/connection" && s.cfg.DVRMasterAPIKey != "" && mutation {
		writeError(w, 409, "dvr_server_managed", "DVR is connected by the server administrator; no personal key is needed")
		return
	}
	if r.URL.Path == "/api/dvr/connection" && s.cfg.DVRMasterAPIKey == "" {
		if r.Method == "DELETE" {
			s.sessions.SetDVRKey(viewer.ID, viewer.DVRKey, "")
			s.downloads.stop(viewer.ID)
			s.playbacks.stop(viewer.ID)
			s.sessions.EndPlayback(viewer.ID)
			s.vlc.DeleteSession(viewer.ID)
			w.WriteHeader(204)
			return
		}
		if r.Method == "POST" {
			var input struct {
				Key string `json:"api_key"`
			}
			if decodeJSON(r, &input) != nil || !dispatcharr.ValidDVRKey(input.Key) {
				writeError(w, 400, "invalid_key", "Enter your Dispatcharr API key")
				return
			}
			identity, err := api.DVRIdentity(r.Context(), input.Key)
			if err != nil {
				writeError(w, 403, "dvr_connection_failed", "Could not verify this API key with Dispatcharr")
				return
			}
			if identity.Username != viewer.Username {
				writeError(w, 403, "dvr_wrong_account", "Use the API key for your signed-in Watch Now account")
				return
			}
			if !s.sessions.SetDVRKey(viewer.ID, viewer.DVRKey, input.Key) {
				writeError(w, 409, "dvr_connection_changed", "Your session changed. Refresh before connecting DVR.")
				return
			}
			writeJSON(w, 200, map[string]any{"connected": true, "access": identity.Access, "managed": s.cfg.DVRMasterAPIKey != ""})
			return
		}
		if viewer.DVRKey == "" {
			writeJSON(w, 200, map[string]any{"connected": false, "access": "none"})
			return
		}
	}
	if s.dvrKey(viewer) == "" {
		writeError(w, 403, "dvr_connect_required", "Connect your own Dispatcharr API key in DVR first")
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
	if r.URL.Path == "/api/dvr/connection" {
		writeJSON(w, 200, map[string]any{"connected": true, "access": identity.Access, "managed": s.cfg.DVRMasterAPIKey != ""})
		return
	}
	if identity.Access != "manage" && ((mutation && r.PathValue("action") != "vlc") || identity.Access != "view") {
		writeError(w, 403, "dvr_permission_denied", "Your Dispatcharr account does not have permission for this DVR action")
		return
	}
	channels, err := s.dispatcharr.LiveChannels(r.Context(), viewer.Credentials, "")
	if err != nil {
		s.writeDispatcharrError(w, r, err, false)
		return
	}
	recordings, err := api.DVRRecordings(r.Context(), s.dvrKey(viewer))
	if err != nil {
		s.dvrError(w, r, err)
		return
	}
	current, alive := s.sessions.Get(viewer.ID)
	if !alive {
		writeError(w, 401, "session_expired", "Sign in again")
		return
	}
	if current.DVRKey != viewer.DVRKey {
		writeError(w, 409, "dvr_connection_changed", "DVR connection changed. Refresh and try again.")
		return
	}
	lineup := make(map[string]dispatcharr.Channel, len(channels))
	for _, ch := range channels {
		lineup[ch.ID] = ch
	}
	rows := []dvrRow{}
	for _, recording := range recordings {
		if ch, allowed := lineup[recording.ChannelID]; allowed {
			rows = append(rows, dvrRow{Recording: recording, Channel: ch})
		}
	}
	if r.URL.Path == "/api/dvr/recordings" {
		if r.Method == "GET" {
			writeJSON(w, 200, map[string]any{"items": rows, "access": identity.Access})
			return
		}
		var input struct {
			ChannelID string    `json:"channel_id"`
			Start     time.Time `json:"start"`
			End       time.Time `json:"end"`
		}
		if decodeJSON(r, &input) != nil || input.Start.IsZero() || !input.End.After(time.Now()) || !input.End.After(input.Start) {
			writeError(w, 400, "invalid_airing", "Choose a current or upcoming program")
			return
		}
		ch, allowed := lineup[input.ChannelID]
		if !allowed {
			writeError(w, 404, "channel_not_found", "Channel is not available to this viewer")
			return
		}
		program, found := s.dvrProgram(r.Context(), viewer, channels, ch, input.Start, input.End)
		if !found {
			writeError(w, 409, "airing_changed", "This airing could not be verified. Refresh the guide and try again.")
			return
		}
		airing := programResultID(program)
		for _, row := range rows {
			if row.ChannelID == ch.ID && (row.AiringID == airing || (!row.Start.After(input.Start) && !row.End.Before(input.End))) && row.Status != "attention" {
				writeJSON(w, 200, map[string]any{"recording": row, "already_scheduled": true})
				return
			}
		}
		// Identity and lineup were verified above; a logout during guide retrieval
		// must not permit a new request using an obsolete session credential.
		current, alive = s.sessions.Get(viewer.ID)
		if !alive || current.DVRKey != viewer.DVRKey {
			writeError(w, 409, "dvr_connection_changed", "Session changed. Refresh before recording.")
			return
		}
		request := dispatcharr.RecordingRequest{ChannelID: ch.ID, Start: program.Start, End: program.End}
		request.Properties.Program.Title = program.Title
		request.Properties.Program.Subtitle = program.Subtitle
		request.Properties.Program.Description = program.Description
		request.Properties.AiringID = airing
		recording, err := api.DVRCreate(r.Context(), s.dvrKey(viewer), request)
		if err != nil {
			s.dvrError(w, r, err)
			return
		}
		if recording.ChannelID != ch.ID {
			s.dvrError(w, r, dispatcharr.ErrInvalidResponse)
			return
		}
		writeJSON(w, 201, map[string]any{"recording": dvrRow{Recording: recording, Channel: ch}, "already_scheduled": false})
		return
	}
	id := r.PathValue("recording_id")
	var selected *dvrRow
	for i := range rows {
		if rows[i].ID == id {
			selected = &rows[i]
			break
		}
	}
	if selected == nil {
		writeError(w, 404, "recording_not_found", "Recording is not available to this viewer")
		return
	}
	if r.Method == "POST" && r.PathValue("action") == "vlc" {
		if !selected.Playable {
			writeError(w, 409, "recording_not_ready", "Playback is available after the recording has finished processing")
			return
		}
		s.createVLCHandoff(w, r, viewer, func(context.Context, session.Session) (mediaSpec, error) {
			return recordingSpec(selected.Recording), nil
		})
		return
	}

	if r.Method == "GET" {
		if r.PathValue("resource") != "stream" && r.PathValue("resource") != "download" {
			writeError(w, 404, "not_found", "DVR endpoint not found")
			return
		}
		if !selected.Playable {
			writeError(w, 409, "recording_not_ready", "Playback is available after the recording has finished processing")
			return
		}
		s.serveDVRFile(w, r, api, viewer, *selected)
		return
	}
	action := r.PathValue("action")
	if r.Method == "DELETE" {
		action = "delete"
	}
	switch action {
	case "stop", "extend":
		if selected.Status != "recording" {
			writeError(w, 409, "recording_changed", "This recording is no longer active. Refresh DVR.")
			return
		}
	case "delete":
		if selected.Status == "recording" {
			writeError(w, 409, "recording_active", "Stop the recording before deleting it")
			return
		}
	default:
		writeError(w, 400, "invalid_action", "Unknown DVR action")
		return
	}
	if err := api.DVRAction(r.Context(), s.dvrKey(viewer), id, action); err != nil {
		s.dvrError(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) dvrProgram(ctx context.Context, viewer session.Session, channels []dispatcharr.Channel, ch dispatcharr.Channel, start, end time.Time) (dispatcharr.GuideProgram, bool) {
	programs, err := s.dispatcharr.LiveEPG(ctx, viewer.Credentials, ch.ID)
	if err == nil {
		for _, p := range programs {
			if p.Start.Equal(start) && p.End.Equal(end) {
				return dispatcharr.GuideProgram{ChannelID: ch.ID, Title: p.Title, Description: p.Description, Start: p.Start, End: p.End}, true
			}
		}
	}
	if s.programSearchEnabled() {
		now := time.Now()
		if !start.Before(now.Add(7 * 24 * time.Hour)) {
			return dispatcharr.GuideProgram{}, false
		}
		for _, days := range []int{1, 3, 7} {
			if !start.Before(now.Add(time.Duration(days) * 24 * time.Hour)) {
				continue
			}
			index, err := s.guideForViewerDays(ctx, viewer, channels, days)
			if err != nil {
				return dispatcharr.GuideProgram{}, false
			}
			for _, p := range index.Programs {
				if p.ChannelID == ch.ID && p.ChannelKey == ch.EPGChannelID() && p.ChannelName == ch.Name && p.Start.Equal(start) && p.End.Equal(end) {
					return p, true
				}
			}
			// Cached horizons are anchored at fetch time. Try a wider window
			// only when this index could not have retained the requested start.
			if start.Before(index.WindowEnd) {
				break
			}
		}
	}
	return dispatcharr.GuideProgram{}, false
}
func (s *Server) serveDVRFile(w http.ResponseWriter, r *http.Request, api dispatcharr.DVRAPI, viewer session.Session, row dvrRow) {
	if !requireMediaGET(w, r) {
		return
	}
	byteRange, ok := acceptedRange(w, r.Header.Get("Range"))
	if !ok {
		return
	}
	ctx, cancel := boundedDownloadContext(r.Context(), viewer, s.cfg.SessionAbsoluteTTL)
	defer cancel()
	if r.PathValue("resource") == "stream" {
		var generation uint64
		ctx, generation = s.playbacks.start(ctx, viewer, s.cfg.SessionAbsoluteTTL)
		begun := false
		defer func() {
			if s.playbacks.finish(viewer.ID, generation) && begun {
				s.sessions.EndPlayback(viewer.ID)
			}
		}()
		if _, ok := s.sessions.BeginPlayback(viewer.ID); !ok {
			writeError(w, 401, "session_expired", "Sign in again")
			return
		}
		begun = true
	}
	release, ok := s.downloads.acquire(viewer.ID, cancel)
	if !ok {
		writeError(w, 429, "dvr_busy", "Too many recording streams")
		return
	}
	defer release()
	// Register before the final session check so logout always cancels the relay.
	current, alive := s.sessions.Get(viewer.ID)
	if !alive || current.DVRKey != viewer.DVRKey {
		writeError(w, 403, "dvr_reconnect_required", "Reconnect DVR before playback")
		return
	}
	stream, err := api.DVROpen(ctx, s.dvrKey(viewer), row.ID, byteRange)
	if err != nil {
		if errors.Is(err, dispatcharr.ErrRangeRejected) || errors.Is(err, dispatcharr.ErrInvalidRange) {
			writeError(w, 416, "invalid_range", "Recording range is unavailable")
		} else {
			s.dvrError(w, r, err)
		}
		return
	}
	defer stream.Body.Close()
	if stream.StatusCode != 200 && stream.StatusCode != 206 {
		writeError(w, 502, "invalid_media_response", "Recording response is invalid")
		return
	}
	idle := time.AfterFunc(2*time.Minute, cancel)
	defer idle.Stop()
	length := stream.ContentLength
	if stream.StatusCode == 206 {
		var valid bool
		length, valid = partialContentLength(stream.ContentRange, length, byteRange)
		if !valid {
			writeError(w, 502, "invalid_media_response", "Recording range is invalid")
			return
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", safeMediaType(stream.ContentType))
	if length >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	}
	if stream.StatusCode == 206 {
		w.Header().Set("Content-Range", stream.ContentRange)
	}
	if stream.AcceptRanges == "bytes" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if r.PathValue("resource") == "download" {
		extension := "mkv"
		if stream.ContentType == "video/mp4" {
			extension = "mp4"
		}
		w.Header().Set("Content-Disposition", `attachment; filename="recording-`+row.ID+`.`+extension+`"`)
	}
	w.WriteHeader(stream.StatusCode)
	controller := http.NewResponseController(w)
	buffer := make([]byte, 64<<10)
	for length != 0 {
		chunk := buffer
		if length > 0 && int64(len(chunk)) > length {
			chunk = chunk[:length]
		}
		n, e := stream.Body.Read(chunk)
		if n > 0 {
			idle.Reset(2 * time.Minute)
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err = w.Write(chunk[:n]); err != nil {
				return
			}
			if length > 0 {
				length -= int64(n)
			}
		}
		if e != nil {
			return
		}
	}
}

func recordingSpec(row dispatcharr.Recording) mediaSpec {
	return mediaSpec{kind: dispatcharr.MediaKindRecording, contentID: row.ID, streamID: row.ID, extension: "mkv", filename: row.Title}
}

// VLC carries only an opaque authorization, never the REST key. Recheck the
// account, current XC lineup, and completed recording on every external request.
func (s *Server) recordingMediaSpec(ctx context.Context, viewer session.Session, id string) (mediaSpec, error) {
	select {
	case s.dvrRequests <- struct{}{}:
		defer func() { <-s.dvrRequests }()
	default:
		return mediaSpec{}, dispatcharr.ErrUnavailable
	}
	api, ok := s.dispatcharr.(dispatcharr.DVRAPI)
	if !ok || s.dvrKey(viewer) == "" {
		return mediaSpec{}, dispatcharr.ErrUnauthorized
	}
	identity, err := s.dvrViewerIdentity(ctx, viewer)
	if err != nil {
		return mediaSpec{}, err
	}
	if identity.Username != viewer.Username || (identity.Access != "view" && identity.Access != "manage") {
		return mediaSpec{}, dispatcharr.ErrUnauthorized
	}
	channels, err := s.dispatcharr.LiveChannels(ctx, viewer.Credentials, "")
	if err != nil {
		return mediaSpec{}, err
	}
	rows, err := api.DVRRecordings(ctx, s.dvrKey(viewer))
	if err != nil {
		return mediaSpec{}, err
	}
	current, alive := s.sessions.Get(viewer.ID)
	if !alive || current.DVRKey != viewer.DVRKey {
		return mediaSpec{}, dispatcharr.ErrUnauthorized
	}
	for _, row := range rows {
		if row.ID == id && row.Playable {
			for _, ch := range channels {
				if ch.ID == row.ChannelID {
					return recordingSpec(row), nil
				}
			}
		}
	}
	return mediaSpec{}, dispatcharr.ErrNotFound
}

func (s *Server) revokeDVRVLC(viewer session.Session) {
	s.sessions.SetDVRKey(viewer.ID, viewer.DVRKey, "")
	s.vlc.DeleteSession(viewer.ID)
}

func (s *Server) dvrKey(viewer session.Session) string {
	if s.cfg.DVRMasterAPIKey != "" {
		return s.cfg.DVRMasterAPIKey
	}
	return viewer.DVRKey
}
func (s *Server) dvrViewerIdentity(ctx context.Context, viewer session.Session) (dispatcharr.DVRIdentity, error) {
	if s.cfg.DVRMasterAPIKey != "" {
		api, ok := s.dispatcharr.(dispatcharr.DVRMasterAPI)
		if !ok {
			return dispatcharr.DVRIdentity{}, dispatcharr.ErrUnavailable
		}
		return api.DVRViewerIdentity(ctx, s.cfg.DVRMasterAPIKey, viewer.Username)
	}
	api, ok := s.dispatcharr.(dispatcharr.DVRAPI)
	if !ok {
		return dispatcharr.DVRIdentity{}, dispatcharr.ErrUnavailable
	}
	return api.DVRIdentity(ctx, viewer.DVRKey)
}
