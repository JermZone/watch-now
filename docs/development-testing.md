# Separate development installation

Changes stay on a feature branch and draft pull request until review and device
testing are complete. Trusted pushes to `feature/**` run the Development image
workflow. Tests, audits, image scanning, and an isolated container health check
must pass before the exact tested image is published. The build identifies itself
as `dev-<12-character commit>` in About and links to its corresponding source.

The workflow publishes only `ghcr.io/jermzone/watch-now:dev-<full commit SHA>`.
It does not create a release or update stable version tags or `latest`. These
Linux amd64 builds are temporary testing candidates, not supported releases.
Registry permission is used only by the trusted branch workflow; pull requests
from forks do not trigger development image publication.

Use the digest recorded in the successful workflow summary, not a moving tag.
Set `NOW_TEST_IMAGE` to `ghcr.io/jermzone/watch-now@sha256:<digest>` and
`DISPATCHARR_URL` to the upstream address reachable from the test container.
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
