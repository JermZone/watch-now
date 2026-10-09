package httpapi

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/session"
	vlcstore "github.com/JermZone/watch-now/internal/vlc"
)

const (
	downloadMaxLifetime              = 6 * time.Hour
	maxConcurrentDownloads           = 16
	maxConcurrentDownloadsPerSession = 2
)

type downloadLimiter struct {
	mu        sync.Mutex
	total     int
	nextID    uint64
	bySession map[string]map[uint64]context.CancelFunc
}

func newDownloadLimiter() *downloadLimiter {
	return &downloadLimiter{bySession: make(map[string]map[uint64]context.CancelFunc)}
}

func (limiter *downloadLimiter) acquire(sessionID string, cancel context.CancelFunc) (func(), bool) {
	limiter.mu.Lock()
	if limiter.total >= maxConcurrentDownloads || len(limiter.bySession[sessionID]) >= maxConcurrentDownloadsPerSession {
		limiter.mu.Unlock()
		return nil, false
	}
	limiter.nextID++
	reservationID := limiter.nextID
	if limiter.bySession[sessionID] == nil {
		limiter.bySession[sessionID] = make(map[uint64]context.CancelFunc)
	}
	limiter.bySession[sessionID][reservationID] = cancel
	limiter.total++
	limiter.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			limiter.mu.Lock()
			defer limiter.mu.Unlock()
			reservations := limiter.bySession[sessionID]
			if _, exists := reservations[reservationID]; !exists {
				return
			}
			delete(reservations, reservationID)
			limiter.total--
			if len(reservations) == 0 {
				delete(limiter.bySession, sessionID)
			}
		})
	}, true
}

func (limiter *downloadLimiter) stop(sessionID string) {
	limiter.mu.Lock()
	reservations := limiter.bySession[sessionID]
	delete(limiter.bySession, sessionID)
	limiter.total -= len(reservations)
	limiter.mu.Unlock()

	for _, cancel := range reservations {
		cancel()
	}
}

type mediaSpec struct {
	kind           dispatcharr.MediaKind
	contentID      string
	parentSeriesID string
	streamID       string
	extension      string
	filename       string
}

func (s *Server) handleMovieStream(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	movieID, ok := validPathID(writer, request.PathValue("movie_id"), "movie")
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	s.serveBrowserMedia(writer, request, viewerSession, func(ctx context.Context, current session.Session) (mediaSpec, error) {
		return s.movieMediaSpec(ctx, current, movieID)
	})
}

func (s *Server) handleEpisodeStream(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	seriesID, episodeID, ok := validEpisodePath(writer, request)
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	s.serveBrowserMedia(writer, request, viewerSession, func(ctx context.Context, current session.Session) (mediaSpec, error) {
		return s.episodeMediaSpec(ctx, current, seriesID, episodeID)
	})
}

func (s *Server) serveBrowserMedia(
	writer http.ResponseWriter,
	request *http.Request,
	viewerSession session.Session,
	authorize func(context.Context, session.Session) (mediaSpec, error),
) {
	rangeHeader, ok := acceptedRange(writer, request.Header.Get("Range"))
	if !ok {
		return
	}
	streamContext, generation := s.playbacks.start(request.Context(), viewerSession, s.cfg.SessionAbsoluteTTL)
	playbackBegan := false
	defer func() {
		s.finishPlayback(viewerSession.ID, generation, playbackBegan)
	}()
	current, ok := s.beginPlayback(viewerSession.ID, generation)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
		return
	}
	playbackBegan = true
	spec, err := authorize(streamContext, current)
	if err != nil {
		if streamContext.Err() == nil {
			s.writeCatalogError(writer, request, err, contentKindLabel(spec, request))
		}
		return
	}
	s.relayMedia(writer, request, streamContext, current, spec, current.ID+":browser", rangeHeader, "", nil, true)
}

