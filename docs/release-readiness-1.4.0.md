# Watch Now 1.4.0 release preparation

The maintainer requested a stable 1.4.0 release after accepting the development
recording workflow and UI. This document records feature evidence and the
remaining release gates at preparation time; it does not announce a published
image. Later execution evidence belongs on the release PR and GitHub release,
so this historical preparation record does not describe current distribution status.

## Source and scope

- Public integration baseline: GitHub main
  `1c3b4594d1ff5427cdc7618fb427266f18849f49`, containing the published 1.3.1 changes.
- The recording workflow and UI were accepted on the development candidate.
  Integration preserves the public 1.3.1 sharing-storage behavior.
- Exact final source, QA image identity, public merge and published digest must
  be recorded on the release PR and release record once known.
- Active-recording playback through supported stock Dispatcharr HTTP/HLS APIs;
  beginning/live choices, Watch & Record, pause/seek/Go Live, readiness recovery
  and completion handling.
- Solid scheduled/active Guide markers, consistent recording menus and manager
  deletion controls, player Details placement, buffering feedback and home-screen icon.
- One non-root Go process/container. No database, transcoder, persistent sessions,
  catalog storage or Dispatcharr recording-directory mount.
- Automatic sharing-key storage and existing explicit-key overrides remain.
  The key is the only persistent Watch Now state.

Dispatcharr 0.32.0 is the real active-recording baseline. Earlier completed-DVR
and viewer checks used 0.31.0. Supported capabilities determine availability;
version metadata is not a whitelist.

## Source and development evidence

The integrated source passed Go tests/vet/race, 478 frontend tests, the production
build, npm audit, govulncheck, actionlint and Compose/latest-image checks.
These local results are separate from pending public GitHub CI and exact-image
distribution verification.

Prior candidate checks also include fourteen core synthetic Chromium playback
scenarios and three Details-placement scenarios. Record the results of any
additional integrated browser/image runs on the release PR when complete.

Real Dispatcharr transport checks read a growing playlist and segment sample,
then verified canonical finished-file readiness and a ranged file response.
The disposable finished MKV decoded and sought in Chromium through an isolated
API harness. Synthetic H.264/AAC scenarios cover growing captured bounds,
beginning/live entry, pause/seek, retry without duplicate capture, old-segment
retrieval, completion recovery and preserved position. Their MP4 completion
fixture does not establish every Dispatcharr MKV/browser combination.

The maintainer reported real iPhone active-recording playback through completion
with pause and rewind working, and accepted the development UI. This is household
feature feedback. Exact iPhone/iOS/browser versions and a complete device/account
matrix were not recorded; it does not establish fresh testing of the public image.
The temporary Firefox runtime lacked H.264 support, so its non-live layout checks
must not be presented as active-media decode evidence.

Documentation screenshots use synthetic channels, guide listings and media.
Phone-sized browser screenshots demonstrate layout, not native iPhone decoding.

## Device acceptance and remaining coverage

The maintainer accepted the development UI and reported successful iPhone
playback through recording completion with pause and rewind. The integrated
application code matches that accepted QA source. A separate public release
candidate is not required for this release.

The complete device/account matrix below has not been repeated against the
public registry image. Retain the recorded feature acceptance, identify the
exact image and About revision when adding coverage, and keep unrun scenarios
explicit. Useful additional device checks include:

- Desktop, iPhone Safari and home-screen shortcut: Watch & Record creates one
  capture, initial buffering progresses, beginning/live choices reuse it, and
  timeline/pause/seek/Go Live work.
- A real recording completes normally; pause for more than twenty seconds across
  completion and verify retained pause/position through the actual finished file,
  or a clear unsupported-format error with VLC/download available afterward.
- Stop playback leaves capture running; manager Extend 30 minutes and Stop recording
  are separate confirmed actions. Cancel/delete only disposable QA recordings.
- Guide scheduled/active dots are solid and match the permitted airing; current
  recording and future scheduling actions work in Browse/Search/Guide.
- A second viewer reuses the capture. View-only accounts cannot mutate, restricted
  lineups remain restricted, and revoked access/logout ends playback.
- Existing Live/Movie/Series/finished-DVR, VLC, sharing, sign-out/in, navigation
  and refresh behavior remains usable. Re-add the Safari shortcut to verify its icon.
- Observe responsiveness, memory and upstream behavior during a longer recording
  and two viewers. Starting limits are not a capacity guarantee.

Retest targeted failures after relevant changes and preserve unrun scenarios as
explicit limitations. Home-screen picture-in-picture is deferred, not a sign-off
requirement.

## Publication gates

1. Review the integrated source and documentation; required CI, audits,
   release-consistency, install-bundle/link, hardened-container and image checks pass.
2. Retain accepted feature tests and maintainer sign-off; record remaining device
   coverage as explicit limits.
3. Merge the reviewed public release PR; main CI passes. Annotated v1.4.0 matches
   the approved main commit and package version. This release uses a stable
   version directly; QA candidate image labels are not public RC releases.
4. Tagged release workflow passes. Verify checksummed source/install assets,
   anonymous pull, source/version labels, SBOM/provenance, isolated hardened
   startup, sharing storage and an independent scan of the exact published image.
5. Promote that verified stable digest to latest and verify manifest identity.
   The maintainer then upgrades production separately.

Actual execution evidence belongs on the release PR and GitHub release. A green
development suite does not substitute for exact-image distribution verification.

## Upgrade and limits

Preserve existing service/project names, ports, upstream/proxy settings, DVR
secret mounts and the sharing key/volume. Explicit keys take precedence over
automatic storage; migrate the same key deliberately before removing an override.
Keep a private key backup and the prior image/configuration for rollback.
No database migration is required. Recreation ends sessions and temporary links.

Linux AMD64 remains the validated image target; ARM64 is not advertised.
No transcoding, saved cross-session playback position, general uncaptured
start-over, recurring rules or backend connection-accounting fix is introduced.
Browser container/codec limits still apply. Home-screen PiP remains deferred.
The reported Watch-button issue after sign-out/in,
[issue #11](https://github.com/JermZone/watch-now/issues/11), remains deferred and
is not claimed fixed.
