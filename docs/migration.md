# Existing-install migration

## Current source and image

The canonical source repository is
[JermZone/watch-now](https://github.com/JermZone/watch-now).
Watch Now 1.0.0 is published at
[GitHub Releases](https://github.com/JermZone/watch-now/releases/tag/v1.0.0),
with the public image namespace `ghcr.io/jermzone/watch-now`.

The repository was created from a reviewed development snapshot using a clean Git
history. The former development repository's commits, branches, tags, releases,
issues, pull requests, and Actions history were intentionally not imported.
[PROVENANCE.md](../PROVENANCE.md) preserves the source-handover identifiers that
matter to the current project.

The deferred Watch-button report is tracked as
[current issue #11](https://github.com/JermZone/watch-now/issues/11). The current
issue preserves the original report context and retained regression-test evidence.

## Existing Docker/Portainer installation

Old package: `ghcr.io/jermzone/dispatcharr-now`.

Current package: `ghcr.io/jermzone/watch-now`.

For the least disruptive transition, keep the existing Compose project/service
name and change **only the image reference** to the tested Watch Now image. Save
the old image digest, Compose file, environment settings, project/service names,
and any custom network or reverse-proxy configuration first.

The verified 1.0.0 image is:

`ghcr.io/jermzone/watch-now@sha256:3db3b5f3655eed2579797800aeb965b69081c161271bbd577b61fc7f73dd7bc5`

The stable `latest` tag was promoted to that same digest after the 1.0.0 release
was published.

Recreating the app requires viewers to sign in again because sessions are held
in memory. No database migration is required.

The clean Compose example names its service `watch-now`. Applying it over an
existing stack whose service is named `dispatcharr-now` can create a second
service and a port conflict. For an existing installation, preserve the existing
service name unless you deliberately intend to retire and replace it.

The internal executable is now `/watch-now`; the image healthcheck and entrypoint
are updated together. Review any custom scripts that hard-code
`/dispatcharr-now`.

## Rollback

Rollback does not depend on the former source repository. Restore the saved prior
image digest and the prior Compose/environment configuration, then recreate the
service. The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a
separate historical image and is not modified by Watch Now releases.

## Reference

- [Installation](installation.md)
- [Release readiness](release-readiness.md)
- [Source provenance](../PROVENANCE.md)
- [Semantic versioning](https://semver.org/)
