package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAcceptedRangeAllowsOnlyOneWellFormedByteRange(t *testing.T) {
	for _, value := range []string{"", "bytes=0-", "bytes=100-199", "bytes=-500"} {
		writer := httptest.NewRecorder()
		if got, ok := acceptedRange(writer, value); !ok || got != value {
			t.Errorf("acceptedRange(%q) = %q, %v", value, got, ok)
		}
	}
	for _, value := range []string{"items=0-1", "bytes=", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0", "bytes=1-x", "bytes=" + strings.Repeat("1", 129) + "-"} {
		writer := httptest.NewRecorder()
		if _, ok := acceptedRange(writer, value); ok {
			t.Errorf("acceptedRange(%q) accepted malformed input", value)
		}
		if writer.Code != http.StatusRequestedRangeNotSatisfiable {
			t.Errorf("acceptedRange(%q) status = %d", value, writer.Code)
		}
	}
}

func TestSafeLogPathRedactsOpaqueVLCTokens(t *testing.T) {
	for _, value := range []string{
		"/api/vlc/media/secret-token",
		"/api//vlc/media/secret-token",
		"//api/vlc/launch/secret-token",
		"/api/other/../vlc/media/secret-token",
		"/api/vlc/media/secret-token/../../../other",
	} {
		if got := safeLogPath(value); got != "/api/vlc/{redacted}" {
			t.Errorf("safeLogPath(%q) = %q", value, got)
		}
	}
	if got := safeLogPath("/api/movies/42"); got != "/api/movies/42" {
		t.Fatalf("ordinary path changed to %q", got)
	}
}

func TestPartialContentMetadataMustBeInternallyConsistent(t *testing.T) {
	for _, value := range []struct {
		raw       string
		length    int64
		requested string
	}{
		{"bytes 10-14/100", 5, "bytes=10-14"},
		{"bytes 0-0/*", 1, "bytes=0-0"},
		{"bytes 90-99/100", -1, "bytes=90-999"},
		{"bytes 95-99/100", 5, "bytes=-5"},
	} {
		if !validPartialContentRange(value.raw, value.length, value.requested) {
			t.Errorf("valid range rejected: %#v", value)
		}
	}
	for _, value := range []struct {
		raw    string
		length int64
	}{
		{"bytes 14-10/100", 5},
		{"bytes 0-100/100", 101},
		{"bytes 10-14/100", 4},
		{"items 0-1/2", 2},
	} {
		if validPartialContentRange(value.raw, value.length, "bytes=10-14") {
			t.Errorf("invalid range accepted: %#v", value)
		}
	}
	for _, mismatch := range []struct {
		response string
		request  string
	}{
		{"bytes 0-499/1000", "bytes=500-999"},
		{"bytes 500-999/1000", "bytes=0-499"},
		{"bytes 10-12/100", "bytes=10-14"},
		{"bytes 10-14/100", "bytes=10-"},
		{"bytes 90-99/100", "bytes=-5"},
	} {
		if validPartialContentRange(mismatch.response, -1, mismatch.request) {
			t.Errorf("mismatched response accepted: %#v", mismatch)
		}
	}
}

func TestDownloadLimiterBoundsGlobalAndPerSessionConcurrency(t *testing.T) {
	limiter := newDownloadLimiter()
	releases := make([]func(), 0, maxConcurrentDownloads)
	for index := range maxConcurrentDownloadsPerSession {
		release, ok := limiter.acquire("viewer", func() {})
		if !ok {
			t.Fatalf("per-session reservation %d rejected", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.acquire("viewer", func() {}); ok {
		t.Fatal("per-session download limit was not enforced")
	}
	for index := len(releases); index < maxConcurrentDownloads; index++ {
		release, ok := limiter.acquire("viewer-"+strconv.Itoa(index), func() {})
		if !ok {
			t.Fatalf("global reservation %d rejected early", index)
		}
		releases = append(releases, release)
	}
	if _, ok := limiter.acquire("overflow", func() {}); ok {
		t.Fatal("global download limit was not enforced")
	}
	releases[0]()
	releases[0]()
	if release, ok := limiter.acquire("viewer", func() {}); !ok {
		t.Fatal("released reservation was not reusable")
	} else {
		release()
	}
	for _, release := range releases[1:] {
		release()
	}
}

func TestDownloadLimiterStopsAllSessionReservations(t *testing.T) {
	limiter := newDownloadLimiter()
	canceled := make(chan struct{}, maxConcurrentDownloadsPerSession)
	releases := make([]func(), 0, maxConcurrentDownloadsPerSession)
	for range maxConcurrentDownloadsPerSession {
		release, ok := limiter.acquire("viewer", func() { canceled <- struct{}{} })
		if !ok {
			t.Fatal("reservation was unexpectedly rejected")
		}
		releases = append(releases, release)
	}

	limiter.stop("viewer")
	for range maxConcurrentDownloadsPerSession {
		select {
		case <-canceled:
		case <-time.After(time.Second):
			t.Fatal("session stop did not cancel every reservation")
		}
	}
	for _, release := range releases {
		release()
	}
	if release, ok := limiter.acquire("viewer", func() {}); !ok {
		t.Fatal("stopped reservations were not reusable")
	} else {
		release()
	}
}

func TestMediaResponseMetadataIsNarrow(t *testing.T) {
	if got := safeMediaType("video/mp4; codecs=avc1"); got != "video/mp4" {
		t.Fatalf("safeMediaType(video) = %q", got)
	}
	if got := safeMediaType("text/html"); got != "application/octet-stream" {
		t.Fatalf("safeMediaType(html) = %q", got)
	}
	if got := withExtension("Movie.mp4", "mp4"); got != "Movie.mp4" {
		t.Fatalf("withExtension duplicate = %q", got)
	}
}
