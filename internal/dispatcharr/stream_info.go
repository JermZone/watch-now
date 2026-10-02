package dispatcharr

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	maximumMediaDimension  = 16384
	maximumMediaBitrate    = 100_000_000_000
	maximumMediaCandidates = 64
)

var (
	dimensionResolutionPattern = regexp.MustCompile(`(?i)^\s*([0-9]{2,5})\s*[x×]\s*([0-9]{2,5})\s*$`)
	verticalResolutionPattern  = regexp.MustCompile(`(?i)^\s*([0-9]{2,5})\s*([pi])\s*$`)
)

// rawStreamMetadata keeps inconsistent optional XC media fields out of the
// main decoding path. Each value is normalized independently; unsupported
// shapes are treated as absent rather than invalidating otherwise usable VOD.
type rawStreamMetadata struct {
	Video      json.RawMessage
	Audio      json.RawMessage
	Width      json.RawMessage
	Height     json.RawMessage
	Resolution json.RawMessage
	Bitrate    json.RawMessage
}

func normalizeStreamInfo(container string, sources ...rawStreamMetadata) *StreamInfo {
	info := StreamInfo{Container: normalizeContainerLabel(container)}
	for _, source := range sources {
		rawVideo := decodeOptionalMetadata(source.Video)
		video := primaryMediaValue(rawVideo, videoCodecLabels)
		audio := primaryMediaValue(decodeOptionalMetadata(source.Audio), audioCodecLabels)

		if info.VideoCodec == "" {
			info.VideoCodec = normalizedCodec(video, videoCodecLabels)
		}
		if info.AudioCodec == "" {
			info.AudioCodec = normalizedCodec(audio, audioCodecLabels)
		}
		// Keep dimension pairs together. Combining a top-level width with an
		// unrelated track's height can invent a resolution supplied by neither.
		mergeDimensions(&info,
			firstBoundedInteger(maximumMediaDimension, decodeOptionalMetadata(source.Width)),
			firstBoundedInteger(maximumMediaDimension, decodeOptionalMetadata(source.Height)))
		videoWidth := firstBoundedInteger(maximumMediaDimension, mediaField(video, "width", "coded_width"))
		videoHeight := firstBoundedInteger(maximumMediaDimension, mediaField(video, "height", "coded_height"))
		videoResolution := mediaField(video, "resolution", "display_resolution")
		if (info.Width > 0 && videoWidth > 0 && info.Width != videoWidth) ||
			(info.Height > 0 && videoHeight > 0 && info.Height != videoHeight) {
			videoResolution = nil
		}
		mergeDimensions(&info, videoWidth, videoHeight)
		if info.Resolution == "" {
			width, height, label := firstConsistentResolution(info.Width, info.Height,
				decodeOptionalMetadata(source.Resolution),
				videoResolution,
				// XC video can itself be an explicit resolution string. Codec
				// selection deliberately rejects that string; resolution parsing
				// must still see it. Arrays/maps are not treated as scalar labels.
				rawVideo,
			)
			if label != "" {
				info.Resolution = label
				if info.Width == 0 {
					info.Width = width
				}
				if info.Height == 0 {
					info.Height = height
				}
			}
		}
		if info.AudioChannels == "" {
			info.AudioChannels = normalizeAudioChannels(audio)
		}
		if info.Bitrate == 0 {
			info.Bitrate = firstBoundedInt64(maximumMediaBitrate,
				decodeOptionalMetadata(source.Bitrate), mediaField(video, "bitrate", "bit_rate"))
		}
	}

	if info.Resolution == "" && info.Width > 0 && info.Height > 0 {
		info.Resolution = resolutionLabel(info.Width, info.Height)
	}
	if info == (StreamInfo{}) {
		return nil
	}
	return &info
}

func decodeOptionalMetadata(raw json.RawMessage) any {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}

