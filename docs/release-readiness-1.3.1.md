# Watch Now 1.3.1 release preparation

The maintainer tested sharing on Docky, confirmed it worked as expected, and
authorized GitHub publication on 2026-10-06. Nebula remains user-managed.

## Source and scope

- Accepted QA revision: `9300b7f29a6e7db2b10d4e496b7a7285d12c6f2c`.
- Exact matching GitHub feature tree: commit
  `fe81b2685a5f838b96989deec141c45bfec4a8ce`, tree
  `d8c95871aa034ddcbe69daafd096c5b61385b065`.
- Public baseline: v1.3.0, `e380f21b8ff8fcf9f47185596c3bc02e430bada8`.
- Automatic private sharing-key creation and retention in a named volume, existing
  key overrides, safe storage failure behavior and sharing status in About.
- Only the key persists. Sessions and catalogs remain in memory; runtime stays a
  single non-root Go process with a read-only root filesystem.
- Docky's existing key survived deliberate migration and container recreation.
- The first CI run found a Docker directory-permission packaging difference; the
  correction passed CI run 37518960925. Release preparation updates metadata and
  documentation; accepted application code remains unchanged.

Evidence includes 211 frontend tests, Go tests/vet/race, dependency audits,
Compose checks, hardened-container storage tests on Loki and GitHub, zero
HIGH/CRITICAL findings in the exact QA image and the maintainer's sharing test.
No fresh full-device playback matrix is inferred from this focused QA acceptance.

## Publication gates

1. Required release PR CI passes and the reviewed PR merges; main CI passes.
2. Annotated v1.3.1 matches the approved main commit and package version.
3. Tagged release workflow passes before distribution verification.
4. Verify checksummed source/install assets, anonymous pull, source/version labels,
   SBOM/provenance, isolated hardened startup and storage tests, and an independent
   scan of the exact published image.
5. Promote the verified stable digest to latest and verify manifest identity.

Record actual publication evidence on the PR and GitHub release. This preparation
document does not claim the release image has already been published.

## Upgrade

Use the release's complete Compose example for automatic sharing, or add its
named volume and `NOW_SHARE_KEY_DIR` to a custom stack. Preserve existing runtime
settings and DVR mounts. Keep explicit sharing keys to preserve old links; migrate
the same key deliberately before removing an override. Retain the volume across
updates and back it up privately. See [sharing](share-navigation.md).

Linux AMD64 remains the validated platform. Codec/device limits, lack of
transcoding and deferred [issue #11](https://github.com/JermZone/watch-now/issues/11)
remain unchanged. No session or connection-accounting fix is included.
