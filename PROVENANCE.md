# Source provenance and attribution

Watch Now continues an earlier development project that used the Dispatcharr Now
name. The clean Git history is a packaging and publication decision, not a claim
that the software had no development history before this repository.

## Verified source handover

The canonical public repository is
[JermZone/watch-now](https://github.com/JermZone/watch-now)
(repository ID `1401082098`).

The source handover used these recorded identifiers:

- Pre-import preparation baseline: commit
  `ce1f08ca54166bc1764d7034d3ab5afb5b32a89c` in the former development
  repository.
- Reviewed package-cleanup snapshot: commit
  `898a865916e47ebb4f636077fe92acc50a07a3b4` in the former development
  repository.
- Clean initial commit:
  [f9851be69e2e33cac9a6316980abb640fb2abb61](https://github.com/JermZone/watch-now/commit/f9851be69e2e33cac9a6316980abb640fb2abb61).
- The reviewed snapshot and clean initial commit both had Git tree
  `bc68741ef8576263ffa30f431426ec046c82b9f6`. Their tracked files and modes
  matched exactly; the former repository's Git history and local test settings
  were not imported.
- Imported candidate version: `1.0.0-rc.3`. Stable 1.0.0 preparation then
  changed version metadata and documentation without adding a playback fix or
  dependency upgrade.
- Stable 1.0.0 source commit:
  [a6a9e8c299eb77d57b5506142d052dff35d45820](https://github.com/JermZone/watch-now/commit/a6a9e8c299eb77d57b5506142d052dff35d45820).

The former development repository is not required to reproduce, install, verify,
or support the current release. The identifiers above preserve the handover facts
that matter to this repository without depending on that repository remaining
online.

## Attribution and retained records

The existing [LICENSE](LICENSE), code copyright headers, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) were imported unchanged and
remain in force. The clean initial commit does not replace contributor credits or
license obligations represented by those retained files and source headers.

The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a separate
historical image. It is not overwritten or promoted by Watch Now's release
workflow.

The deferred Watch-button report is carried forward as
[current issue #11](https://github.com/JermZone/watch-now/issues/11). Its current
issue body preserves the report context and retained repeated-session test
evidence needed for future investigation.

See [migration](docs/migration.md), [release readiness](docs/release-readiness.md),
and the [1.0.0 release](https://github.com/JermZone/watch-now/releases/tag/v1.0.0)
for the current installation and validation record.
