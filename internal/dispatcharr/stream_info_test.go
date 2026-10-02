package dispatcharr

import (
	"encoding/json"
	"testing"
)

func TestStreamInfoLeavesAmbiguousVideoTracksUnknown(t *testing.T) {
	info := normalizeStreamInfo("mp4", rawStreamMetadata{
		Video: json.RawMessage(`[
			{"codec_name":"proprietary","width":640,"height":480},
			{"codec_name":"h264","width":1920,"height":1080}
		]`),
		Audio: json.RawMessage(`{"codec_name":"aac"}`),
	})
	want := StreamInfo{Container: "MP4", AudioCodec: "AAC"}
	if info == nil || *info != want {
		t.Fatalf("stream info = %#v, want %#v", info, want)
	}
}

func TestStreamInfoLeavesMixedScalarCodecTracksUnknown(t *testing.T) {
	info := normalizeStreamInfo("mp4", rawStreamMetadata{
		Video: json.RawMessage(`["h264", "proprietary"]`),
		Audio: json.RawMessage(`"aac"`),
	})
	want := StreamInfo{Container: "MP4", AudioCodec: "AAC"}
	if info == nil || *info != want {
		t.Fatalf("stream info = %#v, want %#v", info, want)
	}
}

func TestStreamInfoUsesOneExplicitDefaultTrackConsistently(t *testing.T) {
	info := normalizeStreamInfo("mp4", rawStreamMetadata{
		Video: json.RawMessage(`[
			{"codec_name":"hevc","width":3840,"height":2160},
			{"codec_name":"h264","width":1920,"height":1080,"disposition":{"default":1}}
		]`),
		Audio: json.RawMessage(`"aac"`),
	})
	want := StreamInfo{
		Container: "MP4", VideoCodec: "H.264", AudioCodec: "AAC",
		Width: 1920, Height: 1080, Resolution: "1920x1080",
	}
	if info == nil || *info != want {
		t.Fatalf("stream info = %#v, want %#v", info, want)
	}
}

func TestStreamInfoRejectsResolutionThatConflictsWithSelectedDimensions(t *testing.T) {
	info := normalizeStreamInfo("mp4",
		rawStreamMetadata{Width: json.RawMessage(`1920`)},
		rawStreamMetadata{Resolution: json.RawMessage(`"3840x2160"`)},
	)
	want := StreamInfo{Container: "MP4", Width: 1920}
	if info == nil || *info != want {
		t.Fatalf("stream info = %#v, want %#v", info, want)
	}
}

func TestStreamInfoRetainsOnlyReportedResolution(t *testing.T) {
	for _, test := range []struct {
		name   string
		video  string
		height int
		width  int
		label  string
	}{
		{name: "explicit vertical string", video: `"1080p"`, height: 1080, label: "1080p"},
		{name: "explicit interlaced string", video: `"1080I"`, height: 1080, label: "1080i"},
		{name: "explicit dimensions string", video: `"1920 × 1080"`, width: 1920, height: 1080, label: "1920x1080"},
		{name: "cropped pixels are not rounded", video: `{"width":1920,"height":1040}`, width: 1920, height: 1040, label: "1920x1040"},
		{name: "portrait pixels are not a quality tier", video: `{"width":1080,"height":1920}`, width: 1080, height: 1920, label: "1080x1920"},
		{name: "height alone is retained without inventing scan type", video: `{"height":1080}`, height: 1080},
		{name: "missing at source", video: `{}`},
		{name: "title-like label is not metadata", video: `"Film FULL HD 1080p"`},
		{name: "invalid dimensions", video: `{"width":1920.5,"height":999999}`},
		{name: "ambiguous tracks", video: `[{"width":1920,"height":1080},{"width":3840,"height":2160}]`},
		{name: "attached artwork", video: `{"width":1920,"height":1080,"disposition":{"attached_pic":1}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			info := normalizeStreamInfo("mp4", rawStreamMetadata{Video: json.RawMessage(test.video)})
			want := StreamInfo{Container: "MP4", Width: test.width, Height: test.height, Resolution: test.label}
			if info == nil || *info != want {
				t.Fatalf("stream info = %#v, want %#v", info, want)
			}
		})
	}
}

func TestStreamInfoDoesNotCombineConflictingDimensionSources(t *testing.T) {
	info := normalizeStreamInfo("mp4", rawStreamMetadata{
		Width: json.RawMessage(`1920`),
		Video: json.RawMessage(`{"width":3840,"height":2160,"resolution":"2160p"}`),
	})
	// The explicit width conflicts with the selected track. Its height and
	// resolution label must not be attached to that width.
	want := StreamInfo{Container: "MP4", Width: 1920}
	if info == nil || *info != want {
		t.Fatalf("stream info = %#v, want %#v", info, want)
	}
}
