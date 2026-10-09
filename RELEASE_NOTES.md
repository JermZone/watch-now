# Watch Now release notes

## 1.5.0 — Active recording playback in VLC

Open recordings in VLC while they are still recording, with the same starting
choices as browser playback.

- Choose **Watch from Beginning** or **Watch Live** before opening an active
  recording in VLC from DVR or Live TV Browse/Search.
- Fix browser **Watch from Beginning** starting at the live point on iPhone.
- Move **Extend 30 minutes** and **Stop recording** into a separate
  **Recording options** menu, keeping confirmation prompts.

Beginning means the earliest captured footage. Closing VLC leaves recording
running. Without an active recording, Live TV VLC still opens the ordinary stream.

### Expectations and upgrade

If temporary segments become unavailable after completion or a long pause, reopen
the finished recording in VLC. Automatic transfer to the finished file with
position restoration is not supported. Download and recording sharing still
require a playable finished recording. See [active recording VLC](docs/active-recording-vlc.md).

No configuration changes or data migration are required for an existing DVR setup.
Preserve service names, ports, secrets and sharing storage; restarting signs viewers
out. Retain the previous image/configuration for rollback. Use the verified image
from this release after publication; production upgrade is a separate action.

Dispatcharr 0.32.0 is the validated active-recording baseline, with capabilities
checked rather than a version whitelist. Linux AMD64 remains the validated image
target. Codec/device limits, no transcoding, deferred home-screen PiP and
[issue #11](https://github.com/JermZone/watch-now/issues/11) remain unchanged.

### Validation

The accepted source passed 493 frontend tests, Go checks, frontend/container
builds and QA deployment checks. The maintainer reported working desktop/iPhone
VLC and confirmed the iPhone browser fix, then accepted the QA candidate.
These reports do not establish a complete device, casting or completion/pause
matrix on the public image. [Release preparation](docs/release-readiness-1.5.0.md)
records scope and remaining checks; verified distribution evidence is added to
the GitHub release after publication.

## 1.4.0 — Watch while recording and live pause

Watch Now 1.4.0 adds playback through active recordings and brings the recording
controls into Live TV, Search, Guide and DVR. Use
[GitHub Releases](https://github.com/JermZone/watch-now/releases) for publication
status, downloadable assets and verified image digests. The
[preparation record](docs/release-readiness-1.4.0.md) preserves source and feature evidence.

- Use **Watch & Record** on a current programme to start one capture and watch near
  its latest footage. Recording continues when playback stops or the viewer leaves.
- Open an existing capture with **Watch from Beginning** or **Watch Live** in
  Live TV and DVR. Pause, seek, skip fifteen seconds and Go Live within captured
  footage; Go Live deliberately resumes near the safe recorded edge.
- Keep the player and paused position through recording updates and finished-file
  recovery. A new capture waits for usable segments; temporary preparation
  failures retry without creating another recording.
- Show solid scheduled/active recording dots in Guide, with distinct accessible
  labels. Keep the Now Recording status in channel controls and playback.
- Align recording choices, manager Extend/Stop controls and the confirmed trash
  action; keep Details below player titles across Live, Movies, Series and DVR.
- Improve buffering feedback and include the Safari home-screen icon.

### Expectations and compatibility

Beginning means the earliest captured footage, not a missed part of the
broadcast. Live through a recording joins its safe edge, normally about twelve
seconds behind capture with stock segments. Ordinary Watch Live does not create
a retained buffer. Download, VLC and recording sharing remain finished-recording
actions; a live channel share does not identify a captured timestamp.

DVR view access permits watching an existing capture; manage access permits
recording actions. Current channel access still applies, and recordings are shared
Dispatcharr resources. Dispatcharr 0.32.0 is the validated active-recording
baseline; capability checks determine availability. Native Apple HLS and other
browser playback still depend on codecs. There is no transcoding or guarantee
that every finished MKV plays in every browser. Home-screen PiP remains deferred.

### Upgrade and validation

After publication and verification, select the verified 1.4.0 tag/digest.
Retain stack/service names, ports, upstream/proxy settings, DVR mounts and the
existing sharing key/volume. The supplied Compose retains its automatic key;
existing explicit overrides remain supported. No database migration is required.
Recreation signs viewers out. Keep the prior image/configuration for rollback.

The integrated source passed 478 frontend tests, Go tests/vet/race, the production
build, dependency checks and configuration checks. Earlier synthetic Chromium
playback and Details-layout scenarios passed. The maintainer reported real
iPhone playback through completion with pause and rewind working. These are
source and accepted feature checks, not claims of public CI or fresh testing of
the published image. Exact release evidence is recorded separately.

Linux AMD64 remains the validated target. No saved cross-session resume position,
catch-up for uncaptured broadcasts, recurring rules or connection-accounting fix
is added. [Issue #11](https://github.com/JermZone/watch-now/issues/11) remains deferred.

## 1.3.1 — Automatic persistent sharing setup

Published on 2026-10-06. See the
[release record](https://github.com/JermZone/watch-now/releases/tag/v1.3.1)
for distribution evidence. The maintainer tested sharing on Docky and authorized
publication; the retained preparation evidence below describes that candidate.

- The supplied Compose setup creates and retains a private sharing key
  automatically. Fresh installations can use Share link without generating or
  copying secrets.
- A small named Docker volume retains only this key. Existing explicit
  `NOW_SHARE_KEY` and `NOW_SHARE_KEY_FILE` settings take precedence and keep
  existing links valid.
- Unsafe, missing, unwritable or damaged automatic storage disables sharing while
  playback stays available. Existing damaged keys are never silently replaced.
- About shows sharing availability. Documentation covers custom stacks, backups
  and deliberate migration of an existing key.
- Package the private storage directory consistently across Docker builders, and
  require hardened-container storage tests in both CI and release workflows.

### Upgrade and validation

After publication and verification, select `ghcr.io/jermzone/watch-now:1.3.1`
or its exact digest. Use the complete release Compose example, or add its named
volume and `NOW_SHARE_KEY_DIR` to your custom stack. Retain service names, ports,
proxy/upstream settings and DVR mounts. Keep existing explicit sharing keys; do
not remove an override until the same key is deliberately migrated. Keep and
privately back up the volume: deleting it invalidates old links. See
[sharing](docs/share-navigation.md) and [installation](docs/installation.md).

The accepted QA image is `qa-auto-share-9300b7f`, revision
`9300b7f29a6e7db2b10d4e496b7a7285d12c6f2c`. Its feature tree exactly matches GitHub
commit `fe81b2685a5f838b96989deec141c45bfec4a8ce`. Evidence includes 211 frontend
tests, Go tests/vet/race, audits, Compose checks, fresh/persistent/private/read-only/
damaged storage tests and an independent QA image scan with zero HIGH/CRITICAL
findings. Docky's existing key survived migration and recreation; the maintainer
confirmed sharing worked. Release evidence is recorded separately after execution.

No database, persistent sessions, catalog storage, transcoding or backend
connection-accounting fix is added. Restart ends in-memory sessions. Retain the
previous image/configuration for rollback. Linux AMD64, codec/device limits and
deferred [issue #11](https://github.com/JermZone/watch-now/issues/11) remain.

## 1.3.0 — Sharing, restored navigation and focused playback

Published on 2026-10-06. See the
[release record](https://github.com/JermZone/watch-now/releases/tag/v1.3.0)
for verified distribution and stable-promotion evidence.

- Share short encrypted links to Live TV channels, movies, selected episodes and
  completed DVR recordings. Recipients sign in with their own accounts and retain
  their existing permissions. Links select content without automatic playback.
- Restore per-tab navigation after refresh, including filters, selected items and
  Guide/DVR state. Back/Forward restores navigation; sign-out clears saved state.
- Fit playback into the available viewport across Live TV, Movies, Series and DVR.
  Details open separately; Stop restores the selected item. Live TV can return to
  browsing and focus again while retaining the running stream.
- Show channel logos or initials on ordinary and shared DVR cards.
- Include the separately reviewed source-map-js 1.2.2 security patch for the
  transitive build dependency (GHSA-68fv-2mgg-jv7q).

### Upgrade and limits

Select the verified `ghcr.io/jermzone/watch-now:1.3.0` tag/digest after publication.
Keep service names, ports, upstream/proxy settings and existing DVR secret mounts.
Sharing requires a new, dedicated persistent production key; configure
`NOW_SHARE_KEY` or mount a file for `NOW_SHARE_KEY_FILE`, using one source only.
Preserve that key across recreations to keep links valid. See
[sharing](docs/share-navigation.md) and [installation](docs/installation.md).

No database or data migration is added; restart ends in-memory sessions. Retain
the previous image/configuration for rollback. Links do not grant access and are
installation-specific. No saved playback position, transcoding or backend
connection-accounting fix is introduced. Linux AMD64 remains the validated target;
codec/device limits and deferred [issue #11](https://github.com/JermZone/watch-now/issues/11) remain.

### Validation scope

The approved QA image was `qa-share-0165850`, revision
`0165850e354a617decb5bbf5327c33e6a8393fca`. Retained source evidence includes
209 frontend tests, Go tests/vet, Compose checks, builds and 96 synthetic browser
playback geometry cases. Those fixtures test layout/lifecycle, not upstream
decoding; Firefox Live TV was skipped in the temporary runtime for missing codec
support. The maintainer's QA acceptance does not specify a complete device matrix
or claim fresh full-device testing of the subsequently published image.

## 1.2.1 — Desktop scrolling and Guide loading

Use the [published release](https://github.com/JermZone/watch-now/releases/tag/v1.2.1)
for the verified digest and distribution evidence.

- Keep desktop navigation visible while channel, search, Guide, catalog, and DVR
  panes scroll within the viewport. Phone and touch-landscape layouts retain page scrolling.
- Fit the dedicated Guide video into the space below its controls and captions,
  including shorter desktop windows.
- Load Grid channels automatically on downward scroll, starting with 50 and adding
  10 at a time up to 500 per batch. Virtualized rows and the 10,000-airing bound
  remain in place; Next channels continues to a new batch. List loading is unchanged.

The maintainer requested production promotion of the Docky QA candidate on
2026-10-05. Existing automated component and synthetic browser layout tests cover
these changes. This request does not establish fresh full-device playback or
account-permission testing on a published image. See [desktop QA](docs/desktop-layout-qa.md).
Linux AMD64 remains the validated target; codec/device limits and
[issue #11](https://github.com/JermZone/watch-now/issues/11) remain unchanged.

For Nebula, preserve the current Compose service, ports, upstream/proxy settings,
and secret mounts. After publication and verification, select the verified 1.2.1
image digest, pull it, and recreate the service. Remove `pull_policy: never` if
inherited from local QA. Retain the previous image and configuration for rollback.
No data migration is needed; restarting ends in-memory sessions.

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
Version 1.1.0 was published on 2026-10-02. See its
[release record](https://github.com/JermZone/watch-now/releases/tag/v1.1.0)
for the image digest, assets, and distribution evidence. The preparation-time
validation scope below is retained as historical context.

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
candidates; final published-image checks were pending at preparation time.
Subsequent distribution evidence is recorded in the linked 1.1.0 release.

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
