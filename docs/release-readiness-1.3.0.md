# Watch Now 1.3.0 release preparation

The maintainer confirmed Docky QA on 2026-10-06 and explicitly requested GitHub
publication. Nebula deployment remains the maintainer's separate image update.

## Source and scope

- Accepted QA revision: `0165850e354a617decb5bbf5327c33e6a8393fca`.
- Matching feature tree: `59cce6c579db30c60d7f8789ff4d484c348f5565`.
- Public baseline: v1.2.1, `ef7f712806128064b2dabeface2e97d08e79973c`.
- Adds encrypted share links, per-tab navigation restoration, focused playback
  across Live TV/Movies/Series/DVR and DVR logos.
- Release preparation changes metadata, public documentation and install packaging.
  Application code matches the accepted QA source. No backend session/media/
  connection-accounting fixes are added.
- Separate security PR #29 patches the transitive build dependency source-map-js
  from 1.2.1 to 1.2.2 after release CI reported GHSA-68fv-2mgg-jv7q. This prerequisite
  receives its own CI and review before release.

Retained feature evidence includes 209 frontend tests, Go tests/vet, builds,
Compose checks and 96 synthetic playback layout cases. The maintainer confirmed
QA acceptance; no full device matrix on the later published image is inferred.

## Publication gates

1. Required GitHub PR CI passes, including race, audits, build and candidate scan.
2. Merge the reviewed release PR; require passing main CI.
3. Create annotated v1.3.0 on the approved merge commit.
4. Require successful tagged release workflow and verify checksummed source/install
   assets, anonymous registry access, version/revision labels, SBOM/provenance,
   isolated startup and an additional scan of the exact published image.
5. Promote that verified digest to latest and check manifest identity.

Record actual results on the release PR and GitHub release after each gate passes.
No release or registry image is claimed available by this preparation document.

## Upgrade and limitations

Sharing needs a dedicated persistent production key. Preserve runtime settings
and existing DVR secret mounts. No data migration is needed; restart ends
process-local sessions. Keep the previous image/configuration for rollback.
Linux AMD64 is the validated target. Playback depends on codecs and devices;
Watch Now does not transcode. Issue #11 remains open and deferred. See
[sharing](share-navigation.md), [QA](share-navigation-qa.md) and
[release notes](../RELEASE_NOTES.md).
