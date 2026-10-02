package dispatcharr

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSourceBindingMetadataIsNotSerialized(t *testing.T) {
	detail := WithMovieDetailSource(MovieDetail{ID: "public-id", Name: "Film"}, "private-stream", "mkv", "https://dispatcharr.invalid/api/vod/movies/1/image")
	payload, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(payload)
	if strings.Contains(serialized, "private-stream") || strings.Contains(serialized, "dispatcharr.invalid") || strings.Contains(serialized, "mkv") {
		t.Fatalf("private source metadata was serialized: %s", serialized)
	}
}

func TestMovieCategoriesAndMoviesParseFlexibleNarrowModels(t *testing.T) {
	var serverURL string
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Query().Get("action") {
		case "get_vod_categories":
			_, _ = writer.Write([]byte(`[{"category_id":12,"category_name":"Movies","parent_id":0}]`))
		case "get_vod_streams":
			if request.URL.Query().Get("category_id") != "12" {
				t.Fatalf("category_id = %q", request.URL.Query().Get("category_id"))
			}
			_, _ = writer.Write([]byte(`[` +
				`{"stream_id":101,"name":"Film","category_id":12,"year":2024,"rating":7.5,"added":1700000000,"genre":"Drama","plot":"Plot","stream_icon":"` + serverURL + `/api/vod/vodlogos/9/cache","container_extension":"MP4","direct_source":"https://provider.invalid/secret","unknown":{"nested":true}},` +
				`{"stream_id":null,"name":{"bad":true}}` +
				`]`))
		default:
			t.Fatalf("unexpected action %q", request.URL.Query().Get("action"))
		}
	})
	serverURL = client.baseURL.String()
	credentials := Credentials{Username: "viewer", Password: "secret"}
	categories, err := client.MovieCategories(context.Background(), credentials)
	if err != nil || len(categories) != 1 || categories[0] != (Category{ID: "12", Name: "Movies"}) {
		t.Fatalf("categories = %#v, error = %v", categories, err)
	}
	movies, err := client.Movies(context.Background(), credentials, "12")
	if err != nil || len(movies) != 1 {
		t.Fatalf("movies = %#v, error = %v", movies, err)
	}
	movie := movies[0]
	if movie.ID != "101" || movie.Name != "Film" || movie.Year != "2024" || movie.Rating != "7.5" || movie.Added != "1700000000" {
		t.Fatalf("movie = %#v", movie)
	}
	if !movie.HasArtwork || movie.ArtworkURL() == "" || movie.ContainerExtension() != "mp4" || movie.StreamID() != "101" {
		t.Fatalf("private media metadata was not normalized: %#v, art = %q, ext = %q", movie, movie.ArtworkURL(), movie.ContainerExtension())
	}
}

func TestMovieDetailsUsesStockXCShapeAndRejectsMissingRequiredFields(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("action") != "get_vod_info" || request.URL.Query().Get("vod_id") != "101" {
			t.Fatalf("query = %q", request.URL.RawQuery)
		}
		_, _ = writer.Write([]byte(`{"info":{"name":"Film","releasedate":"2024-03-04","episode_run_time":123,"duration":"02:03:00","rating":8.1,"genre":"Drama","plot":"Story","director":"Director","cast":"One, Two","country":"US"},"movie_data":{"stream_id":101,"category_id":12,"added":1700000000,"container_extension":"mkv"}}`))
	})
	detail, err := client.MovieDetails(context.Background(), Credentials{}, "101")
	if err != nil {
		t.Fatal(err)
	}
	if detail.ID != "101" || detail.Name != "Film" || detail.Year != "2024" || detail.Runtime != "123" || detail.Duration != "02:03:00" || detail.ContainerExtension() != "mkv" || detail.StreamID() != "101" {
		t.Fatalf("detail = %#v, ext = %q", detail, detail.ContainerExtension())
	}
	fallback := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{"name":"Fallback"},"movie_data":{"container_extension":"mp4"}}`))
	})
	fallbackDetail, err := fallback.MovieDetails(context.Background(), Credentials{}, "101")
	if err != nil || fallbackDetail.StreamID() != "101" {
		t.Fatalf("fallback detail = %#v, error = %v", fallbackDetail, err)
	}

	invalid := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{},"movie_data":{"stream_id":101}}`))
	})
	if _, err := invalid.MovieDetails(context.Background(), Credentials{}, "101"); !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("missing name error = %v", err)
	}
}

