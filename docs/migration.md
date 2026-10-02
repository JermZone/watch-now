# Fresh repository and existing-install migration

## Plan only — no migration performed

A fresh repository can start with a single reviewed source snapshot. Old commits,
branches, tags, releases, issues, PRs, and Actions history are not imported. Preserve
them in the existing repository; do not delete history to make the launch look clean.
This is optional: keeping the current repo and publishing a new unused version is
also valid. Reusing an existing published tag/image is not.

## Proposed clean-start sequence

1. Complete code/UI/docs cleanup and the [release checklist](release-readiness.md)
   on a preparation branch. Save the final commit/tree and a backup. Freeze changes
   during cutover. No tags are pushed as part of preparation.
2. With explicit approval, rename the existing repository to `watch-now-legacy`
   (after confirming that name is free). Record its actual URL and source commit in
   [PROVENANCE.md](../PROVENANCE.md). Keep its source, tags, releases, and attribution.
3. With explicit approval, create a new empty `JermZone/watch-now` and import only
   the reviewed source snapshot as its first commit, or generate from a template's
   default branch. Do not fork or mirror-push if a single-commit history is desired.
4. Recreate repository-specific settings: branch/tag protection, private vulnerability
   reporting, Actions permissions, required reviews, app connections, and GHCR access.
   Leave `WATCH_NOW_RELEASE_ENABLED` unset until the release workflow is approved.
5. Carry open issues, including the deferred Watch-button report, into the new
   repository with links to their original discussion. Update support/source links
   and known issue references. Verify old release/source
   links separately. Reusing `watch-now` intentionally replaces its previous redirect:
   old `/issues/33`, `/pull/33`, tag, and commit links at that path must not be assumed
   to reach the legacy repository. Publish an archive notice with the final links.
6. Pause old release automation; archive the legacy repo only after its references,
   package linkage, deployment needs, and open work have been checked. Keep both old
   source archives and old image digests available. Do not redirect old `latest` to
   a differently named/versioned product silently.
7. Clone the new repository into a separate folder. Do not point a history-bearing
   checkout at it and force-push. Retain the old folder as the legacy working copy.
8. Re-run CI and image checks in the final repo. The first stable tag there may be
   `v1.0.0`; the legacy repository's `v1.0.x` releases remain separate and immutable.

A new repository does not transfer the old issue/PR numbering or make unresolved
bugs go away. The final tag and image can be approved only after the checklist.

## Existing Docker/Portainer installation

Old package: `ghcr.io/jermzone/dispatcharr-now`.
Proposed new package: `ghcr.io/jermzone/watch-now` (not published by this preparation).

Do not change a working stack until the new image is public and verified. Save the
old image digest, Compose file, environment settings, project/service names, and
any custom network/reverse-proxy configuration.

For the least disruptive transition, keep the existing Compose project/service
name and change **only the image reference** to the tested new digest. The settings
and ports are retained. Sign-in is required after recreation. Verify login, repeated
logout/login, permissions, playback, and VLC before accepting the change. Roll back
by restoring the prior image/configuration. No persistent app data needs migration.

The clean Compose example names its service `watch-now`. Applying it over a stack
with service `dispatcharr-now` can create a second service/port conflict. Use it for
a fresh test stack, or deliberately retire the old service after saving rollback
information. Do not use broad prune or remove-orphans commands blindly.

The internal executable is now `/watch-now`; the image's healthcheck/entrypoint are
updated together. Review custom scripts that hard-code `/dispatcharr-now`. Old
household-specific scripts are deliberately absent from the public snapshot.

## Reference

- GitHub: https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template
- GitHub: https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- GitHub: https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories
- Versioning: https://semver.org/
