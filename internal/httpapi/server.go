package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/JermZone/watch-now/internal/cache"
	"github.com/JermZone/watch-now/internal/config"
	"github.com/JermZone/watch-now/internal/dispatcharr"
	"github.com/JermZone/watch-now/internal/ratelimit"
	"github.com/JermZone/watch-now/internal/session"
	vlcstore "github.com/JermZone/watch-now/internal/vlc"
)

const sessionCookieName = "dispatcharr_now_session"

var errChannelNotFound = errors.New("viewer-authorized channel not found")

type contextKey string

const sessionContextKey contextKey = "viewer-session"

type Server struct {
	dvrRequests    chan struct{}
	dvrWrites      chan struct{}
	dvrLimiter     *ratelimit.Limiter
	guideFills     chan struct{}
	lookups        itemLookups
	cfg            config.Config
	dispatcharr    dispatcharr.API
	sessions       *session.Store
	cache          *cache.Cache
	loginLimiter   *ratelimit.Limiter
	accountLimiter *ratelimit.Limiter
	playbacks      *playbackRegistry
	downloads      *downloadLimiter
	vlc            *vlcstore.Store
	logger         *slog.Logger
	static         http.Handler
}

type errorResponse struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type sessionResponse struct {
	User struct {
		Username string `json:"username"`
	} `json:"user"`
	CSRFToken string `json:"csrf_token"`
}

type guideResponse struct {
	Current  *dispatcharr.Program `json:"current"`
	Upcoming *dispatcharr.Program `json:"upcoming"`
}

