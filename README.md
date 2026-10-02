# Watch Now

*A web player for Dispatcharr.*

Live TV, Movies, and Series in a lightweight interface for phones, tablets, and
desktops. Give viewers a place to watch without giving them Dispatcharr's admin
interface.

Watch Now is independent and open source. It is not affiliated with or endorsed
by Dispatcharr or VideoLAN. Bring your own Dispatcharr installation and XC viewer
account; no channels, subscriptions, or media are supplied.

![Live TV browsing with synthetic sample channels](docs/images/live-tv.png)

The screenshot uses sample channels and guide data, not a real viewer's lineup.

**[Installation](docs/installation.md)** · [HTTPS hosting](docs/public-hosting.md) ·
[Support](SUPPORT.md) · [Release notes](RELEASE_NOTES.md)

## What it does

- Browse live channels and search current/upcoming shows when a viewer-specific guide is available.
- Browse Movies and Series, watch supported formats in the browser, or use VLC and downloads.
- Follow the viewer permissions supplied by Dispatcharr, with sessions kept in memory.
- Run one non-root container with a Go backend and compiled React interface: no database or transcoder.

## Releases

This source targets **Watch Now 1.0.0**. Check
[GitHub Releases](https://github.com/JermZone/watch-now/releases) for available
versions and their verified image digests before installing from
`ghcr.io/jermzone/watch-now`. A version in the source or Compose examples does not
mean that image is already published. During preparation, use the separate
source-test route in the [installation guide](docs/installation.md).

The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a separate,
unchanged image. Its original source and installation files remain at the
[legacy release tag](https://github.com/JermZone/watch-now-legacy/tree/v1.0.2).
Do not replace a working stack based only on the repository's new name.
See [migration](docs/migration.md) and [source provenance](PROVENANCE.md).

**Known issue:** Watch has been reported to become unresponsive after signing out
and back in. Investigation is deferred; the cause and a reliable workaround are
not verified. [Issue #11](https://github.com/JermZone/watch-now/issues/11) remains
open, with the original report retained in the legacy repository. Version 1.0.0
preparation does not fix that report.

## Getting started

You need Docker with Compose v2 or Portainer, a Dispatcharr HTTP/XC endpoint
reachable from the container, and an existing **XC viewer** username/password.
The viewer's API & XC credentials may differ from the administration login.

Dispatcharr **0.31.0** is the earlier tested baseline, not a version whitelist.
Linux **AMD64** is the initial image target; ARM64 is not yet validated. Browser
playback depends on codecs. VLC is optional and must be installed separately.

Follow the [installation guide](docs/installation.md) for isolated source testing
and the Docker/Portainer route after image publication. Keep Dispatcharr's
administration interface private; use [HTTPS hosting](docs/public-hosting.md)
before exposing Watch Now to the internet.

## Playback and compatibility

| Area | Recorded development checks / limits |
| --- | --- |
| iPhone/iPad | Navigation and VLC handoff checked during development; one VLC movie session exceeded 45 minutes. |
| Desktop | Firefox navigation and browser playback checked; downloaded playlists opened in desktop VLC. |
| Browser video | Depends on container, video/audio codecs, and browser. Unsupported formats may need VLC. There is no transcoding. |
| Media badges | Use metadata supplied by XC. Missing resolution is not guessed or measured by probing video. |
| Live show search | Requires a usable viewer-specific XMLTV guide; channel search remains available without it. |
| Permissions | A restricted viewer lineup was manually checked; automated tests cover viewer separation and revoked access. |

These playback records are from development, not a repeat on the new image.
The maintainer also confirmed that the rc.3 source-built test container was
healthy, accepted sign-in, and displayed the correct name/version. See
[release readiness](docs/release-readiness.md) for the evidence and remaining
published-image checks.

Desktop **Watch in VLC** downloads a temporary playlist; open it promptly. Apple
mobile **Open in VLC** hands off outside the browser. Launch links last one minute;
media links expire after ten minutes without a request, with a six-hour maximum.
Generate a new playlist after expiry. These are not permanent library URLs.

Opening Movie/Series details or starting media can cause stock Dispatcharr to
refresh shared metadata. Poster browsing uses current listings without adding
provider-detail calls. See [VOD access behavior](docs/vod-current-eligibility.md).

## Support and updates

Use **Menu → About** for the version and source link. Report the image tag/digest
or source commit, browser/device, and steps to reproduce. Never post credentials,
cookies, raw HAR files, playlists, or tokenized media/provider URLs.

The new package's `latest` is reserved for verified published **stable** releases;
release candidates and drafts are excluded. Existing legacy tags are unchanged.
Pull and recreate to update; a registry tag moving does not update a running
container. Keep the prior image digest and configuration for rollback. Restarting
signs viewers out because sessions are intentionally held in memory.

[Installation and troubleshooting](docs/installation.md) · [Support](SUPPORT.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[GNU AGPLv3](LICENSE). Contributors retain copyright in their contributions.
[Third-party notices](THIRD_PARTY_NOTICES.md) and [source provenance](PROVENANCE.md)
are retained. Modified deployments must provide corresponding source as required
by the license; the app includes a source link in About.
