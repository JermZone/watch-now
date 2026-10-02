package ratelimit

import (
	"testing"
	"time"
)

func TestLimiterResetsAndBoundsPeers(t *testing.T) {
	now := time.Now()
	limiter := New(2, time.Minute, 1)
	limiter.now = func() time.Time { return now }
	if allowed, _ := limiter.Allow("one"); !allowed {
		t.Fatal("first request rejected")
	}
	if allowed, _ := limiter.Allow("one"); !allowed {
		t.Fatal("second request rejected")
	}
	if allowed, retry := limiter.Allow("one"); allowed || retry <= 0 {
		t.Fatalf("third request allowed=%v retry=%v", allowed, retry)
	}
	now = now.Add(time.Minute)
	if allowed, _ := limiter.Allow("one"); !allowed {
		t.Fatal("request was not allowed after reset")
	}
	if allowed, _ := limiter.Allow("two"); !allowed {
		t.Fatal("new peer was not admitted after bounded eviction")
	}
}