func TestMovieDetailsNormalizesFlexibleStreamMetadata(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{
			"info": {
				"name": "Film",
				"video": [
					{"codec_name":"mjpeg","width":600,"height":600,"is_attached_picture":true},
					{"codec":"AVC1","width":"1920","height":1080,"bit_rate":"8000000"}
				],
				"audio": {"codec_name":"MP4A","channels":"2","channel_layout":"stereo"},
				"bitrate": "6500"
			},
			"movie_data": {
				"stream_id": 101,
				"container_extension": "MOV",
				"direct_source": "https://provider.invalid/user/password/101.mov"
			}
		}`))
	})
	detail, err := client.MovieDetails(context.Background(), Credentials{}, "101")
	if err != nil {
		t.Fatal(err)
	}
	want := StreamInfo{
		Container: "MP4", VideoCodec: "H.264", AudioCodec: "AAC",
		Width: 1920, Height: 1080, Resolution: "1920x1080", AudioChannels: "2.0", Bitrate: 6500,
	}
	if detail.StreamInfo == nil || *detail.StreamInfo != want {
		t.Fatalf("stream info = %#v, want %#v", detail.StreamInfo, want)
	}
	payload, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "provider.invalid") || strings.Contains(string(payload), "password") || strings.Contains(string(payload), "direct_source") {
		t.Fatalf("provider source escaped into movie response: %s", payload)
	}
}

func TestMovieDetailsDoesNotClaimFallbackContainerWhenPlaybackUsesUnknownExtension(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{
			"info":{"name":"Film","container_extension":"mp4"},
			"movie_data":{"stream_id":101,"container_extension":"foo"}
		}`))
	})
	detail, err := client.MovieDetails(context.Background(), Credentials{}, "101")
	if err != nil {
		t.Fatal(err)
	}
	if detail.ContainerExtension() != "foo" || detail.StreamInfo != nil {
		t.Fatalf("extension = %q, stream info = %#v", detail.ContainerExtension(), detail.StreamInfo)
	}
}

