# Source-repository handover and existing-install migration

## Source handover completed; image migration still pending

The clean repository is now
[JermZone/watch-now](https://github.com/JermZone/watch-now)
(repository ID `1401082098`). It was initially created as private
`watch-now-launch`, populated from the reviewed source snapshot, and renamed to
its final name. It remains private during release preparation.

The previous development repository is preserved as
[JermZone/watch-now-legacy](https://github.com/JermZone/watch-now-legacy)
(repository ID `1380280253`). Its old commits, branches, tags, releases, issues,
pull requests, and Actions records were not imported into the new Git history.
The legacy repository has not been deleted or placed into GitHub's archived state.

[PROVENANCE.md](../PROVENANCE.md) records the exact source chain and matching tree.
The clean initial commit passed CI. The maintainer also confirmed healthy startup,
sign-in, and the name/version on a separate rc.3 source build; see
[release readiness](release-readiness.md) for limits and earlier testing evidence.

## Historical links and local checkouts

The reused `watch-now` address now identifies the new repository. Do not expect
its old issue, pull-request, release, or commit URLs to redirect to the legacy
repository. Use the explicit legacy address for historical material, including
[the v1.0.2 source tag](https://github.com/JermZone/watch-now-legacy/tree/v1.0.2).
Current support and source links use `JermZone/watch-now`.

The deferred Watch-button report is now tracked as
[new issue #11](https://github.com/JermZone/watch-now/issues/11), with its original
record at [legacy issue #35](https://github.com/JermZone/watch-now-legacy/issues/35).
No issue number or resolution was assumed to transfer automatically.

Keep the clean launch checkout pointed at `JermZone/watch-now` and every
history-bearing development checkout pointed at `JermZone/watch-now-legacy`.
The two checkouts used for this handover have been updated. Review any other
pre-handover clone before its next push. Do not force-push the old history into
the new repository, and do not rename or delete working folders unnecessarily.

## Remaining repository/release checks

Recheck repository-specific branch/tag protections, security reporting, Actions
permissions, app connections, and GHCR access rather than assuming they transferred.
Leave `WATCH_NOW_RELEASE_ENABLED` unset until publication is approved. Preserve
unresolved work and historical source access. Archive the legacy repository only
after its automation, package linkage, references, and rollback needs are reviewed.

The first stable tag in the new repository may be `v1.0.0` after approval. The
legacy `v1.0.x` tags and `ghcr.io/jermzone/dispatcharr-now` images remain separate;
do not reuse or overwrite them. Completing the source handover does not publish
an image, change a running stack, or approve stability.

## Existing Docker/Portainer installation — after verified publication

Old package: `ghcr.io/jermzone/dispatcharr-now`.
New package: `ghcr.io/jermzone/watch-now` (not published by the source handover).

Do not change a working stack until the new image is public and verified. Save the
old image digest, Compose file, environment settings, project/service names, and
any custom network/reverse-proxy configuration.

For the least disruptive transition, keep the existing Compose project/service
name and change **only the image reference** to the tested new digest. The settings
and ports are retained. Sign-in is required after recreation. Check the updated
stack before accepting the change, and roll back by restoring its previous image
and configuration. No persistent app data needs migration. This production change
is separate from the completed source-repository handover.

The clean Compose example names its service `watch-now`. Applying it over a stack
with service `dispatcharr-now` can create a second service/port conflict. Use it for
a fresh test stack, or deliberately retire the old service after saving rollback
information. Do not use broad prune or remove-orphans commands blindly.

The internal executable is now `/watch-now`; the image's healthcheck/entrypoint are
updated together. Review custom scripts that hard-code `/dispatcharr-now`. Old
household-specific scripts are deliberately absent from the public snapshot, but
remain in legacy history where needed.

## Reference

- [GitHub repository renaming](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
- [GitHub repository archiving](https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories)
- [Semantic versioning](https://semver.org/)
