# Maintainer release procedure

Read [release readiness](release-readiness.md) before publishing. This preparation
is **1.0.0-rc.3**. Do not reset the existing development release line below its published v1.0.2.
The planned stable **1.0.0** belongs to the separately approved new repository/package.

Published tags, images, and assets are immutable. Do not replace a version to fix
it. The new registry path is `ghcr.io/jermzone/watch-now`; old images stay untouched.

## Prepare

Update the root package/lock metadata, both image-only Compose defaults, source
Compose build argument, and `.env.example` together. The Makefile/CI read the
package version instead of hard-coding one. Use `-rc.N` during testing and a new
candidate number for changed source. The workflow accepts stable and `-rc.N` tags.

Run all CI checks, including release-consistency and promotion tests. Read the diff
and license/source notices. Keep stable release approval separate from green CI.

## Build and validate

The release/promotion jobs are disabled unless the repository variable
`WATCH_NOW_RELEASE_ENABLED` is `true`. Enable it only in the approved target after
checking app/package permissions. This setting is not a substitute for review.

Push an annotated version tag only on reviewed source, matching package.json. The
workflow tests, builds an AMD64 image, scans it, publishes the versioned image, and
uploads a release manifest. It does not publish the GitHub release or move latest.
Review the pushed image's digest, SBOM/provenance, and source/version labels. The
pipeline builds a scan candidate and a provenance-enabled published image separately;
verify the exact published image too rather than inferring byte identity from the
candidate scan. Check anonymous pull, health, sign-in and real-device playback.

## Publish

Download the workflow's `release-manifest`: `watch-now-VERSION.tar.gz`,
`image-digest.txt`, and `SHA256SUMS`. Verify source/digest checksums. Preserve the
previous image/configuration for rollback. Confirm GHCR package visibility is
Public and private vulnerability reporting is available in the new repository.

Publish an RC as a prerelease, never as stable. Once the stable source/image is
approved, publish the stable GitHub release with the exact manifest assets and
honest notes. Refresh the README/release-readiness record before the final tag;
any source change after a tag needs a new version/candidate and revalidation.

Only the newest published **stable** semantic version can become `latest`. The
promotion script rejects drafts, missing/non-boolean release flags, prereleases,
prerelease version suffixes, older versions, wrong registry/archive names, bad
checksums, and versions without a successful tagged release workflow. The workflow
copies the selected registry manifest and verifies its digest; it does not rebuild.

Confirm anonymous `latest` pull equals the tested stable digest before announcing.
For recovery, run promotion manually on `main` using the published stable tag.
Never promote an RC just to make the `latest` instructions work.

Linux AMD64 is the initial target. ARM64 must be built/tested before advertising it.