func TestSeriesDetailsNormalizesFlexibleEpisodeStreamMetadata(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{
			"info":{"series_id":55,"name":"Show"},
			"episodes":{"1":[{
				"id":501,
				"episode_num":1,
				"title":"Pilot",
				"container_extension":"MKV",
				"info":{
					"video":"h265",
					"audio":[{"codec":"E-AC-3","channels":6,"channel_layout":"5.1"}],
					"resolution":"3840 x 2160",
					"bitrate":12000
				}
			}]}
		}`))
	})
	detail, err := client.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil {
		t.Fatal(err)
	}
	want := StreamInfo{
		Container: "MKV", VideoCodec: "HEVC", AudioCodec: "EAC3",
		Width: 3840, Height: 2160, Resolution: "3840x2160", AudioChannels: "5.1", Bitrate: 12000,
	}
	if len(detail.Episodes) != 1 || detail.Episodes[0].StreamInfo == nil || *detail.Episodes[0].StreamInfo != want {
		t.Fatalf("episodes = %#v, want stream info %#v", detail.Episodes, want)
	}
}

func TestMalformedOptionalStreamMetadataDoesNotRejectOrExposeProviderData(t *testing.T) {
	const secretURL = "https://provider.invalid/secret-user/secret-password/movie.mkv"
	movieClient := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{
			"info":{
				"name":"Film",
				"container_extension":"mp4",
				"video":{"codec_name":"` + secretURL + `","width":"999999999"},
				"audio":{"codec":{"url":"` + secretURL + `"}},
				"resolution":"` + secretURL + `",
				"bitrate":{"raw":"` + secretURL + `"}
			},
			"movie_data":{"stream_id":101,"container_extension":"provider-secret","direct_source":"` + secretURL + `"}
		}`))
	})
	detail, err := movieClient.MovieDetails(context.Background(), Credentials{}, "101")
	if err != nil {
		t.Fatalf("malformed optional movie metadata rejected content: %v", err)
	}
	if detail.ContainerExtension() != "mp4" || detail.StreamInfo == nil || *detail.StreamInfo != (StreamInfo{Container: "MP4"}) {
		t.Fatalf("safe movie container fallback was not retained: extension=%q info=%#v", detail.ContainerExtension(), detail.StreamInfo)
	}
	payload, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "provider.invalid") || strings.Contains(string(payload), "secret-user") || strings.Contains(string(payload), "provider-secret") {
		t.Fatalf("provider data escaped into response: %s", payload)
	}

	seriesClient := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{
			"info":{"name":"Show"},
			"episodes":{"1":[{
				"id":501,"title":"Pilot","container_extension":"mp4",
				"info":{"video":42,"audio":{"codec_name":{"url":"` + secretURL + `"}},"width":[],"height":{},"bitrate":false}
			}]}
		}`))
	})
	series, err := seriesClient.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil || len(series.Episodes) != 1 {
		t.Fatalf("malformed optional episode metadata rejected content: detail=%#v error=%v", series, err)
	}
	if got := series.Episodes[0].StreamInfo; got == nil || *got != (StreamInfo{Container: "MP4"}) {
		t.Fatalf("episode stream info = %#v", got)
	}
	payload, err = json.Marshal(series)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "provider.invalid") || strings.Contains(string(payload), "secret-user") {
		t.Fatalf("provider data escaped into series response: %s", payload)
	}
}

func TestSeriesCategoriesListingsAndDetailsSupportSpecialsAndEmptyEpisodes(t *testing.T) {
	var serverURL string
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Query().Get("action") {
		case "get_series_categories":
			_, _ = writer.Write([]byte(`[{"category_id":"4","category_name":"Series"}]`))
		case "get_series":
			_, _ = writer.Write([]byte(`[{"series_id":55,"name":"Show","category_id":4,"releaseDate":"2021-01-01","rating":9,"genre":"Sci-Fi","plot":"Series plot","cover":"https://external.invalid/poster.jpg"}]`))
		case "get_series_info":
			if request.URL.Query().Get("series_id") != "55" {
				t.Fatalf("series_id = %q", request.URL.Query().Get("series_id"))
			}
			_, _ = writer.Write([]byte(`{"info":{"series_id":55,"name":"Show","category_id":4,"releaseDate":"2021-01-01","rating":"9","genre":"Sci-Fi","plot":"Series plot","cover":"` + serverURL + `/api/vod/series/10/image?kind=movie_image"},"seasons":[{"season_number":0,"name":"Specials","episode_count":1},{"season_number":"1","name":"Season 1"}],"episodes":{"1":[{"id":502,"episode_num":2,"title":"Second","container_extension":"MKV","info":{"release_date":"2021-01-08","duration":"45:00","rating":8.2,"plot":"Two"}},{"id":"501","episode_num":"1","title":"First","container_extension":"mp4","info":{"air_date":"2021-01-01"}}],"0":[{"id":500,"episode_num":1,"title":"Special","season":0,"container_extension":"mp4","info":null}]}}`))
		default:
			t.Fatalf("unexpected action %q", request.URL.Query().Get("action"))
		}
	})
	serverURL = client.baseURL.String()
	categories, err := client.SeriesCategories(context.Background(), Credentials{})
	if err != nil || len(categories) != 1 {
		t.Fatalf("categories = %#v, error = %v", categories, err)
	}
	list, err := client.Series(context.Background(), Credentials{}, "4")
	if err != nil || len(list) != 1 || list[0].Year != "2021" || list[0].HasArtwork {
		t.Fatalf("series = %#v, error = %v", list, err)
	}
	detail, err := client.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Seasons) != 2 || detail.Seasons[0].Number != 0 || detail.Seasons[0].EpisodeCount != 1 {
		t.Fatalf("seasons = %#v", detail.Seasons)
	}
	if !detail.HasArtwork || detail.ArtworkURL() == "" {
		t.Fatalf("series detail artwork was not retained: %#v", detail)
	}
	if len(detail.Episodes) != 3 || detail.Episodes[0].ID != "500" || detail.Episodes[1].ID != "501" || detail.Episodes[2].ID != "502" {
		t.Fatalf("episodes = %#v", detail.Episodes)
	}
	if detail.Episodes[2].ContainerExtension() != "mkv" || detail.Episodes[2].StreamID() != "502" {
		t.Fatalf("episode media = %#v", detail.Episodes[2])
	}

	empty := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{"series_id":55,"name":"Empty"},"episodes":[]}`))
	})
	emptyDetail, err := empty.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil || len(emptyDetail.Episodes) != 0 || emptyDetail.Episodes == nil {
		t.Fatalf("empty detail = %#v, error = %v", emptyDetail, err)
	}
}

