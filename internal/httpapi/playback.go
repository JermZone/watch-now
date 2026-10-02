package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/JermZone/watch-now/internal/session"
)

type activePlayback struct {
	generation uint64
	cancel     context.CancelFunc
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
	ctx, cancel := context.WithDeadline(parent, viewerSession.CreatedAt.Add(absoluteTTL))

	registry.mu.Lock()
	registry.next++
	generation := registry.next
	previous := registry.bySession[viewerSession.ID]
	registry.bySession[viewerSession.ID] = activePlayback{generation: generation, cancel: cancel}
	registry.mu.Unlock()

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
		active.cancel()
		return true
	}
	return false
}

func (registry *playbackRegistry) stop(sessionID string) {
	registry.mu.Lock()
	active, ok := registry.bySession[sessionID]
	if ok {
		delete(registry.bySession, sessionID)
	}
	registry.mu.Unlock()
	if ok {
		active.cancel()
	}
}
