# Maintainer release procedure

Read [release readiness](release-readiness.md) before publishing. The clean
source-repository handover is complete. The source is prepared for **1.0.0** from
the imported **1.0.0-rc.3** snapshot. Version metadata and release notes do not
approve stable publication or establish that a registry image exists.
The earlier v1.0.2 remains in [watch-now-legacy](https://github.com/JermZone/watch-now-legacy/releases/tag/v1.0.2);
do not replace or relabel that historical release.

Published tags, images, and assets are immutable. Do not replace a version to fix
it. The new registry path is `ghcr.io/jermzone/watch-now`; old images stay untouched.

## Prepare

Update the root package/lock metadata, both image-only Compose defaults, source
Compose build argument, and `.env.example` together. The Makefile/CI read the
package version instead of hard-coding one. Use `-rc.N` during testing and a new
candidate number after changing a tagged/published candidate. The imported rc.3
snapshot was not tagged or published by the source handover. The workflow accepts
stable and `-rc.N` tags.

Run all CI checks, including release-consistency and promotion tests. Read the diff
and license/source notices. Keep stable release approval separate from green CI.
Use the evidence policy in [release readiness](release-readiness.md): retain the
maintainer's earlier feature tests and completed source-install check without
presenting them as newly repeated tests of a registry image.

Finalize the README, installation wording, and [release notes](../RELEASE_NOTES.md)
before creating the release tag. Keep publication status conditional on the actual
GitHub release and verified image; do not claim a build or pull passed in advance.
Record later CI and distribution results in the release PR and release record so
the tagged source does not need rewriting to add evidence.

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
candidate scan. Check anonymous pull, healthy startup, and version/source labels
using the image-only public installation route on an isolated stack. Repeat
functional testing where subsequent runtime changes or failures justify it.

## Publish

Download the workflow's `release-manifest`: `watch-now-VERSION.tar.gz`,
`image-digest.txt`, and `SHA256SUMS`. Verify source/digest checksums. Preserve the
previous image/configuration for rollback. Confirm GHCR package visibility is
Public and private vulnerability reporting is available in the new repository.

Publish an RC as a prerelease, never as stable. Once the stable source/image is
approved, publish the stable GitHub release with the exact manifest assets and
honest notes. Include the verified digest and actual check results, retain the
known issue and limitations from the prepared release notes, and keep unrun checks
explicit. Any source change after a tag needs a new version/candidate and revalidation.

Only the newest published **stable** semantic version can become `latest`. The
promotion script rejects drafts, missing/non-boolean release flags, prereleases,
prerelease version suffixes, older versions, wrong registry/archive names, bad
checksums, and versions without a successful tagged release workflow. The workflow
copies the selected registry manifest and verifies its digest; it does not rebuild.

Confirm anonymous `latest` pull equals the tested stable digest before announcing.
For recovery, run promotion manually on `main` using the published stable tag.
Never promote an RC just to make the `latest` instructions work.

Linux AMD64 is the initial target. ARM64 must be built/tested before advertising it.
