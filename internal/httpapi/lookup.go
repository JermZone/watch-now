package httpapi

import (
	"context"
	"sync"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

// Share only overlapping item authorizations, never completed authorization
// decisions. The fixed capacity bounds both upstream concurrency and memory.
type itemLookups struct {
	mu      sync.Mutex
	active  map[string]*itemLookup
	waiters int
}

type itemLookup struct {
	done  chan struct{}
	value any
	err   error
}

func (g *itemLookups) do(ctx context.Context, key string, fetch func() (any, error)) (any, error) {
	g.mu.Lock()
	if call, ok := g.active[key]; ok {
		if g.waiters >= 32 {
			g.mu.Unlock()
			return nil, dispatcharr.ErrUnavailable
		}
		g.waiters++
		g.mu.Unlock()
		defer func() { g.mu.Lock(); g.waiters--; g.mu.Unlock() }()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-call.done:
			return call.value, call.err
		}
	}
	if len(g.active) >= 16 {
		g.mu.Unlock()
		return nil, dispatcharr.ErrUnavailable
	}
	if g.active == nil {
		g.active = make(map[string]*itemLookup)
	}
	call := &itemLookup{done: make(chan struct{}), err: dispatcharr.ErrUnavailable}
	g.active[key] = call
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		delete(g.active, key)
		close(call.done)
		g.mu.Unlock()
	}()
	call.value, call.err = fetch()
	return call.value, call.err
}