func normalizedCodec(value any, labels map[string]string) string {
	if scalar, ok := value.(string); ok {
		return labels[mediaToken(scalar)]
	}
	if values, ok := value.([]any); ok {
		for index, item := range values {
			if index >= maximumMediaCandidates {
				break
			}
			if scalar, ok := item.(string); ok {
				if label := labels[mediaToken(scalar)]; label != "" {
					return label
				}
			}
		}
	}
	for _, candidate := range mediaCandidates(value) {
		if metadataBoolean(candidate, "is_attached_picture", "attached_pic") {
			continue
		}
		for _, key := range []string{"codec_name", "codec", "codec_id", "format", "name"} {
			if raw, ok := caseInsensitiveValue(candidate, key); ok {
				if label := labels[mediaToken(metadataString(raw))]; label != "" {
					return label
				}
			}
		}
	}
	return ""
}

// primaryMediaValue selects one internally consistent stream description.
// Multiple tracks without a single explicit default remain ambiguous so their
// fields cannot be combined into an overconfident compatibility result.
func primaryMediaValue(value any, labels map[string]string) any {
	if scalar, ok := value.(string); ok {
		if labels[mediaToken(scalar)] != "" {
			return scalar
		}
		return nil
	}
	if values, ok := value.([]any); ok {
		scalars := make([]string, 0, 1)
		nonEmptyScalars := 0
		for index, item := range values {
			if index >= maximumMediaCandidates {
				break
			}
			if scalar, ok := item.(string); ok && strings.TrimSpace(scalar) != "" {
				nonEmptyScalars++
				if labels[mediaToken(scalar)] != "" {
					scalars = append(scalars, scalar)
				}
			}
		}
		if nonEmptyScalars > 1 {
			return nil
		}
		if len(scalars) == 1 && len(mediaCandidates(value)) == 0 {
			return scalars[0]
		}
	}

	candidates := make([]map[string]any, 0, 2)
	for _, candidate := range mediaCandidates(value) {
		if !isMediaCandidate(candidate, labels) || isAttachedMedia(candidate) {
			continue
		}
		candidates = append(candidates, candidate)
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	var selected map[string]any
	for _, candidate := range candidates {
		if !isDefaultMedia(candidate) {
			continue
		}
		if selected != nil {
			return nil
		}
		selected = candidate
	}
	return selected
}

func mergeDimensions(info *StreamInfo, width, height int) {
	switch {
	case info.Width == 0 && info.Height == 0:
		info.Width, info.Height = width, height
	case info.Width > 0 && info.Height == 0 && width == info.Width:
		info.Height = height
	case info.Width == 0 && info.Height > 0 && height == info.Height:
		info.Width = width
	}
}

func isMediaCandidate(candidate map[string]any, labels map[string]string) bool {
	for _, key := range []string{"codec_name", "codec", "codec_id", "format"} {
		if raw, ok := caseInsensitiveValue(candidate, key); ok && metadataString(raw) != "" {
			return true
		}
	}
	if raw, ok := caseInsensitiveValue(candidate, "name"); ok && labels[mediaToken(metadataString(raw))] != "" {
		return true
	}
	for _, key := range []string{
		"width", "coded_width", "height", "coded_height", "resolution", "display_resolution",
		"channels", "channel_count", "channel_layout", "layout",
	} {
		if _, ok := caseInsensitiveValue(candidate, key); ok {
			return true
		}
	}
	return false
}

func isAttachedMedia(candidate map[string]any) bool {
	if metadataBoolean(candidate, "is_attached_picture", "attached_pic") {
		return true
	}
	disposition, ok := caseInsensitiveValue(candidate, "disposition")
	if !ok {
		return false
	}
	values, ok := disposition.(map[string]any)
	return ok && metadataBoolean(values, "attached_pic")
}

func isDefaultMedia(candidate map[string]any) bool {
	if metadataBoolean(candidate, "is_default", "default") {
		return true
	}
	disposition, ok := caseInsensitiveValue(candidate, "disposition")
	if !ok {
		return false
	}
	values, ok := disposition.(map[string]any)
	return ok && metadataBoolean(values, "default")
}

func mediaCandidates(value any) []map[string]any {
	result := make([]map[string]any, 0, 2)
	visited := 0
	var appendCandidates func(any, int)
	appendCandidates = func(current any, depth int) {
		if current == nil || depth > 2 || visited >= maximumMediaCandidates {
			return
		}
		visited++
		switch typed := current.(type) {
		case map[string]any:
			result = append(result, typed)
			for _, key := range []string{"streams", "tracks", "items", "data"} {
				if nested, ok := caseInsensitiveValue(typed, key); ok {
					appendCandidates(nested, depth+1)
				}
			}
		case []any:
			for _, item := range typed {
				appendCandidates(item, depth+1)
				if visited >= maximumMediaCandidates {
					break
				}
			}
		}
	}
	appendCandidates(value, 0)
	return result
}

func mediaField(value any, keys ...string) any {
	for _, candidate := range mediaCandidates(value) {
		if metadataBoolean(candidate, "is_attached_picture", "attached_pic") {
			continue
		}
		if field, ok := caseInsensitiveValue(candidate, keys...); ok {
			return field
		}
	}
	return nil
}

func caseInsensitiveValue(values map[string]any, keys ...string) (any, bool) {
	for _, wanted := range keys {
		for key, value := range values {
			if strings.EqualFold(strings.TrimSpace(key), wanted) {
				return value, true
			}
		}
	}
	return nil, false
}

func metadataBoolean(values map[string]any, keys ...string) bool {
	value, ok := caseInsensitiveValue(values, keys...)
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case json.Number:
		return typed.String() == "1"
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.TrimSpace(typed) == "1"
	default:
		return false
	}
}

