package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func (s *Server) handleMovieArtwork(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	movieID := strings.TrimSpace(request.PathValue("movie_id"))
	if movieID == "" || !validIdentifier(movieID) {
		writeError(writer, http.StatusBadRequest, "invalid_movie", "Movie ID is invalid")
		return
	}
	movie, err := s.movieForViewer(request.Context(), viewerSession, movieID)
	if err != nil {
		s.writeCatalogError(writer, request, err, "movie")
		return
	}
	artworkURL := movie.ArtworkURL()
	if cached, ok := s.cache.Get(viewerSession.ID + ":movie-detail:" + movieID); ok {
		if detailURL := cached.(dispatcharr.MovieDetail).ArtworkURL(); detailURL != "" {
			artworkURL = detailURL
		}
	}
	s.serveVODArtwork(writer, request, viewerSession.ID+":movie-artwork:"+movieID, artworkURL)
}

func (s *Server) handleSeriesArtwork(writer http.ResponseWriter, request *http.Request) {
	viewerSession := sessionFromContext(request.Context())
	seriesID := strings.TrimSpace(request.PathValue("series_id"))
	if seriesID == "" || !validIdentifier(seriesID) {
		writeError(writer, http.StatusBadRequest, "invalid_series", "Series ID is invalid")
		return
	}
	series, err := s.seriesForViewerByID(request.Context(), viewerSession, seriesID)
	if err != nil {
		s.writeCatalogError(writer, request, err, "series")
		return
	}
	artworkURL := series.ArtworkURL()
	if cached, ok := s.cache.Get(viewerSession.ID + ":series-detail:" + seriesID); ok {
		if detailURL := cached.(dispatcharr.SeriesDetail).ArtworkURL(); detailURL != "" {
			artworkURL = detailURL
		}
	} else if cached, ok := s.cache.Get(viewerSession.ID + ":series-detail:" + seriesID + ":artwork"); ok {
		if detailURL := cached.(dispatcharr.SeriesDetail).ArtworkURL(); detailURL != "" {
			artworkURL = detailURL
		}
	}
	s.serveVODArtwork(writer, request, viewerSession.ID+":series-artwork:"+seriesID, artworkURL)
}

func (s *Server) serveVODArtwork(writer http.ResponseWriter, request *http.Request, cacheKey, upstreamURL string) {
	if upstreamURL == "" {
		writeError(writer, http.StatusNotFound, "artwork_not_found", "Artwork is not available")
		return
	}
	var artwork dispatcharr.Artwork
	var err error
	if cached, ok := s.cache.Get(cacheKey); ok {
		artwork = cached.(dispatcharr.Artwork)
	} else {
		artwork, err = s.dispatcharr.MediaArtwork(request.Context(), upstreamURL)
		if err != nil {
			if errors.Is(err, dispatcharr.ErrArtworkMissing) || errors.Is(err, dispatcharr.ErrNotFound) {
				writeError(writer, http.StatusNotFound, "artwork_not_found", "Artwork is not available")
				return
			}
			s.writeDispatcharrError(writer, request, err, false)
			return
		}
		if _, alive := s.sessions.Get(sessionFromContext(request.Context()).ID); !alive {
			s.writeDispatcharrError(writer, request, dispatcharr.ErrUnauthorized, false)
			return
		}
		s.cache.Set(cacheKey, artwork, int64(len(artwork.Data)), s.cfg.ArtworkCacheTTL)
	}
	if _, alive := s.sessions.Get(sessionFromContext(request.Context()).ID); !alive {
		s.writeDispatcharrError(writer, request, dispatcharr.ErrUnauthorized, false)
		return
	}
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("Content-Type", artwork.ContentType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(artwork.Data)))
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(artwork.Data)
}
