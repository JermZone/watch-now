package dispatcharr

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return NewClient(baseURL, &http.Client{Timeout: time.Second}, 1024*1024, 1024)
}

func TestAuthenticateValidatesXCInterfaceWithoutVersionGate(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/player_api.php" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Get("username") != "viewer" || request.URL.Query().Get("password") != "secret" {
			t.Fatal("credentials were not sent to the XC endpoint")
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"user_info":{"username":"viewer","password":"secret","auth":"1","status":"Active"},"server_info":{"version":"99.0"}}`))
	})

	account, err := client.Authenticate(context.Background(), Credentials{Username: "viewer", Password: "secret"})
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if account.Username != "viewer" || account.Status != "Active" {
		t.Fatalf("account = %#v", account)
	}
}

func TestAuthenticateRejectsInvalidCredentialsWithoutLeakingThem(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "secret", http.StatusUnauthorized)
	})
	_, err := client.Authenticate(context.Background(), Credentials{Username: "sensitive-user-42", Password: "top-secret-42"})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "top-secret-42") || strings.Contains(err.Error(), "sensitive-user-42") {
		t.Fatalf("credential leaked in error %q", err)
	}
}

func TestDiagnosticsTreatsVersionAsMetadata(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/core/version/" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		_, _ = writer.Write([]byte(`{"version":"0.99.0","timestamp":1999999999,"extra":"ignored"}`))
	})
	diagnostics := client.Diagnostics(context.Background())
	if !diagnostics.Reachable || diagnostics.Version != "0.99.0" || diagnostics.Timestamp != "1999999999" {
		t.Fatalf("diagnostics = %#v", diagnostics)
	}
}

func TestLiveCategoriesAndChannelsUseNarrowModels(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Query().Get("action") {
		case "get_live_categories":
			_, _ = writer.Write([]byte(`[{"category_id":"2","category_name":"News","parent_id":0}]`))
		case "get_live_streams":
			if request.URL.Query().Get("category_id") != "2" {
				t.Fatal("category_id was not forwarded")
			}
			_, _ = writer.Write([]byte(`[{"stream_id":41,"name":"World News","num":7,"category_id":"2","stream_icon":"https://internal/logo","direct_source":"https://provider/secret"}]`))
		default:
			t.Fatalf("unexpected action %q", request.URL.Query().Get("action"))
		}
	})
	credentials := Credentials{Username: "viewer", Password: "secret"}
	categories, err := client.LiveCategories(context.Background(), credentials)
	if err != nil || len(categories) != 1 || categories[0].Name != "News" {
		t.Fatalf("categories = %#v, error = %v", categories, err)
	}
	channels, err := client.LiveChannels(context.Background(), credentials, "2")
	if err != nil || len(channels) != 1 {
		t.Fatalf("channels = %#v, error = %v", channels, err)
	}
	if channels[0] != (Channel{ID: "41", Name: "World News", ChannelNumber: "7", CategoryID: "2"}) {
		t.Fatalf("channel = %#v", channels[0])
	}
}

func TestLiveCategoriesRejectsMissingRequiredShape(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`[{"category_id":"2"}]`))
	})
	_, err := client.LiveCategories(context.Background(), Credentials{Username: "viewer", Password: "secret"})
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}

func TestResponseLimitIsEnforced(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"user_info":{"auth":1},"padding":"` + strings.Repeat("x", 1024*1024) + `"}`))
	})
	_, err := client.Authenticate(context.Background(), Credentials{Username: "viewer", Password: "secret"})
	if !errors.Is(err, ErrResponseTooBig) {
		t.Fatalf("error = %v", err)
	}
}

func TestLiveEPGParsesDispatcharrShortGuideAndSkipsMissingOrMalformedListings(t *testing.T) {
	title := base64.StdEncoding.EncodeToString([]byte("Evening News"))
	description := base64.StdEncoding.EncodeToString([]byte("Top stories"))
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("action") != "get_short_epg" || request.URL.Query().Get("stream_id") != "41" || request.URL.Query().Get("limit") != "6" {
			t.Fatalf("query = %q", request.URL.RawQuery)
		}
		_, _ = writer.Write([]byte(`{"epg_listings":[` +
			`{"epg_id":"8","title":"` + title + `","description":"` + description + `","start_timestamp":"1789999200","stop_timestamp":"1790002800"},` +
			`{"epg_id":"8","title":"bad time","start_timestamp":"nope","stop_timestamp":"1790006400"},` +
			`{"epg_id":"0","title":"generated fallback","start_timestamp":"1790002800","stop_timestamp":"1790006400"}` +
			`]}`))
	})

	programs, err := client.LiveEPG(context.Background(), Credentials{Username: "viewer", Password: "secret"}, "41")
	if err != nil {
		t.Fatalf("LiveEPG() error = %v", err)
	}
	if len(programs) != 1 || programs[0].Title != "Evening News" || programs[0].Description != "Top stories" {
		t.Fatalf("programs = %#v", programs)
	}
}