func New(cfg config.Config, client dispatcharr.API, logger *slog.Logger) http.Handler {
	vlcLimit := cfg.VLCSessionLimit
	if vlcLimit <= 0 {
		vlcLimit = 1024
	}
	accountLimit := cfg.LoginAccountRateLimit
	if accountLimit <= 0 {
		accountLimit = 30
	}
	server := &Server{
		dvrRequests:    make(chan struct{}, 8),
		dvrWrites:      make(chan struct{}, 1),
		dvrLimiter:     ratelimit.New(30, time.Minute, cfg.SessionLimit),
		guideFills:     make(chan struct{}, 2),
		cfg:            cfg,
		dispatcharr:    client,
		sessions:       session.NewStore(cfg.SessionIdleTimeout, cfg.SessionAbsoluteTTL, cfg.SessionLimit),
		cache:          cache.New(cfg.CacheEntries, cfg.CacheMaxBytes),
		loginLimiter:   ratelimit.New(cfg.LoginRateLimit, cfg.LoginRateWindow, cfg.LoginRateLimitPeers),
		accountLimiter: ratelimit.New(accountLimit, cfg.LoginRateWindow, cfg.LoginRateLimitPeers),
		playbacks:      newPlaybackRegistry(),
		downloads:      newDownloadLimiter(),
		vlc:            vlcstore.NewStore(vlcLimit),
		logger:         logger,
		static:         spaHandler(cfg.WebRoot),
	}
	return server.middleware(server.routes())
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	for _, pattern := range []string{"GET /api/dvr/connection", "POST /api/dvr/connection", "DELETE /api/dvr/connection", "GET /api/dvr/recordings", "POST /api/dvr/recordings", "DELETE /api/dvr/recordings/{recording_id}", "POST /api/dvr/recordings/{recording_id}/{action}", "GET /api/dvr/recordings/{recording_id}/{resource}"} {
		mux.Handle(pattern, s.requireSession(http.HandlerFunc(s.handleDVR)))
	}
	mux.HandleFunc("GET /api/health/live", s.handleLiveness)
	mux.HandleFunc("GET /api/health/ready", s.handleReadiness)
	mux.Handle("GET /api/diagnostics/dispatcharr", s.requireSession(http.HandlerFunc(s.handleDiagnostics)))
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.Handle("POST /api/auth/logout", s.requireSession(http.HandlerFunc(s.handleLogout)))
	mux.Handle("GET /api/session", s.requireSession(http.HandlerFunc(s.handleSession)))
	mux.Handle("GET /api/live/search/capabilities", s.requireSession(http.HandlerFunc(s.handleSearchCapabilities)))
	mux.Handle("GET /api/live/programs/search", s.requireSession(http.HandlerFunc(s.handleProgramSearch)))
	mux.Handle("GET /api/live/categories", s.requireSession(http.HandlerFunc(s.handleCategories)))
	mux.Handle("GET /api/live/channels", s.requireSession(http.HandlerFunc(s.handleChannels)))
	mux.Handle("GET /api/live/channels/{channel_id}/epg", s.requireSession(http.HandlerFunc(s.handleEPG)))
	mux.Handle("GET /api/live/channels/{channel_id}/artwork", s.requireSession(http.HandlerFunc(s.handleArtwork)))
	mux.Handle("GET /api/live/channels/{channel_id}/stream", s.requireSession(http.HandlerFunc(s.handleLiveStream)))
	mux.Handle("POST /api/live/channels/{channel_id}/vlc", s.requireSession(http.HandlerFunc(s.handleLiveVLC)))
	mux.Handle("GET /api/movies/categories", s.requireSession(http.HandlerFunc(s.handleMovieCategories)))
	mux.Handle("GET /api/movies", s.requireSession(http.HandlerFunc(s.handleMovies)))
	mux.Handle("GET /api/movies/{movie_id}", s.requireSession(http.HandlerFunc(s.handleMovieDetail)))
	mux.Handle("GET /api/movies/{movie_id}/artwork", s.requireSession(http.HandlerFunc(s.handleMovieArtwork)))
	mux.Handle("GET /api/movies/{movie_id}/stream", s.requireSession(http.HandlerFunc(s.handleMovieStream)))
	mux.Handle("GET /api/movies/{movie_id}/download", s.requireSession(http.HandlerFunc(s.handleMovieDownload)))
	mux.Handle("POST /api/movies/{movie_id}/vlc", s.requireSession(http.HandlerFunc(s.handleMovieVLC)))
	mux.Handle("GET /api/series/categories", s.requireSession(http.HandlerFunc(s.handleSeriesCategories)))
	mux.Handle("GET /api/series", s.requireSession(http.HandlerFunc(s.handleSeries)))
	mux.Handle("GET /api/series/{series_id}", s.requireSession(http.HandlerFunc(s.handleSeriesDetail)))
	mux.Handle("GET /api/series/{series_id}/artwork", s.requireSession(http.HandlerFunc(s.handleSeriesArtwork)))
	mux.Handle("GET /api/series/{series_id}/episodes/{episode_id}/stream", s.requireSession(http.HandlerFunc(s.handleEpisodeStream)))
	mux.Handle("GET /api/series/{series_id}/episodes/{episode_id}/download", s.requireSession(http.HandlerFunc(s.handleEpisodeDownload)))
	mux.Handle("POST /api/series/{series_id}/episodes/{episode_id}/vlc", s.requireSession(http.HandlerFunc(s.handleEpisodeVLC)))
	mux.HandleFunc("GET /api/vlc/launch/{ticket_id}", s.handleVLCLaunch)
	mux.HandleFunc("GET /api/vlc/launch/{ticket_id}/{filename}", s.handleVLCLaunch)
	mux.HandleFunc("GET /api/vlc/media/{media_id}", s.handleVLCMedia)
	mux.HandleFunc("GET /api/vlc/media/{media_id}/{filename}", s.handleVLCMedia)
	mux.HandleFunc("/api/", func(writer http.ResponseWriter, _ *http.Request) {
		writeError(writer, http.StatusNotFound, "not_found", "API endpoint not found")
	})
	mux.Handle("/", s.static)
	return mux
}

