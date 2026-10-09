# Installation

[Back to Watch Now](../README.md)

**Source version: `1.5.0`.** Use **Docker image / Portainer** only when
[GitHub Releases](https://github.com/JermZone/watch-now/releases) supplies a
published version and verified image digest for `ghcr.io/jermzone/watch-now`.
If the desired release is not available yet, use **Source testing** below.
The version in the example files is not itself an availability announcement.

For the unchanged earlier beta, use the files for
the historical `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta, not
this version's Compose files. Existing deployments should first read
[Migration](migration.md).

Sharing works automatically with the supplied Compose persistent volume. Keep that
volume across upgrades so existing links continue to work. Existing manual keys
remain supported. See [Sharing](share-navigation.md) for custom stacks and migration;
recipients still need their own authorized account.

## Before starting

You need a reachable Dispatcharr HTTP/XC endpoint and **XC viewer** credentials.
Administration credentials may differ. Sign in through the application; do not
put viewer passwords in Compose, `.env`, URLs, or bug reports.

Dispatcharr 0.32.0 is the validated active-recording baseline. DVR playback
requires its supported HTTP/HLS capabilities and optional DVR connection;
earlier Live/Movie/Series/completed-DVR checks used 0.31.0. Later versions are
checked by capability. Linux AMD64 is the validated image target.

Keep test and production folders, stack names, and host ports separate. The
examples here do not modify an existing installation or create Dispatcharr itself.

## Source testing

Check out the reviewed source revision into a separate source folder. From
that folder, prepare settings:

```sh
cp .env.example .env
# Edit .env before starting the test stack.
```

Set `DISPATCHARR_URL` to a disposable test endpoint where possible and
`NOW_HOST_PORT=19192` to avoid the normal port. The example
`http://192.168.1.20:9191` is only a placeholder. Explicit VOD detail/media actions
may refresh upstream metadata; do not use household accounts for automated tests.

```sh
git rev-parse HEAD
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml config --quiet
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml up -d --build
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml ps
```

The override builds `watch-now:local` and uses `pull_policy: build`; it does not
pull or overwrite a published registry image. Open `http://localhost:19192` on the
Docker host. For trusted-LAN access, use the host's LAN address after changing the
binding as described below. Record both the commit and displayed version.

Stop only this test stack using the same project name and files:

```sh
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml down
```

## Docker image / Portainer — after publication

Only proceed once the new package has a published release with a verified image
tag and digest. Obtain [compose.yaml](../compose.yaml) and
[.env.example](../.env.example) from that release, not an arbitrary development
branch. Use a new folder or stack for a fresh installation.

For Docker Compose, copy `.env.example` to `.env`, set `DISPATCHARR_URL`, and select
the verified image using `NOW_IMAGE`. A digest pins exact image bytes; a version
tag lets you choose when to update. Validate and start:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
```

For Portainer, create a new stack from the complete image-only `compose.yaml`.
Set `DISPATCHARR_URL`, the verified `NOW_IMAGE`, and any overrides in the stack's
environment-variable editor. Portainer does not automatically load a `.env` file
from your workstation. Do not paste `compose.build.yaml` into a remote Portainer
stack: it needs a local source build context.

Confirm the container is healthy, open the configured host address/port, sign in
with the XC viewer credentials, and verify **Menu → About**.

## Optional DVR connection

DVR can use a per-account API key file mounted through Compose, so viewers do not have to paste keys at login. See [DVR setup](dvr.md#configure-keys-through-compose). You can instead configure one Admin key with `NOW_DVR_MASTER_API_KEY`; master-key mode independently checks each viewer’s DVR permissions and channel lineup. See the documented account-flag limitation in the DVR setup guide.

## Local and LAN access

The default is host-loopback only at `127.0.0.1:9192`. Leave that binding in place
for host-local access or a reverse proxy running directly on the host. For other
devices on a trusted LAN, set:

```dotenv
NOW_HOST_BIND=0.0.0.0
NOW_HOST_PORT=9192
```

Use `19192` instead for the separate test stack. Do not port-forward the app's
plain HTTP port to the internet. Follow [HTTPS hosting](public-hosting.md).

## Connecting containers

`localhost` inside Watch Now means the Watch Now container, not Dispatcharr or the
host. Use a reachable Dispatcharr LAN address or its service name and **container**
port on a shared Docker network.

For separate Compose projects, the following is a partial network configuration
to merge into a new Watch Now stack, not a replacement for the whole file:

```yaml
services:
  watch-now:
    networks: [dispatcharr_shared]
networks:
  dispatcharr_shared:
    external: true
```

The network must already exist and both services must be attached to it. Then
set the actual Dispatcharr service name and container port in `DISPATCHARR_URL`.
Do not rename an existing legacy service just to copy this example.

A reverse proxy in another container cannot use the host's loopback address as
its upstream. Follow [the container-proxy instructions](public-hosting.md),
including a shared network and blocking direct access around the proxy. Trust
proxy headers only when direct access to the app is restricted appropriately.

## Synology and resource limits

The supplied stack does not require CPU quotas, which some Synology hosts lack.
It retains read-only filesystem operation, dropped capabilities, no-new-privileges,
and memory/process limits. An old `cpus: 1.0` setting can cause
`NanoCPUs can not be set`; remove that optional quota rather than removing the
other hardening settings.

## Updates and rollback

Before updating, save the previous image digest and Compose/environment settings.
For an image-only install, change `NOW_IMAGE` to the reviewed tag/digest and run
`docker compose pull` then `docker compose up -d` from the **existing** stack folder.
In Portainer, update the existing stack with **Re-pull image** when needed.
Check health, About version/source, sign-in, permissions and playback after
recreation. Keep the sharing volume and existing explicit key settings; do not
run `docker compose down -v` during an ordinary upgrade.

Roll back by restoring the previous image selection and configuration, then
recreating the same service. Source builds require checking out the intended
revision and rebuilding with the same override; a registry pull does not update
local source. Restarts sign viewers out and invalidate temporary media links.
There is no persistent Watch Now database to migrate. Only the sharing key is
persistent; Dispatcharr retains the recordings.

The new `watch-now:latest` policy is **stable-only** after verified publication.
The legacy `dispatcharr-now:latest` remains a separate, unchanged beta-era tag.
No image or tag is moved by this preparation. Follow [Migration](migration.md)
for the later transition between packages.

## iPhone/iPad home-screen shortcut

Open Watch Now in Safari, then choose **Share → Add to Home Screen**. If an older
shortcut still shows the wrong icon, remove it and add it again. The shortcut
uses the same server and account; it does not add offline playback.
Home-screen picture-in-picture is deferred. Apple's fullscreen controls can
differ from the inline recording controls.

For recording, pause and rewind instructions see
[recording and live pause](watch-while-recording.md).

## Troubleshooting

**Cannot sign in:** verify XC credentials and the server address reachable from
Docker. A 429 response means a login rate limit; respect Retry-After.
**Unexpected channels:** check the viewer's assigned Channel Profiles in Dispatcharr.
**Missing resolution:** XC may not supply it; Watch Now does not guess.
**Expired VLC playlist:** generate a new one and open it promptly.

Use [Support](../SUPPORT.md) for safe report details and [Security](../SECURITY.md)
for private vulnerability reports. Docker documents `.env` interpolation in
[its Compose guide](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).
