package dispatcharr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCatalogsStreamBeyondWholeDocumentBudget(t *testing.T) {
	// A normal-sized retained listing can have large repeated provider metadata.
	// This wire response exceeds both the 8 MiB document and 4 MiB string limits.
	item := `{"stream_id":1,"series_id":1,"name":"Title","category_id":"2","plot":"Summary","provider_extra":"` + strings.Repeat("x", 2048) + `"}`
	body := "[" + strings.Repeat(item+",", 4999) + item + "]"
	for _, series := range []bool{false, true} {
		t.Run(fmt.Sprint(series), func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
			c.maxResponse = 32 << 20
			c.httpClient.Timeout = 10 * time.Second
			if series {
				items, err := c.Series(context.Background(), Credentials{}, "")
				if err != nil || len(items) != 5000 {
					t.Fatalf("items=%d err=%v", len(items), err)
				}
			} else {
				items, err := c.Movies(context.Background(), Credentials{}, "")
				if err != nil || len(items) != 5000 {
					t.Fatalf("items=%d err=%v", len(items), err)
				}
			}
		})
	}
}
func TestCatalogAcceptsMoreThanTwentyThousandNarrowItems(t *testing.T) {
	body := "[" + strings.Repeat(`{"stream_id":1,"name":"Movie"},`, 20000) + `{"stream_id":2,"name":"Last"}]`
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
	c.maxResponse = 32 << 20
	c.httpClient.Timeout = 10 * time.Second
	items, err := c.Movies(context.Background(), Credentials{}, "")
	if err != nil || len(items) != 20001 {
		t.Fatalf("items=%d err=%v", len(items), err)
	}
}
func TestCatalogStreamBudgetsAndMalformedResponses(t *testing.T) {
	cases := map[string]string{
		"oversized item":   `[{"stream_id":1,"name":"` + strings.Repeat("x", 1<<20) + `"}]`,
		"depth":            "[" + strings.Repeat("[", 17) + "0" + strings.Repeat("]", 17) + "]",
		"item count":       "[" + strings.Repeat("null,", maxCatalogItems) + "null]",
		"retained strings": "[" + strings.Repeat(`{"stream_id":1,"name":"x","plot":"`+strings.Repeat("x", 60000)+`"},`, 290) + `{"stream_id":1,"name":"x"}]`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
			c.maxResponse = 32 << 20
			c.httpClient.Timeout = 10 * time.Second
			items, err := c.Movies(context.Background(), Credentials{}, "")
			if !errors.Is(err, ErrResponseTooBig) || items != nil {
				t.Fatalf("items=%d err=%v", len(items), err)
			}
		})
	}
	for _, body := range []string{`[`, `[{"stream_id":1,"name":"x"}`, `[] {}`, `{}`, `[{"stream_id":1,"name":"x"}] true`} {
		c := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) })
		if items, err := c.Movies(context.Background(), Credentials{}, ""); !errors.Is(err, ErrInvalidResponse) || items != nil {
			t.Fatalf("malformed response returned items=%d err=%v", len(items), err)
		}
	}
}
func TestCatalogTransportLimitStillApplies(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `[{"stream_id":1,"name":"Movie"}]`) })
	c.maxResponse = 20
	if _, err := c.Movies(context.Background(), Credentials{}, ""); !errors.Is(err, ErrResponseTooBig) {
		t.Fatal(err)
	}
}
func TestCatalogWindowRejectsBeforeReadingWholeItem(t *testing.T) {
	body := strings.NewReader(strings.Repeat("x", 1<<20))
	r := &catalogWindow{source: body}
	_, err := io.Copy(io.Discard, r)
	if !errors.Is(err, ErrResponseTooBig) || body.Len() != (1<<20)-maxCatalogItemBytes {
		t.Fatal("item was read before budget rejected it")
	}
}
