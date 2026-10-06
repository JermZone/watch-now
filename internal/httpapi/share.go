package httpapi

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

// Tokens are destinations, never playback authorizations. Versioned authenticated
// encryption binds their purpose; random nonces keep repeated shares unlinkable.
// No titles, accounts, credentials or upstream addresses enter the payload.
type shareTarget struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Episode string `json:"episode,omitempty"`
}

var shareKinds = []string{"live", "movie", "episode", "recording"}
var shareAAD = []byte("watch-now:share:v1")
var errShare = errors.New("invalid share link")

func (t shareTarget) valid() bool {
	if t.ID == "" || !validIdentifier(t.ID) {
		return false
	}
	for _, kind := range shareKinds {
		if kind == t.Kind {
			return (kind == "episode" && t.Episode != "" && validIdentifier(t.Episode)) || (kind != "episode" && t.Episode == "")
		}
	}
	return false
}
func shareCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errShare
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errShare
	}
	return cipher.NewGCMWithRandomNonce(block)
}
func sealShare(key []byte, target shareTarget) (string, error) {
	if !target.valid() {
		return "", errShare
	}
	aead, err := shareCipher(key)
	if err != nil {
		return "", err
	}
	kind := byte(0)
	for i, k := range shareKinds {
		if target.Kind == k {
			kind = byte(i)
		}
	}
	payload := append([]byte{kind}, []byte(target.ID+"\x00"+target.Episode)...)
	return "1" + base64.RawURLEncoding.EncodeToString(aead.Seal(nil, nil, payload, shareAAD)), nil
}
func openShare(key []byte, token string) (shareTarget, error) {
	if len(token) < 40 || len(token) > 400 || token[0] != '1' {
		return shareTarget{}, errShare
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(token[1:])
	if err != nil {
		return shareTarget{}, errShare
	}
	aead, err := shareCipher(key)
	if err != nil {
		return shareTarget{}, errShare
	}
	payload, err := aead.Open(nil, nil, data, shareAAD)
	if err != nil || len(payload) < 3 || int(payload[0]) >= len(shareKinds) {
		return shareTarget{}, errShare
	}
	parts := strings.Split(string(payload[1:]), "\x00")
	if len(parts) != 2 {
		return shareTarget{}, errShare
	}
	target := shareTarget{shareKinds[payload[0]], parts[0], parts[1]}
	if !target.valid() {
		return shareTarget{}, errShare
	}
	return target, nil
}
func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	viewer := sessionFromContext(r.Context())
	if r.Method == "GET" {
		message := ""
		if len(s.cfg.ShareKey) != 32 {
			message = "Sharing is unavailable. Ask the server administrator to check sharing storage."
		}
		writeJSON(w, 200, struct {
			Enabled bool   `json:"enabled"`
			Message string `json:"message,omitempty"`
		}{len(s.cfg.ShareKey) == 32, message})
		return
	}
	if !s.validOrigin(r) || !validCSRF(r.Header.Get("X-CSRF-Token"), viewer.CSRFToken) {
		writeError(w, 403, "csrf_rejected", "Request was not accepted")
		return
	}
	if len(s.cfg.ShareKey) != 32 {
		writeError(w, 503, "share_disabled", "Sharing is not configured on this server")
		return
	}
	if allowed, _ := s.shareLimiter.Allow(viewer.ID); !allowed {
		writeError(w, 429, "rate_limited", "Too many share requests. Try again shortly.")
		return
	}
	select {
	case s.shareRequests <- struct{}{}:
		defer func() { <-s.shareRequests }()
	default:
		writeError(w, 503, "share_busy", "Sharing is busy. Try again shortly.")
		return
	}
	var target shareTarget
	resolving := r.URL.Path == "/api/share/resolve"
	if resolving {
		var input struct {
			Token string `json:"token"`
		}
		if decodeJSON(r, &input) != nil {
			writeError(w, 400, "invalid_share", "This share link is invalid or no longer available")
			return
		}
		var err error
		target, err = openShare(s.cfg.ShareKey, input.Token)
		if err != nil {
			writeError(w, 400, "invalid_share", "This share link is invalid or no longer available")
			return
		}
	} else if decodeJSON(r, &target) != nil || !target.valid() {
		writeError(w, 400, "invalid_share", "Choose an item to share")
		return
	}
	// Fresh viewer eligibility is checked for both sender and recipient. Resolution
	// returns only the destination; existing APIs recheck access when it is used.
	var err error
	switch target.Kind {
	case "live":
		_, err = s.currentChannelForViewer(r.Context(), viewer, target.ID, "")
	case "movie":
		_, err = s.movieDetailForViewer(r.Context(), viewer, target.ID)
	case "episode":
		var detail dispatcharr.SeriesDetail
		detail, err = s.seriesDetailForViewer(r.Context(), viewer, target.ID)
		if err == nil {
			_, err = episodeForViewer(detail, target.Episode)
		}
	case "recording":
		_, err = s.recordingMediaSpec(r.Context(), viewer, target.ID)
	}
	current, alive := s.sessions.Get(viewer.ID)
	if !alive || current.DVRKey != viewer.DVRKey {
		writeError(w, 401, "session_expired", "Sign in again")
		return
	}
	if err != nil {
		writeError(w, 404, "share_unavailable", "This item is unavailable or your account cannot access it. For recordings, connect DVR first.")
		return
	}
	if resolving {
		writeJSON(w, 200, target)
		return
	}
	token, err := sealShare(s.cfg.ShareKey, target)
	if err != nil {
		writeError(w, 500, "share_failed", "Could not create a share link")
		return
	}
	writeJSON(w, 201, map[string]string{"token": token})
}