func (s *Server) handleLiveness(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

// Public status is deliberately limited to a boolean; details require a viewer session.
func (s *Server) handleReadiness(writer http.ResponseWriter, request *http.Request) {
	const key = "global:dispatcharr-readiness"
	if cached, ok := s.cache.Get(key); ok {
		writeJSON(writer, http.StatusOK, cached)
		return
	}
	status := map[string]bool{"reachable": s.dispatcharr.Diagnostics(request.Context()).Reachable}
	s.cache.Set(key, status, 32, s.cfg.DiagnosticCacheTTL)
	writeJSON(writer, http.StatusOK, status)
}

func (s *Server) handleDiagnostics(writer http.ResponseWriter, request *http.Request) {
	const key = "global:dispatcharr-diagnostics"
	if cached, ok := s.cache.Get(key); ok {
		writeJSON(writer, http.StatusOK, cached)
		return
	}
	diagnostics := s.dispatcharr.Diagnostics(request.Context())
	payload, _ := json.Marshal(diagnostics)
	s.cache.Set(key, diagnostics, int64(len(payload)), s.cfg.DiagnosticCacheTTL)
	writeJSON(writer, http.StatusOK, diagnostics)
}

func (s *Server) handleLogin(writer http.ResponseWriter, request *http.Request) {
	if !s.validOrigin(request) {
		writeError(writer, http.StatusForbidden, "invalid_origin", "Request origin was not accepted")
		return
	}
	clientIP := s.clientIP(request)
	allowed, retryAfter := s.loginLimiter.Allow(clientIP)
	if !allowed {
		writer.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		writeError(writer, http.StatusTooManyRequests, "rate_limited", "Too many login attempts; try again later")
		return
	}

	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(request, &input); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_request", "Enter a username and password")
		return
	}
	input.Username = strings.TrimSpace(input.Username)
	if input.Username == "" || input.Password == "" || len(input.Username) > 256 || len(input.Password) > 1024 {
		writeError(writer, http.StatusBadRequest, "invalid_request", "Enter a username and password")
		return
	}

	// Hash normalized account keys so this bounded limiter holds no account names.
	accountKey := fmt.Sprintf("%x", sha256.Sum256([]byte(strings.ToLower(input.Username))))
	if allowed, retryAfter := s.accountLimiter.Allow(accountKey); !allowed {
		writer.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		writeError(writer, http.StatusTooManyRequests, "rate_limited", "Too many login attempts; try again later")
		return
	}
	credentials := dispatcharr.Credentials{Username: input.Username, Password: input.Password}
	account, err := s.dispatcharr.Authenticate(request.Context(), credentials)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, true)
		return
	}
	if account.Status != "" && !strings.EqualFold(account.Status, "active") {
		writeError(writer, http.StatusUnauthorized, "invalid_credentials", "Dispatcharr did not accept this viewer account")
		return
	}

	viewerSession, err := s.sessions.Create(credentials, account.Username)
	if err != nil {
		if errors.Is(err, session.ErrCapacity) {
			writeError(writer, http.StatusServiceUnavailable, "session_capacity", "Watch Now is at session capacity")
			return
		}
		s.logger.Error("could not create viewer session", "error", err)
		writeError(writer, http.StatusInternalServerError, "session_error", "A viewer session could not be created")
		return
	}

	// The configured key is selected only after successful XC authentication.
	// DVR requests still verify REST identity and permissions before using it.
	if key := s.cfg.DVRAPIKeys[account.Username]; key != "" {
		s.sessions.SetDVRKey(viewerSession.ID, "", key)
	}
	http.SetCookie(writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    viewerSession.ID,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookie(request),
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(writer, http.StatusOK, newSessionResponse(viewerSession))
}

