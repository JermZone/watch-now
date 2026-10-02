# Version-1 release readiness

Target: **Watch Now 1.0.0**, a new repository/package version line. Preparation:
**1.0.0-rc.3**. Status: **not approved for stable publication**.

## Automated review

- [ ] Complete Go tests, vet, race tests, frontend tests/build, workflow lint,
      dependency checks, Compose tests, and container security scan on this source.
- [ ] Review the entire candidate diff, version metadata, dependency lock, licenses,
      attribution, source links, and preservation of the session regression tests.
- [ ] Confirm release publishing stays disabled until the target repository is approved.

## Installation and playback review

- [ ] Fresh Docker Compose install using only public instructions and sample config.
- [ ] Fresh Portainer install; include supported Synology behavior.
- [ ] Anonymous pull of the exact new GHCR image; record digest and image labels.
- [ ] Desktop and supported mobile checks: sign-in/out, Live TV, Movies, episodes,
      Watch/Stop, seeking, unsupported-codec handling, VLC handoff, and downloads.
- [ ] Restricted/revoked viewer access and HTTPS proxy/security behavior.
- [ ] Update and rollback on an isolated test stack without changing production.
- [ ] Verify screenshots against the final interface using synthetic data only.

## Deferred issue and final decision

The Watch-button report remains open. Its investigation is deferred at the
maintainer's request and does not block unrelated preparation work. The existing
synthetic tests do not establish its cause or a fix.

- [ ] Review the deferred report during final release approval. Record its actual
      disposition, known limitations, and any remaining risk. Do not silently mark
      it fixed or describe simulated tests as proof of real-browser behavior.
- [ ] Approve the final source snapshot, optional fresh-repository migration, and
      stable publication separately. Carry the open report into any new repository.

Record date, source commit, image digest, device/browser, results, and sanitized
evidence. Earlier development tests do not validate this candidate. CI results
belong on the preparation PR; real-installation results need their own evidence.

## Supported promise

Version 1 covers the documented viewer workflow and Linux AMD64 container.
Universal browser-codec support, transcoding, ARM64, and uptime guarantees are
not implied. Honest limitations do not all need to become new features for 1.0.

## Publication order

Finish and review the candidate, approve the snapshot and repository handover,
re-run CI in the final repository, then build and test the exact versioned image.
Publish stable assets only after approval; promote that digest to the new
`latest` and verify its anonymous pull before announcing. See [releases](releases.md).
