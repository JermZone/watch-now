package dispatcharr

import (
	"errors"
	"net/http"
	"strconv"
)

var (
	ErrForbidden   = errors.New("Dispatcharr denied access")
	ErrRateLimited = errors.New("Dispatcharr temporarily limited requests")
)

// RateLimitError carries only a bounded retry delay, never an upstream body or
// arbitrary header value.
type RateLimitError struct {
	RetryAfterSeconds int
}

func (err *RateLimitError) Error() string { return ErrRateLimited.Error() }
func (err *RateLimitError) Unwrap() error { return ErrRateLimited }

func upstreamAccessError(response *http.Response) error {
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return ErrUnauthorized
	case http.StatusForbidden:
		return ErrForbidden
	case http.StatusTooManyRequests:
		return &RateLimitError{RetryAfterSeconds: safeRetryAfterSeconds(response.Header.Get("Retry-After"))}
	default:
		return nil
	}
}

func safeRetryAfterSeconds(raw string) int {
	if len(raw) == 0 || len(raw) > 9 {
		return 0
	}
	for _, digit := range raw {
		if digit < '0' || digit > '9' {
			return 0
		}
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 1 {
		return 0
	}
	return min(seconds, 3600)
}
