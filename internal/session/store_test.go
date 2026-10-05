package session

import (
	"testing"
	"time"

	"github.com/JermZone/watch-now/internal/dispatcharr"
)

func TestSessionIdleAndAbsoluteExpiration(t *testing.T) {
	base := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	now := base
	store := NewStore(10*time.Minute, time.Hour, 4)
	store.now = func() time.Time { return now }

	created, err := store.Create(dispatcharr.Credentials{Username: "viewer", Password: "secret"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(9 * time.Minute)
	if _, ok := store.Get(created.ID); !ok {
		t.Fatal("session expired before idle timeout")
	}
	now = now.Add(11 * time.Minute)
	if _, ok := store.Get(created.ID); ok {
		t.Fatal("session survived idle timeout")
	}

	now = base
	created, err = store.Create(dispatcharr.Credentials{Username: "viewer", Password: "secret"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	for range 6 {
		now = now.Add(10 * time.Minute)
		if _, ok := store.Get(created.ID); !ok && now.Sub(base) <= time.Hour {
			t.Fatal("session expired before absolute timeout")
		}
	}
	now = now.Add(time.Nanosecond)
	if _, ok := store.Get(created.ID); ok {
		t.Fatal("session survived absolute timeout")
	}
}

func TestSessionStoreIsBoundedAndRevocable(t *testing.T) {
	store := NewStore(time.Hour, time.Hour, 1)
	first, err := store.Create(dispatcharr.Credentials{Username: "one"}, "one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(dispatcharr.Credentials{Username: "two"}, "two"); err != ErrCapacity {
		t.Fatalf("error = %v", err)
	}
	store.Delete(first.ID)
	if store.Len() != 0 {
		t.Fatal("session was not deleted")
	}
}

func TestActivePlaybackSuspendsOnlyIdleExpiration(t *testing.T) {
	base := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	now := base
	store := NewStore(10*time.Minute, time.Hour, 2)
	store.now = func() time.Time { return now }
	created, err := store.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.BeginPlayback(created.ID); !ok {
		t.Fatal("playback could not begin")
	}

	now = base.Add(30 * time.Minute)
	if _, ok := store.Get(created.ID); !ok {
		t.Fatal("active playback did not suspend idle expiration")
	}
	store.EndPlayback(created.ID)
	now = now.Add(10*time.Minute + time.Nanosecond)
	if _, ok := store.Get(created.ID); ok {
		t.Fatal("idle expiration did not resume after playback ended")
	}

	now = base
	created, err = store.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := store.BeginPlayback(created.ID); !ok {
		t.Fatal("playback could not begin")
	}
	now = base.Add(time.Hour + time.Nanosecond)
	if _, ok := store.Get(created.ID); ok {
		t.Fatal("active playback survived the absolute timeout")
	}
}

func TestDVRKeyCannotResurrectOrReplaceNewConnection(t *testing.T) {
	store := NewStore(time.Hour, 2*time.Hour, 4)
	viewer, err := store.Create(dispatcharr.Credentials{Username: "viewer"}, "viewer")
	if err != nil {
		t.Fatal(err)
	}
	if !store.SetDVRKey(viewer.ID, "", "first") || !store.SetDVRKey(viewer.ID, "first", "second") {
		t.Fatal("connect failed")
	}
	if store.SetDVRKey(viewer.ID, "first", "") {
		t.Fatal("stale request cleared newer key")
	}
	current, _ := store.Get(viewer.ID)
	if current.DVRKey != "second" {
		t.Fatal("key was overwritten")
	}
	store.Delete(viewer.ID)
	if store.SetDVRKey(viewer.ID, "second", "third") {
		t.Fatal("logged-out session resurrected")
	}
}
