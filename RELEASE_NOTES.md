# Watch Now release notes

## 1.0.0 — planned; not released

A web player for Dispatcharr: Live TV, Movies, Series, viewer-specific permissions,
browser playback for supported formats, VLC handoff, and downloads.

This is the intended first stable release of a fresh Watch Now repository/package,
not a replacement of an old published version. The preparation source is
**1.0.0-rc.3**. This change does not publish an image, release, or `latest` tag.

## Preparation 1.0.0-rc.3

- Align the binary, Go module/imports, frontend package/lock, Compose examples,
  release assets, and image workflow names under Watch Now.
- Preserve the existing session regression tests, permissions, configuration names,
  browser preferences, and ports. No runtime dependency upgrade is included.
- Consolidate the installation documentation and new-user README; separate source
  testing from instructions for images that have not been published yet.
- Remove household deployment scripts and obsolete development records from the
  proposed public snapshot. Preserve old releases and history in their repository.
- Gate publishing behind explicit repository approval. Make the new `latest`
  stable-only, rejecting incomplete release state, bad manifests, and failed builds.

**Not fixed:** the reported Watch-button failure after signing out and back in.
Investigation is deferred, and the report must be reviewed at final release approval.

Historical development versions are not rewritten or relabeled. See
[source provenance](PROVENANCE.md), [migration](docs/migration.md), and
[release readiness](docs/release-readiness.md).
