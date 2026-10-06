package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/JermZone/watch-now/internal/config"
)

func TestShareEncryption(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	for _, target := range []shareTarget{{"live", "41", ""}, {"movie", "123456", ""}, {"episode", "123", "9876"}, {"recording", "42", ""}} {
		token, err := sealShare(key, target)
		if err != nil {
			t.Fatal(err)
		}
		other, _ := sealShare(key, target)
		if token == other {
			t.Fatal("nonce reused")
		}
		got, err := openShare(append([]byte(nil), key...), token)
		if err != nil || got != target {
			t.Fatalf("round trip: %v", err)
		}
		if len(token) > 65 {
			t.Fatalf("compact ID token unexpectedly long: %d", len(token))
		}
		t.Logf("%s: %d-character token", target.Kind, len(token))
		for i := 1; i < len(token); i++ {
			changed := []byte(token)
			if changed[i] == 'A' {
				changed[i] = 'B'
			} else {
				changed[i] = 'A'
			}
			if _, err := openShare(key, string(changed)); err == nil {
				t.Fatal("tampered token accepted")
			}
		}
		if _, err := openShare(bytes.Repeat([]byte{8}, 32), token); err == nil {
			t.Fatal("rotated key accepted old token")
		}
	}
	for _, token := range []string{"", "1", strings.Repeat("A", 401), "2" + strings.Repeat("A", 50)} {
		if _, err := openShare(key, token); err == nil {
			t.Fatal("invalid token accepted")
		}
	}
	for _, target := range []shareTarget{{"redirect", "https://evil.test", ""}, {"movie", "", ""}, {"live", "41", "extra"}, {"episode", "1", ""}, {"movie", "../1", ""}} {
		if _, err := sealShare(key, target); err == nil {
			t.Fatal("invalid target accepted")
		}
	}
}

func TestAutomaticSharingSurvivesServerRecreation(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	t.Setenv("DISPATCHARR_URL", "http://dispatcharr.test")
	t.Setenv("NOW_SHARE_KEY", "")
	t.Setenv("NOW_SHARE_KEY_FILE", "")
	t.Setenv("NOW_SHARE_KEY_DIR", dir)
	first, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	h := New(first, liveVLCFake(), slog.New(slog.NewTextHandler(&logs, nil)))
	cookie, viewer := loginViewer(t, h)
	w := shareRequest(h, cookie, viewer.CSRFToken, "/api/share", shareTarget{"live", "41", ""})
	if w.Code != 201 {
		t.Fatal("automatic sharing unavailable", w.Code)
	}
	var created struct {
		Token string `json:"token"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	second, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	h = New(second, liveVLCFake(), slog.New(slog.NewTextHandler(&logs, nil)))
	cookie, viewer = loginViewer(t, h)
	w = shareRequest(h, cookie, viewer.CSRFToken, "/api/share/resolve", map[string]string{"token": created.Token})
	if w.Code != 200 {
		t.Fatal("existing link did not survive recreation", w.Code)
	}
	if strings.Contains(logs.String(), created.Token) || strings.Contains(logs.String(), fmt.Sprintf("%x", first.ShareKey)) {
		t.Fatal("sharing secret leaked")
	}
}
func shareRequest(h http.Handler, cookie *http.Cookie, csrf, path string, body any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", path, bytes.NewReader(data))
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-CSRF-Token", csrf)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestShareAuthenticationRevocationAndLogs(t *testing.T) {
	cfg := testConfig(t)
	cfg.ShareKey = bytes.Repeat([]byte{7}, 32)
	fake := liveVLCFake()
	var logs bytes.Buffer
	h := New(cfg, fake, slog.New(slog.NewTextHandler(&logs, nil)))
	target := shareTarget{"live", "41", ""}
	if w := shareRequest(h, nil, "", "/api/share", target); w.Code != 401 {
		t.Fatal(w.Code)
	}
	cookie, viewer := loginViewer(t, h)
	if w := shareRequest(h, cookie, "wrong", "/api/share", target); w.Code != 403 {
		t.Fatal(w.Code)
	}
	w := shareRequest(h, cookie, viewer.CSRFToken, "/api/share", target)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var created struct {
		Token string `json:"token"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	// A different viewer must use their own current lineup, not the sender's session.
	recipient, other := loginViewerAs(t, h, "friend", "password", "192.0.2.2:1234")
	w = shareRequest(h, recipient, other.CSRFToken, "/api/share/resolve", map[string]string{"token": created.Token})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("share response cached")
	}
	if strings.Contains(logs.String(), created.Token) || strings.Contains(logs.String(), "World News") {
		t.Fatal("share metadata leaked in logs")
	}
	fake.mu.Lock()
	fake.channels = nil
	fake.mu.Unlock()
	w = shareRequest(h, recipient, other.CSRFToken, "/api/share/resolve", map[string]string{"token": created.Token})
	if w.Code != 404 {
		t.Fatal("revoked content resolved", w.Code)
	}
	if fake.streamCalls != 0 {
		t.Fatal("share started playback")
	}
	for i := 0; i < 65; i++ {
		w = shareRequest(h, cookie, viewer.CSRFToken, "/api/share/resolve", map[string]string{"token": "invalid"})
	}
	if w.Code != 429 {
		t.Fatal("missing share rate limit", w.Code)
	}
}
func TestSharingDisabledByDefault(t *testing.T) {
	h := newTestHandler(t, liveVLCFake(), io.Discard)
	cookie, viewer := loginViewer(t, h)
	w := shareRequest(h, cookie, viewer.CSRFToken, "/api/share", shareTarget{"live", "41", ""})
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestShareCatalogEligibility(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fake   *fakeDispatcharr
		target shareTarget
	}{
		{"movie", movieFake(), shareTarget{"movie", "41", ""}},
		{"episode", episodeFake(), shareTarget{"episode", "51", "971"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig(t)
			cfg.ShareKey = bytes.Repeat([]byte{1}, 32)
			h := New(cfg, tc.fake, slog.New(slog.NewTextHandler(io.Discard, nil)))
			cookie, viewer := loginViewer(t, h)
			w := shareRequest(h, cookie, viewer.CSRFToken, "/api/share", tc.target)
			if w.Code != 201 {
				t.Fatal(w.Code, w.Body.String())
			}
			var created struct {
				Token string `json:"token"`
			}
			json.Unmarshal(w.Body.Bytes(), &created)
			tc.fake.movies = nil
			tc.fake.seriesDetail.Episodes = nil
			w = shareRequest(h, cookie, viewer.CSRFToken, "/api/share/resolve", map[string]string{"token": created.Token})
			if w.Code != 404 {
				t.Fatal("removed item resolved", w.Code)
			}
			if tc.fake.mediaCalls != 0 {
				t.Fatal("share started media")
			}
		})
	}
}
