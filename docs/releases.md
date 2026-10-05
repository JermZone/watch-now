# Maintainer release procedure

Version **1.2.1 is prepared but not published** for the desktop layout and Guide
loading candidate. The maintainer requested QA-to-production promotion on
2026-10-05 and will update Nebula Compose after image verification. Follow the
review, tagged release, exact-image verification, and latest-promotion steps below.

Watch Now **1.2.0 is published**. Its
[release record](https://github.com/JermZone/watch-now/releases/tag/v1.2.0)
contains distribution verification and stable-promotion evidence. The clean
source-repository handover is complete; 1.0.0's evidence remains in
[release readiness](release-readiness.md), and the
[1.1.0 preparation record](release-readiness-1.1.0.md) is historical.
Use the procedure below for future releases. Version metadata and release notes
alone do not approve stable publication or establish that a registry image exists.
The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a separate historical image;
do not replace or relabel that historical release.

Published tags, images, and assets are immutable. Do not replace a version to fix
it. The new registry path is `ghcr.io/jermzone/watch-now`; old images stay untouched.

## Prepare

Update the frontend package/lock metadata, both image-only Compose defaults, source
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
workflow tests, builds an AMD64 image, scans it, publishes the versioned image,
uploads a release manifest, and creates the GitHub release with its assets. The
release build does not itself move latest; verify distribution before promotion.
Review the pushed image's digest, SBOM/provenance, and source/version labels. The
pipeline builds a scan candidate and a provenance-enabled published image separately;
verify the exact published image too rather than inferring byte identity from the
candidate scan. Check anonymous pull, healthy startup, and version/source labels
using the image-only public installation route on an isolated stack. Repeat
functional testing where subsequent runtime changes or failures justify it.

## Publish

Download the workflow's `release-manifest`: `watch-now-VERSION.tar.gz`,
`watch-now-VERSION-install.zip`, `image-digest.txt`, and `SHA256SUMS`. Verify
source/digest checksums. Preserve the previous image/configuration for rollback.
Confirm GHCR package visibility is
Public and private vulnerability reporting is available in the new repository.

The tag-triggered workflow creates an RC release as a prerelease and a stable
release as stable, with the exact manifest assets. Approve the version/tag before
triggering it. Review the generated release notes and include the verified digest
and actual check results; retain the known issue and limitations from the prepared
release notes, and keep unrun checks
explicit. Any source change after a tag needs a new version/candidate and revalidation.

Only the newest published **stable** semantic version can become `latest`. The
promotion script rejects drafts, missing/non-boolean release flags, prereleases,
prerelease version suffixes, older versions, wrong registry/archive names, bad
checksums, and versions without a successful tagged release workflow. The workflow
copies the selected registry manifest and verifies its digest; it does not rebuild.

Confirm anonymous `latest` pull equals the tested stable digest before announcing.
For recovery, run promotion manually on `main` using the published stable tag.
Never promote an RC just to make the `latest` instructions work.

The release workflow creates releases using `GITHUB_TOKEN`. Those release events
do not start another workflow under [GitHub's token event rules](https://docs.github.com/en/actions/concepts/security/github_token).
Run the existing manual promotion action after the release build and exact-image
verification; do not assume automatic promotion occurred.

Linux AMD64 is the initial target. ARM64 must be built/tested before advertising it.
