package dispatcharr

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

func queueTestClient() *Client {
	return &Client{metadataSlots: make(chan struct{}, 2), metadataAdmissions: make(chan struct{}, 10)}
}

func occupyMetadata(t *testing.T, c *Client) {
	t.Helper()
	for range 2 {
		if err := c.acquireMetadata(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMetadataStartupBurstWaitsForCapacity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := queueTestClient()
		occupyMetadata(t, c)
		done := make(chan error, 1)
		go func() { done <- c.acquireMetadata(context.Background()) }()
		synctest.Wait()
		select {
		case err := <-done:
			t.Fatalf("startup request did not wait: %v", err)
		default:
		}
		c.releaseMetadata()
		if err := <-done; err != nil {
			t.Fatalf("queued request failed: %v", err)
		}
		if len(c.metadataSlots) != 2 {
			t.Fatal("active capacity changed")
		}
		c.releaseMetadata()
		c.releaseMetadata()
		if len(c.metadataAdmissions) != 0 {
			t.Fatal("admission leaked")
		}
	})
}

func TestMetadataQueueBoundAndCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := queueTestClient()
		occupyMetadata(t, c)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 8)
		for range 8 {
			go func() { done <- c.acquireMetadata(ctx) }()
		}
		synctest.Wait()
		if err := c.acquireMetadata(context.Background()); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("overflow: %v", err)
		}
		cancel()
		for range 8 {
			if err := <-done; !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation: %v", err)
			}
		}
		if len(c.metadataAdmissions) != 2 || len(c.metadataSlots) != 2 {
			t.Fatal("cancelled waiter retained capacity")
		}
		c.releaseMetadata()
		c.releaseMetadata()
		if err := c.acquireMetadata(ctx); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if len(c.metadataAdmissions) != 0 {
			t.Fatal("cancelled request acquired capacity")
		}
		if err := c.acquireMetadata(context.Background()); err != nil {
			t.Fatal(err)
		}
		c.releaseMetadata()
	})
}

func TestMetadataQueueTimeoutReleasesAdmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := queueTestClient()
		occupyMetadata(t, c)
		start := time.Now()
		if err := c.acquireMetadata(context.Background()); !errors.Is(err, ErrUnavailable) {
			t.Fatal(err)
		}
		if time.Since(start) != metadataWaitLimit {
			t.Fatal("unexpected queue deadline")
		}
		if len(c.metadataAdmissions) != 2 {
			t.Fatal("timed-out waiter retained capacity")
		}
		c.releaseMetadata()
		c.releaseMetadata()
	})
}