func (s *Server) handleLogout(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	if !s.validOrigin(request) || !validCSRF(request.Header.Get("X-CSRF-Token"), viewerSession.CSRFToken) {
		writeError(writer, http.StatusForbidden, "csrf_rejected", "CSRF validation failed")
		return
	}
	s.revokeViewerState(viewerSession.ID)
	s.expireSessionCookie(writer, request)
	writer.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLiveStream(writer http.ResponseWriter, request *http.Request) {
	if !requireMediaGET(writer, request) {
		return
	}
	viewerSession := sessionFromContext(request.Context())
	channelID := strings.TrimSpace(request.PathValue("channel_id"))
	if channelID == "" || !validIdentifier(channelID) {
		writeError(writer, http.StatusBadRequest, "invalid_channel", "Channel ID is invalid")
		return
	}

	// Register before authorization so a concurrent logout can cancel this
	// request even while the authorized catalog is being fetched. Re-check the
	// session after registration to close the inverse logout-before-start race.
	streamContext, generation := s.playbacks.start(
		request.Context(), viewerSession, s.cfg.SessionAbsoluteTTL,
	)
	playbackBegan := false
	defer func() {
		if s.playbacks.finish(viewerSession.ID, generation) && playbackBegan {
			s.sessions.EndPlayback(viewerSession.ID)
		}
	}()
	currentSession, ok := s.sessions.BeginPlayback(viewerSession.ID)
	if !ok {
		writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
		return
	}
	playbackBegan = true
	viewerSession = currentSession
	if _, err := s.currentChannelForViewer(streamContext, viewerSession, channelID, ""); err != nil {
		if streamContext.Err() != nil {
			return
		}
		if errors.Is(err, errChannelNotFound) {
			writeError(writer, http.StatusNotFound, "channel_not_found", "Channel is not available to this viewer")
			return
		}
		s.writeDispatcharrError(writer, request, err, false)
		return
	}

	streamContext, cancelRelay := context.WithCancel(streamContext)
	defer cancelRelay()
	stream, err := s.dispatcharr.OpenLiveStream(streamContext, viewerSession.Credentials, channelID)
	if err != nil {
		if streamContext.Err() != nil {
			return
		}
		if errors.Is(err, dispatcharr.ErrRedirect) {
			writeError(writer, http.StatusBadGateway, "upstream_redirect_rejected", "Dispatcharr redirected the live stream; playback was stopped")
			return
		}
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	defer stream.Body.Close()
	idleTimer := time.AfterFunc(2*time.Minute, cancelRelay)
	defer idleTimer.Stop()

	writer.Header().Set("Content-Type", "video/mp2t")
	writer.WriteHeader(http.StatusOK)
	buffer := make([]byte, 32*1024)
	controller := http.NewResponseController(writer)
	for {
		read, readErr := stream.Body.Read(buffer)
		if read > 0 {
			idleTimer.Reset(2 * time.Minute)
			// Refresh the write deadline for an active stream without permitting a
			// stalled viewer to retain its upstream connection indefinitely.
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, writeErr := writer.Write(buffer[:read]); writeErr != nil {
				return
			}
			_ = controller.Flush()
		}
		if readErr != nil {
			return
		}
	}
}

func (s *Server) handleSession(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, newSessionResponse(sessionFromContext(request.Context())))
}

func (s *Server) handleCategories(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	key := viewerSession.ID + ":categories"
	if cached, ok := s.cache.Get(key); ok {
		writeJSON(writer, http.StatusOK, cached)
		return
	}
	categories, err := s.dispatcharr.LiveCategories(request.Context(), viewerSession.Credentials)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	payload, _ := json.Marshal(categories)
	s.cache.Set(key, categories, int64(len(payload)), s.cfg.CategoryCacheTTL)
	writeJSON(writer, http.StatusOK, categories)
}

func (s *Server) handleChannels(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	categoryID := strings.TrimSpace(request.URL.Query().Get("category_id"))
	if !validIdentifier(categoryID) {
		writeError(writer, http.StatusBadRequest, "invalid_category", "Category ID is too long")
		return
	}
	channels, err := s.channelsForViewer(request.Context(), viewerSession, categoryID)
	if err != nil {
		s.writeDispatcharrError(writer, request, err, false)
		return
	}
	writeJSON(writer, http.StatusOK, channels)
}

func (s *Server) channelsForViewer(ctx context.Context, viewerSession session.Session, categoryID string) ([]dispatcharr.Channel, error) {
	key := viewerSession.ID + ":channels:" + categoryID
	if cached, ok := s.cache.Get(key); ok {
		return cached.([]dispatcharr.Channel), nil
	}
	channels, err := s.dispatcharr.LiveChannels(ctx, viewerSession.Credentials, categoryID)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(channels)
	cacheSize := int64(len(payload))
	for _, channel := range channels {
		cacheSize += int64(len(channel.ArtworkURL()))
	}
	s.cache.Set(key, channels, cacheSize, s.cfg.ChannelCacheTTL)
	return channels, nil
}

// Playback and EPG must not inherit eligibility from a stale browsing cache.
func (s *Server) currentChannelForViewer(ctx context.Context, viewerSession session.Session, channelID, categoryID string) (dispatcharr.Channel, error) {
	value, err := s.lookups.do(ctx, viewerSession.ID+":live:"+categoryID, func() (any, error) {
		return s.dispatcharr.LiveChannels(ctx, viewerSession.Credentials, categoryID)
	})
	if err != nil {
		return dispatcharr.Channel{}, err
	}
	if _, alive := s.sessions.Get(viewerSession.ID); !alive {
		return dispatcharr.Channel{}, dispatcharr.ErrUnauthorized
	}
	for _, channel := range value.([]dispatcharr.Channel) {
		if channel.ID == channelID {
			return channel, nil
		}
	}
	return dispatcharr.Channel{}, errChannelNotFound
}

func (s *Server) handleEPG(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	channelID := strings.TrimSpace(request.PathValue("channel_id"))
	categoryID := strings.TrimSpace(request.URL.Query().Get("category_id"))
	if channelID == "" || !validIdentifier(channelID) || !validIdentifier(categoryID) {
		writeError(writer, http.StatusBadRequest, "invalid_channel", "Channel or category ID is invalid")
		return
	}
	if _, err := s.currentChannelForViewer(request.Context(), viewerSession, channelID, categoryID); err != nil {
		if errors.Is(err, errChannelNotFound) {
			writeError(writer, http.StatusNotFound, "channel_not_found", "Channel is not available to this viewer")
			return
		}
		s.writeDispatcharrError(writer, request, err, false)
		return
	}

	key := viewerSession.ID + ":epg:" + channelID
	var programs []dispatcharr.Program
	if cached, ok := s.cache.Get(key); ok {
		programs = cached.([]dispatcharr.Program)
	} else {
		var err error
		programs, err = s.dispatcharr.LiveEPG(request.Context(), viewerSession.Credentials, channelID)
		if err != nil {
			s.writeDispatcharrError(writer, request, err, false)
			return
		}
		payload, _ := json.Marshal(programs)
		s.cache.Set(key, programs, int64(len(payload)), s.cfg.EPGCacheTTL)
	}
	writeJSON(writer, http.StatusOK, guideAt(programs, time.Now()))
}

func (s *Server) handleArtwork(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	channelID := strings.TrimSpace(request.PathValue("channel_id"))
	categoryID := strings.TrimSpace(request.URL.Query().Get("category_id"))
	if channelID == "" || !validIdentifier(channelID) || !validIdentifier(categoryID) {
		writeError(writer, http.StatusBadRequest, "invalid_channel", "Channel or category ID is invalid")
		return
	}
	channel, err := s.currentChannelForViewer(request.Context(), viewerSession, channelID, categoryID)
	if err != nil || !channel.HasArtwork {
		if err != nil && !errors.Is(err, errChannelNotFound) {
			s.writeDispatcharrError(writer, request, err, false)
			return
		}
		writeError(writer, http.StatusNotFound, "artwork_not_found", "Channel artwork is not available")
		return
	}

	key := viewerSession.ID + ":artwork:" + channelID
	var artwork dispatcharr.Artwork
	if cached, ok := s.cache.Get(key); ok {
		artwork = cached.(dispatcharr.Artwork)
	} else {
		artwork, err = s.dispatcharr.ChannelArtwork(request.Context(), channel)
		if err != nil {
			if errors.Is(err, dispatcharr.ErrArtworkMissing) {
				writeError(writer, http.StatusNotFound, "artwork_not_found", "Channel artwork is not available")
				return
			}
			s.writeDispatcharrError(writer, request, err, false)
			return
		}
		s.cache.Set(key, artwork, int64(len(artwork.Data)), s.cfg.ArtworkCacheTTL)
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("Content-Type", artwork.ContentType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(artwork.Data)))
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(artwork.Data)
}

func validIdentifier(value string) bool {
	return len(value) <= 128 && !strings.ContainsAny(value, "/\\\x00")
}

func guideAt(programs []dispatcharr.Program, now time.Time) guideResponse {
	ordered := append([]dispatcharr.Program(nil), programs...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Start.Before(ordered[j].Start) })
	guide := guideResponse{}
	for index := range ordered {
		program := &ordered[index]
		if !program.Start.After(now) && program.End.After(now) {
			guide.Current = program
			continue
		}
		if program.Start.After(now) {
			guide.Upcoming = program
			break
		}
	}
	return guide
}