func (s *Server) handleMovieDownload(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	movieID, ok := validPathID(writer, request.PathValue("movie_id"), "movie")
	if !ok {
		return
	}
	rangeHeader, ok := acceptedRange(writer, request.Header.Get("Range"))
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	downloadContext, cancel := boundedDownloadContext(request.Context(), viewerSession, s.cfg.SessionAbsoluteTTL)
	release, ok := s.downloads.acquire(viewerSession.ID, cancel)
	if !ok {
		cancel()
		writeError(writer, http.StatusTooManyRequests, "download_limit", "Too many downloads are already active")
		return
	}
	defer release()
	current, ok := s.sessions.Get(viewerSession.ID)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
		return
	}
	spec, err := s.movieMediaSpec(downloadContext, current, movieID)
	if err != nil {
		if downloadContext.Err() == nil {
			s.writeCatalogError(writer, request, err, "movie")
		}
		return
	}
	s.relayMedia(writer, request, downloadContext, current, spec, current.ID+":download", rangeHeader, withExtension(spec.filename, spec.extension), nil, true)
}

func (s *Server) handleEpisodeDownload(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	seriesID, episodeID, ok := validEpisodePath(writer, request)
	if !ok {
		return
	}
	rangeHeader, ok := acceptedRange(writer, request.Header.Get("Range"))
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	downloadContext, cancel := boundedDownloadContext(request.Context(), viewerSession, s.cfg.SessionAbsoluteTTL)
	release, ok := s.downloads.acquire(viewerSession.ID, cancel)
	if !ok {
		cancel()
		writeError(writer, http.StatusTooManyRequests, "download_limit", "Too many downloads are already active")
		return
	}
	defer release()
	current, ok := s.sessions.Get(viewerSession.ID)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
		return
	}
	spec, err := s.episodeMediaSpec(downloadContext, current, seriesID, episodeID)
	if err != nil {
		if downloadContext.Err() == nil {
			s.writeCatalogError(writer, request, err, "episode")
		}
		return
	}
	s.relayMedia(writer, request, downloadContext, current, spec, current.ID+":download", rangeHeader, withExtension(spec.filename, spec.extension), nil, true)
}

func (s *Server) handleLiveVLC(writer http.ResponseWriter, request *http.Request) {
	channelID, ok := validPathID(writer, request.PathValue("channel_id"), "channel")
	if !ok {
		return
	}
	s.createVLCHandoff(writer, request, sessionFromContext(request.Context()), func(ctx context.Context, current session.Session) (mediaSpec, error) {
		return s.liveMediaSpec(ctx, current, channelID)
	})
}

func (s *Server) handleMovieVLC(writer http.ResponseWriter, request *http.Request) {
	movieID, ok := validPathID(writer, request.PathValue("movie_id"), "movie")
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	s.createVLCHandoff(writer, request, viewerSession, func(ctx context.Context, current session.Session) (mediaSpec, error) {
		return s.movieMediaSpec(ctx, current, movieID)
	})
}

