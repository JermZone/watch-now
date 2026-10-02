# Watch Now release notes

## 1.0.0

*A web player for Dispatcharr.*

Release notes for the first Watch Now version line. See
[GitHub Releases](https://github.com/JermZone/watch-now/releases) for publication
status, matching source assets, checksums, and the verified image digest.
Preparing these notes does not publish a release or update an installed container.

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

Automated checks and final-image distribution checks must be recorded against
their actual commit and image digest. See [release readiness](docs/release-readiness.md)
for the evidence and outstanding publication steps; these notes alone are not a
claim that the final registry image has been tested or published.

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

The earlier `dispatcharr-now:1.0.2` beta and its historical releases remain
separate and unchanged in [watch-now-legacy](https://github.com/JermZone/watch-now-legacy).
Licenses, notices, and [source provenance](PROVENANCE.md) are retained.

## Preparation history

The imported `1.0.0-rc.3` snapshot aligned package names, removed household-specific
tooling from the new source snapshot, preserved session tests and runtime settings,
and added stable-only release-promotion checks. The 1.0.0 preparation changes only
version metadata and documentation; no new playback fix or dependency upgrade is
included.