func (s *Server) writeDispatcharrError(writer http.ResponseWriter, request *http.Request, err error, login bool) {
	switch {
	case errors.Is(err, dispatcharr.ErrUnauthorized):
		if login {
			writeError(writer, http.StatusUnauthorized, "invalid_credentials", "Dispatcharr did not accept those viewer credentials")
		} else {
			viewerSession := sessionFromContext(request.Context())
			s.revokeViewerState(viewerSession.ID)
			s.expireSessionCookie(writer, request)
			writeError(writer, http.StatusUnauthorized, "session_expired", "The Dispatcharr viewer credentials are no longer accepted")
		}
	case errors.Is(err, dispatcharr.ErrInvalidResponse):
		writeError(writer, http.StatusBadGateway, "unsupported_interface", "Dispatcharr returned an XC response that Now could not understand")
	case errors.Is(err, dispatcharr.ErrResponseTooBig):
		writeError(writer, http.StatusBadGateway, "upstream_response_too_large", "Dispatcharr returned more data than Now is configured to accept")
	case errors.Is(err, dispatcharr.ErrNotFound):
		writeError(writer, http.StatusNotFound, "upstream_not_found", "Dispatcharr no longer has this resource")
	default:
		writeError(writer, http.StatusBadGateway, "dispatcharr_unavailable", "Dispatcharr could not be reached")
	}
}

