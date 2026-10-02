# Watch Now 1.1.0 release preparation

Status: prepared source, pending maintainer publication approval and distribution
validation. No 1.1.0 image digest or successful tagged release build is claimed.
The existing public installation and stable/latest registry tags are unchanged
by preparation.

## Source and validation

- The Live TV VLC feature merged through [PR #17](https://github.com/JermZone/watch-now/pull/17) at `66de0704f48c6d4142b0665c97ac9c7851d67a8f`.
- [Main CI 37068706129](https://github.com/JermZone/watch-now/actions/runs/37068706129) passed Go tests/vet/race, audits, 150 frontend tests, build, Compose/release checks, and the Docker build/security scan on that commit.
- [Live TV VLC QA evidence](live-tv-vlc-qa.md) records maintainer reports, candidate digests, approval, and unmeasured device checks.
- The version-preparation change updates package/lock metadata, Compose defaults, build version, installation wording, release notes, and the manual promotion tag default. It adds no playback code or dependency changes.
- Fresh checks and their commit/run identifiers are recorded on the release-preparation PR. A subsequent published-image check must be recorded separately.

The prepared source includes the dependency updates already merged into main.
The maintainer's VLC/casting QA used the recorded development candidates; it is
not presented as a fresh full-device repeat on the prepared 1.1.0 source or image.
The reported Watch-button problem, [issue #11](https://github.com/JermZone/watch-now/issues/11),
remains open.

## Publication sequence

1. Review and merge the release-preparation PR after its checks pass.
2. Create the new `v1.1.0` tag at the approved release commit. The enabled Release container workflow runs tests, builds/scans, publishes the versioned image, and creates the GitHub release with checksummed source/install/digest assets.
3. Verify the exact published image: anonymous access, Linux AMD64, version/revision labels, manifest/checksums, source archive, and isolated healthy startup. The scan candidate and provenance-enabled published image are separate builds; do not infer exact byte identity.
4. Run the existing Promote published release to latest workflow on main with `release_tag=v1.1.0` after the release build and distribution checks pass. Verify latest resolves to the same checked digest.
5. Update production only when the maintainer approves that deployment, retaining its prior digest and configuration for rollback.

Versioned images and release assets are immutable. Retain the 1.0.0 evidence in
[release readiness](release-readiness.md). See [maintainer release procedure](releases.md)
for details and [release notes](../RELEASE_NOTES.md) for the public change list.