func metadataString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func mediaToken(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

var videoCodecLabels = map[string]string{
	"h264":       "H.264",
	"avc":        "H.264",
	"avc1":       "H.264",
	"x264":       "H.264",
	"h265":       "HEVC",
	"hevc":       "HEVC",
	"hev1":       "HEVC",
	"hvc1":       "HEVC",
	"x265":       "HEVC",
	"av1":        "AV1",
	"av01":       "AV1",
	"vp8":        "VP8",
	"vp9":        "VP9",
	"mpeg2":      "MPEG-2",
	"mpeg2video": "MPEG-2",
	"mpeg4":      "MPEG-4",
	"mpeg4video": "MPEG-4",
	"mp4v":       "MPEG-4",
	"xvid":       "MPEG-4",
	"divx":       "MPEG-4",
	"theora":     "Theora",
	"vc1":        "VC-1",
	"wmv":        "WMV3",
	"wmv3":       "WMV3",
}

var audioCodecLabels = map[string]string{
	"aac":              "AAC",
	"aaclc":            "AAC",
	"heaac":            "AAC",
	"mp4a":             "AAC",
	"ac3":              "AC3",
	"dolbydigital":     "AC3",
	"eac3":             "EAC3",
	"ec3":              "EAC3",
	"ddp":              "EAC3",
	"dolbydigitalplus": "EAC3",
	"dts":              "DTS",
	"dca":              "DTS",
	"dtshd":            "DTS-HD",
	"truehd":           "TrueHD",
	"mp3":              "MP3",
	"mpeglayer3":       "MP3",
	"mp2":              "MP2",
	"opus":             "Opus",
	"vorbis":           "Vorbis",
	"flac":             "FLAC",
	"alac":             "ALAC",
	"wma":              "WMA",
	"pcm":              "PCM",
	"pcms16le":         "PCM",
	"pcms24le":         "PCM",
	"none":             "None",
	"noaudio":          "None",
	"silent":           "None",
	"withoutaudio":     "None",
}

func normalizeContainerLabel(value string) string {
	switch mediaToken(strings.TrimPrefix(strings.TrimSpace(value), ".")) {
	case "mp4", "m4v", "mov", "quicktime", "isom":
		return "MP4"
	case "mkv", "matroska":
		return "MKV"
	case "webm":
		return "WebM"
	case "ts", "mpegts", "m2ts", "mts":
		return "MPEG-TS"
	case "mpeg", "mpg", "mpegps":
		return "MPEG"
	case "avi":
		return "AVI"
	case "flv":
		return "FLV"
	case "wmv", "asf":
		return "WMV"
	case "ogg", "ogv":
		return "OGG"
	case "3gp", "3g2":
		return "3GP"
	default:
		return ""
	}
}

func firstBoundedInteger(maximum int, values ...any) int {
	value := firstBoundedInt64(int64(maximum), values...)
	if value == 0 {
		return 0
	}
	return int(value)
}

func firstBoundedInt64(maximum int64, values ...any) int64 {
	for _, value := range values {
		if parsed, ok := boundedInt64(value, maximum); ok {
			return parsed
		}
	}
	return 0
}

func boundedInt64(value any, maximum int64) (int64, bool) {
	var raw string
	switch typed := value.(type) {
	case json.Number:
		raw = typed.String()
	case string:
		raw = strings.TrimSpace(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		raw = strconv.FormatFloat(typed, 'g', -1, 64)
	case float32:
		raw = strconv.FormatFloat(float64(typed), 'g', -1, 32)
	case int:
		raw = strconv.Itoa(typed)
	case int64:
		raw = strconv.FormatInt(typed, 10)
	default:
		return 0, false
	}
	parsed, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 1 || parsed > float64(maximum) || parsed != math.Trunc(parsed) {
		return 0, false
	}
	return int64(parsed), true
}

func firstConsistentResolution(currentWidth, currentHeight int, values ...any) (int, int, string) {
	for _, value := range values {
		if width, height, label := normalizeResolution(value); label != "" {
			if width > 0 && currentWidth > 0 && width != currentWidth {
				continue
			}
			if height > 0 && currentHeight > 0 && height != currentHeight {
				continue
			}
			if width == 0 && height == 0 && (currentWidth > 0 || currentHeight > 0) {
				continue
			}
			return width, height, label
		}
	}
	return 0, 0, ""
}

func normalizeResolution(value any) (int, int, string) {
	raw := metadataString(value)
	if raw == "" {
		return 0, 0, ""
	}
	if matched := dimensionResolutionPattern.FindStringSubmatch(raw); matched != nil {
		width, widthOK := boundedInt64(matched[1], maximumMediaDimension)
		height, heightOK := boundedInt64(matched[2], maximumMediaDimension)
		if widthOK && heightOK {
			return int(width), int(height), resolutionLabel(int(width), int(height))
		}
	}
	if matched := verticalResolutionPattern.FindStringSubmatch(raw); matched != nil {
		height, ok := boundedInt64(matched[1], maximumMediaDimension)
		if ok {
			return 0, int(height), strconv.FormatInt(height, 10) + strings.ToLower(matched[2])
		}
	}
	return 0, 0, ""
}

func resolutionLabel(width, height int) string {
	if width <= 0 || width > maximumMediaDimension || height <= 0 || height > maximumMediaDimension {
		return ""
	}
	// Dimensions do not establish scan type or justify rounding cropped/padded
	// images to a standard quality tier. Keep the actual reported pixel counts.
	return strconv.Itoa(width) + "x" + strconv.Itoa(height)
}

func normalizeAudioChannels(value any) string {
	channels := firstBoundedInteger(64, mediaField(value, "channels", "channel_count"))
	layout := mediaToken(metadataString(mediaField(value, "channel_layout", "layout")))
	label := ""
	wantChannels := 0
	switch layout {
	case "mono", "10":
		label, wantChannels = "1.0", 1
	case "stereo", "20":
		label, wantChannels = "2.0", 2
	case "51", "51side", "51back":
		label, wantChannels = "5.1", 6
	case "71", "71wide", "71wideback":
		label, wantChannels = "7.1", 8
	}
	if label != "" && (channels == 0 || channels == wantChannels) {
		return label
	}
	if layout == "" {
		switch channels {
		case 1:
			return "1.0"
		case 2:
			return "2.0"
		}
	}
	return ""
}
