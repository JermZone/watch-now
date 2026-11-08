package dispatcharr

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestLiveChannelsStreamBeyondWholeDocumentBudget(t *testing.T) {
	// Provider-only fields can make the XC response large without making the
	// narrow channel list large. Live TV must retain the configured wire limit.
	item := `{"stream_id":41,"name":"World News","num":7,"category_id":"2","epg_channel_id":"news","provider_extra":"` + strings.Repeat("x", 2048) + `"}`
	body := "[" + strings.Repeat(item+",", 4999) + item + "]"
	if len(body) <= int(maxJSONBytes) {
		t.Fatal("test catalog must exceed the whole-document JSON limit")
	}
	client := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("action") != "get_live_streams" || r.URL.Query().Get("category_id") != "2" {
			t.Fatalf("unexpected XC catalog request")
		}
		_, _ = io.WriteString(w, body)
	})
	client.maxResponse = 32 << 20
	client.httpClient.Timeout = 10 * time.Second

	channels, err := client.LiveChannels(context.Background(), Credentials{Username: "viewer", Password: "secret"}, "2")
	if err != nil || len(channels) != 5000 {
		t.Fatalf("channels=%d err=%v", len(channels), err)
	}
	want := Channel{ID: "41", Name: "World News", ChannelNumber: "7", CategoryID: "2", epgID: "news"}
	if channels[0] != want || channels[len(channels)-1] != want {
		t.Fatal("large XC catalog changed narrow channel fields")
	}
}

func TestLiveChannelsStreamRejectsWithoutPartialResult(t *testing.T) {
	good := `{"stream_id":41,"name":"World News"}`
	for _, tc := range []struct {
		name string
		body string
		want error
	}{
		{name: "malformed after a valid channel", body: "[" + good + `,{"stream_id":42,"name":"Broken"`, want: ErrInvalidResponse},
		{name: "oversized item after a valid channel", body: "[" + good + `,{"stream_id":42,"name":"Large","provider_extra":"` + strings.Repeat("x", 1<<20) + `"}]`, want: ErrResponseTooBig},
		{name: "missing required field after a valid channel", body: "[" + good + `,{"stream_id":42}]`, want: ErrInvalidResponse},
		{name: "trailing data after a valid channel", body: "[" + good + `] true`, want: ErrInvalidResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := testClient(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, tc.body) })
			client.maxResponse = 32 << 20
			client.httpClient.Timeout = 10 * time.Second
			channels, err := client.LiveChannels(context.Background(), Credentials{}, "")
			if !errors.Is(err, tc.want) || channels != nil {
				t.Fatalf("channels=%d err=%v, want nil and %v", len(channels), err, tc.want)
			}
		})
	}
}

func TestLiveChannelsStreamHonorsConfiguredWireLimit(t *testing.T) {
	client := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"stream_id":41,"name":"World News"}]`)
	})
	client.maxResponse = 20
	channels, err := client.LiveChannels(context.Background(), Credentials{}, "")
	if !errors.Is(err, ErrResponseTooBig) || channels != nil {
		t.Fatalf("channels=%d err=%v, want nil and response limit", len(channels), err)
	}
}
