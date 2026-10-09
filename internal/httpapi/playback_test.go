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

func TestFinishingPlaybackCannotClearActivityAfterNewStart(t *testing.T) {
	registry := newPlaybackRegistry()
	viewer := session.Session{ID: "viewer", CreatedAt: time.Now()}
	_, old := registry.startRecording(viewer, time.Hour, "1")
	entered := make(chan struct{})
	release := make(chan struct{})
	ended := make(chan struct{})
	go func() {
		registry.finishWith(viewer.ID, old, func() { close(entered); <-release })
		close(ended)
	}()
	<-entered
	started := make(chan uint64, 1)
	go func() { _, gen := registry.startRecording(viewer, time.Hour, "2"); started <- gen }()
	select {
	case <-started:
		t.Fatal("new start crossed older session finish")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	<-ended
	newer := <-started
	if _, ok := registry.recording(viewer.ID, "2", newer); !ok {
		t.Fatal("new generation not retained")
	}
	registry.finish(viewer.ID, newer)
}

func TestStoppingPlaybackCannotClearActivityAfterNewStart(t *testing.T) {
	registry := newPlaybackRegistry()
	viewer := session.Session{ID: "viewer", CreatedAt: time.Now()}
	first, _ := registry.startRecording(viewer, time.Hour, "1")
	entered := make(chan struct{})
	release := make(chan struct{})
	ended := make(chan struct{})
	go func() {
		registry.stopWith(viewer.ID, func() { close(entered); <-release })
		close(ended)
	}()
	<-entered
	select {
	case <-first.Done():
	default:
		t.Fatal("stopped playback was not canceled")
	}
	started := make(chan uint64, 1)
	go func() { _, gen := registry.startRecording(viewer, time.Hour, "2"); started <- gen }()
	select {
	case <-started:
		t.Fatal("new start crossed older session stop")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	<-ended
	newer := <-started
	if _, ok := registry.recording(viewer.ID, "2", newer); !ok {
		t.Fatal("new generation not retained")
	}
	registry.finish(viewer.ID, newer)
}

func TestStoppedOrReplacedGenerationCannotBeginActivity(t *testing.T) {
	registry := newPlaybackRegistry()
	viewer := session.Session{ID: "viewer", CreatedAt: time.Now()}
	_, old := registry.startRecording(viewer, time.Hour, "1")
	registry.stop(viewer.ID)
	calls := 0
	begin := func() bool { calls++; return true }
	if registry.beginWith(viewer.ID, old, begin) || calls != 0 {
		t.Fatal("stopped generation began session activity")
	}
	_, newer := registry.startRecording(viewer, time.Hour, "2")
	if registry.beginWith(viewer.ID, old, begin) || calls != 0 {
		t.Fatal("replaced generation began session activity")
	}
	if !registry.beginWith(viewer.ID, newer, begin) || calls != 1 {
		t.Fatal("current generation did not begin session activity")
	}
	registry.finish(viewer.ID, newer)
}

func TestBeginningActivityIsAtomicWithStop(t *testing.T) {
	registry := newPlaybackRegistry()
	viewer := session.Session{ID: "viewer", CreatedAt: time.Now()}
	_, generation := registry.startRecording(viewer, time.Hour, "1")
	entered := make(chan struct{})
	release := make(chan struct{})
	began := make(chan bool, 1)
	go func() {
		began <- registry.beginWith(viewer.ID, generation, func() bool { close(entered); <-release; return true })
	}()
	<-entered
	stopped := make(chan struct{})
	go func() { registry.stop(viewer.ID); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("stop crossed session activity begin")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	if !<-began {
		t.Fatal("generation did not begin activity")
	}
	<-stopped
}