func (s *Server) handleEpisodeVLC(writer http.ResponseWriter, request *http.Request) {
	seriesID, episodeID, ok := validEpisodePath(writer, request)
	if !ok {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	s.createVLCHandoff(writer, request, viewerSession, func(ctx context.Context, current session.Session) (mediaSpec, error) {
		return s.episodeMediaSpec(ctx, current, seriesID, episodeID)
	})
}

func (s *Server) createVLCHandoff(
	writer http.ResponseWriter,
	request *http.Request,
	viewerSession session.Session,
	authorize func(context.Context, session.Session) (mediaSpec, error),
) {
	if !s.validOrigin(request) || !validCSRF(request.Header.Get("X-CSRF-Token"), viewerSession.CSRFToken) {
		writeError(writer, http.StatusForbidden, "csrf_rejected", "CSRF validation failed")
		return
	}
	spec, err := authorize(request.Context(), viewerSession)
	if err != nil {
		s.writeCatalogError(writer, request, err, contentKindLabel(spec, request))
		return
	}
	if _, ok := s.sessions.Get(viewerSession.ID); !ok {
		writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
		return
	}
	kind := vlcstore.KindMovie
	if spec.kind == dispatcharr.MediaKindRecording {
		kind = vlcstore.KindRecording
	} else if spec.kind == dispatcharr.MediaKindLive {
		kind = vlcstore.KindLive
	} else if spec.kind == dispatcharr.MediaKindSeries {
		kind = vlcstore.KindEpisode
	}
	created, err := s.vlc.Create(vlcstore.CreateParams{
		SessionID: viewerSession.ID, Kind: kind, ContentID: spec.contentID,
		ParentSeriesID: spec.parentSeriesID, StreamID: spec.streamID,
		Extension: spec.extension, DisplayFilename: withExtension(spec.filename, spec.extension),
	})
	if err != nil {
		if errors.Is(err, vlcstore.ErrCapacity) {
			writeError(writer, http.StatusServiceUnavailable, "vlc_capacity", "VLC handoff capacity is currently full")
			return
		}
		writeError(writer, http.StatusServiceUnavailable, "vlc_unavailable", "VLC handoff could not be created")
		return
	}
	writeJSON(writer, http.StatusCreated, map[string]any{
		"launch_url": "/api/vlc/launch/" + created.TicketID + "/" + vlcPathFilename(withExtension(spec.filename, spec.extension)),
		"expires_at": created.TicketExpiresAt.Unix(),
	})
}

func (s *Server) handleVLCLaunch(writer http.ResponseWriter, request *http.Request) {
	media, ok := s.vlc.RedeemTicket(strings.TrimSpace(request.PathValue("ticket_id")))
	if !ok {
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC handoff was not found")
		return
	}
	if filename := request.PathValue("filename"); filename != "" && filename != vlcPathFilename(media.DisplayFilename) {
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC handoff was not found")
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(writer, request, "/api/vlc/media/"+media.ID+"/"+vlcPathFilename(media.DisplayFilename), http.StatusFound)
}

func (s *Server) handleVLCMedia(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	rangeHeader, ok := acceptedRange(writer, request.Header.Get("Range"))
	if !ok {
		return
	}
	mediaID := strings.TrimSpace(request.PathValue("media_id"))
	media, ok := s.vlc.ResolveMedia(mediaID, false)
	if !ok {
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		return
	}
	if filename := request.PathValue("filename"); filename != "" && filename != vlcPathFilename(media.DisplayFilename) {
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		return
	}
	viewerSession, ok := s.sessions.Get(media.SessionID)
	if !ok {
		s.vlc.DeleteSession(media.SessionID)
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		return
	}
	var spec mediaSpec
	var err error
	if media.Kind == vlcstore.KindRecording {
		spec, err = s.recordingMediaSpec(request.Context(), viewerSession, media.ContentID)
	} else if media.Kind == vlcstore.KindLive {
		spec, err = s.liveMediaSpec(request.Context(), viewerSession, media.ContentID)
	} else if media.Kind == vlcstore.KindMovie {
		spec, err = s.movieMediaSpec(request.Context(), viewerSession, media.ContentID)
	} else {
		spec, err = s.episodeMediaSpec(request.Context(), viewerSession, media.ParentSeriesID, media.ContentID)
	}
	if err != nil {
		if errors.Is(err, dispatcharr.ErrUnauthorized) {
			if media.Kind == vlcstore.KindRecording {
				s.revokeDVRVLC(viewerSession)
			} else {
				s.revokeViewerState(media.SessionID)
			}
			writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
			return
		}
		if errors.Is(err, dispatcharr.ErrNotFound) || errors.Is(err, errChannelNotFound) || errors.Is(err, errMovieNotFound) || errors.Is(err, errSeriesNotFound) || errors.Is(err, errEpisodeNotFound) {
			s.vlc.DeleteSession(media.SessionID)
			writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
			return
		}
		// A canceled probe or an upstream metadata failure must not revoke a
		// previously authorized stream. Every retry still rechecks access.
		if request.Context().Err() != nil {
			return
		}
		s.logger.Warn("VLC media recheck failed", "reason", vlcRecheckReason(err))
		writeError(writer, http.StatusServiceUnavailable, "vlc_temporarily_unavailable", "VLC media is temporarily unavailable")
		return
	}
	if spec.streamID != media.StreamID || spec.extension != media.Extension {
		s.logger.Warn("VLC media recheck failed", "reason", "stream_changed")
		s.vlc.DeleteSession(media.SessionID)
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		return
	}
	media, releaseRelay, ok := s.vlc.BeginRelay(mediaID)
	if !ok {
		writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		return
	}
	defer releaseRelay()
	if media.Kind == vlcstore.KindLive {
		// Tear down any browser relay before opening the external live stream.
		// VLC may fetch this URL without the browser's session cookie.
		s.stopPlayback(media.SessionID)
	}
	deadline := media.HardExpiresAt
	if sessionDeadline := viewerSession.CreatedAt.Add(s.cfg.SessionAbsoluteTTL); sessionDeadline.Before(deadline) {
		deadline = sessionDeadline
	}
	streamContext, cancel := context.WithDeadline(request.Context(), deadline)
	defer cancel()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		select {
		case <-media.Revoked():
			cancel()
			return
		case <-streamContext.Done():
			return
		case <-ticker.C:
		}
		for {
			if _, alive := s.vlc.ResolveMedia(mediaID, false); !alive {
				cancel()
				return
			}
			select {
			case <-media.Revoked():
				cancel()
				return
			case <-streamContext.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	lastTouch := time.Now()
	progress := func() bool {
		if time.Since(lastTouch) < time.Minute {
			return true
		}
		_, alive := s.vlc.ResolveMedia(mediaID, true)
		// Only delivered media activity renews the owner's idle window. A
		// stalled transfer must not keep either authorization alive forever.
		_, ownerAlive := s.sessions.Get(media.SessionID)
		lastTouch = time.Now()
		return alive && ownerAlive
	}
	s.relayMedia(writer, request, streamContext, viewerSession, spec, media.ID, rangeHeader, "", progress, false)
}

func vlcRecheckReason(err error) string {
	switch {
	case errors.Is(err, dispatcharr.ErrUnavailable):
		return "upstream_unavailable"
	case errors.Is(err, dispatcharr.ErrInvalidResponse):
		return "upstream_invalid_response"
	case errors.Is(err, dispatcharr.ErrInvalidMedia):
		return "invalid_media"
	default:
		return "other"
	}
}

// The filename is cosmetic. Authorization still comes solely from the opaque
// ticket and media IDs, while VLC can use the final URL segment as a label.
func vlcPathFilename(displayFilename string) string {
	return strings.ReplaceAll(sanitizeDownloadBase(displayFilename, "video"), " ", "-")
}

func (s *Server) liveMediaSpec(ctx context.Context, viewerSession session.Session, channelID string) (mediaSpec, error) {
	channel, err := s.currentChannelForViewer(ctx, viewerSession, channelID, "")
	if err != nil {
		return mediaSpec{}, err
	}
	return mediaSpec{
		kind: dispatcharr.MediaKindLive, contentID: channel.ID, streamID: channel.ID,
		extension: "ts", filename: sanitizeDownloadBase(channel.Name, "Live-TV"),
	}, nil
}

func (s *Server) movieMediaSpec(ctx context.Context, viewerSession session.Session, movieID string) (mediaSpec, error) {
	detail, err := s.movieDetailForViewer(ctx, viewerSession, movieID)
	if err != nil {
		return mediaSpec{}, err
	}
	streamID := detail.StreamID()
	if streamID == "" {
		streamID = movieID
	}
	extension := detail.ContainerExtension()
	if extension == "" {
		if listing, ok := s.cachedMovieForViewer(viewerSession.ID, movieID); ok {
			extension = listing.ContainerExtension()
		}
	}
	if !validIdentifier(streamID) || extension == "" {
		return mediaSpec{}, dispatcharr.ErrInvalidMedia
	}
	return mediaSpec{
		kind: dispatcharr.MediaKindMovie, contentID: movieID, streamID: streamID,
		extension: extension, filename: movieDownloadFilename(detail.Name),
	}, nil
}

func (s *Server) episodeMediaSpec(ctx context.Context, viewerSession session.Session, seriesID, episodeID string) (mediaSpec, error) {
	detail, err := s.seriesDetailForViewer(ctx, viewerSession, seriesID)
	if err != nil {
		return mediaSpec{}, err
	}
	episode, err := episodeForViewer(detail, episodeID)
	if err != nil {
		return mediaSpec{}, err
	}
	if !validIdentifier(episode.StreamID()) || episode.ContainerExtension() == "" {
		return mediaSpec{}, dispatcharr.ErrInvalidMedia
	}
	return mediaSpec{
		kind: dispatcharr.MediaKindSeries, contentID: episodeID, parentSeriesID: seriesID,
		streamID: episode.StreamID(), extension: episode.ContainerExtension(),
		filename: episodeDownloadFilename(detail.Name, episode.SeasonNumber, episode.EpisodeNumber, episode.Name),
	}, nil
}

func (s *Server) relayMedia(
	writer http.ResponseWriter,
	request *http.Request,
	ctx context.Context,
	viewerSession session.Session,
	spec mediaSpec,
	relayID, rangeHeader, downloadFilename string,
	progress func() bool,
	revokeOnUnauthorized bool,
) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stream dispatcharr.MediaStream
	var err error
	if spec.kind == dispatcharr.MediaKindRecording {
		api, ok := s.dispatcharr.(dispatcharr.DVRAPI)
		if !ok {
			err = dispatcharr.ErrUnavailable
		} else {
			stream, err = api.DVROpen(ctx, s.dvrKey(viewerSession), spec.streamID, rangeHeader)
		}
	} else if spec.kind == dispatcharr.MediaKindLive {
		// Live MPEG-TS has no fixed length or seekable byte range. Ignore a
		// valid VLC probe range and return the current live stream as HTTP 200.
		var live dispatcharr.LiveStream
		live, err = s.dispatcharr.OpenLiveStream(ctx, viewerSession.Credentials, spec.streamID)
		stream = dispatcharr.MediaStream{Body: live.Body, StatusCode: http.StatusOK, ContentType: "video/mp2t", ContentLength: -1}
	} else {
		stream, err = s.dispatcharr.OpenMedia(ctx, viewerSession.Credentials, spec.kind, spec.streamID, spec.extension, rangeHeader, relayID)
	}
	if err != nil {
		if ctx.Err() == nil {
			if spec.kind == dispatcharr.MediaKindRecording {
				if errors.Is(err, dispatcharr.ErrUnauthorized) {
					s.revokeDVRVLC(viewerSession)
				}
				bound := request.WithContext(context.WithValue(request.Context(), sessionContextKey, viewerSession))
				bound.SetPathValue("resource", "stream")
				s.dvrError(writer, bound, err)
			} else {
				s.writeMediaError(writer, request, viewerSession.ID, err, revokeOnUnauthorized)
			}
		}
		return
	}
	defer stream.Body.Close()
	// Transport header timeouts do not bound a stalled response body.
	// Cancellation closes the upstream HTTP body and releases the relay slot.
	idleTimer := time.AfterFunc(2*time.Minute, cancel)
	defer idleTimer.Stop()
	if stream.StatusCode != http.StatusOK && stream.StatusCode != http.StatusPartialContent {
		writeError(writer, http.StatusBadGateway, "invalid_media_response", "Dispatcharr returned an unsupported media response")
		return
	}
	relayLength := stream.ContentLength
	if stream.StatusCode == http.StatusPartialContent {
		var valid bool
		relayLength, valid = partialContentLength(stream.ContentRange, stream.ContentLength, rangeHeader)
		if !valid {
			writeError(writer, http.StatusBadGateway, "invalid_media_response", "Dispatcharr returned an unsupported media response")
			return
		}
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("Content-Type", safeMediaType(stream.ContentType))
	if relayLength >= 0 {
		writer.Header().Set("Content-Length", strconv.FormatInt(relayLength, 10))
	}
	if stream.StatusCode == http.StatusPartialContent {
		writer.Header().Set("Content-Range", stream.ContentRange)
	}
	if strings.EqualFold(strings.TrimSpace(stream.AcceptRanges), "bytes") {
		writer.Header().Set("Accept-Ranges", "bytes")
	}
	if downloadFilename != "" {
		writer.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": downloadFilename}))
	}
	writer.WriteHeader(stream.StatusCode)
	controller := http.NewResponseController(writer)
	buffer := make([]byte, 64*1024)
	remaining := relayLength
	for remaining != 0 {
		readBuffer := buffer
		if remaining > 0 && int64(len(readBuffer)) > remaining {
			readBuffer = readBuffer[:remaining]
		}
		read, readErr := stream.Body.Read(readBuffer)
		if read > 0 {
			idleTimer.Reset(2 * time.Minute)
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, writeErr := writer.Write(buffer[:read]); writeErr != nil {
				return
			}
			if spec.kind == dispatcharr.MediaKindLive {
				_ = controller.Flush()
			}
			if progress != nil && !progress() {
				return
			}
			if remaining > 0 {
				remaining -= int64(read)
			}
		}
		if readErr != nil {
			return
		}
	}
}

func (s *Server) writeMediaError(writer http.ResponseWriter, request *http.Request, sessionID string, err error, revoke bool) {
	switch {
	case errors.Is(err, dispatcharr.ErrInvalidRange), errors.Is(err, dispatcharr.ErrRangeRejected):
		var rangeError *dispatcharr.RangeRejectedError
		if errors.As(err, &rangeError) && rangeError.ContentRange() != "" {
			writer.Header().Set("Content-Range", rangeError.ContentRange())
		}
		writeError(writer, http.StatusRequestedRangeNotSatisfiable, "range_not_satisfiable", "The requested media range is not available")
	case errors.Is(err, dispatcharr.ErrRedirect):
		writeError(writer, http.StatusBadGateway, "upstream_redirect_rejected", "Dispatcharr redirected the media request; playback was stopped")
	case errors.Is(err, dispatcharr.ErrUnauthorized):
		if revoke {
			s.writeDispatcharrError(writer, request, err, false)
		} else {
			s.revokeViewerState(sessionID)
			writeError(writer, http.StatusNotFound, "vlc_not_found", "VLC media was not found")
		}
	case errors.Is(err, dispatcharr.ErrNotFound), errors.Is(err, dispatcharr.ErrInvalidMedia):
		writeError(writer, http.StatusNotFound, "media_not_found", "Media is not available to this viewer")
	default:
		writeError(writer, http.StatusBadGateway, "dispatcharr_unavailable", "Dispatcharr could not be reached")
	}
}

func acceptedRange(writer http.ResponseWriter, raw string) (string, bool) {
	if len(raw) > 128 {
		writeError(writer, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "Byte range is malformed")
		return "", false
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", true
	}
	if !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") {
		writeError(writer, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "Only one byte range may be requested")
		return "", false
	}
	parts := strings.Split(strings.TrimPrefix(raw, "bytes="), "-")
	if len(parts) != 2 || parts[0] == "" && parts[1] == "" {
		writeError(writer, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "Byte range is malformed")
		return "", false
	}
	for _, part := range parts {
		if part == "" {
			continue
		}
		value, err := strconv.ParseUint(part, 10, 63)
		if err != nil || parts[0] == "" && value == 0 {
			writeError(writer, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "Byte range is malformed")
			return "", false
		}
	}
	if parts[0] != "" && parts[1] != "" {
		start, _ := strconv.ParseUint(parts[0], 10, 63)
		end, _ := strconv.ParseUint(parts[1], 10, 63)
		if start > end {
			writeError(writer, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "Byte range is malformed")
			return "", false
		}
	}
	return raw, true
}

func validPartialContentRange(raw string, contentLength int64, requestedRange string) bool {
	_, ok := partialContentLength(raw, contentLength, requestedRange)
	return ok
}

func partialContentLength(raw string, contentLength int64, requestedRange string) (int64, bool) {
	if !strings.HasPrefix(raw, "bytes ") {
		return 0, false
	}
	parts := strings.Split(strings.TrimPrefix(raw, "bytes "), "/")
	if len(parts) != 2 {
		return 0, false
	}
	bounds := strings.Split(parts[0], "-")
	if len(bounds) != 2 || bounds[0] == "" || bounds[1] == "" {
		return 0, false
	}
	start, startErr := strconv.ParseUint(bounds[0], 10, 63)
	end, endErr := strconv.ParseUint(bounds[1], 10, 63)
	if startErr != nil || endErr != nil || start > end {
		return 0, false
	}
	span := end - start
	if span >= uint64(1<<63-1) {
		return 0, false
	}
	rangeLength := int64(span + 1)
	var total uint64
	totalKnown := parts[1] != "*"
	if totalKnown {
		var err error
		total, err = strconv.ParseUint(parts[1], 10, 63)
		if err != nil || total == 0 || end >= total {
			return 0, false
		}
	}
	if contentLength >= 0 && contentLength != rangeLength {
		return 0, false
	}
	if !strings.HasPrefix(requestedRange, "bytes=") {
		return 0, false
	}
	requested := strings.Split(strings.TrimPrefix(requestedRange, "bytes="), "-")
	if len(requested) != 2 {
		return 0, false
	}
	if requested[0] != "" {
		requestedStart, err := strconv.ParseUint(requested[0], 10, 63)
		if err != nil || start != requestedStart {
			return 0, false
		}
		if requested[1] != "" {
			requestedEnd, err := strconv.ParseUint(requested[1], 10, 63)
			if err != nil {
				return 0, false
			}
			expectedEnd := requestedEnd
			if totalKnown && expectedEnd >= total {
				expectedEnd = total - 1
			}
			if end != expectedEnd {
				return 0, false
			}
		} else if !totalKnown || end != total-1 {
			return 0, false
		}
		return rangeLength, true
	}
	if !totalKnown {
		return 0, false
	}
	suffix, err := strconv.ParseUint(requested[1], 10, 63)
	if err != nil || suffix == 0 {
		return 0, false
	}
	expectedLength := min(suffix, total)
	if start != total-expectedLength || end != total-1 {
		return 0, false
	}
	return rangeLength, true
}

func boundedDownloadContext(parent context.Context, viewerSession session.Session, sessionAbsoluteTTL time.Duration) (context.Context, context.CancelFunc) {
	deadline := viewerSession.CreatedAt.Add(sessionAbsoluteTTL)
	if downloadDeadline := time.Now().Add(downloadMaxLifetime); downloadDeadline.Before(deadline) {
		deadline = downloadDeadline
	}
	return context.WithDeadline(parent, deadline)
}

func requireMediaGET(writer http.ResponseWriter, request *http.Request) bool {
	if request.Method == http.MethodGet {
		return true
	}
	writer.Header().Set("Allow", http.MethodGet)
	writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "This media endpoint requires GET")
	return false
}

func validPathID(writer http.ResponseWriter, raw, kind string) (string, bool) {
	id := strings.TrimSpace(raw)
	if id == "" || !validIdentifier(id) {
		writeError(writer, http.StatusBadRequest, "invalid_"+kind, fmt.Sprintf("%s ID is invalid", strings.ToUpper(kind[:1])+kind[1:]))
		return "", false
	}
	return id, true
}

func validEpisodePath(writer http.ResponseWriter, request *http.Request) (string, string, bool) {
	seriesID, ok := validPathID(writer, request.PathValue("series_id"), "series")
	if !ok {
		return "", "", false
	}
	episodeID, ok := validPathID(writer, request.PathValue("episode_id"), "episode")
	return seriesID, episodeID, ok
}

func safeMediaType(raw string) string {
	mediaType, _, err := mime.ParseMediaType(raw)
	if err == nil && (strings.HasPrefix(mediaType, "video/") || strings.HasPrefix(mediaType, "audio/") || mediaType == "application/octet-stream") {
		return mediaType
	}
	return "application/octet-stream"
}

func withExtension(base, extension string) string {
	extension = strings.TrimPrefix(extension, ".")
	if strings.HasSuffix(strings.ToLower(base), "."+strings.ToLower(extension)) {
		return base
	}
	return base + "." + extension
}

func contentKindLabel(spec mediaSpec, request *http.Request) string {
	if spec.kind == dispatcharr.MediaKindLive || request.PathValue("channel_id") != "" {
		return "channel"
	}
	if spec.kind == dispatcharr.MediaKindSeries || request.PathValue("episode_id") != "" {
		return "episode"
	}
	return "movie"
}
