package vlc

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func movieParams(sessionID, contentID string) CreateParams {
	return CreateParams{
		SessionID:       sessionID,
		Kind:            KindMovie,
		ContentID:       contentID,
		StreamID:        "stream-" + contentID,
		Extension:       "mp4",
		DisplayFilename: "A Movie.mp4",
		BaseURL:         "https://dispatcharr.example",
	}
}

func TestLiveHandoffPreservesExpiryAndRevocationBoundaries(t *testing.T) {
	for _, boundary := range []string{"launch", "idle", "hard", "logout"} {
		t.Run(boundary, func(t *testing.T) {
			base := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
			now := base
			store := NewStore(1)
			store.now = func() time.Time { return now }
			created, err := store.Create(CreateParams{
				SessionID: "viewer", Kind: KindLive, ContentID: "41", StreamID: "41",
				Extension: "ts", DisplayFilename: "World-News.ts",
			})
			if err != nil {
				t.Fatal(err)
			}
			media, ok := store.RedeemTicket(created.TicketID)
			if !ok || media.Kind != KindLive || media.ContentID != "41" {
				t.Fatal("live ticket lost its channel binding")
			}
			switch boundary {
			case "launch":
				now = base.Add(HandshakeTTL)
			case "idle":
				media, ok = store.ResolveMedia(created.MediaID, true)
				if !ok {
					t.Fatal("live media could not be activated")
				}
				now = media.ExpiresAt
			case "hard":
				for now.Before(created.HardExpiresAt) {
					if _, ok := store.ResolveMedia(created.MediaID, true); !ok {
						t.Fatal("active live media expired before its hard limit")
					}
					now = now.Add(MediaIdleTTL / 2)
				}
			case "logout":
				store.DeleteSession("viewer")
			}
			if _, ok := store.RedeemTicket(created.TicketID); ok {
				t.Fatal("live launch survived its boundary")
			}
			if _, ok := store.ResolveMedia(created.MediaID, false); ok {
				t.Fatal("live media survived its boundary")
			}
			select {
			case <-media.Revoked():
			default:
				t.Fatal("live relay was not notified of revocation")
			}
		})
	}
}

func TestCreateBindsOpaqueTicketAndMedia(t *testing.T) {
	base := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	store := NewStore(2)
	store.now = func() time.Time { return base }
	params := CreateParams{
		SessionID:       "viewer-session",
		Kind:            KindEpisode,
		ContentID:       "episode-42",
		ParentSeriesID:  "series-7",
		StreamID:        "authorized-stream",
		Extension:       "mkv",
		DisplayFilename: "Series - S01E02 - Episode.mkv",
		BaseURL:         "https://dispatcharr.example/base",
	}

	created, err := store.Create(params)
	if err != nil {
		t.Fatal(err)
	}
	if !validToken(created.TicketID) || !validToken(created.MediaID) {
		t.Fatalf("tokens are not 32-byte base64url values: %#v", created)
	}
	if created.TicketID == created.MediaID {
		t.Fatal("ticket and media IDs must be distinct")
	}
	if !created.TicketExpiresAt.Equal(base.Add(HandshakeTTL)) ||
		!created.MediaExpiresAt.Equal(base.Add(HandshakeTTL)) ||
		!created.HardExpiresAt.Equal(base.Add(MediaMaxLifetime)) {
		t.Fatalf("unexpected deadlines: %#v", created)
	}

	first, ok := store.RedeemTicket(created.TicketID)
	if !ok {
		t.Fatal("ticket was not redeemable")
	}
	second, ok := store.RedeemTicket(created.TicketID)
	if !ok || second != first {
		t.Fatal("repeat launch did not resolve the same media binding")
	}
	if first.ID != created.MediaID || first.SessionID != params.SessionID ||
		first.Kind != params.Kind || first.ContentID != params.ContentID ||
		first.ParentSeriesID != params.ParentSeriesID || first.StreamID != params.StreamID ||
		first.Extension != params.Extension || first.DisplayFilename != params.DisplayFilename ||
		first.BaseURL != params.BaseURL {
		t.Fatalf("media binding = %#v", first)
	}
	if stats := store.Stats(); stats != (StoreStats{Tickets: 1, Media: 1, Limit: 2}) {
		t.Fatalf("stats = %#v", stats)
	}
}

