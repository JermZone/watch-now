package httpapi

import (
	"context"
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
	"github.com/JermZone/watch-now/internal/session"
)

type restDVRFixture struct {
	*fakeDispatcharr
	dispatcharr.DVRAPI
}

func TestDVRIdentityPermissionsIsolationAndRecording(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	access := "manage"
	revoked := false
	writes := 0
	files := 0
	records := []map[string]any{
		{"id": 1, "channel": 41, "start_time": now.Add(-2 * time.Hour), "end_time": now.Add(-time.Hour), "custom_properties": map[string]any{"status": "completed", "remux_success": true, "program": map[string]any{"title": "Football"}, "watch_now_airing": "0123456789abcdef0123456789abcdef", "file_path": "/secret/file.mkv", "file_url": "http://private/?api_key=secret"}},
		{"id": 2, "channel": 99, "start_time": now.Add(-2 * time.Hour), "end_time": now.Add(-time.Hour), "custom_properties": map[string]any{"status": "completed", "remux_success": true, "program": map[string]any{"title": "Hidden recording"}}},
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") == "" || r.URL.RawQuery != "" {
			t.Error("missing key or unexpected credential query")
		}
		if revoked {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/accounts/users/me/" {
			user := "viewer"
			if r.Header.Get("X-API-Key") == "wrong-account" {
				user = "admin"
			}
			json.NewEncoder(w).Encode(map[string]any{"username": user, "user_level": 1, "api_key": "secret", "xc_password": "secret", "custom_properties": map[string]string{"dvr_access": access}})
			return
		}
		if r.URL.Path == "/api/channels/recordings/" {
			if r.Method == "POST" {
				writes++
				var input map[string]any
				json.NewDecoder(r.Body).Decode(&input)
				input["id"] = 3
				records = append(records, input)
				w.WriteHeader(201)
				json.NewEncoder(w).Encode(input)
				return
			}
			json.NewEncoder(w).Encode(records)
			return
		}
		if r.URL.Path == "/api/channels/recordings/1/file/" {
			files++
			if r.Header.Get("Range") == "bytes=1-3" {
				w.Header().Set("Content-Range", "bytes 1-3/6")
				w.Header().Set("Content-Length", "3")
				w.Header().Set("Content-Type", "video/x-matroska")
				w.WriteHeader(206)
				io.WriteString(w, "bcd")
				return
			}
			w.Header().Set("Location", "http://private/?api_key=secret")
			w.WriteHeader(302)
			return
		}
		writes++
		w.WriteHeader(204)
	}))
	defer upstream.Close()
	base, _ := url.Parse(upstream.URL)
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Sports"}}, programs: []dispatcharr.Program{{Title: "Future football", Description: "Canonical description", Start: now.Add(time.Hour), End: now.Add(2 * time.Hour)}}}
	fixture := &restDVRFixture{fakeDispatcharr: fake, DVRAPI: dispatcharr.NewClient(base, upstream.Client(), 1<<20, 1024)}
	handler := New(testConfig(t), fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(method, path, body string, csrf bool, who *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
		req.AddCookie(who)
		req.Header.Set("Origin", "http://now.test")
		if csrf {
			req.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if strings.HasSuffix(path, "/stream") {
			req.Header.Set("Range", "bytes=1-3")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "file_path") {
			t.Fatal("upstream secrets exposed")
		}
	}
	check(call("POST", "/api/dvr/connection", `{"api_key":"valid-key"}`, false, cookie), 403)
	check(call("POST", "/api/dvr/connection", `{"api_key":"wrong-account"}`, true, cookie), 403)
	check(call("POST", "/api/dvr/connection", `{"api_key":"valid-key"}`, true, cookie), 200)
	list := call("GET", "/api/dvr/recordings", "", false, cookie)
	check(list, 200)
	if strings.Contains(list.Body.String(), "Hidden recording") || !strings.Contains(list.Body.String(), "Football") {
		t.Fatal("lineup filtering failed")
	}
	var catalog struct {
		Items []struct {
			AiringID string `json:"airing_id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &catalog); err != nil || len(catalog.Items) != 1 || catalog.Items[0].AiringID != "0123456789abcdef0123456789abcdef" {
		t.Fatal("validated recording owner was not exposed")
	}
	properties := records[0]["custom_properties"].(map[string]any)
	properties["watch_now_airing"] = "arbitrary-upstream-marker"
	invalidOwner := call("GET", "/api/dvr/recordings", "", false, cookie)
	check(invalidOwner, 200)
	if strings.Contains(invalidOwner.Body.String(), "airing_id") || strings.Contains(invalidOwner.Body.String(), "arbitrary-upstream-marker") {
		t.Fatal("unvalidated upstream airing metadata was exposed")
	}
	other, _ := loginViewerAs(t, handler, "viewer", "top-secret", "192.0.2.6:1234")
	check(call("GET", "/api/dvr/recordings", "", false, other), 403)
	check(call("DELETE", "/api/dvr/recordings/2", "", true, cookie), 404)
	check(call("POST", "/api/dvr/recordings/1/extend", "", true, cookie), 409)
	check(call("GET", "/api/dvr/recordings/1/stream", "", false, cookie), 206)
	if files != 1 {
		t.Fatal("file relay not called")
	}
	check(call("GET", "/api/dvr/recordings/1/download", "", false, cookie), 409)
	body, _ := json.Marshal(map[string]any{"channel_id": "41", "start": fake.programs[0].Start, "end": fake.programs[0].End})
	created := call("POST", "/api/dvr/recordings", string(body), true, cookie)
	check(created, 201)
	var creation struct {
		Recording struct {
			AiringID string `json:"airing_id"`
		} `json:"recording"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &creation); err != nil {
		t.Fatal(err)
	}
	wantOwner := programResultID(dispatcharr.GuideProgram{ChannelID: "41", Title: fake.programs[0].Title, Start: fake.programs[0].Start, End: fake.programs[0].End})
	if creation.Recording.AiringID != wantOwner {
		t.Fatal("created recording did not return its original airing identifier")
	}
	check(call("POST", "/api/dvr/recordings", string(body), true, cookie), 200)
	if writes != 1 {
		t.Fatal("duplicate created or unauthorized mutation sent")
	}
	check(call("GET", "/api/dvr/recordings/3/stream", "", false, cookie), 409)
	access = "view"
	check(call("DELETE", "/api/dvr/recordings/1", "", true, cookie), 403)
	check(call("GET", "/api/dvr/recordings", "", false, cookie), 200)

	// View-only users can launch completed recordings in VLC without cookies.
	handoff := call("POST", "/api/dvr/recordings/1/vlc", "", true, cookie)
	check(handoff, 201)
	var ticket struct {
		LaunchURL string `json:"launch_url"`
	}
	json.Unmarshal(handoff.Body.Bytes(), &ticket)
	launchRequest := httptest.NewRequest("GET", "http://now.test"+ticket.LaunchURL, nil)
	launchResponse := httptest.NewRecorder()
	handler.ServeHTTP(launchResponse, launchRequest)
	check(launchResponse, 302)
	mediaPath := launchResponse.Header().Get("Location")
	mediaRequest := httptest.NewRequest("GET", "http://now.test"+mediaPath, nil)
	mediaRequest.Header.Set("Range", "bytes=1-3")
	mediaResponse := httptest.NewRecorder()
	handler.ServeHTTP(mediaResponse, mediaRequest)
	check(mediaResponse, 206)
	if mediaResponse.Body.String() != "bcd" {
		t.Fatal("VLC did not receive recording bytes")
	}
	access = "none"
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, mediaRequest)
	check(denied, 404)
	check(call("GET", "/api/session", "", false, cookie), 200)
	// Reconnect after VLC revocation to exercise the remaining permission checks.
	check(call("POST", "/api/dvr/connection", `{"api_key":"valid-key"}`, true, cookie), 200)
	access = "none"
	check(call("GET", "/api/dvr/recordings", "", false, cookie), 403)
	revoked = true
	check(call("GET", "/api/dvr/recordings", "", false, cookie), 403)
	check(call("GET", "/api/session", "", false, cookie), 200)
	check(call("GET", "/api/dvr/connection", "", false, cookie), 200)
}

func TestDVRRejectsUnverifiedAiring(t *testing.T) {
	fake := &fakeDVR{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "1", Name: "Sports"}}}}
	handler := New(testConfig(t), fake, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	for _, body := range []string{`{"api_key":"key"}`, `{"channel_id":"1","start":"2099-01-01T00:00:00Z","end":"2099-01-01T01:00:00Z"}`} {
		path := "/api/dvr/connection"
		want := 200
		if strings.Contains(body, "channel_id") {
			path = "/api/dvr/recordings"
			want = 409
		}
		req := httptest.NewRequest("POST", "http://now.test"+path, strings.NewReader(body))
		req.AddCookie(cookie)
		req.Header.Set("Origin", "http://now.test")
		req.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("got %d want %d", w.Code, want)
		}
	}
	if fake.created {
		t.Fatal("unverified airing created")
	}
}

