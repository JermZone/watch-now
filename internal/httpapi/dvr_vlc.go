package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	vlcstore "github.com/JermZone/watch-now/internal/vlc"
)

// An external HLS player has no viewer cookie. Every asset is bound to the
// handoff's recording and owner; never accept an upstream URL from the client.
// Keep serving retained HLS after completion. Switching a running HLS demuxer
// to the finished MKV cannot reliably preserve the external player's position.
func (s *Server) serveVLCRecordingHLS(w http.ResponseWriter, r *http.Request, media vlcstore.Media) {
	asset := r.PathValue("filename")
	manifest := asset == vlcPathFilename(media.DisplayFilename)
	if !manifest && !dispatcharr.ValidDVRHLSSegment(asset) {
		writeError(w, 404, "vlc_not_found", "VLC media was not found")
		return
	}
	// VLC may probe an unknown resource with an open range at byte zero.
	// Serve the complete asset with 200; arbitrary HLS byte ranges stay disabled.
	if byteRange := r.Header.Get("Range"); byteRange != "" && byteRange != "bytes=0-" {
		writeError(w, 416, "invalid_range", "Recording HLS ranges are unavailable")
		return
	}
	viewer, alive := s.sessions.Get(media.SessionID)
	if !alive {
		s.vlc.DeleteSession(media.SessionID)
		writeError(w, 404, "vlc_not_found", "VLC media was not found")
		return
	}
	hls, supported := s.dispatcharr.(dispatcharr.DVRHLSAPI)
	if !supported {
		writeError(w, 503, "vlc_temporarily_unavailable", "Recording playback is unavailable")
		return
	}
	select {
	case s.dvrRequests <- struct{}{}:
		defer func() { <-s.dvrRequests }()
	default:
		writeError(w, 429, "dvr_busy", "Too many recording requests")
		return
	}
	deadline := minTime(media.HardExpiresAt, viewer.CreatedAt.Add(s.cfg.SessionAbsoluteTTL))
	deadline = minTime(deadline, time.Now().Add(30*time.Second))
	ctx, cancel := context.WithDeadline(r.Context(), deadline)
	defer cancel()
	go func() {
		select {
		case <-media.Revoked():
			cancel()
		case <-ctx.Done():
		}
	}()
	fail := func(err error) {
		if errors.Is(err, dispatcharr.ErrUnauthorized) {
			s.revokeDVRVLC(viewer)
			writeError(w, 404, "vlc_not_found", "Recording access has ended")
		} else {
			writeError(w, 503, "recording_unavailable", "Recorded media is unavailable. Reopen the recording from DVR.")
		}
	}
	_, err := s.authorizeActiveRecording(ctx, viewer, media.ContentID)
	if err != nil {
		if errors.Is(err, dispatcharr.ErrNotFound) {
			s.vlc.DeleteSession(media.SessionID)
			writeError(w, 404, "vlc_not_found", "Recording access has ended")
		} else {
			fail(err)
		}
		return
	}
	_, release, ok := s.vlc.BeginRelay(media.ID)
	if !ok {
		writeError(w, 404, "vlc_not_found", "VLC media was not found")
		return
	}
	defer release()
	stillOwned := func() bool {
		current, alive := s.sessions.Get(media.SessionID)
		_, valid := s.vlc.ResolveMedia(media.ID, false)
		return alive && valid && current.DVRKey == viewer.DVRKey && ctx.Err() == nil
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if manifest {
		playlist, err := hls.DVRHLSManifest(ctx, s.dvrKey(viewer), media.ContentID)
		if err != nil {
			fail(err)
			return
		}
		if len(playlist.Segments) == 0 {
			w.Header().Set("Retry-After", "3")
			writeError(w, 503, "recording_preparing", "Waiting for recorded video. Try VLC again shortly.")
			return
		}
		if !stillOwned() {
			writeError(w, 404, "vlc_not_found", "Recording access has ended")
			return
		}
		allowed := make(map[string]bool, len(playlist.Segments))
		for _, segment := range playlist.Segments {
			allowed[segment] = true
		}
		lines := strings.Split(vlcRecordingPlaylist(playlist, media.StartPosition, s.vlc.RecordingStarted(media.ID)), "\n")
		for i, line := range lines {
			if allowed[line] {
				lines[i] = "/api/vlc/media/" + media.ID + "/" + line
			}
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write([]byte(strings.Join(lines, "\n")))
		return
	}
	stream, err := hls.DVRHLSSegment(ctx, s.dvrKey(viewer), media.ContentID, asset)
	if err != nil {
		fail(err)
		return
	}
	defer stream.Body.Close()
	if stream.StatusCode != 200 {
		writeError(w, 502, "invalid_media_response", "Recorded segment is unavailable")
		return
	}
	if !stillOwned() {
		writeError(w, 404, "vlc_not_found", "Recording access has ended")
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	if stream.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(stream.ContentLength, 10))
	}
	controller := http.NewResponseController(w)
	buffer := make([]byte, 64<<10)
	remaining := stream.ContentLength
	for remaining != 0 {
		chunk := buffer
		if remaining > 0 && remaining < int64(len(chunk)) {
			chunk = chunk[:remaining]
		}
		n, readErr := stream.Body.Read(chunk)
		if n > 0 {
			if ctx.Err() != nil {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := w.Write(chunk[:n]); err != nil {
				return
			}
			s.vlc.MarkRecordingStarted(media.ID)
			if remaining > 0 {
				remaining -= int64(n)
			}
		}
		if readErr != nil {
			return
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// VLC 3 ignores EXT-X-START on live playlists. For beginning, initially publish
// the first three segments so its live-edge heuristic selects the first one.
// Once the player receives a segment, expose the full growing EVENT timeline.
// Prefix expansion only appends media, retaining sequence/discontinuity tags.
func vlcRecordingPlaylist(playlist dispatcharr.RecordingPlaylist, position string, started bool) string {
	if position == "" {
		return playlist.Playlist
	}
	hint := "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"
	if position == "latest" {
		delay := uint64(playlist.TargetDuration) * 3
		if delay == 0 {
			delay = 12
		}
		hint = "#EXT-X-START:TIME-OFFSET=-" + strconv.FormatUint(delay, 10) + ",PRECISE=NO"
	}
	lines := strings.Split(playlist.Playlist, "\n")
	if position == "beginning" && !started && len(playlist.Segments) > 3 {
		for i, line := range lines {
			if line == "#EXT-X-PLAYLIST-TYPE:VOD" {
				lines[i] = "#EXT-X-PLAYLIST-TYPE:EVENT"
			}
			if line == playlist.Segments[2] {
				lines = lines[:i+1]
				break
			}
		}
	}
	return strings.Join(append([]string{lines[0], hint}, lines[1:]...), "\n") + "\n"
}
