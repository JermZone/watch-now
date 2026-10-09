# Maintainer release procedure

This procedure applies to the stable **1.5.1** release for the iPhone recording-menu fix.
The maintainer accepted the QA candidate and authorized a stable release directly.
The [1.5.1 preparation record](release-readiness-1.5.1.md) preserves evidence and
release gates. Use the [published release records](https://github.com/JermZone/watch-now/releases)
for actual distribution status; source metadata alone does not establish availability.
Production deployment follows the verified release and remains user-managed.

Published tags, images, and assets are immutable. Do not replace a version to fix
it. The new registry path is `ghcr.io/jermzone/watch-now`; old images stay untouched.

## Prepare

Update the frontend package/lock metadata, both image-only Compose defaults, source
Compose build argument, and `.env.example` together. The Makefile/CI read the
package version instead of hard-coding one. For 1.5.1 the maintainer requested a
stable version directly: use unique commit-labelled QA images without
publishing an RC. The workflow also supports `-rc.N` for releases that choose
public candidates; changes to a published candidate require a new candidate.
Published versions are immutable.

Run all CI checks, including release-consistency and promotion tests. Read the diff
and license/source notices. Keep stable release approval separate from green CI.
Use the evidence policy in [release readiness](release-readiness.md): retain the
maintainer's earlier feature tests and completed source-install check without
presenting them as newly repeated tests of a registry image.

Finalize the README, installation wording, and [release notes](../RELEASE_NOTES.md)
before creating the release tag. Include all linked customer guides in the
installation ZIP and check its relative links; do not ship a DVR guide linking
to a missing recording guide. Keep publication status conditional on the actual
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
triggering it. Review the authored release notes and include the verified digest
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

## Interrupted publication

The workflow checks that the GitHub release and versioned registry image are
absent before publication and checks again immediately before the image push.
It never replaces release assets. It checks the extracted installation ZIP and
scans the exact published digest before creating the GitHub release; latest
promotion repeats that image scan.

If an image was published before a later step failed, its version is consumed.
Keep that image and digest intact. Correct the failure and prepare a new version;
do not rerun publication to overwrite the existing version. A failed release
run does not promote latest.

Linux AMD64 is the initial target. ARM64 must be built/tested before advertising it.
