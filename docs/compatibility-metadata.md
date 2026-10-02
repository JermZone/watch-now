# Video metadata investigation

Current viewer behavior: available normalized video details appear automatically in `VideoDetails` badges. There is no compatibility button, prediction label, or missing-resolution warning. The investigation below records the earlier compatibility-panel implementation and its metadata findings.

Investigation baseline: local `main` and a read-only remote-main check both
resolved to `f028f69263225615d9c684a0270cac9d89c8c1a9`.
The earlier poster investigation files were left intact.

## Source to panel

The inspected [Dispatcharr v0.31.0 XC implementation](https://raw.githubusercontent.com/Dispatcharr/Dispatcharr/v0.31.0/apps/output/views.py)
constructs movie and episode responses with explicit field lists. Movies forward
`info.video`, `info.audio`, and `info.bitrate` from provider detail metadata;
episodes expose those fields under each episode's `info`. These values can be
empty. The movie extraction also sits behind a truthiness check on the shared
movie's properties, so stored relation metadata alone does not guarantee output.

Neither response explicitly exports top-level `width`, `height`, `resolution`,
or an exact whole-file size. Dimensions may be available inside the forwarded
`video` value. Top-level provider fields outside those selected outputs are not
automatically preserved. This was also checked against the adjacent embedded
source checkout at `1e51b4f8`.

In Now:

1. `internal/dispatcharr/vod.go` decodes optional fields from XC movie `info` /
   `movie_data`, or episode `info` / episode data. Movie and episode details use
   the same `normalizeStreamInfo` function.
2. `internal/dispatcharr/stream_info.go` selects an unambiguous/default track,
   filters attached pictures, validates values, and produces the narrow
   `StreamInfo` model. Unsupported optional data does not reject the title.
3. `internal/httpapi/catalog.go` verifies membership in the viewer's catalog
   before requesting details, caches metadata per session, and serializes
   `stream_info` into the movie or episode response. Source URLs and raw metadata
   are not added to the viewer model.
4. `MoviesSection` / `SeriesSection` pass that object to `CompatibilityCheck`.
   Checking compatibility reveals existing metadata; it makes no new request.
   Codec/container classification is unchanged by this fix.

No authenticated live XC response was available in this session. These findings
identify code paths and supported shapes, not the missing fields of a specific
deployed title. Source omission and adapter rejection cannot always be
distinguished from the public Now response alone.

## Fixed omissions and misleading labels

- A scalar `video: "1080p"` or `video: "1920x1080"` was discarded by the
  codec-only scalar selector before resolution parsing could inspect it. The
  resolution parser now receives the original scalar independently, while
  arrays still require unambiguous track selection.
- Explicit progressive/interlaced labels are retained when valid and consistent
  with available dimensions. An arbitrary title such as `Film FULL HD 1080p`
  remains insufficient evidence.
- Pixel dimensions are preserved exactly. The old normalizer rounded heights
  such as 1040 to `1080p`; neither rounding nor progressive scan is established
  by those dimensions. The panel now shows `1920x1040` in that case.
- Partial dimensions are useful but do not establish a complete resolution.
  The panel shows `1080 px high` or `1920 px wide`, without inventing the missing
  dimension or scan type. Conflicting dimension sources are not spliced together.
- Empty, invalid, ambiguous, or picture-only metadata remains unknown. After
  the viewer checks compatibility the panel explicitly says
  `Resolution unavailable` when no usable resolution/dimension survives.

## Availability and file size

| Field | Availability through the inspected XC interfaces |
| --- | --- |
| Container | Supplied as `container_extension`; Dispatcharr may default it |
| Video/audio codecs | Optional, inside `video` / `audio`; not guaranteed |
| Pixel width/height | Optional inside `video`; unavailable when omitted/empty |
| Explicit resolution/scan label | Usable when present in forwarded video metadata; not guaranteed |
| Standalone provider `width` / `height` / `resolution` | Not explicitly forwarded by the inspected Dispatcharr detail constructors |
| Bitrate | Optional; zero/missing does not establish a value or file size |
| Exact whole-file byte count | No verified field in the inspected movie/episode detail contracts |

File size remains hidden. No generic `size`, `file_size`, track tag, title,
bitrate-duration estimate, artwork size, or cached partial-response length is
treated as a verified whole-file size. No HEAD/range request, playback request,
media download, or probe was added or performed for this investigation. No new
administrative endpoint, credential flow, or direct-provider access was added.

## Validation

- Normalizer tests cover scalar resolutions, interlace, exact cropped/portrait
  dimensions, partial dimensions, invalid values, attached pictures, ambiguous
  tracks, and conflicting dimension sources.
- Real-adapter HTTP tests exercise movie and episode XC details through the
  authenticated Now API, verify caching and viewer isolation, and reject any
  non-XC/media/probe request. Unknown size fields are not exposed.
- Panel tests cover exact/partial/explicit values, missing-state text, rejection
  of arbitrary labels, and omission of unverified sizes. The existing movie
  interaction test verifies checking compatibility makes no request.
- `go test ./...`, `go vet ./...`, `npm test` (86 tests), `npm run build`, and
  `git diff --check` passed. Build retains the existing bundle-size warning.
- Docker build unavailable: no local Docker CLI/daemon.

The initial investigation and validation were performed locally without
committing, pushing, or deploying.
