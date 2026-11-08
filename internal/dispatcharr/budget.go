package dispatcharr

import (
	"context"
	"encoding/json"
	"time"
)

const maxJSONBytes int64 = 8 << 20

// Reject semantic amplification before unmarshaling into slices, maps or raw
// messages. This pass uses a fixed stack and allocates no decoded strings.
// Unknown fields remain compatible but consume the same resource budgets.
func validateJSONBudget(data []byte, maxItems int) error {
	var counts [16]int
	var kinds [16]byte
	depth, nodes, stringsBytes, arrayItems := 0, 0, 0, 0
	for i := 0; i < len(data); i++ {
		ch := data[i]
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == ',' || ch == ':' {
			continue
		}
		if ch == ']' || ch == '}' {
			depth--
			if depth < 0 {
				return ErrInvalidResponse
			}
			continue
		}
		nodes++
		if nodes > 250000 {
			return ErrResponseTooBig
		}
		if depth > 0 {
			counts[depth-1]++
			if kinds[depth-1] == '[' {
				arrayItems++
				if arrayItems > maxItems {
					return ErrResponseTooBig
				}
			}
			limit := maxItems
			if kinds[depth-1] == '{' {
				limit = 256
			} // keys plus values
			if counts[depth-1] > limit {
				return ErrResponseTooBig
			}
		}
		switch ch {
		case '[', '{':
			if depth == len(counts) {
				return ErrResponseTooBig
			}
			counts[depth], kinds[depth] = 0, ch
			depth++
		case '"':
			start := i
			i++
			for i < len(data) && data[i] != '"' {
				if data[i] == '\\' {
					i++
				}
				i++
			}
			size := i - start
			stringsBytes += size
			if size > 64<<10 || stringsBytes > 4<<20 {
				return ErrResponseTooBig
			}
		default:
			start := i
			for i+1 < len(data) && data[i+1] != ',' && data[i+1] != ']' && data[i+1] != '}' && data[i+1] != ' ' && data[i+1] != '\n' && data[i+1] != '\r' && data[i+1] != '\t' {
				i++
			}
			if i-start > 128 {
				return ErrResponseTooBig
			}
		}
	}
	if depth != 0 || !json.Valid(data) {
		return ErrInvalidResponse
	}
	return nil
}

// Keep active decoding bounded while allowing normal startup bursts to wait.
// Admission includes two active requests and at most eight waiting requests.
const metadataWaitLimit = 5 * time.Second

func (c *Client) acquireMetadata(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case c.metadataAdmissions <- struct{}{}:
	default:
		return ErrUnavailable
	}
	timer := time.NewTimer(metadataWaitLimit)
	defer timer.Stop()
	select {
	case c.metadataSlots <- struct{}{}:
		if err := ctx.Err(); err != nil {
			c.releaseMetadata()
			return err
		}
		return nil
	case <-ctx.Done():
		<-c.metadataAdmissions
		return ctx.Err()
	case <-timer.C:
		<-c.metadataAdmissions
		return ErrUnavailable
	}
}
func (c *Client) releaseMetadata() {
	<-c.metadataSlots
	<-c.metadataAdmissions
}
