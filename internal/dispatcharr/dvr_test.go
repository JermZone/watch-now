package dispatcharr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDVRIdentityRolesAndSafeResponses(t *testing.T) {
	for _, tc := range []struct {
		level        int
		access, want string
	}{{10, "none", "manage"}, {1, "", "view"}, {1, "manage", "manage"}, {1, "none", "none"}, {0, "manage", "none"}, {1, "unknown", "none"}} {
		t.Run(fmt.Sprintf("%d-%s", tc.level, tc.access), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, `{"username":"viewer","user_level":%d,"custom_properties":{"dvr_access":%q},"api_key":"secret","future_field":true}`, tc.level, tc.access)
			}))
			defer upstream.Close()
			base, _ := url.Parse(upstream.URL)
			client := NewClient(base, upstream.Client(), 1024, 1024)
			identity, err := client.DVRIdentity(context.Background(), "key")
			if err != nil || identity.Access != tc.want {
				t.Fatalf("identity = %#v, %v", identity, err)
			}
		})
	}
}
func TestDVRMetadataBoundsAndRedirects(t *testing.T) {
	for _, scenario := range []string{"redirect", "large", "envelope", "malformed", "unauthorized"} {
		t.Run(scenario, func(t *testing.T) {
			followed := false
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/target" {
					followed = true
					return
				}
				switch scenario {
				case "redirect":
					w.Header().Set("Location", "/target?api_key=secret")
					w.WriteHeader(302)
				case "large":
					io.WriteString(w, strings.Repeat("x", 2048))
				case "envelope":
					io.WriteString(w, `{"results":[]}`)
				case "malformed":
					io.WriteString(w, `[{"id":1}]`)
				case "unauthorized":
					w.WriteHeader(403)
					io.WriteString(w, `secret response body`)
				}
			}))
			defer upstream.Close()
			base, _ := url.Parse(upstream.URL)
			client := NewClient(base, upstream.Client(), 1024, 1024)
			_, err := client.DVRRecordings(context.Background(), "key")
			if err == nil || followed || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe response: %v", err)
			}
		})
	}
}
func TestDVRKeyHeaderValidation(t *testing.T) {
	for _, key := range []string{"", "foo\nbar", "foo bar", strings.Repeat("a", 513)} {
		base, _ := url.Parse("http://invalid.test")
		client := NewClient(base, http.DefaultClient, 1024, 1024)
		_, err := client.DVRIdentity(context.Background(), key)
		if !errors.Is(err, ErrUnauthorized) {
			t.Fatal("invalid key accepted")
		}
	}
}

// Dispatcharr's DRF view negotiates JSON before calling its video-file action.
// Model that behavior so a video-only Accept regression cannot pass fixtures.
func TestDVRFileNegotiatesAPIRendererBeforeVideoResponse(t *testing.T) {
	for _, byteRange := range []string{"", "bytes=1-3"} {
		t.Run(byteRange, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				accept := r.Header.Get("Accept")
				if !strings.Contains(accept, "*/*") && !strings.Contains(accept, "application/json") {
					w.WriteHeader(http.StatusNotAcceptable)
					return
				}
				if r.Header.Get("X-API-Key") != "viewer-key" || r.URL.RawQuery != "" || r.URL.Path != "/api/channels/recordings/7/file/" {
					t.Error("incorrect authenticated file request")
				}
				w.Header().Set("Content-Type", "video/x-matroska")
				w.Header().Set("Accept-Ranges", "bytes")
				if r.Header.Get("Range") == "bytes=1-3" {
					w.Header().Set("Content-Length", "3")
					w.Header().Set("Content-Range", "bytes 1-3/6")
					w.WriteHeader(206)
					io.WriteString(w, "bcd")
					return
				}
				io.WriteString(w, "abcdef")
			}))
			defer upstream.Close()
			base, _ := url.Parse(upstream.URL)
			client := NewClient(base, upstream.Client(), 1024, 1024)
			stream, err := client.DVROpen(context.Background(), "viewer-key", "7", byteRange)
			if err != nil {
				t.Fatalf("file negotiation failed: %v", err)
			}
			defer stream.Body.Close()
			data, err := io.ReadAll(stream.Body)
			if err != nil {
				t.Fatal(err)
			}
			wantStatus, wantBody := 200, "abcdef"
			if byteRange != "" {
				wantStatus, wantBody = 206, "bcd"
			}
			if stream.StatusCode != wantStatus || string(data) != wantBody || stream.ContentType != "video/x-matroska" {
				t.Fatal("file or range response changed")
			}
		})
	}
}

func TestMasterKeyResolvesExactViewerPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, users string
		owner       int
		want        string
		fail        bool
	}{
		{"view", `[{"username":"viewer","user_level":1,"api_key":"private-user-key","custom_properties":{}}]`, 10, "view", false},
		{"manage", `[{"username":"viewer","user_level":1,"custom_properties":{"dvr_access":"manage"}}]`, 10, "manage", false},
		{"none", `[{"username":"viewer","user_level":1,"custom_properties":{"dvr_access":"none"}}]`, 10, "none", false},
		{"streamer", `[{"username":"viewer","user_level":0,"custom_properties":{"dvr_access":"manage"}}]`, 10, "none", false},
		{"disabled field", `[{"username":"viewer","user_level":10,"is_active":false}]`, 10, "none", false},
		{"admin", `[{"username":"viewer","user_level":10}]`, 10, "manage", false},
		{"missing viewer", `[{"username":"other","user_level":10}]`, 10, "", true},
		{"duplicate viewer", `[{"username":"viewer","user_level":10},{"username":"viewer","user_level":1}]`, 10, "", true},
		{"missing role", `[{"username":"viewer"}]`, 10, "", true},
		{"unsupported envelope", `{"results":[]}`, 10, "", true},
		{"not admin key", `[{"username":"viewer","user_level":1}]`, 1, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-API-Key") != "master-key" || r.URL.RawQuery != "" {
					t.Error("master credential transport changed")
				}
				if r.URL.Path == "/api/accounts/users/me/" {
					fmt.Fprintf(w, `{"username":"service","user_level":%d}`, tc.owner)
					return
				}
				if tc.owner < 10 {
					t.Error("non-admin key used to inspect users")
				}
				io.WriteString(w, tc.users)
			}))
			defer upstream.Close()
			base, _ := url.Parse(upstream.URL)
			client := NewClient(base, upstream.Client(), 1024, 1024)
			identity, err := client.DVRViewerIdentity(context.Background(), "master-key", "viewer")
			if (err != nil) != tc.fail {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.fail && (identity.Username != "viewer" || identity.Access != tc.want) {
				t.Fatal("viewer received service account permissions")
			}
		})
	}
}
