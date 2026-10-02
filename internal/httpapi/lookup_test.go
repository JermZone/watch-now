package httpapi

import (
	"context"
	"sync"
	"testing"
	"testing/synctest"
)

func TestItemLookupCapacityAndCanceledWaiters(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var group itemLookups
		ctx, cancel := context.WithCancel(context.Background())
		var wg sync.WaitGroup
		for i := range 16 {
			key := string(rune(i))
			wg.Go(func() { _, _ = group.do(ctx, key, func() (any, error) { <-ctx.Done(); return nil, ctx.Err() }) })
		}
		synctest.Wait()
		if _, err := group.do(ctx, "overflow", func() (any, error) { t.Error("capacity exceeded"); return nil, nil }); err == nil {
			t.Fatal("missing capacity error")
		}
		waitCtx, stop := context.WithCancel(ctx)
		stop()
		if _, err := group.do(waitCtx, string(rune(0)), func() (any, error) { t.Error("waiter started duplicate"); return nil, nil }); err != context.Canceled {
			t.Fatal("canceled waiter blocked")
		}
		cancel()
		wg.Wait()
		if len(group.active) != 0 {
			t.Fatal("finished lookups retained")
		}
	})
}