func TestLiveEPGHandlesMissingAndMalformedPayloads(t *testing.T) {
	t.Run("missing listings", func(t *testing.T) {
		client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) { _, _ = writer.Write([]byte(`{}`)) })
		programs, err := client.LiveEPG(context.Background(), Credentials{}, "1")
		if err != nil || len(programs) != 0 {
			t.Fatalf("programs = %#v, error = %v", programs, err)
		}
	})
	t.Run("malformed listings", func(t *testing.T) {
		client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte(`{"epg_listings":"invalid"}`))
		})
		_, err := client.LiveEPG(context.Background(), Credentials{}, "1")
		if !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestChannelArtworkAllowsOnlyDispatcharrLogoCacheURLs(t *testing.T) {
	var serverURL string
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/player_api.php":
			_, _ = writer.Write([]byte(`[{"stream_id":41,"name":"News","stream_icon":"` + serverURL + `/api/channels/logos/7/cache/"}]`))
		case "/api/channels/logos/7/cache/":
			writer.Header().Set("Content-Type", "text/plain")
			_, _ = writer.Write([]byte("\x89PNG\r\n\x1a\nartwork"))
		default:
			t.Fatalf("unexpected path %q", request.URL.Path)
		}
	})
	serverURL = client.baseURL.String()
	channels, err := client.LiveChannels(context.Background(), Credentials{}, "")
	if err != nil || len(channels) != 1 || !channels[0].HasArtwork {
		t.Fatalf("channels = %#v, error = %v", channels, err)
	}
	artwork, err := client.ChannelArtwork(context.Background(), channels[0])
	if err != nil || artwork.ContentType != "image/png" || len(artwork.Data) == 0 {
		t.Fatalf("artwork = %#v, error = %v", artwork, err)
	}
	if got := client.safeArtworkURL(serverURL + "/unexpected/api/channels/logos/7/cache/"); got != "" {
		t.Fatalf("unexpected path was accepted: %q", got)
	}

	external := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`[{"stream_id":42,"name":"Unsafe","stream_icon":"https://example.test/api/channels/logos/8/cache/"}]`))
	})
	unsafeChannels, err := external.LiveChannels(context.Background(), Credentials{}, "")
	if err != nil || unsafeChannels[0].HasArtwork {
		t.Fatalf("unsafe channels = %#v, error = %v", unsafeChannels, err)
	}
}

func TestChannelArtworkDoesNotFollowCrossOriginRedirects(t *testing.T) {
	externalCalls := 0
	external := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		externalCalls++
		_, _ = writer.Write([]byte("\x89PNG\r\n\x1a\nexternal"))
	}))
	defer external.Close()

	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, external.URL+"/image.png", http.StatusFound)
	}))
	defer upstream.Close()
	baseURL, _ := url.Parse(upstream.URL)
	client := NewClient(baseURL, &http.Client{Timeout: time.Second}, 1024, 1024)
	channel := Channel{ID: "1", HasArtwork: true, artworkURL: upstream.URL + "/api/channels/logos/1/cache/"}

	_, err := client.ChannelArtwork(context.Background(), channel)
	if !errors.Is(err, ErrUnavailable) || externalCalls != 0 {
		t.Fatalf("error = %v, external calls = %d", err, externalCalls)
	}
}

func TestOpenLiveStreamBuildsCredentialedXCPathServerSide(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/live/viewer%2Fname/secret%3Fvalue/41.ts" {
			t.Fatalf("escaped path = %q", request.URL.EscapedPath())
		}
		if request.URL.RawQuery != "" {
			t.Fatalf("query = %q", request.URL.RawQuery)
		}
		if accept := request.Header.Get("Accept"); accept != "" {
			t.Fatalf("live stream request sent restrictive Accept header %q", accept)
		}
		_, _ = writer.Write([]byte("stream"))
	})
	stream, err := client.OpenLiveStream(context.Background(), Credentials{Username: "viewer/name", Password: "secret?value"}, "41")
	if err != nil {
		t.Fatalf("OpenLiveStream() error = %v", err)
	}
	defer stream.Body.Close()
	body, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if string(body) != "stream" {
		t.Fatalf("body = %q", body)
	}
}

func TestOpenLiveStreamRejectsRedirectWithoutCallingProvider(t *testing.T) {
	externalCalls := 0
	external := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		externalCalls++
		_, _ = writer.Write([]byte("provider stream"))
	}))
	defer external.Close()
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, external.URL+"/credentialed/provider/path", http.StatusFound)
	})

	_, err := client.OpenLiveStream(context.Background(), Credentials{Username: "viewer", Password: "secret"}, "41")
	if !errors.Is(err, ErrRedirect) || externalCalls != 0 {
		t.Fatalf("error = %v, external calls = %d", err, externalCalls)
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), external.URL) {
		t.Fatalf("redirect detail leaked in error %q", err)
	}
}

func TestOpenLiveStreamCancellationClosesUpstreamRequest(t *testing.T) {
	upstreamCanceled := make(chan struct{})
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
		if flusher, ok := writer.(http.Flusher); ok {
			flusher.Flush()
		}
		<-request.Context().Done()
		close(upstreamCanceled)
	})
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := client.OpenLiveStream(ctx, Credentials{Username: "viewer", Password: "secret"}, "41")
	if err != nil {
		t.Fatalf("OpenLiveStream() error = %v", err)
	}
	cancel()
	defer stream.Body.Close()
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("upstream request was not canceled")
	}
}

func TestSafeImageTypeValidatesSVGAndRejectsHTML(t *testing.T) {
	if got := safeImageType("image/svg+xml; charset=utf-8", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)); got != "image/svg+xml" {
		t.Fatalf("SVG content type = %q", got)
	}
	if got := safeImageType("image/svg+xml", []byte(`<html><body>not an image</body></html>`)); got != "" {
		t.Fatalf("HTML was accepted as %q", got)
	}
}
