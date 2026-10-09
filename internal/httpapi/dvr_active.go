package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
)

// authorizeActiveRecording deliberately repeats the REST identity and current
// XC lineup checks for every playlist, segment, status and file request.
func (s *Server) authorizeActiveRecording(ctx context.Context, viewer session.Session, id string) (dispatcharr.Recording, error) {
	api, ok := s.dispatcharr.(dispatcharr.DVRAPI)
	if !ok || s.dvrKey(viewer) == "" {
		return dispatcharr.Recording{}, dispatcharr.ErrUnauthorized
	}
	identity, err := s.dvrViewerIdentity(ctx, viewer)
	if err != nil {
		return dispatcharr.Recording{}, err
	}
	if identity.Username != viewer.Username || (identity.Access != "view" && identity.Access != "manage") {
		return dispatcharr.Recording{}, dispatcharr.ErrUnauthorized
	}
	channels, err := s.dispatcharr.LiveChannels(ctx, viewer.Credentials, "")
	if err != nil {
		return dispatcharr.Recording{}, err
	}
	recordings, err := api.DVRRecordings(ctx, s.dvrKey(viewer))
	if err != nil {
		return dispatcharr.Recording{}, err
	}
	current, alive := s.sessions.Get(viewer.ID)
	if !alive || current.DVRKey != viewer.DVRKey {
		return dispatcharr.Recording{}, dispatcharr.ErrUnauthorized
	}
	for _, row := range recordings {
		if row.ID != id {
			continue
		}
		for _, ch := range channels {
			if ch.ID == row.ChannelID {
				return row, nil
			}
		}
	}
	return dispatcharr.Recording{}, dispatcharr.ErrNotFound
}
func (s *Server) activeRecordingError(w http.ResponseWriter, r *http.Request, err error, generation uint64) {
	viewer := sessionFromContext(r.Context())
	if errors.Is(err, dispatcharr.ErrUnauthorized) || errors.Is(err, dispatcharr.ErrNotFound) {
		s.finishPlayback(viewer.ID, generation, true)
	}
	switch {
	case errors.Is(err, dispatcharr.ErrUnauthorized):
		writeError(w, 403, "dvr_permission_denied", "Recording access could not be verified. Reconnect DVR or ask your administrator.")
	case errors.Is(err, dispatcharr.ErrNotFound):
		writeError(w, 404, "recording_not_found", "Recording is no longer available to this viewer")
	case errors.Is(err, dispatcharr.ErrRecordingFinalized):
		writeError(w, 409, "recording_finalized", "Recording finished. Check playback status to continue.")
	default:
		writeError(w, 502, "recording_playback_unavailable", "Recording playback is temporarily unavailable. Try again shortly.")
	}
}

func (s *Server) activeRecordingStillOwned(w http.ResponseWriter, r *http.Request, viewer session.Session, id string, generation uint64, ctx context.Context) bool {
	current, alive := s.sessions.Get(viewer.ID)
	_, owned := s.playbacks.recording(viewer.ID, id, generation)
	if !alive || current.DVRKey != viewer.DVRKey || !owned {
		s.finishPlayback(viewer.ID, generation, true)
		writeError(w, 410, "recording_playback_expired", "Playback ended. Open the recording again.")
		return false
	}
	if ctx.Err() != nil {
		writeError(w, 504, "recording_playback_unavailable", "Recording request timed out. Try again shortly.")
		return false
	}
	return true
}

func activeRecordingBase(id string, generation uint64) string {
	return "/api/dvr/recordings/" + id + "/active/" + strconv.FormatUint(generation, 10)
}

