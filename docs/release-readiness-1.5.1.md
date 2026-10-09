# Watch Now 1.5.1 release preparation

The maintainer confirmed the iPhone fix, accepted Docky QA, and authorized this
stable bug-fix release on 2026-10-09. Actual CI, publication and image-verification
results are recorded on the release PR and GitHub release after they complete.

## Accepted change

QA source: `c73dc687a013d38d6c7eef02c601b9394466c011`.
QA image: `watch-now:qa-iphone-recording-options-c73dc68`.
QA image identity: `sha256:70d5a81d9ea82d562228ffb30b08af648313c555e4cdc3c4dc33f7dac127cf9a`.

The Recording options menu no longer closes on focus changes that can occur
between a touch and its click. Outside pointer interactions still dismiss it;
Tab closes the menu and returns focus to its trigger before normal tab traversal.
Stop and Extend continue to require confirmation and existing permission checks.
No backend, playback, dependency or authentication behavior changes.

## Evidence

- The maintainer reported Stop recording failing to open confirmation on iPhone,
  confirmed the Loki candidate fixed it, and accepted the promoted Docky QA build.
- Modeled touch-focus event regression tests fail on the previous implementation
  and pass with the fix for Stop and Extend, including confirmation before mutation.
- All 495 frontend tests, Go tests/vet, frontend build and Docker build passed.
- QA health, protected routes, served assets, runtime configuration and persistent
  sharing-key preservation were verified; rollback remains available.
- The release preparation changes version metadata and documentation only after
  the accepted runtime fix. No complete device matrix or new public-image iPhone
  test is inferred from the QA report.

## Publication checks

Run release consistency, promotion, Compose and CI checks on the final source.
Publish the annotated version tag only after CI succeeds. Verify release asset
checksums, packaged documentation links, source identity, anonymous image access,
labels, SBOM/provenance and isolated startup. Scan the exact published image and
verify latest resolves to its digest after promotion. Production stays user-managed.

The [1.5.0 feature evidence](release-readiness-1.5.0.md) and its playback/device
limitations remain applicable. This patch does not change those capabilities.
