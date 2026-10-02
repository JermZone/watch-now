package cache

import (
	"testing"
	"time"
)

func TestCacheEnforcesLRUAndByteLimits(t *testing.T) {
	now := time.Now()
	cache := New(2, 10)
	cache.now = func() time.Time { return now }
	cache.Set("one", 1, 4, time.Minute)
	cache.Set("two", 2, 4, time.Minute)
	if _, ok := cache.Get("one"); !ok {
		t.Fatal("expected one in cache")
	}
	cache.Set("three", 3, 4, time.Minute)
	if _, ok := cache.Get("two"); ok {
		t.Fatal("least recently used entry was not evicted")
	}
	entries, bytes := cache.Stats()
	if entries != 2 || bytes != 8 {
		t.Fatalf("stats = %d entries, %d bytes", entries, bytes)
	}
}

func TestCacheExpiresAndDeletesPrefix(t *testing.T) {
	now := time.Now()
	cache := New(4, 100)
	cache.now = func() time.Time { return now }
	cache.Set("session:categories", 1, 1, time.Minute)
	cache.Set("other:categories", 2, 1, time.Minute)
	now = now.Add(time.Minute)
	if _, ok := cache.Get("session:categories"); ok {
		t.Fatal("expired item returned")
	}
	cache.DeletePrefix("other:")
	if entries, _ := cache.Stats(); entries != 0 {
		t.Fatalf("entries = %d", entries)
	}
}

func TestCacheRejectsEntriesLargerThanItsMemoryBound(t *testing.T) {
	cache := New(4, 8)
	cache.Set("oversized-artwork", []byte("too large"), 9, time.Minute)
	if _, ok := cache.Get("oversized-artwork"); ok {
		t.Fatal("oversized entry was cached")
	}
	if entries, bytes := cache.Stats(); entries != 0 || bytes != 0 {
		t.Fatalf("stats = %d entries, %d bytes", entries, bytes)
	}
}
