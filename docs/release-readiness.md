# Version-1 release readiness

Target: **Watch Now 1.0.0**, the new repository/package version line. Imported
preparation candidate: **1.0.0-rc.3**. Stable publication is still pending approval.

## Completed evidence

The reviewed legacy snapshot is
[898a865916e47ebb4f636077fe92acc50a07a3b4](https://github.com/JermZone/watch-now-legacy/commit/898a865916e47ebb4f636077fe92acc50a07a3b4).
The clean initial commit is
[f9851be69e2e33cac9a6316980abb640fb2abb61](https://github.com/JermZone/watch-now/commit/f9851be69e2e33cac9a6316980abb640fb2abb61).
Both have tree `bc68741ef8576263ffa30f431426ec046c82b9f6`.

- [x] The package-cleanup review and automated checks passed in [legacy PR #37](https://github.com/JermZone/watch-now-legacy/pull/37). Runtime changes were confined to the reviewed name/import substitutions; dependency versions, session tests, licenses, and notices were preserved.
- [x] The source was imported with a single parentless initial commit; the repositories were renamed and the two handover checkouts' remotes updated. Historical records remain in `watch-now-legacy`.
- [x] [New-repository CI run 36966365981](https://github.com/JermZone/watch-now/actions/runs/36966365981) passed on the clean initial commit, completing on October 2, 2026 (UTC). It covered Go tests/vet/race, vulnerability and workflow checks, frontend tests/audit/build, Compose configuration checks, promotion/consistency tests, the Docker build, and the container scan.
- [x] The maintainer confirmed a separate rc.3 source-built Docker test stack was healthy, accepted sign-in, and displayed **Watch Now 1.0.0-rc.3**. No image digest was recorded for that local build.
- [x] The unresolved Watch-button report was carried forward as [issue #11](https://github.com/JermZone/watch-now/issues/11), with a link to [legacy issue #35](https://github.com/JermZone/watch-now-legacy/issues/35).

## Reusing earlier testing

The maintainer recently completed feature/playback testing and chose not to
repeat the full checklist for the naming, packaging, and documentation changes.
Retain that earlier evidence with its original scope. Playback, seeking, VLC,
downloads, device compatibility, and restricted-viewer checks were **not freshly
repeated on rc.3**. A passing simulated test does not resolve the reported
Watch-button failure or prove real browser/device playback.

A new registry image still needs distribution checks: a successful local source
build does not demonstrate anonymous registry access or the bytes served by a
published tag. Repeat targeted functional checks only where a subsequent change
or failure justifies them; do not restart the whole feature checklist for this
source-reference cleanup. No fresh Portainer/Synology install or production
upgrade/rollback is claimed by the source-build result.

## Remaining before announcement

- [ ] Prepare and review the final 1.0.0 source/version metadata and notes; run CI on that exact final commit.
- [ ] Verify the final repository's visibility, security-reporting path, and required repository/package permissions. Release/promotion workflows remain gated by `WATCH_NOW_RELEASE_ENABLED`; do not enable publishing accidentally.
- [ ] Approve the final source and release disposition, explicitly retaining the known issue and the limits of reused testing. Deferral is not a fix or a stable-release approval.
- [ ] Build the versioned image and record its exact digest, source/version/architecture labels, and successful security checks. Verify the published image rather than treating a separately built scan candidate as byte-identical.
- [ ] Verify anonymous pull and healthy startup from the public image-only instructions on an isolated stack. Retain earlier playback evidence rather than presenting it as a new-image test.
- [ ] Confirm public source and matching release assets/checksums, then publish and verify that stable-only `latest` resolves to the tested image digest.
- [ ] Preserve the old image/configuration rollback path. Do not change production or archive the legacy repository as a side effect of publishing.

## Supported promise

Version 1 covers the documented viewer workflow and Linux AMD64 container.
Universal browser-codec support, transcoding, ARM64, and uptime guarantees are
not implied. Limitations must be documented; not all require new features for 1.0.

See [releases](releases.md), [migration](migration.md), and
[source provenance](../PROVENANCE.md). Record results against their actual source
commit and image digest; do not relabel earlier evidence as a new test run.
