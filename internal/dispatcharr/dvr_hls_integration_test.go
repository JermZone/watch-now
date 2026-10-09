package dispatcharr

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// This opt-in read-only check uses the maintainer's disposable recording.
// Inputs are private file paths; no credentials or upstream content are logged.
func TestDVRHLSRealRecording(t *testing.T) {
	base := os.Getenv("DVR_HLS_INTEGRATION_BASE")
	keyPath := os.Getenv("DVR_HLS_INTEGRATION_KEY_FILE")
	reference := os.Getenv("DVR_HLS_INTEGRATION_REFERENCE")
	if base == "" || keyPath == "" || reference == "" {
		t.Skip("private recording trial not configured")
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal("invalid trial origin")
	}
	rawKey, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal("trial key unavailable")
	}
	rawRef, err := os.ReadFile(reference)
	if err != nil {
		t.Fatal("trial reference unavailable")
	}
	var ref struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(rawRef, &ref) != nil || ref.ID == "" {
		t.Fatal("invalid trial reference")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := NewClient(u, &http.Client{Timeout: 20 * time.Second}, 1<<20, 1024)
	key := strings.TrimSpace(string(rawKey))
	rows, err := client.DVRRecordings(ctx, key)
	if err != nil {
		t.Fatal("trial catalog unavailable")
	}
	var row Recording
	for _, item := range rows {
		if item.ID == ref.ID {
			row = item
			break
		}
	}
	if row.ID == "" {
		t.Fatal("trial recording unavailable")
	}
	manifest, err := client.DVRHLSManifest(ctx, key, ref.ID)
	if errors.Is(err, ErrRecordingFinalized) {
		if !row.ReadyFile && !row.Playable {
			t.Fatal("finalized trial file not ready")
		}
		stream, openErr := client.DVROpen(ctx, key, ref.ID, "bytes=0-1023")
		if openErr != nil {
			t.Fatal("finalized trial file unavailable")
		}
		defer stream.Body.Close()
		sample, readErr := io.ReadAll(io.LimitReader(stream.Body, 1024))
		if readErr != nil || len(sample) == 0 {
			t.Fatal("finalized trial bytes unavailable")
		}
		t.Logf("real completion validated: strict HLS redirect, ready file, %d-byte ranged sample", len(sample))
		return
	}
	if err != nil {
		t.Fatalf("trial manifest failed: %v", err)
	}
	if strings.Contains(manifest.Playlist, "http") || strings.Contains(manifest.Playlist, key) {
		t.Fatal("trial playlist not sanitized")
	}
	if len(manifest.Segments) == 0 {
		t.Fatal("trial has no recorded segments yet")
	}
	stream, err := client.DVRHLSSegment(ctx, key, ref.ID, manifest.Segments[0])
	if err != nil {
		t.Fatalf("trial segment failed: %v", err)
	}
	defer stream.Body.Close()
	bytes, err := io.ReadAll(io.LimitReader(stream.Body, 1024))
	if err != nil || len(bytes) == 0 {
		t.Fatal("trial segment bytes unavailable")
	}
	t.Logf("real recording validated: %d segments, ended=%t, first segment sample=%d bytes", len(manifest.Segments), manifest.Ended, len(bytes))
}
