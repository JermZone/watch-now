package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/JermZone/watch-now/internal/session"
)

type activePlayback struct {
	generation  uint64
	cancel      context.CancelFunc
	ctx         context.Context
	recordingID string
	idle        *time.Timer
}

type playbackRegistry struct {
	mu        sync.Mutex
	next      uint64
	bySession map[string]activePlayback
}

func newPlaybackRegistry() *playbackRegistry {
	return &playbackRegistry{bySession: make(map[string]activePlayback)}
}

func (registry *playbackRegistry) start(parent context.Context, viewerSession session.Session, absoluteTTL time.Duration) (context.Context, uint64) {
	return registry.startUntil(parent, viewerSession.ID, viewerSession.CreatedAt.Add(absoluteTTL))
}

func (registry *playbackRegistry) startUntil(parent context.Context, sessionID string, deadline time.Time) (context.Context, uint64) {
	ctx, cancel := context.WithDeadline(parent, deadline)

	registry.mu.Lock()
	registry.next++
	generation := registry.next
	previous := registry.bySession[sessionID]
	registry.bySession[sessionID] = activePlayback{generation: generation, cancel: cancel, ctx: ctx}
	registry.mu.Unlock()

	if previous.idle != nil {
		previous.idle.Stop()
	}
	if previous.cancel != nil {
		previous.cancel()
	}
	return ctx, generation
}

func (registry *playbackRegistry) finish(sessionID string, generation uint64) bool {
	registry.mu.Lock()
	active, ok := registry.bySession[sessionID]
	if ok && active.generation == generation {
		delete(registry.bySession, sessionID)
	}
	registry.mu.Unlock()
	if ok && active.generation == generation {
		if active.idle != nil {
			active.idle.Stop()
		}
		active.cancel()
		return true
	}
	return false
}

func (registry *playbackRegistry) stop(sessionID string) {
	registry.stopWith(sessionID, func() {})
}

// Keep teardown and session activity atomic with a competing playback start.
func (registry *playbackRegistry) stopWith(sessionID string, end func()) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	active, ok := registry.bySession[sessionID]
	delete(registry.bySession, sessionID)
	if ok {
		if active.idle != nil {
			active.idle.Stop()
		}
		active.cancel()
	}
	end()
}
func (s *Server) stopPlayback(sessionID string) {
	s.playbacks.stopWith(sessionID, func() { s.sessions.EndPlayback(sessionID) })
}

// Recording playback spans many short HTTP requests, unlike a single TS/file
// relay. The generation belongs to the viewer and recording, not any one GET.
func (registry *playbackRegistry) startRecording(viewer session.Session, ttl time.Duration, recordingID string) (context.Context, uint64) {
	deadline := viewer.CreatedAt.Add(ttl)
	if cap := time.Now().Add(6 * time.Hour); cap.Before(deadline) {
		deadline = cap
	}
	ctx, generation := registry.startUntil(context.Background(), viewer.ID, deadline)
	registry.mu.Lock()
	if active, ok := registry.bySession[viewer.ID]; ok && active.generation == generation {
		active.recordingID = recordingID
		active.idle = time.AfterFunc(10*time.Minute, active.cancel)
		registry.bySession[viewer.ID] = active
	}
	registry.mu.Unlock()
	return ctx, generation
}
func (registry *playbackRegistry) recording(sessionID, recordingID string, generation uint64) (context.Context, bool) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	active, ok := registry.bySession[sessionID]
	if !ok || active.generation != generation || active.recordingID != recordingID || active.ctx.Err() != nil {
		return nil, false
	}
	if active.idle != nil {
		active.idle.Reset(10 * time.Minute)
	}
	return active.ctx, true
}

// End the generation and session activity under the same registry lock used
// by start. An older completion cannot clear a newer player's active flag.
func (registry *playbackRegistry) finishWith(sessionID string, generation uint64, end func()) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	active, ok := registry.bySession[sessionID]
	if !ok || active.generation != generation {
		return false
	}
	delete(registry.bySession, sessionID)
	if active.idle != nil {
		active.idle.Stop()
	}
	active.cancel()
	end()
	return true
}
func (s *Server) finishPlayback(sessionID string, generation uint64, began bool) bool {
	return s.playbacks.finishWith(sessionID, generation, func() {
		if began {
			s.sessions.EndPlayback(sessionID)
		}
	})
}

// Beginning activity must still own the generation: a stop can race the gap
// between registration and the session update.
func (registry *playbackRegistry) beginWith(sessionID string, generation uint64, begin func() bool) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	active, ok := registry.bySession[sessionID]
	if !ok || active.generation != generation || active.ctx.Err() != nil {
		return false
	}
	return begin()
}

func (s *Server) beginPlayback(sessionID string, generation uint64) (session.Session, bool) {
	var current session.Session
	ok := s.playbacks.beginWith(sessionID, generation, func() bool {
		var alive bool
		current, alive = s.sessions.BeginPlayback(sessionID)
		return alive
	})
	return current, ok
}