func (s *Server) revokeViewerState(sessionID string) {
	s.playbacks.stop(sessionID)
	s.downloads.stop(sessionID)
	s.vlc.DeleteSession(sessionID)
	s.sessions.Delete(sessionID)
	s.cache.DeletePrefix(sessionID + ":")
}

func (s *Server) expireSessionCookie(writer http.ResponseWriter, request *http.Request) {
	http.SetCookie(writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   s.secureCookie(request),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(sessionCookieName)
		if err != nil || cookie.Value == "" {
			writeError(writer, http.StatusUnauthorized, "session_expired", "Sign in to continue")
			return
		}
		viewerSession, ok := s.sessions.Get(cookie.Value)
		if !ok {
			s.revokeViewerState(cookie.Value)
			writeError(writer, http.StatusUnauthorized, "session_expired", "Your viewer session expired; sign in again")
			return
		}
		next.ServeHTTP(writer, request.WithContext(context.WithValue(request.Context(), sessionContextKey, viewerSession)))
	})
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return s.recoverPanics(s.securityHeaders(s.requestLogger(next)))
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("X-Frame-Options", "DENY")
		writer.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if strings.HasPrefix(request.URL.Path, "/api/") {
			writer.Header().Set("Cache-Control", "no-store")
			writer.Header().Add("Vary", "Cookie")
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		capture := &statusWriter{ResponseWriter: writer, status: http.StatusOK}
		next.ServeHTTP(capture, request)
		s.logger.Info("request",
			"method", request.Method,
			"path", safeLogPath(request.URL.Path),
			"status", capture.status,
			"duration_ms", time.Since(started).Milliseconds(),
			"client_ip", s.clientIP(request),
		)
	})
}

