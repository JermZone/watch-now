package ratelimit

import (
	"sync"
	"time"
)

type peer struct {
	count       int
	windowStart time.Time
	lastSeen    time.Time
}

type Limiter struct {
	mu       sync.Mutex
	peers    map[string]peer
	limit    int
	window   time.Duration
	maxPeers int
	now      func() time.Time
}

func New(limit int, window time.Duration, maxPeers int) *Limiter {
	return &Limiter{
		peers:    make(map[string]peer),
		limit:    limit,
		window:   window,
		maxPeers: maxPeers,
		now:      time.Now,
	}
}

func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	current, exists := l.peers[key]
	if !exists || now.Sub(current.windowStart) >= l.window {
		if !exists && len(l.peers) >= l.maxPeers {
			l.evictOldest()
		}
		l.peers[key] = peer{count: 1, windowStart: now, lastSeen: now}
		return true, 0
	}
	current.lastSeen = now
	if current.count >= l.limit {
		l.peers[key] = current
		return false, l.window - now.Sub(current.windowStart)
	}
	current.count++
	l.peers[key] = current
	return true, 0
}

func (l *Limiter) evictOldest() {
	var oldestKey string
	var oldest time.Time
	for key, current := range l.peers {
		if oldestKey == "" || current.lastSeen.Before(oldest) {
			oldestKey = key
			oldest = current.lastSeen
		}
	}
	delete(l.peers, oldestKey)
}
