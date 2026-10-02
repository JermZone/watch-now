# Version-1 release readiness

Watch Now **1.0.0** is published. This file records the evidence and limits of that
release rather than serving as a pending-launch checklist.

## Source and CI evidence

- Clean initial commit:
  [f9851be69e2e33cac9a6316980abb640fb2abb61](https://github.com/JermZone/watch-now/commit/f9851be69e2e33cac9a6316980abb640fb2abb61).
- Stable 1.0.0 source/tag commit:
  [a6a9e8c299eb77d57b5506142d052dff35d45820](https://github.com/JermZone/watch-now/commit/a6a9e8c299eb77d57b5506142d052dff35d45820).
- The imported reviewed snapshot and clean initial commit shared Git tree
  `bc68741ef8576263ffa30f431426ec046c82b9f6`.
- New-repository CI passed on the clean initial import.
- PR #13 CI passed on the final 1.0.0 preparation, including Go tests/vet/race,
  vulnerability and workflow checks, frontend tests/audit/build, Compose and
  release-consistency checks, Docker build, and container security scan.
- Main CI also passed after PR #13 merged.
- Release workflow
  [36970121918](https://github.com/JermZone/watch-now/actions/runs/36970121918)
  completed successfully for tag `v1.0.0`.
- Published-release promotion workflow
  [37023153521](https://github.com/JermZone/watch-now/actions/runs/37023153521)
  verified the published assets/checksummed digest and promoted the exact image
  to `latest`.

The former development repository is not required by this evidence record.
Pre-import identifiers that matter to source provenance are preserved in
[PROVENANCE.md](../PROVENANCE.md).

## Distribution evidence

Published and tested image:

`ghcr.io/jermzone/watch-now@sha256:3db3b5f3655eed2579797800aeb965b69081c161271bbd577b61fc7f73dd7bc5`

The maintainer verified:

- anonymous pull using a temporary Docker configuration without saved registry
  credentials;
- Linux AMD64, version `1.0.0`, and source revision
  `a6a9e8c299eb77d57b5506142d052dff35d45820`;
- healthy startup of that digest in a separate image-only Compose stack;
- release-manifest checksums for `watch-now-1.0.0.tar.gz`,
  `image-digest.txt`, and `SHA256SUMS`;
- the source archive reconstructed to the reviewed tagged source tree; and
- stable `latest` promotion succeeded against the same checksummed digest.

The release workflow records a successful pre-publication candidate scan. No
separate claim is made that an independently rebuilt post-publication image scan
was performed after registry publication.

## Reused testing and limits

The maintainer had recently completed feature/playback testing and chose not to
repeat the entire checklist for naming, packaging, documentation, and version
changes. Playback, seeking, VLC, downloads, device compatibility, and
restricted-viewer checks were therefore **not freshly repeated on the final
1.0.0 image**.

The maintainer did separately confirm a source-built rc.3 test container was
healthy, accepted sign-in, and displayed the correct name/version. The final
published image then passed the targeted distribution/startup checks described
above.

The unresolved Watch-button report remains
[issue #11](https://github.com/JermZone/watch-now/issues/11). A passing simulated
session test does not resolve that browser failure.

## Supported promise

Version 1 covers the documented viewer workflow and Linux AMD64 container.
Universal browser-codec support, transcoding, ARM64, and uptime guarantees are
not implied.

See [releases](releases.md), [migration](migration.md), and
[source provenance](../PROVENANCE.md).