func safeLogPath(requestPath string) string {
	raw := "/" + strings.TrimLeft(requestPath, "/")
	normalized := path.Clean(raw)
	if raw == "/api/vlc" || strings.HasPrefix(raw, "/api/vlc/") ||
		normalized == "/api/vlc" || strings.HasPrefix(normalized, "/api/vlc/") {
		return "/api/vlc/{redacted}"
	}
	return requestPath
}

func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("request panic", "path", safeLogPath(request.URL.Path))
				writeError(writer, http.StatusInternalServerError, "internal_error", "An internal error occurred")
			}
		}()
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) validOrigin(request *http.Request) bool {
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		referer := strings.TrimSpace(request.Header.Get("Referer"))
		if referer == "" {
			return false
		}
		parsed, err := url.Parse(referer)
		if err != nil {
			return false
		}
		origin = parsed.Scheme + "://" + parsed.Host
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	host := request.Host
	if s.cfg.TrustProxyHeaders {
		if forwardedProto := firstHeaderValue(request.Header.Get("X-Forwarded-Proto")); forwardedProto == "http" || forwardedProto == "https" {
			scheme = forwardedProto
		}
		if forwardedHost := firstHeaderValue(request.Header.Get("X-Forwarded-Host")); forwardedHost != "" {
			host = forwardedHost
		}
	}
	return strings.EqualFold(parsed.Scheme, scheme) && strings.EqualFold(parsed.Host, host)
}

func (s *Server) secureCookie(request *http.Request) bool {
	switch s.cfg.CookieSecure {
	case "true":
		return true
	case "false":
		return false
	default:
		if request.TLS != nil {
			return true
		}
		return s.cfg.TrustProxyHeaders && firstHeaderValue(request.Header.Get("X-Forwarded-Proto")) == "https"
	}
}

func (s *Server) clientIP(request *http.Request) string {
	if s.cfg.TrustProxyHeaders {
		if forwarded := firstHeaderValue(request.Header.Get("X-Forwarded-For")); forwarded != "" {
			return forwarded
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		return host
	}
	return request.RemoteAddr
}

func firstHeaderValue(value string) string {
	if index := strings.IndexByte(value, ','); index >= 0 {
		value = value[:index]
	}
	return strings.TrimSpace(value)
}

func validCSRF(provided, expected string) bool {
	if provided == "" || expected == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func decodeJSON(request *http.Request, destination any) error {
	const maxBodyBytes = 16 * 1024
	data, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxBodyBytes {
		return fmt.Errorf("request body is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return fmt.Errorf("request contained more than one JSON value")
	}
	return nil
}

func newSessionResponse(viewerSession session.Session) sessionResponse {
	response := sessionResponse{CSRFToken: viewerSession.CSRFToken}
	response.User.Username = viewerSession.Username
	return response
}

func sessionFromContext(ctx context.Context) session.Session {
	return ctx.Value(sessionContextKey).(session.Session)
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	response := errorResponse{}
	response.Error.Code = code
	response.Error.Message = message
	writeJSON(writer, status, response)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *statusWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func spaHandler(webRoot string) http.Handler {
	fileServer := http.FileServer(http.Dir(webRoot))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		cleanPath := strings.TrimPrefix(filepath.ToSlash(filepath.Clean("/"+request.URL.Path)), "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}
		candidate := filepath.Join(webRoot, filepath.FromSlash(cleanPath))
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			if filepath.Ext(cleanPath) != "" || !strings.Contains(request.Header.Get("Accept"), "text/html") {
				http.NotFound(writer, request)
				return
			}
			indexPath := filepath.Join(webRoot, "index.html")
			indexFile, openErr := os.Open(indexPath)
			if openErr != nil {
				http.NotFound(writer, request)
				return
			}
			defer indexFile.Close()
			indexInfo, statErr := indexFile.Stat()
			if statErr != nil {
				http.NotFound(writer, request)
				return
			}
			writer.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(writer, request, "index.html", indexInfo.ModTime(), indexFile)
			return
		}
		if cleanPath == "index.html" {
			writer.Header().Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(cleanPath, "assets/") {
			writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fileServer.ServeHTTP(writer, request)
	})
}