type fakeDVR struct {
	*fakeDispatcharr
	created bool
}

func (f *fakeDVR) DVRIdentity(context.Context, string) (dispatcharr.DVRIdentity, error) {
	return dispatcharr.DVRIdentity{Username: "viewer", Access: "manage"}, nil
}
func (f *fakeDVR) DVRRecordings(context.Context, string) ([]dispatcharr.Recording, error) {
	return []dispatcharr.Recording{}, nil
}
func (f *fakeDVR) DVRCreate(context.Context, string, dispatcharr.RecordingRequest) (dispatcharr.Recording, error) {
	f.created = true
	return dispatcharr.Recording{}, nil
}
func (f *fakeDVR) DVRAction(context.Context, string, string, string) error { return nil }
func (f *fakeDVR) DVROpen(context.Context, string, string, string) (dispatcharr.MediaStream, error) {
	return dispatcharr.MediaStream{}, dispatcharr.ErrNotFound
}

func TestConfiguredDVRKeysAreMatchedAfterXCLogin(t *testing.T) {
	fake := &configuredDVRFixture{fakeDVR: fakeDVR{fakeDispatcharr: &fakeDispatcharr{}}}
	cfg := testConfig(t)
	cfg.DVRAPIKeys = map[string]string{"viewer": "viewer-key", "wrong": "admin-key"}
	handler := New(cfg, fake, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	for i, username := range []string{"viewer", "unconfigured", "wrong"} {
		cookie, _ := loginViewerAs(t, handler, username, "password", []string{"192.0.2.1:1234", "192.0.2.2:1234", "192.0.2.3:1234"}[i])
		req := httptest.NewRequest("GET", "http://now.test/api/dvr/connection", nil)
		req.AddCookie(cookie)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if strings.Contains(w.Body.String(), "-key") {
			t.Fatal("configured key exposed")
		}
		switch username {
		case "viewer":
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"connected":true`) {
				t.Fatal("matching key did not connect")
			}
		case "unconfigured":
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"connected":false`) {
				t.Fatal("key shared with unrelated viewer")
			}
		case "wrong":
			if w.Code != 403 {
				t.Fatal("mismatched configured identity accepted")
			}
		}
	}
}

type configuredDVRFixture struct{ fakeDVR }

func (f *configuredDVRFixture) DVRIdentity(_ context.Context, key string) (dispatcharr.DVRIdentity, error) {
	if key == "viewer-key" {
		return dispatcharr.DVRIdentity{Username: "viewer", Access: "view"}, nil
	}
	return dispatcharr.DVRIdentity{Username: "admin", Access: "manage"}, nil
}

func TestDVRPlaybackErrorsAreActionSpecific(t *testing.T) {
	server := &Server{}
	request := httptest.NewRequest("GET", "http://now.test/api/dvr/recordings/7/stream", nil)
	request = request.WithContext(context.WithValue(request.Context(), sessionContextKey, session.Session{}))
	request.SetPathValue("resource", "stream")
	response := httptest.NewRecorder()
	server.dvrError(response, request, dispatcharr.ErrUnavailable)
	if response.Code != 502 || !strings.Contains(response.Body.String(), "recording_playback_unavailable") || strings.Contains(response.Body.String(), "recording change") {
		t.Fatal("playback error suggests recording mutation retry")
	}
}