func TestTicketAndMediaExpirationAreIndependent(t *testing.T) {
	base := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	now := base
	store := NewStore(2)
	store.now = func() time.Time { return now }
	created, err := store.Create(movieParams("viewer", "1"))
	if err != nil {
		t.Fatal(err)
	}

	now = base.Add(30 * time.Second)
	media, ok := store.ResolveMedia(created.MediaID, true)
	if !ok || !media.ExpiresAt.Equal(now.Add(MediaIdleTTL)) {
		t.Fatalf("touched media = %#v, %v", media, ok)
	}
	now = base.Add(HandshakeTTL)
	if _, ok := store.RedeemTicket(created.TicketID); ok {
		t.Fatal("ticket survived its exact deadline")
	}
	if _, ok := store.ResolveMedia(created.MediaID, false); !ok {
		t.Fatal("activated media expired with its launch ticket")
	}

	now = media.ExpiresAt
	if _, ok := store.ResolveMedia(created.MediaID, false); ok {
		t.Fatal("media survived its exact idle deadline")
	}
	if stats := store.Stats(); stats.Tickets != 0 || stats.Media != 0 {
		t.Fatalf("expired state remains: %#v", stats)
	}
}

func TestMediaTouchNeverExceedsHardLifetime(t *testing.T) {
	base := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	now := base
	store := NewStore(1)
	store.now = func() time.Time { return now }
	created, err := store.Create(movieParams("viewer", "1"))
	if err != nil {
		t.Fatal(err)
	}

	now = base.Add(30 * time.Second)
	if _, ok := store.ResolveMedia(created.MediaID, true); !ok {
		t.Fatal("media could not be activated during its handshake window")
	}
	for now.Before(base.Add(5*time.Hour + 55*time.Minute)) {
		now = now.Add(9 * time.Minute)
		if now.After(base.Add(5*time.Hour + 55*time.Minute)) {
			now = base.Add(5*time.Hour + 55*time.Minute)
		}
		if _, ok := store.ResolveMedia(created.MediaID, true); !ok {
			t.Fatalf("media expired during periodic activity at %v", now.Sub(base))
		}
	}
	media, ok := store.ResolveMedia(created.MediaID, true)
	if !ok || !media.ExpiresAt.Equal(created.HardExpiresAt) {
		t.Fatalf("hard-capped media = %#v, %v", media, ok)
	}
	now = created.HardExpiresAt
	if _, ok := store.ResolveMedia(created.MediaID, true); ok {
		t.Fatal("media survived its exact hard deadline")
	}
}

func TestStoreCapacityFailsClosedAndExpiredStateFreesCapacity(t *testing.T) {
	base := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	now := base
	store := NewStore(1)
	store.now = func() time.Time { return now }
	if _, err := store.Create(movieParams("one", "1")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(movieParams("two", "2")); !errors.Is(err, ErrCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
	if stats := store.Stats(); stats.Tickets != 1 || stats.Media != 1 {
		t.Fatalf("failed create changed state: %#v", stats)
	}

	now = base.Add(HandshakeTTL)
	if _, err := store.Create(movieParams("two", "2")); err != nil {
		t.Fatalf("expired handoff did not free capacity: %v", err)
	}
	if _, err := NewStore(0).Create(movieParams("none", "3")); !errors.Is(err, ErrCapacity) {
		t.Fatalf("zero-capacity error = %v", err)
	}
}

func TestSingleViewerCannotExhaustGlobalCapacity(t *testing.T) {
	store := NewStore(maxHandoffsPerSession + 4)
	for index := range maxHandoffsPerSession {
		if _, err := store.Create(movieParams("one-viewer", fmt.Sprint(index))); err != nil {
			t.Fatalf("create %d: %v", index, err)
		}
	}
	if _, err := store.Create(movieParams("one-viewer", "overflow")); !errors.Is(err, ErrCapacity) {
		t.Fatalf("per-viewer capacity error = %v", err)
	}
	if _, err := store.Create(movieParams("another-viewer", "allowed")); err != nil {
		t.Fatalf("other viewer was denied: %v", err)
	}
}

func TestDeleteSessionRevokesOnlyOwnedState(t *testing.T) {
	store := NewStore(4)
	first, err := store.Create(movieParams("target", "1"))
	if err != nil {
		t.Fatal(err)
	}
	secondParams := movieParams("target", "2")
	secondParams.Kind = KindEpisode
	secondParams.ParentSeriesID = "series"
	second, err := store.Create(secondParams)
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.Create(movieParams("other", "3"))
	if err != nil {
		t.Fatal(err)
	}

	store.DeleteSession("target")
	for _, id := range []string{first.TicketID, second.TicketID} {
		if _, ok := store.RedeemTicket(id); ok {
			t.Fatalf("ticket %q survived session deletion", id)
		}
	}
	for _, id := range []string{first.MediaID, second.MediaID} {
		if _, ok := store.ResolveMedia(id, true); ok {
			t.Fatalf("media %q survived session deletion", id)
		}
	}
	if _, ok := store.RedeemTicket(other.TicketID); !ok {
		t.Fatal("unrelated ticket was deleted")
	}
	if stats := store.Stats(); stats.Tickets != 1 || stats.Media != 1 {
		t.Fatalf("stats after deletion = %#v", stats)
	}
}

func TestInvalidInputAndBindingMismatchFailClosed(t *testing.T) {
	store := NewStore(2)
	for name, params := range map[string]CreateParams{
		"session":   {Kind: KindMovie, ContentID: "1", StreamID: "1", Extension: "mp4"},
		"kind":      {SessionID: "s", Kind: "unknown", ContentID: "1", StreamID: "1", Extension: "mp4"},
		"content":   {SessionID: "s", Kind: KindMovie, StreamID: "1", Extension: "mp4"},
		"stream":    {SessionID: "s", Kind: KindMovie, ContentID: "1", Extension: "mp4"},
		"extension": {SessionID: "s", Kind: KindMovie, ContentID: "1", StreamID: "1"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.Create(params); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v", err)
			}
		})
	}
	if _, ok := store.RedeemTicket("not-a-token"); ok {
		t.Fatal("invalid ticket resolved")
	}
	if _, ok := store.ResolveMedia("not-a-token", true); ok {
		t.Fatal("invalid media ID resolved")
	}

	created, err := store.Create(movieParams("viewer", "1"))
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	record := store.tickets[created.TicketID]
	record.contentID = "different-content"
	store.tickets[created.TicketID] = record
	store.mu.Unlock()
	if _, ok := store.RedeemTicket(created.TicketID); ok {
		t.Fatal("mismatched ticket binding resolved")
	}
	if _, ok := store.ResolveMedia(created.MediaID, false); ok {
		t.Fatal("media survived a corrupt ticket binding")
	}
}