func (s *Server) handleActiveRecording(w http.ResponseWriter, r *http.Request) {
	viewer := sessionFromContext(r.Context())
	hls, supported := s.dispatcharr.(dispatcharr.DVRHLSAPI)
	if !supported {
		writeError(w, 409, "recording_playback_unsupported", "Active recording playback is unavailable on this connection")
		return
	}
	mutation := r.Method == http.MethodPost
	if mutation && (!s.validOrigin(r) || !validCSRF(r.Header.Get("X-CSRF-Token"), viewer.CSRFToken)) {
		writeError(w, 403, "invalid_csrf", "Request was not accepted")
		return
	}
	if !mutation && !requireMediaGET(w, r) {
		return
	}
	if mutation {
		if allowed, _ := s.dvrLimiter.Allow(viewer.ID); !allowed {
			writeError(w, 429, "rate_limited", "Too many playback changes. Try again shortly.")
			return
		}
	}
	id := r.PathValue("recording_id")
	if len(id) == 0 || len(id) > 64 || strings.ContainsAny(id, "/.%\\") {
		writeError(w, 404, "recording_not_found", "Recording is unavailable")
		return
	}
	var generation uint64
	playbackContext := r.Context()
	isStart := r.PathValue("generation") == ""
	if !isStart {
		var err error
		generation, err = strconv.ParseUint(r.PathValue("generation"), 10, 64)
		if err != nil || generation == 0 {
			writeError(w, 410, "recording_playback_expired", "Playback ended. Open the recording again.")
			return
		}
		var alive bool
		playbackContext, alive = s.playbacks.recording(viewer.ID, id, generation)
		if !alive {
			writeError(w, 410, "recording_playback_expired", "Playback ended. Open the recording again.")
			return
		}
		if mutation {
			s.finishPlayback(viewer.ID, generation, true)
			w.WriteHeader(204)
			return
		}
	}
	// A canceled media GET must never terminate its sibling requests or the
	// playback generation, but logout/new playback cancels all children.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(playbackContext, cancel)
	defer stop()
	select {
	case s.dvrRequests <- struct{}{}:
		defer func() { <-s.dvrRequests }()
	default:
		writeError(w, 429, "dvr_busy", "Too many recording requests. Try again shortly.")
		return
	}
	row, err := s.authorizeActiveRecording(ctx, viewer, id)
	if err != nil {
		s.activeRecordingError(w, r, err, generation)
		return
	}
	if isStart {
		if !row.CanWatchActive && !row.Playable {
			writeError(w, 409, "recording_preparing", "Playback is not ready. Refresh DVR shortly.")
			return
		}
		// Register before marking activity, coordinating with an older finish.
		persistent, gen := s.playbacks.startRecording(viewer, s.cfg.SessionAbsoluteTTL, id)
		generation = gen
		if _, ok := s.beginPlayback(viewer.ID, gen); !ok {
			s.finishPlayback(viewer.ID, gen, false)
			writeError(w, 401, "session_expired", "Sign in again")
			return
		}
		context.AfterFunc(persistent, func() {
			s.finishPlayback(viewer.ID, gen, true)
		})
		current, alive := s.sessions.Get(viewer.ID)
		if !alive || current.DVRKey != viewer.DVRKey || persistent.Err() != nil {
			s.finishPlayback(viewer.ID, gen, true)
			writeError(w, 401, "session_expired", "Sign in again")
			return
		}
		base := activeRecordingBase(id, gen)
		writeJSON(w, 201, map[string]any{"generation": strconv.FormatUint(gen, 10), "manifest_url": base + "/index.m3u8", "status_url": base + "/status", "stop_url": base + "/stop"})
		return
	}
	base := activeRecordingBase(id, generation)
	asset := r.PathValue("asset")
	if asset == "status" {
		if !s.activeRecordingStillOwned(w, r, viewer, id, generation, ctx) {
			return
		}
		if row.Playable || row.ReadyFile {
			writeJSON(w, 200, map[string]any{"mode": "file", "stream_url": base + "/file", "recording": false})
			return
		}
		response := map[string]any{"mode": "waiting", "recording": row.CanWatchActive}
		if row.CanWatchActive {
			// Capture status can precede the playlist and its first complete
			// segments. Give native HLS and MSE a small published buffer before
			// attaching either player; a short ended capture needs no live buffer.
			playlist, err := hls.DVRHLSManifest(ctx, s.dvrKey(viewer), id)
			// Logout or a replacement playback may occur during the extra
			// upstream read, including one that returns an error on cancellation.
			if !s.activeRecordingStillOwned(w, r, viewer, id, generation, ctx) {
				return
			}
			switch {
			case errors.Is(err, dispatcharr.ErrNotFound):
				// The recording row was authorized; missing media is preparation.
			case errors.Is(err, dispatcharr.ErrRecordingFinalized):
				response["recording"] = false
			case err != nil:
				s.activeRecordingError(w, r, err, generation)
				return
			default:
				response["recording"] = !playlist.Ended
				if playlist.TargetDuration > 0 {
					response["live_delay_seconds"] = 3 * uint64(playlist.TargetDuration)
				}
				if len(playlist.Segments) >= 3 || (playlist.Ended && len(playlist.Segments) > 0) {
					response["mode"] = "hls"
				}
			}
		}
		writeJSON(w, 200, response)
		return
	}
	if asset == "index.m3u8" {
		playlist, err := hls.DVRHLSManifest(ctx, s.dvrKey(viewer), id)
		if err != nil {
			if errors.Is(err, dispatcharr.ErrNotFound) {
				// The row was freshly authorized; 404 here means first
				// segment/processing delay, not deletion of the recording.
				w.Header().Set("Retry-After", "3")
				writeError(w, 409, "recording_preparing", "Waiting for recorded media. Try again shortly.")
			} else {
				s.activeRecordingError(w, r, err, generation)
			}
			return
		}
		if len(playlist.Segments) == 0 {
			w.Header().Set("Retry-After", "3")
			writeError(w, 409, "recording_preparing", "Waiting for the first recorded segment.")
			return
		}
		if !s.activeRecordingStillOwned(w, r, viewer, id, generation, ctx) {
			return
		}
		lines := strings.Split(playlist.Playlist, "\n")
		allowed := make(map[string]bool, len(playlist.Segments))
		for _, segment := range playlist.Segments {
			allowed[segment] = true
		}
		for i, line := range lines {
			if allowed[line] {
				lines[i] = base + "/" + line
			}
		}
		// Native HLS chooses its initial position before JavaScript can reliably
		// seek. This viewer-owned hint retains the entire growing timeline and
		// is never forwarded to Dispatcharr. Ordinary/live requests are unchanged.
		if r.URL.Query().Get("start") == "beginning" {
			lines[0] += "\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = w.Write([]byte(strings.Join(lines, "\n")))
		return
	}
	requestContext, streamCancel := context.WithCancel(r.Context())
	defer streamCancel()
	unregister := context.AfterFunc(playbackContext, streamCancel)
	defer unregister()
	release, ok := s.downloads.acquire(viewer.ID, streamCancel)
	if !ok {
		writeError(w, 429, "dvr_busy", "Too many recording streams")
		return
	}
	defer release()
	var stream dispatcharr.MediaStream
	if asset == "file" {
		if !row.ReadyFile && !row.Playable {
			writeError(w, 409, "recording_preparing", "Recording is still processing.")
			return
		}
		byteRange, ok := acceptedRange(w, r.Header.Get("Range"))
		if !ok {
			return
		}
		stream, err = s.dispatcharr.(dispatcharr.DVRAPI).DVROpen(requestContext, s.dvrKey(viewer), id, byteRange)
		if err == nil && stream.StatusCode == 206 {
			length, valid := partialContentLength(stream.ContentRange, stream.ContentLength, byteRange)
			if !valid {
				stream.Body.Close()
				writeError(w, 502, "invalid_media_response", "Recording range is invalid")
				return
			}
			stream.ContentLength = length
		}
	} else {
		if r.Header.Get("Range") != "" {
			writeError(w, 416, "invalid_range", "Segment ranges are unavailable")
			return
		}
		stream, err = hls.DVRHLSSegment(requestContext, s.dvrKey(viewer), id, asset)
	}
	if err != nil {
		if errors.Is(err, dispatcharr.ErrNotFound) {
			writeError(w, 409, "recording_finalized", "Recorded segment is unavailable. Check playback status.")
		} else if errors.Is(err, dispatcharr.ErrRangeRejected) || errors.Is(err, dispatcharr.ErrInvalidRange) {
			writeError(w, 416, "invalid_range", "Recording range is unavailable")
		} else {
			s.activeRecordingError(w, r, err, generation)
		}
		return
	}
	defer stream.Body.Close()
	if stream.StatusCode != 200 && stream.StatusCode != 206 {
		writeError(w, 502, "invalid_media_response", "Recording response is invalid")
		return
	}
	// Recheck after upstream setup so a logout during authorization/open never
	// gets media bytes. The registry context then cancels an in-flight relay.
	current, alive := s.sessions.Get(viewer.ID)
	if !alive || current.DVRKey != viewer.DVRKey || playbackContext.Err() != nil {
		writeError(w, 403, "dvr_permission_denied", "Recording access ended")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if asset == "file" {
		w.Header().Set("Content-Type", safeMediaType(stream.ContentType))
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
	}
	if stream.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(stream.ContentLength, 10))
	}
	if stream.StatusCode == 206 {
		w.Header().Set("Content-Range", stream.ContentRange)
	}
	if asset == "file" && stream.AcceptRanges == "bytes" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	idle := time.AfterFunc(30*time.Second, streamCancel)
	defer idle.Stop()
	w.WriteHeader(stream.StatusCode)
	controller := http.NewResponseController(w)
	buffer := make([]byte, 64<<10)
	remaining := stream.ContentLength
	for remaining != 0 {
		chunk := buffer
		if remaining > 0 && int64(len(chunk)) > remaining {
			chunk = chunk[:remaining]
		}
		n, readErr := stream.Body.Read(chunk)
		if n > 0 {
			if requestContext.Err() != nil {
				return
			}
			idle.Reset(30 * time.Second)
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err = w.Write(chunk[:n]); err != nil {
				return
			}
			if remaining > 0 {
				remaining -= int64(n)
			}
		}
		if readErr != nil {
			return
		}
	}
}
