# Source provenance and attribution

Watch Now continues the earlier Dispatcharr Now development project. The clean
Git history is a packaging decision, not a claim that the software has no prior
contributors or development history.

## Verified source handover

The development repository is now
[JermZone/watch-now-legacy](https://github.com/JermZone/watch-now-legacy)
(repository ID `1380280253`). It retains the earlier commits, issues, pull
requests, tags, and releases. It has not been deleted or placed into GitHub's
read-only archived state by this handover.

The clean repository is [JermZone/watch-now](https://github.com/JermZone/watch-now)
(repository ID `1401082098`), created initially as `watch-now-launch` and renamed
after the source import. It remains private during release preparation.

The source chain is:

- Preparation baseline: [ce1f08ca54166bc1764d7034d3ab5afb5b32a89c](https://github.com/JermZone/watch-now-legacy/commit/ce1f08ca54166bc1764d7034d3ab5afb5b32a89c), including the rebrand and repeated-session tests from [legacy PR #34](https://github.com/JermZone/watch-now-legacy/pull/34).
- Reviewed package-cleanup snapshot: [898a865916e47ebb4f636077fe92acc50a07a3b4](https://github.com/JermZone/watch-now-legacy/commit/898a865916e47ebb4f636077fe92acc50a07a3b4), merged through [legacy PR #37](https://github.com/JermZone/watch-now-legacy/pull/37).
- Clean initial commit: [f9851be69e2e33cac9a6316980abb640fb2abb61](https://github.com/JermZone/watch-now/commit/f9851be69e2e33cac9a6316980abb640fb2abb61), with no parent commits.
- The reviewed snapshot and clean initial commit both have Git tree `bc68741ef8576263ffa30f431426ec046c82b9f6`. Their tracked files and modes match exactly; the old Git history and local test settings were not imported.
- Imported candidate version: `1.0.0-rc.3`. This is not a stable-release or image-publication claim. Later documentation and release-preparation commits build on that initial commit normally.

## Attribution and retained records

The existing [LICENSE](LICENSE), code copyright headers, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) were imported unchanged and remain
in force. Contributor history remains available in the legacy repository; the
single initial commit does not replace those credits or license obligations.

The earlier beta's source and installation files remain at the
[legacy v1.0.2 tag](https://github.com/JermZone/watch-now-legacy/tree/v1.0.2).
Historical issue, pull-request, commit, and release links must use the legacy
address rather than relying on the reused `watch-now` name to redirect them.

The deferred Watch-button report is carried forward as
[current issue #11](https://github.com/JermZone/watch-now/issues/11), linked to
[legacy issue #35](https://github.com/JermZone/watch-now-legacy/issues/35).
The source handover does not resolve it. See [migration](docs/migration.md) and
[release readiness](docs/release-readiness.md) for the separate image/release work.