func TestSeriesDetailsRejectsMalformedEpisodeShape(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{"series_id":55,"name":"Show"},"episodes":"bad"}`))
	})
	if _, err := client.SeriesDetails(context.Background(), Credentials{}, "55"); !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}

func TestSeriesDetailsAcceptsListShapedSeasonSlots(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{"name":"Show"},"episodes":[[{"id":10,"title":"Special","episode_num":1,"container_extension":"mp4"}],[{"id":11,"title":"Pilot","episode_num":1,"container_extension":"mkv"}],null]}`))
	})
	detail, err := client.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Episodes) != 2 || detail.Episodes[0].SeasonNumber != 0 || detail.Episodes[1].SeasonNumber != 1 {
		t.Fatalf("episodes = %#v", detail.Episodes)
	}
}

func TestSeriesDetailsIgnoresUnsupportedOptionalEpisodeInfoShapes(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"info":{"name":"Show"},"episodes":{"1":[{"id":10,"title":"Pilot","episode_num":1,"container_extension":"mp4","info":""},{"id":11,"title":"Next","episode_num":2,"container_extension":"mkv","info":[]}]}}`))
	})
	detail, err := client.SeriesDetails(context.Background(), Credentials{}, "55")
	if err != nil || len(detail.Episodes) != 2 {
		t.Fatalf("detail = %#v, error = %v", detail, err)
	}
}

func TestVODCatalogResponseLimitIsEnforced(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`[{"stream_id":1,"name":"` + strings.Repeat("x", 512) + `"}]`))
	}))
	defer server.Close()
	baseURL, _ := url.Parse(server.URL)
	client := NewClient(baseURL, &http.Client{Timeout: time.Second}, 128, 1024)
	if _, err := client.Movies(context.Background(), Credentials{}, ""); !errors.Is(err, ErrResponseTooBig) {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenMediaBuildsCredentialedPathsAndForwardsSingleRange(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/movie/viewer%2Fname/secret%3Fvalue/101.mp4" {
			t.Fatalf("escaped path = %q", request.URL.EscapedPath())
		}
		if request.Header.Get("Range") != "bytes=10-99" || request.Header.Get("Accept-Encoding") != "identity" {
			t.Fatalf("request headers = %#v", request.Header)
		}
		writer.Header().Set("Content-Type", "video/mp4")
		writer.Header().Set("Content-Length", "90")
		writer.Header().Set("Content-Range", "bytes 10-99/1000")
		writer.Header().Set("Accept-Ranges", "bytes")
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write([]byte(strings.Repeat("x", 90)))
	})
	stream, err := client.OpenMedia(context.Background(), Credentials{Username: "viewer/name", Password: "secret?value"}, MediaKindMovie, "101", "MP4", "bytes=10-99", "browser")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusPartialContent || stream.ContentType != "video/mp4" || stream.ContentLength != 90 || stream.ContentRange != "bytes 10-99/1000" || stream.AcceptRanges != "bytes" {
		t.Fatalf("stream = %#v", stream)
	}
	if body, err := io.ReadAll(stream.Body); err != nil || len(body) != 90 {
		t.Fatalf("body bytes = %d, error = %v", len(body), err)
	}
}

func TestOpenMediaBuildsSeriesPathWithoutInventingARange(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/series/viewer/secret/502.mkv" {
			t.Fatalf("escaped path = %q", request.URL.EscapedPath())
		}
		if request.Header.Get("Range") != "" {
			t.Fatalf("unexpected Range = %q", request.Header.Get("Range"))
		}
		writer.Header().Set("Content-Type", "video/x-matroska")
		_, _ = writer.Write([]byte("episode"))
	})
	stream, err := client.OpenMedia(context.Background(), Credentials{Username: "viewer", Password: "secret"}, MediaKindSeries, "502", "mkv", "", "browser")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusOK || stream.ContentType != "video/x-matroska" {
		t.Fatalf("stream = %#v", stream)
	}
}

func TestOpenMediaRejectsInvalidInputsWithoutCallingUpstream(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	for _, test := range []struct {
		kind       MediaKind
		id         string
		extension  string
		rangeValue string
	}{
		{kind: "provider", id: "1", extension: "mp4"},
		{kind: MediaKindMovie, id: "../1", extension: "mp4"},
		{kind: MediaKindMovie, id: "1", extension: "../mp4"},
		{kind: MediaKindMovie, id: "1", extension: "mp4", rangeValue: "bytes=1-2,4-5"},
		{kind: MediaKindSeries, id: "1", extension: "mp4", rangeValue: "bytes=9-1"},
	} {
		_, err := client.OpenMedia(context.Background(), Credentials{}, test.kind, test.id, test.extension, test.rangeValue, "browser")
		if err == nil {
			t.Fatalf("OpenMedia(%q, %q, %q, %q) succeeded", test.kind, test.id, test.extension, test.rangeValue)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("upstream calls = %d", calls.Load())
	}
}

func TestByteRangeValidationCoversOpenEndedAndSuffixRanges(t *testing.T) {
	for _, value := range []string{"", "bytes=0-0", "bytes=10-", "bytes=-500"} {
		if !validByteRange(value) {
			t.Fatalf("validByteRange(%q) = false", value)
		}
	}
	for _, value := range []string{"bytes=-0", "bytes=-", "bytes=2-1", "bytes=1-2,4-5", "Bytes=0-1", " bytes=0-1"} {
		if validByteRange(value) {
			t.Fatalf("validByteRange(%q) = true", value)
		}
	}
}

func TestOpenMediaMapsUpstreamRangeRejectionWithoutRelayingItsBody(t *testing.T) {
	client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Range", "bytes */100")
		writer.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		_, _ = writer.Write([]byte("credential-bearing upstream detail"))
	})
	_, err := client.OpenMedia(context.Background(), Credentials{Username: "viewer", Password: "secret"}, MediaKindMovie, "1", "mp4", "bytes=200-", "browser")
	if !errors.Is(err, ErrRangeRejected) || strings.Contains(err.Error(), "credential") {
		t.Fatalf("error = %v", err)
	}
	var rangeError *RangeRejectedError
	if !errors.As(err, &rangeError) || rangeError.ContentRange() != "bytes */100" {
		t.Fatalf("safe unsatisfied range metadata = %#v", err)
	}
}

func TestOpenMediaRejectsRedirectAndCancelsUpstream(t *testing.T) {
	externalCalls := atomic.Int32{}
	external := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		externalCalls.Add(1)
		_, _ = writer.Write([]byte("provider"))
	}))
	defer external.Close()
	redirecting := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, external.URL+"/provider", http.StatusFound)
	})
	if _, err := redirecting.OpenMedia(context.Background(), Credentials{Username: "viewer", Password: "secret"}, MediaKindMovie, "1", "mp4", "", "browser"); !errors.Is(err, ErrRedirect) {
		t.Fatalf("redirect error = %v", err)
	} else if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), external.URL) {
		t.Fatalf("redirect detail leaked in %q", err)
	}
	if externalCalls.Load() != 0 {
		t.Fatalf("external calls = %d", externalCalls.Load())
	}

	canceled := make(chan struct{})
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusOK)
		if flusher, ok := writer.(http.Flusher); ok {
			flusher.Flush()
		}
		<-request.Context().Done()
		close(canceled)
	})
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := client.OpenMedia(ctx, Credentials{}, MediaKindSeries, "2", "mkv", "", "browser")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	defer stream.Body.Close()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("upstream media request was not canceled")
	}
}

func TestOpenMediaFollowsOnlyStockSameOriginSessionRedirect(t *testing.T) {
	var calls atomic.Int32
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.URL.Path != "/movie/viewer/secret/77.mp4" || request.Header.Get("Range") != "bytes=5-9" {
			t.Fatalf("request = %s, headers = %#v", request.URL.String(), request.Header)
		}
		if request.URL.Query().Get("session_id") == "" {
			writer.Header().Set("Location", request.URL.Path+"?session_id=vod_1727020800000_1234")
			writer.WriteHeader(http.StatusMovedPermanently)
			return
		}
		if request.URL.RawQuery != "session_id=vod_1727020800000_1234" {
			t.Fatalf("redirect query = %q", request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "video/mp4")
		writer.Header().Set("Content-Range", "bytes 5-9/100")
		writer.Header().Set("Content-Length", "5")
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write([]byte("media"))
	})
	stream, err := client.OpenMedia(context.Background(), Credentials{Username: "viewer", Password: "secret"}, MediaKindMovie, "77", "mp4", "bytes=5-9", "browser")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	if calls.Load() != 2 || stream.StatusCode != http.StatusPartialContent || stream.ContentRange != "bytes 5-9/100" {
		t.Fatalf("calls = %d, stream = %#v", calls.Load(), stream)
	}
}

func TestOpenMediaReusesOneHiddenSessionAcrossConcurrentAndSequentialRanges(t *testing.T) {
	var bareCalls atomic.Int32
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("session_id") == "" {
			bareCalls.Add(1)
			time.Sleep(20 * time.Millisecond)
			writer.Header().Set("Location", request.URL.Path+"?session_id=vod_shared_1234")
			writer.WriteHeader(http.StatusMovedPermanently)
			return
		}
		if request.URL.RawQuery != "session_id=vod_shared_1234" {
			t.Fatalf("unexpected query %q", request.URL.RawQuery)
		}
		bounds := strings.TrimPrefix(request.Header.Get("Range"), "bytes=")
		writer.Header().Set("Content-Type", "video/mp4")
		writer.Header().Set("Content-Range", "bytes "+bounds+"/100")
		writer.Header().Set("Content-Length", "1")
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write([]byte("x"))
	})

	open := func(rangeHeader string) error {
		stream, err := client.OpenMedia(
			context.Background(), Credentials{Username: "viewer", Password: "secret"},
			MediaKindMovie, "77", "mp4", rangeHeader, "same-browser-playback",
		)
		if err != nil {
			return err
		}
		return stream.Body.Close()
	}
	errorsFound := make(chan error, 2)
	for _, rangeHeader := range []string{"bytes=0-0", "bytes=1-1"} {
		go func() { errorsFound <- open(rangeHeader) }()
	}
	for range 2 {
		if err := <-errorsFound; err != nil {
			t.Fatal(err)
		}
	}
	if err := open("bytes=2-2"); err != nil {
		t.Fatal(err)
	}
	if bareCalls.Load() != 1 {
		t.Fatalf("bare upstream requests = %d, want 1", bareCalls.Load())
	}
}

func TestOpenMediaCanceledWaitDoesNotQueueBehindSessionDiscovery(t *testing.T) {
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("session_id") == "" {
			select {
			case <-firstEntered:
			default:
				close(firstEntered)
			}
			<-releaseFirst
			writer.Header().Set("Location", request.URL.Path+"?session_id=vod_shared_5678")
			writer.WriteHeader(http.StatusMovedPermanently)
			return
		}
		writer.Header().Set("Content-Type", "video/mp4")
		writer.Header().Set("Content-Length", "1")
		_, _ = writer.Write([]byte("x"))
	})
	credentials := Credentials{Username: "viewer", Password: "secret"}
	firstResult := make(chan error, 1)
	go func() {
		stream, err := client.OpenMedia(context.Background(), credentials, MediaKindMovie, "77", "mp4", "", "same-browser-playback")
		if err == nil {
			err = stream.Body.Close()
		}
		firstResult <- err
	}()
	<-firstEntered

	waitContext, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	_, err := client.OpenMedia(waitContext, credentials, MediaKindMovie, "77", "mp4", "bytes=0-0", "same-browser-playback")
	if !errors.Is(err, context.Canceled) || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("canceled wait error = %v after %v", err, time.Since(started))
	}
	close(releaseFirst)
	if err := <-firstResult; err != nil {
		t.Fatal(err)
	}
}

func TestOpenMediaRejectsUnsafeSameOriginSessionRedirectShapes(t *testing.T) {
	for name, location := range map[string]string{
		"different path": "/movie/viewer/secret/78.mp4?session_id=valid",
		"extra query":    "/movie/viewer/secret/77.mp4?session_id=valid&url=provider",
		"bad token":      "/movie/viewer/secret/77.mp4?session_id=bad%2Ftoken",
	} {
		t.Run(name, func(t *testing.T) {
			client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Location", location)
				writer.WriteHeader(http.StatusMovedPermanently)
			})
			if _, err := client.OpenMedia(context.Background(), Credentials{Username: "viewer", Password: "secret"}, MediaKindMovie, "77", "mp4", "", "browser"); !errors.Is(err, ErrRedirect) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestMediaArtworkAllowsOnlyKnownSameOriginVODPathsAndQueries(t *testing.T) {
	var serverURL string
	client := testClient(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/vod/movies/7/image" || request.URL.Query().Get("kind") != "movie_image" {
			t.Fatalf("artwork request = %s?%s", request.URL.Path, request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "image/png")
		_, _ = writer.Write([]byte("\x89PNG\r\n\x1a\nimage"))
	})
	serverURL = client.baseURL.String()
	artwork, err := client.MediaArtwork(context.Background(), serverURL+"/api/vod/movies/7/image?kind=movie_image&index=0&m3u_account_id=3&v=1")
	if err != nil || artwork.ContentType != "image/png" {
		t.Fatalf("artwork = %#v, error = %v", artwork, err)
	}
	for _, raw := range []string{
		"https://external.invalid/api/vod/movies/7/image",
		serverURL + "/api/vod/movies/not-a-number/image",
		serverURL + "/api/vod/movies/7/image?url=https://external.invalid",
		serverURL + "/api/vod/movies/7/image?kind=movie_image%0d%0aBad",
	} {
		if _, err := client.MediaArtwork(context.Background(), raw); !errors.Is(err, ErrArtworkMissing) {
			t.Fatalf("MediaArtwork(%q) error = %v", raw, err)
		}
	}
}

func TestMediaArtworkRetainsSizeAndContentTypeBounds(t *testing.T) {
	t.Run("oversized", func(t *testing.T) {
		client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write(append([]byte("\x89PNG\r\n\x1a\n"), []byte(strings.Repeat("x", 1024))...))
		})
		if _, err := client.MediaArtwork(context.Background(), client.baseURL.String()+"/api/vod/vodlogos/1/cache/"); !errors.Is(err, ErrResponseTooBig) {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("unsafe type", func(t *testing.T) {
		client := testClient(t, func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "text/html")
			_, _ = writer.Write([]byte("<html>not artwork</html>"))
		})
		if _, err := client.MediaArtwork(context.Background(), client.baseURL.String()+"/api/vod/series/1/image"); !errors.Is(err, ErrArtworkMissing) {
			t.Fatalf("error = %v", err)
		}
	})
}
