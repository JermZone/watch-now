package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/session"
)

func TestStartingPlaybackCancelsPriorStream(t *testing.T) {
	registry := newPlaybackRegistry()
	viewerSession := session.Session{ID: "session", CreatedAt: time.Now(), LastSeenAt: time.Now()}
	first, _ := registry.start(context.Background(), viewerSession, 12*time.Hour)
	second, secondGeneration := registry.start(context.Background(), viewerSession, 12*time.Hour)

	select {
	case <-first.Done():
	case <-time.After(time.Second):
		t.Fatal("first playback was not canceled")
	}
	select {
	case <-second.Done():
		t.Fatal("new playback was canceled")
	default:
	}
	registry.finish(viewerSession.ID, secondGeneration)
}

func TestOlderPlaybackCompletionCannotRemoveNewerStream(t *testing.T) {
	registry := newPlaybackRegistry()
	viewerSession := session.Session{ID: "session", CreatedAt: time.Now(), LastSeenAt: time.Now()}
	_, firstGeneration := registry.start(context.Background(), viewerSession, 12*time.Hour)
	second, secondGeneration := registry.start(context.Background(), viewerSession, 12*time.Hour)

	if registry.finish(viewerSession.ID, firstGeneration) {
		t.Fatal("older playback claimed ownership of the newer playback entry")
	}
	select {
	case <-second.Done():
		t.Fatal("older completion canceled the newer playback")
	default:
	}
	if !registry.finish(viewerSession.ID, secondGeneration) {
		t.Fatal("newer playback did not retain ownership of its entry")
	}
	select {
	case <-second.Done():
	case <-time.After(time.Second):
		t.Fatal("newer playback completion did not cancel its context")
	}
}
