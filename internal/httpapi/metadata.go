package httpapi

import "net/http"

func (s *Server) boundMetadata(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.metadataRequests <- struct{}{}:
			defer func() { <-s.metadataRequests }()
			next.ServeHTTP(w, r)
		default:
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "metadata_busy", "Catalog capacity is busy; retry shortly")
		}
	})
}
