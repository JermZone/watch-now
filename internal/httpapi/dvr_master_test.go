package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

type masterRestFixture struct {
	*restDVRFixture
	dispatcharr.DVRMasterAPI
}

func TestMasterDVRPreservesViewerPermissionsAcrossBrowserAndVLC(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	access := "view"
	exists := true
	keyValid := true
	writes := 0
	fileCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "master-fixture-key" || r.URL.RawQuery != "" {
			t.Error("master key missing or leaked to query")
		}
		if !keyValid {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/api/accounts/users/me/":
			io.WriteString(w, `{"username":"service-admin","user_level":10}`)
		case "/api/accounts/users/":
			if !exists {
				io.WriteString(w, `[]`)
				return
			}
			json.NewEncoder(w).Encode([]any{map[string]any{"username": "viewer", "user_level": 1, "api_key": "other-private-key", "custom_properties": map[string]string{"dvr_access": access, "xc_password": "private-password"}}})
		case "/api/channels/recordings/":
			if r.Method != "GET" {
				writes++
				w.WriteHeader(500)
				return
			}
			json.NewEncoder(w).Encode([]any{
				map[string]any{"id": 7, "channel": 41, "start_time": now.Add(-2 * time.Hour), "end_time": now.Add(-time.Hour), "custom_properties": map[string]any{"status": "completed", "remux_success": true, "program": map[string]string{"title": "Allowed recording"}}},
				map[string]any{"id": 8, "channel": 99, "start_time": now.Add(-2 * time.Hour), "end_time": now.Add(-time.Hour), "custom_properties": map[string]any{"status": "completed", "remux_success": true, "program": map[string]string{"title": "Hidden recording"}}},
			})
		case "/api/channels/recordings/7/file/":
			fileCalls++
			w.Header().Set("Content-Type", "video/x-matroska")
			io.WriteString(w, "recording bytes")
		default:
			writes++
			w.WriteHeader(204)
		}
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(base, upstream.Client(), 1<<20, 1024)
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Allowed"}}}
	fixture := &masterRestFixture{restDVRFixture: &restDVRFixture{fakeDispatcharr: fake, DVRAPI: client}, DVRMasterAPI: client}
	cfg := testConfig(t)
	cfg.DVRMasterAPIKey = "master-fixture-key"
	var logs bytes.Buffer
	handler := New(cfg, fixture, slog.New(slog.NewJSONHandler(&logs, nil)))
	cookie, session := loginViewer(t, handler)
	call := func(method, path, body string, csrf, withCookie bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
		if withCookie {
			req.AddCookie(cookie)
		}
		req.Header.Set("Origin", "http://now.test")
		if csrf {
			req.Header.Set("X-CSRF-Token", session.CSRFToken)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	check := func(w *httptest.ResponseRecorder, want int) {
		t.Helper()
		if w.Code != want {
			t.Fatalf("got %d want %d: %s", w.Code, want, w.Body.String())
		}
		for _, secret := range []string{"master-fixture-key", "other-private-key", "private-password", "Hidden recording"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("private information leaked")
			}
		}
	}
	connection := call("GET", "/api/dvr/connection", "", false, true)
	check(connection, 200)
	if !strings.Contains(connection.Body.String(), `"managed":true`) || !strings.Contains(connection.Body.String(), `"access":"view"`) {
		t.Fatal("automatic viewer connection incorrect")
	}
	check(call("POST", "/api/dvr/connection", `{"api_key":"ignored"}`, true, true), 409)
	check(call("GET", "/api/dvr/recordings", "", false, false), 401)
	check(call("GET", "/api/dvr/recordings", "", false, true), 200)
	check(call("DELETE", "/api/dvr/recordings/7", "", true, true), 403)
	check(call("POST", "/api/dvr/recordings", `{}`, true, true), 403)
	check(call("GET", "/api/dvr/recordings/8/stream", "", false, true), 404)
	check(call("GET", "/api/dvr/recordings/7/stream", "", false, true), 200)
	handoff := call("POST", "/api/dvr/recordings/7/vlc", "", true, true)
	check(handoff, 201)
	var ticket struct {
		URL string `json:"launch_url"`
	}
	json.Unmarshal(handoff.Body.Bytes(), &ticket)
	launch := call("GET", ticket.URL, "", false, false)
	check(launch, 302)
	media := launch.Header().Get("Location")
	check(call("GET", media, "", false, false), 200)
	access = "none"
	check(call("GET", media, "", false, false), 404)
	check(call("GET", "/api/dvr/recordings/7/stream", "", false, true), 403)
	check(call("GET", "/api/session", "", false, true), 200)
	access = "manage"
	check(call("DELETE", "/api/dvr/recordings/7", "", false, true), 403)
	check(call("DELETE", "/api/dvr/recordings/8", "", true, true), 404)
	check(call("DELETE", "/api/dvr/recordings/7", "", true, true), 204)
	if writes != 1 || fileCalls != 2 {
		t.Fatal("unauthorized upstream action or playback")
	}
	fake.channels = nil
	check(call("GET", "/api/dvr/recordings/7/stream", "", false, true), 404)
	exists = false
	check(call("GET", "/api/dvr/connection", "", false, true), 503)
	exists = true
	keyValid = false
	failure := call("GET", "/api/dvr/connection", "", false, true)
	check(failure, 503)
	if !strings.Contains(failure.Body.String(), "dvr_service_unavailable") {
		t.Fatal("master failure asks for personal key")
	}
	check(call("GET", "/api/session", "", false, true), 200)
	for _, secret := range []string{"master-fixture-key", "other-private-key", "private-password"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("credential logged")
		}
	}
}
