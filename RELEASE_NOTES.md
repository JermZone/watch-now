# Watch Now release notes

## 1.2.0 — DVR and expanded TV Guide

Use the [published release](https://github.com/JermZone/watch-now/releases/tag/v1.2.0)
for the verified image digest and distribution checks; source metadata alone does
not confirm image availability.

### Highlights

- Browse a multi-day TV Guide in Grid or List on desktop and mobile. Grid shows
  the selected day's remaining schedule, with readable current-show context,
  a desktop horizontal scrollbar, and touch scrolling. List retains its time-window slider.
- Start with 50 channels and reveal 10 more on scroll, with bounded batches for
  larger lineups. Only dates with available listings are offered. Schedule depth
  depends on Dispatcharr's data and the existing memory limits (up to seven days).
- Open Guide playback in a dedicated view. Stop keeps the player ready to restart;
  Back stops playback and restores discovery. Search playback also restores results.
- Show channel logos, group conflicting listings into one channel row, include
  Up next descriptions, and shorten redundant airing timestamps.
- Connect optional DVR through supported Dispatcharr HTTP APIs: browse completed
  recordings, play/download or open in VLC, schedule exact guide airings, and
  manage scheduled/active recordings according to account permissions.
- Configure a server-side master API key or per-user keys; viewer credentials and
  Dispatcharr keys stay off browser-facing media URLs. No database, transcoder,
  or additional container is required.

### Validation and limits

The maintainer approved production publication after development feedback and
QA deployment. Automated coverage includes DVR permissions and exact-airing
validation, bounded guide loading, overlapping listings, and playback navigation.
Release CI and exact published-image verification are recorded on GitHub.
This approval does not assert that every manual account/device or concurrent-viewer
scenario was independently repeated on the published image.

Linux AMD64 remains the validated container target. Playback depends on codecs
and device support. DVR recordings are shared Dispatcharr resources. Growing-file
playback, recurring recording rules, pause-live TV, and saved resume positions
remain outside scope. Search still covers 24 hours.
[Issue #11](https://github.com/JermZone/watch-now/issues/11) is not claimed fixed.

### Upgrade

Keep your current Compose service name, port, upstream URL, proxy settings, and
secret mounts. Replace the image with the verified 1.2.0 tag/digest and pull it;
remove a local-QA `pull_policy: never` if present. Optional DVR needs the API-key
configuration in [DVR](docs/dvr.md). No data migration is needed; restarting ends
in-memory sessions. Keep the prior image and Compose settings for rollback.

## 1.1.0 — historical preparation notes

Adds Live TV VLC handoff and brings together the reviewed changes since 1.0.0.
Version metadata is not an announcement that an image is available. Install only
after the published release provides the matching image digest and assets.

### Highlights

- Add a VLC action to Live TV's Watch options. Supported Apple mobile devices use Open in VLC; desktop devices download a temporary playlist. During browser playback, show a plain Stop button matching Movies and Series; stopping restores Watch options.
- Live handoffs use the existing short-lived links, recheck the viewer's current channel access, and stop the browser relay when external playback begins.
- The maintainer confirmed Live TV VLC playback/casting and Movie/Series casting on the development candidates. See [QA evidence](docs/live-tv-vlc-qa.md) for the tested commits and remaining limits. Choose the cast device inside VLC; automatic casting is not included.

### Maintenance and packaging

- Include reviewed React, playback-library, frontend-tooling, and pinned CI action updates already merged into main. The live track guard and container license notices were adapted for mpegts.js 1.8.2.
- Provide a versioned installation ZIP alongside source, image digest, and checksum assets. GitHub's aggregate asset download counts can indicate adoption; Watch Now still contains no application telemetry.
- Provide tested, commit-labeled development images and separate test-stack instructions for future feature work.

### Validation and limits

The maintainer approved the Live TV feature after testing the separate QA
candidates. Integration on main passed Go tests/vet/race, all 150 frontend tests,
audits, Compose/release checks, the Docker build, and the HIGH/CRITICAL image scan.
Exact device/OS/VLC versions, a measured sustained-playback duration, and independent
concurrent upstream counts were not supplied. Results apply to the recorded
candidates; checks on a final published 1.1.0 image remain pending.

[Issue #11](https://github.com/JermZone/watch-now/issues/11), the reported
unresponsive Watch button after signing out/in, remains unresolved. This release
does not claim a fix. Linux AMD64 remains the container target. Codecs, VLC/device
support, and network reachability determine playback/casting compatibility;
there is no transcoding or automatic cast-device selection.

### Upgrade

Keep the existing stack/service name, port, upstream URL, and proxy settings when
changing only the image to the verified 1.1.0 tag/digest. No database migration
is needed. Restarting ends in-memory sessions, so viewers must sign in again.
Retain the prior digest/configuration for rollback. See
[installation](docs/installation.md) and
[1.1.0 release preparation](docs/release-readiness-1.1.0.md).

## 1.0.0

*A web player for Dispatcharr.*

Release notes for the first stable Watch Now version. The published
[GitHub Release](https://github.com/JermZone/watch-now/releases/tag/v1.0.0)
contains the matching source asset, checksums, and verified image digest.

### Highlights

- Live TV browsing, channel search, and current/upcoming show search when a usable viewer-specific guide is available.
- Movies and Series with browser playback for supported formats, downloads, and optional VLC handoff.
- A compact interface for phones, tablets, and desktops, with Blue and Green appearance options.
- Viewer access supplied by an existing Dispatcharr XC account, without exposing the administration interface through the viewer.
- One non-root Go/React container, with in-memory sessions and no database or transcoder.
- Consistent Watch Now executable, package, image, and source names, with Docker Compose and Portainer instructions.

Watch Now supplies no channels, subscriptions, or media. It is independent and
is not affiliated with or endorsed by Dispatcharr or VideoLAN.

### Requirements and limits

The initial container target is **Linux AMD64**. Dispatcharr **0.31.0** is the
recorded development baseline, not a version whitelist. ARM64 is not validated.
Use an existing XC viewer account and a Dispatcharr endpoint reachable from the
container; do not put viewer passwords in Compose files or URLs.

Browser playback depends on the media container and codecs. Unsupported formats
may need VLC, installed separately; audio can remain silent when unsupported.
Watch Now does not transcode or guarantee every stream will play in every browser.
Media metadata is shown only when supplied by XC; missing resolution is not guessed.
VLC links are temporary, and restarting the app ends its in-memory sessions.

### Known issue

[Issue #11](https://github.com/JermZone/watch-now/issues/11): Watch has been
reported to become unresponsive after signing out and back in. Investigation is
deferred. No root cause, fix, or reliable workaround has been verified. The issue
remains open; neither the name change nor the 1.0.0 version metadata resolves it.

### Validation scope

Earlier feature/playback checks are retained as development evidence. The
maintainer separately confirmed a healthy rc.3 source-built test container,
successful sign-in, and the correct About version. The full playback checklist
was not repeated for the subsequent naming, documentation, and version changes.

Automated checks and final-image distribution checks are recorded against their
actual commit and image digest. See [release readiness](docs/release-readiness.md)
for the evidence and validation limits.

### Installing and upgrading

Use the [installation guide](docs/installation.md) and only a tag or digest that
appears in a published release. The new image namespace is
`ghcr.io/jermzone/watch-now`; its `latest` is reserved for verified stable releases,
not drafts or release candidates.

Existing users should read [migration](docs/migration.md). Keep the previous image
digest and configuration for rollback. Preserve an existing Compose project and
service name when changing only its image; copying the new service name over an
old stack can create a second service and a port conflict. No database migration
is required, but viewers must sign in after a restart.

The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a separate,
unchanged historical image. Its Git history is not part of this clean repository;
the relevant handover identifiers are preserved in [source provenance](PROVENANCE.md).
Licenses and third-party notices remain retained.

## Preparation history

The imported `1.0.0-rc.3` snapshot aligned package names, removed household-specific
tooling from the clean source snapshot, preserved session tests and runtime settings,
and added stable-only release-promotion checks. The 1.0.0 preparation changed only
version metadata and documentation; no new playback fix or dependency upgrade was
included.

## Verified distribution

Published image:
`ghcr.io/jermzone/watch-now@sha256:3db3b5f3655eed2579797800aeb965b69081c161271bbd577b61fc7f73dd7bc5`

The release workflow passed its tests, build, and pre-publication candidate scan.
The maintainer verified anonymous download, Linux AMD64/version/source labels, and
healthy startup of the published image on an isolated stack. The published-release
promotion workflow then verified the checksummed digest and promoted that exact
image to `latest`.

Earlier playback results are retained; the full feature checklist was not repeated
on this image. The deferred Watch-button issue remains open.
