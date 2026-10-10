# Separate development installation

Changes stay on a feature branch and draft pull request until review and device
testing are complete. Pushes to `feature/**` run the Development image
workflow. Tests, audits, image scanning, and an isolated container health check
must pass before the exact tested image is saved as a downloadable Actions
artifact. The build identifies itself as `dev-<12-character commit>` in About
and links to its corresponding source.

The checked-in development workflow has read-only repository permission, does
not persist checkout credentials, and receives no registry publication
credential. It does not create releases or publish package tags. These Linux
amd64 builds are temporary testing candidates, not supported releases. Review
the source commit before running a
candidate; its archive checksum verifies transfer integrity, not source approval.
Pull requests from forks do not trigger this workflow.

Users who can change feature workflow YAML can request package write permission
again. If feature writers are outside release trust, maintainers must separately
restrict production GHCR package inheritance and Actions write access, and grant
publication only to a separately controlled publisher. Restricted default token
permissions alone do not enforce that boundary. The existing release and latest
workflows use this repository's package-write token, so changing package access
requires a planned publisher migration. These external settings have not been
verified by the workflow change. See [GitHub Actions permissions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
and [package access controls](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Download `watch-now-development-<full commit SHA>` from the successful workflow
run linked in the pull request or its workflow summary. Artifacts expire after
seven days. The artifact contains `watch-now-image.tar.gz` and `SHA256SUMS`.
For example, with the GitHub CLI:

```sh
gh run download <successful-run-id> --repo JermZone/watch-now \
  --name watch-now-development-<full-commit-SHA> --dir watch-now-development
cd watch-now-development
sha256sum --check SHA256SUMS && docker load --input watch-now-image.tar.gz
```

Stop if checksum verification fails. Load the archive into the same Docker
host/context that will run the test stack. For Portainer, transfer and load it
on that stack's Docker host, not just your workstation. Set `NOW_TEST_IMAGE` to
`watch-now:dev-<full commit SHA>` and `DISPATCHARR_URL` to the upstream address
reachable from the test container. The test stack uses `pull_policy: never` and
fails if that exact local image has not been loaded.
Deploy `compose.test.yaml` as its own project/Portainer stack, for example
`watch-now-vlc-test`. Keep the production stack running. The default test port is
9194, distinct from production's 9192; change it if already occupied.

The template binds to localhost by default. For a trusted LAN test, set
`NOW_TEST_HOST_BIND=0.0.0.0` and visit `http://<server-LAN-IP>:9194` from the VLC
device. The VLC device and Chromecast must be able to reach that address. For
HTTPS, use a separate proxy route to the test service and the documented cookie
and trusted-proxy configuration. Do not reuse the production route.

Sign in with your existing Dispatcharr viewer account and confirm About shows
the expected development version. Test Live TV VLC directly first, then cast
from VLC. Check browser playback stops on handoff, playlist expiry, logout
revocation, and restricted-channel access. Recheck Movies and Series VLC behavior.
Record results and device versions on the pull request without credentials,
playlists, or temporary media links. Automated health checks do not establish
Dispatcharr playback, VLC, or Chromecast compatibility.

Stop and remove the separate test stack after testing. It has no persistent
volumes and does not replace the production container. Sessions are process-local.
