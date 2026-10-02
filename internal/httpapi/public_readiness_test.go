package httpapi

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestPublicReadinessDoesNotExposeDiagnostics(t *testing.T) {
	handler := newTestHandler(t, &fakeDispatcharr{diagnostics: dispatcharr.Diagnostics{Reachable: true, Version: "private-version", Error: "private-error"}}, io.Discard)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest("GET", "http://now.test/api/health/ready", nil))
	if recorder.Code != 200 || strings.TrimSpace(recorder.Body.String()) != `{"reachable":true}` {
		t.Fatalf("public status: %d %s", recorder.Code, recorder.Body)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest("GET", "http://now.test/api/diagnostics/dispatcharr", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("diagnostics status: %d", recorder.Code)
	}
}

func TestAccountLoginLimitAcrossAddresses(t *testing.T) {
	cfg := testConfig(t)
	cfg.LoginAccountRateLimit = 3
	handler := New(cfg, &fakeDispatcharr{authError: dispatcharr.ErrUnauthorized}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for attempt := 1; attempt <= 4; attempt++ {
		username := "viewer"
		if attempt == 4 {
			username = " VIEWER "
		}
		request := httptest.NewRequest("POST", "http://now.test/api/auth/login", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":"wrong"}`, username)))
		request.Header.Set("Origin", "http://now.test")
		request.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", attempt)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		want := 401
		if attempt == 4 {
			want = 429
			if recorder.Header().Get("Retry-After") == "" {
				t.Fatal("missing retry hint")
			}
		}
		if recorder.Code != want {
			t.Fatalf("attempt %d: %d", attempt, recorder.Code)
		}
	}
}