func TestCreateIsConcurrencySafeAndBounded(t *testing.T) {
	const (
		limit    = 16
		attempts = 128
	)
	store := NewStore(limit)
	var successes atomic.Int64
	var unexpected atomic.Int64
	var wait sync.WaitGroup
	for index := range attempts {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := store.Create(movieParams(fmt.Sprintf("session-%d", index), fmt.Sprint(index)))
			switch {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrCapacity):
			default:
				unexpected.Add(1)
			}
		}()
	}
	wait.Wait()
	if unexpected.Load() != 0 {
		t.Fatalf("unexpected errors = %d", unexpected.Load())
	}
	if successes.Load() != limit {
		t.Fatalf("successful creates = %d, want %d", successes.Load(), limit)
	}
	if stats := store.Stats(); stats.Tickets != limit || stats.Media != limit {
		t.Fatalf("bounded stats = %#v", stats)
	}
}

func TestConcurrentTicketRedemptionIsRepeatable(t *testing.T) {
	store := NewStore(1)
	created, err := store.Create(movieParams("viewer", "1"))
	if err != nil {
		t.Fatal(err)
	}
	const readers = 64
	results := make(chan string, readers)
	var wait sync.WaitGroup
	for range readers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			item, ok := store.RedeemTicket(created.TicketID)
			if !ok {
				results <- ""
				return
			}
			results <- item.ID
		}()
	}
	wait.Wait()
	close(results)
	for id := range results {
		if id != created.MediaID {
			t.Fatalf("redeemed media ID = %q", id)
		}
	}
}

func TestMediaRelayConcurrencyIsBoundedPerToken(t *testing.T) {
	store := NewStore(1)
	created, err := store.Create(movieParams("viewer", "1"))
	if err != nil {
		t.Fatal(err)
	}
	releases := make([]func(), 0, maxRelaysPerMedia)
	for range maxRelaysPerMedia {
		_, release, ok := store.BeginRelay(created.MediaID)
		if !ok {
			t.Fatal("relay slot unexpectedly unavailable")
		}
		releases = append(releases, release)
	}
	if _, _, ok := store.BeginRelay(created.MediaID); ok {
		t.Fatal("media token exceeded its relay concurrency bound")
	}
	releases[0]()
	_, release, ok := store.BeginRelay(created.MediaID)
	if !ok {
		t.Fatal("released relay slot was not reusable")
	}
	release()
	for _, release := range releases[1:] {
		release()
	}
}
