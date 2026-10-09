package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestLiveRecordingsFreshPermissionsIsolationAndBounds(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	var mu sync.Mutex
	access := "view"
	identityCalls, recordCalls := 0, 0
	upstreamFailure := false
	afterRecords := func() {}
	records := []map[string]any{}
	for i := 25; i >= 1; i-- {
		records = append(records, map[string]any{
			"id": i, "channel": 41, "start_time": now.Add(-time.Hour), "end_time": now.Add(time.Hour),
			"custom_properties": map[string]any{
				"status": "recording", "file_url": "http://private/secret-key",
				"file_path": "/private/secret-path", "program": map[string]string{"title": fmt.Sprintf("Capture %d", i), "description": "private-description"},
			},
		})
	}
	for _, item := range []struct {
		id, channel int
		status      string
	}{
		{999, 99, "recording"}, {50, 41, "completed"}, {51, 41, "scheduled"}, {52, 41, "failed"},
	} {
		records = append(records, map[string]any{"id": item.id, "channel": item.channel, "start_time": now.Add(-time.Hour), "end_time": now.Add(time.Hour), "custom_properties": map[string]any{"status": item.status, "remux_success": true, "program": map[string]string{"title": "Excluded capture"}}})
	}
	records = append(records, map[string]any{
		"id": 53, "channel": 41, "start_time": now.Add(-2 * time.Hour), "end_time": now.Add(-time.Hour),
		"custom_properties": map[string]any{"status": "recording", "file_url": "/api/channels/recordings/53/file/", "program": map[string]string{"title": "Finished capture with lagging status"}},
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "master-secret" || r.URL.RawQuery != "" {
			t.Error("unexpected DVR key or query")
		}
		mu.Lock()
		currentAccess, fail, callback := access, upstreamFailure, afterRecords
		switch r.URL.Path {
		case "/api/accounts/users/me/":
			identityCalls++
		case "/api/channels/recordings/":
			recordCalls++
		}
		mu.Unlock()
		switch r.URL.Path {
		case "/api/accounts/users/me/":
			io.WriteString(w, `{"username":"admin","user_level":10,"api_key":"master-secret"}`)
		case "/api/accounts/users/":
			json.NewEncoder(w).Encode([]map[string]any{
				{"username": "viewer", "user_level": 1, "custom_properties": map[string]string{"dvr_access": currentAccess}},
				{"username": "no-dvr", "user_level": 1, "custom_properties": map[string]string{"dvr_access": "none"}},
			})
		case "/api/channels/recordings/":
			if fail {
				w.WriteHeader(503)
				return
			}
			callback()
			json.NewEncoder(w).Encode(records)
		default:
			t.Errorf("unexpected DVR request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	client := dispatcharr.NewClient(u, upstream.Client(), 1<<20, 1024)
	fake := &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Visible channel"}}}
	fixture := &activeDVRFixture{restDVRFixture: &restDVRFixture{fakeDispatcharr: fake, DVRAPI: client}, DVRMasterAPI: client}
	cfg := testConfig(t)
	cfg.DVRMasterAPIKey = "master-secret"
	handler := New(cfg, fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(path string, who *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://now.test"+path, nil)
		if who != nil {
			req.AddCookie(who)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	const endpoint = "/api/live/channels/41/recordings"
	list := call(endpoint, cookie)
	if list.Code != 200 {
		t.Fatalf("discovery failed: %d %s", list.Code, list.Body.String())
	}
	var payload liveRecordingsResponse
	if err := json.Unmarshal(list.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Access != "view" || len(payload.Items) != liveRecordingLimit {
		t.Fatalf("unexpected response: access=%s rows=%d", payload.Access, len(payload.Items))
	}
	for i, row := range payload.Items {
		if row.ID != fmt.Sprint(i+1) || row.ChannelID != "41" || row.Status != "recording" || !row.CanWatchActive {
			t.Fatalf("wrong row order/filter at %d: %+v", i, row)
		}
	}
	for _, private := range []string{"master-secret", upstream.URL, "file_url", "file_path", "private-description", "Excluded capture", "Finished capture", "description", "playable"} {
		if strings.Contains(list.Body.String(), private) {
			t.Fatalf("private or unrelated field exposed: %s", private)
		}
	}
	if list.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("discovery must not be cached")
	}
	if call(endpoint, nil).Code != 401 || call("/api/live/channels/99/recordings", cookie).Code != 404 {
		t.Fatal("discovery exposed to unauthenticated or hidden channel")
	}

	// A different signed-in viewer must use their exact REST permissions.
	otherCookie, _ := loginViewerAs(t, handler, "no-dvr", "password", "192.0.2.8:1234")
	if response := call(endpoint, otherCookie); response.Code != 200 || strings.Contains(response.Body.String(), "Capture") {
		t.Fatalf("viewer permissions were shared: %d %s", response.Code, response.Body.String())
	}
	mu.Lock()
	access = "manage"
	records = []map[string]any{}
	mu.Unlock()
	empty := call(endpoint, cookie)
	if empty.Code != 200 || !strings.Contains(empty.Body.String(), `"access":"manage"`) || !strings.Contains(empty.Body.String(), `"items":[]`) {
		t.Fatalf("empty response lost management capability: %s", empty.Body.String())
	}
	mu.Lock()
	access = "none"
	mu.Unlock()
	if denied := call(endpoint, cookie); denied.Code != 200 || !strings.Contains(denied.Body.String(), `"access":"none"`) {
		t.Fatalf("fresh permission revocation failed: %s", denied.Body.String())
	}

	// A previously cached visible channel cannot authorize discovery after
	// Dispatcharr removes that channel from this viewer's current XC lineup.
	if call("/api/live/channels", cookie).Code != 200 {
		t.Fatal("could not prime browsing cache")
	}
	fake.mu.Lock()
	fake.channels = []dispatcharr.Channel{}
	fake.mu.Unlock()
	if call(endpoint, cookie).Code != 404 {
		t.Fatal("stale browsing lineup authorized discovery")
	}
	fake.mu.Lock()
	fake.channels = []dispatcharr.Channel{{ID: "41", Name: "Visible channel"}}
	fake.mu.Unlock()
	mu.Lock()
	access, upstreamFailure = "view", true
	mu.Unlock()
	if response := call(endpoint, cookie); response.Code != 502 {
		t.Fatalf("DVR failure not isolated: %d", response.Code)
	}
	if call("/api/live/channels", cookie).Code != 200 || call("/api/session", cookie).Code != 200 {
		t.Fatal("optional DVR failure disrupted Live/session")
	}

	// Log out after fresh authorization while the recording fetch is pending.
	mu.Lock()
	upstreamFailure = false
	afterRecords = func() {
		req := httptest.NewRequest("POST", "http://now.test/api/auth/logout", nil)
		req.AddCookie(cookie)
		req.Header.Set("Origin", "http://now.test")
		req.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != 204 {
			t.Errorf("logout status = %d", response.Code)
		}
	}
	mu.Unlock()
	if response := call(endpoint, cookie); response.Code != 401 {
		t.Fatalf("logged-out session received recordings: %d", response.Code)
	}
	mu.Lock()
	defer mu.Unlock()
	if identityCalls < 6 || recordCalls < 3 {
		t.Fatalf("fresh REST authorization missing: identity=%d records=%d", identityCalls, recordCalls)
	}
}

type livePersonalDVRFixture struct {
	*fakeDVR
	identity   func(context.Context, string) (dispatcharr.DVRIdentity, error)
	recordings func(context.Context, string) ([]dispatcharr.Recording, error)
}

func (f *livePersonalDVRFixture) DVRIdentity(ctx context.Context, key string) (dispatcharr.DVRIdentity, error) {
	return f.identity(ctx, key)
}
func (f *livePersonalDVRFixture) DVRRecordings(ctx context.Context, key string) ([]dispatcharr.Recording, error) {
	return f.recordings(ctx, key)
}

func TestLiveRecordingsPersonalKeySessionAndReadLimits(t *testing.T) {
	var afterRecords func()
	identity := dispatcharr.DVRIdentity{Username: "viewer", Access: "view"}
	fixture := &livePersonalDVRFixture{
		fakeDVR: &fakeDVR{fakeDispatcharr: &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Channel"}}}},
		identity: func(_ context.Context, key string) (dispatcharr.DVRIdentity, error) {
			if key != "personal-key" {
				t.Fatal("wrong personal DVR key")
			}
			return identity, nil
		},
		recordings: func(_ context.Context, key string) ([]dispatcharr.Recording, error) {
			if key != "personal-key" {
				t.Fatal("wrong personal DVR key")
			}
			if afterRecords != nil {
				afterRecords()
			}
			return []dispatcharr.Recording{{ID: "7", ChannelID: "41", Title: "Active capture", Start: time.Now().Add(-time.Minute), End: time.Now().Add(time.Hour), Status: "recording", CanWatchActive: true}}, nil
		},
	}
	handler := New(testConfig(t), fixture, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	cookie, viewer := loginViewer(t, handler)
	call := func(method, path, body string, who *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://now.test"+path, strings.NewReader(body))
		req.AddCookie(who)
		req.Header.Set("Origin", "http://now.test")
		req.Header.Set("X-CSRF-Token", viewer.CSRFToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	const endpoint = "/api/live/channels/41/recordings"
	if r := call("GET", endpoint, "", cookie); r.Code != 200 || !strings.Contains(r.Body.String(), `"access":"none"`) {
		t.Fatal("unconnected DVR should leave Live usable")
	}
	if r := call("POST", "/api/dvr/connection", `{"api_key":"personal-key"}`, cookie); r.Code != 200 {
		t.Fatal("could not connect fixture DVR")
	}
	other, _ := loginViewerAs(t, handler, "viewer", "password", "192.0.2.9:1234")
	if r := call("GET", endpoint, "", other); r.Code != 200 || strings.Contains(r.Body.String(), "Active capture") {
		t.Fatal("personal DVR credential was shared across sessions")
	}
	if r := call("GET", endpoint, "", cookie); r.Code != 200 || !strings.Contains(r.Body.String(), "Active capture") {
		t.Fatal("connected viewer could not discover active capture")
	}
	afterRecords = func() {
		if r := call("DELETE", "/api/dvr/connection", "", cookie); r.Code != 204 {
			t.Errorf("disconnect failed: %d", r.Code)
		}
	}
	if r := call("GET", endpoint, "", cookie); r.Code != 409 {
		t.Fatalf("disconnected session received discovery: %d", r.Code)
	}
	afterRecords = nil
	if r := call("POST", "/api/dvr/connection", `{"api_key":"personal-key"}`, cookie); r.Code != 200 {
		t.Fatal("could not reconnect fixture DVR")
	}
	identity.Username = "someone-else"
	if r := call("GET", endpoint, "", cookie); r.Code != 403 || strings.Contains(r.Body.String(), "Active capture") {
		t.Fatal("REST account mismatch was accepted")
	}
	identity.Username = "viewer"
	// Optional reads have their own allowance, so polling cannot exhaust the
	// existing limiter used for recording changes.
	for i := 0; i < 60; i++ {
		call("GET", endpoint, "", cookie)
	}
	if r := call("GET", endpoint, "", cookie); r.Code != 429 {
		t.Fatalf("unbounded discovery reads: %d", r.Code)
	}
	if r := call("POST", "/api/dvr/connection", `{"api_key":"personal-key"}`, cookie); r.Code != 200 {
		t.Fatal("discovery reads consumed the DVR mutation allowance")
	}
}

func TestLiveRecordingsUnavailableDVRAndInvalidChannel(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{channels: []dispatcharr.Channel{{ID: "41", Name: "Channel"}}}, io.Discard)
	cookie, _ := loginViewer(t, handler)
	for _, trial := range []struct {
		path   string
		status int
	}{
		{"/api/live/channels/41/recordings", 200},
		{"/api/live/channels/99/recordings", 404},
		{"/api/live/channels/" + strings.Repeat("a", 129) + "/recordings", 400},
	} {
		req := httptest.NewRequest("GET", "http://now.test"+trial.path, nil)
		req.AddCookie(cookie)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != trial.status {
			t.Fatalf("path %s status %d want %d", trial.path, w.Code, trial.status)
		}
		if trial.status == 200 && w.Body.String() != "{\"items\":[],\"access\":\"none\"}\n" {
			t.Fatalf("unexpected unsupported-DVR result: %s", w.Body.String())
		}
	}
}
