# Watch Now 1.5.0 release preparation

The maintainer accepted the QA deployment and authorized stable publication on
2026-10-09. This is preparation evidence; actual CI, release image/digest,
installation and latest-promotion results belong on the release PR and GitHub
release. Publication is not established by source metadata.

## Accepted source and scope

The QA candidate is commit `414bde256a4e422a554cb9b0be2514001d51970d`, based on
public 1.4.0 commit `97b4ff588d6f6fdadad262b1cbc09843ac0bca63`.
QA version: `qa-active-vlc-414bde2`; image identity:
`sha256:9c658190477424c8839077e033169260afc84aea7bf2d69f73e049793fa0ce5b`.

This release adds authenticated active-recording HLS playback for VLC,
beginning/live choices in DVR and Live TV Browse/Search, a separate manager-only
recording menu with confirmations, and native browser startup correction for
beginning selection on iPhone. Release preparation changes documentation, version metadata and CI image
retrieval only; runtime code matches the accepted candidate. After Docker Hub
rate limits blocked main CI, CI/release builds were configured to try the public
Docker Hub mirror while retaining every pinned Dockerfile image digest.
No dependency upgrade, new service, transcoding, persistent session/catalog,
Dispatcharr database/filesystem access or production deployment is included.

## Evidence and limits

- 493 frontend tests, Go tests/vet, frontend/container builds and whitespace checks
  passed for the QA source. Earlier HTTP/VLC race checks also passed.
- Automated fixtures exercise beginning/live choices, native readiness timing,
  cookie-free HLS requests, local segment rewriting, range probes, bounded relay,
  revocation, permissions and session isolation.
- QA deployment preserved configuration and sharing-key bytes, verified exact
  transferred image identity, and passed liveness/readiness, protected-route denial,
  invalid VLC-token rejection and served frontend/version checks.
- Maintainer reports cover desktop/iPhone VLC, desktop browser beginning selection,
  the iPhone browser fix and the recording menu. The maintainer subsequently
  accepted the QA deployment. Exact OS/browser/VLC versions were not recorded.

These reports do not assert all device/account/casting cases or fresh household
playback testing of the public registry image. Extended pause/reconnect through
completion and casting remain incompletely measured. Preserve those limits rather
than treating older browser tests or synthetic layout captures as new device tests.

## Publication gates

1. Required public PR and main CI, race tests, dependency audits, release/Compose
   consistency, packaged-link tests and candidate scan pass.
2. The reviewed source and package version match an annotated `v1.5.0` tag.
3. The tagged workflow succeeds. Verify exact source/install assets and checksums,
   anonymous versioned pull, AMD64 source/version labels, SBOM/provenance, independent
   exact-image scan, hardened startup, sharing persistence and upgrade preservation.
4. Promote only that verified stable digest to latest and check identity. Keep
   production upgrade separate and retain the prior image/configuration for rollback.

A runtime fix after acceptance requires a new candidate and targeted retesting.
Stable tags/images are immutable. No public RC is required for this release.

## Upgrade and known limits

Existing DVR users need no configuration change or database migration. Preserve
service/project names, ports, upstream/proxy settings, secret mounts and sharing
keys/volume. Recreation ends in-memory sessions and temporary playback links.
Dispatcharr 0.32.0 is the active-recording baseline, not a version whitelist.

VLC keeps the retained HLS timeline through completion. If its temporary segments
are cleaned up after a long pause/disconnect, reopen the finished recording and
seek manually. No automatic external HLS-to-file position transfer is promised.
Download/sharing require playable finished recordings. No saved resume, uncaptured
start-over, recurring rules or backend connection-accounting fix is added.
Linux AMD64, container/codec limits, deferred home-screen PiP and open
[issue #11](https://github.com/JermZone/watch-now/issues/11) remain unchanged.
