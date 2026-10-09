# Watch Now

*A web player for Dispatcharr.*

Live TV, Movies, Series and DVR in a lightweight interface for phones, tablets
and desktops. Give viewers a place to watch without giving them Dispatcharr's
admin interface.

Watch Now is independent and open source. It is not affiliated with or endorsed
by Dispatcharr or VideoLAN. Bring your own Dispatcharr installation and XC viewer
account; no channels, subscriptions or media are supplied.

![Live TV browsing with synthetic sample channels](docs/images/live-tv.png)

The screenshot uses sample channels and guide data, not a real viewer's lineup.

**[Installation](docs/installation.md)** · [Recording and live pause](docs/watch-while-recording.md) ·
[HTTPS hosting](docs/public-hosting.md) · [Support](SUPPORT.md) ·
[Release notes](RELEASE_NOTES.md)

## What it does

- Browse live channels and search current/upcoming shows when a viewer-specific guide is available.
- Open **Guide** beside Browse/Search for Grid or List, with dates up to seven days where listings exist. Solid red dots identify scheduled and active recordings. See [TV Guide](docs/tv-guide.md).
- Use **Watch & Record** on a current programme, then pause, rewind and **Go Live** within captured footage. An existing recording offers **Watch from Beginning** or **Watch Live**. See [recording and live pause](docs/watch-while-recording.md).
- Browse Movies and Series, watch supported formats in the browser, or use VLC and downloads.
- Connect optional DVR to browse, schedule and manage recordings according to the viewer's permissions. Finished recordings offer Watch, download, VLC and sharing. See [DVR setup](docs/dvr.md).
- Share authorized channels, movies, episodes and finished recordings; restore navigation on refresh and use focused playback views with **Details** below the title. The supplied Compose setup retains the sharing key automatically. See [sharing](docs/share-navigation.md).
- Run one non-root container with a Go backend and compiled React interface: no database or transcoder. Sessions and catalogs remain in memory.

## Releases

This documentation describes **Watch Now 1.4.0**, with recording playback,
live pause through an active capture, recording markers and playback controls.
See the [release notes](RELEASE_NOTES.md). Download production assets only from
[published releases](https://github.com/JermZone/watch-now/releases), using their
verified image digests; source version metadata does not announce availability.

Automatic persistent sharing setup was introduced in 1.3.1 and remains supported,
along with existing explicit sharing keys. Stable `latest` advances only after
verification of a published stable release.

Each release includes a `watch-now-<version>-install.zip` with Compose,
`.env.example`, customer guides and license information. DVR remains optional.
The Guide uses Dispatcharr's listings; Watch Now cannot supply missing guide data.

The earlier `ghcr.io/jermzone/dispatcharr-now:1.0.2` beta remains a separate
historical image. See [migration](docs/migration.md) before changing an existing
installation. The clean Watch Now repository preserves relevant handover records
in [source provenance](PROVENANCE.md).

**Known issue:** Watch has been reported to become unresponsive after signing out
and back in. The cause and a reliable workaround remain unverified;
[issue #11](https://github.com/JermZone/watch-now/issues/11) is deferred and is not
claimed fixed by this release.

## Getting started

You need Docker with Compose v2 or Portainer, a Dispatcharr HTTP/XC endpoint
reachable from the container, and an existing **XC viewer** username/password.
Viewer credentials can differ from an administration login.

Dispatcharr **0.32.0** is the validated active-recording baseline. Earlier
Live/Movie/Series/completed-DVR checks used 0.31.0. Watch Now checks the capabilities
it needs rather than rejecting newer versions by number. Recording playback
requires the supported active-recording HLS endpoints and DVR access.

Linux **AMD64** is the validated image target; ARM64 is not yet validated.
The supplied stack starts with 256 MiB memory and 100 PIDs. These are starting
limits, not a capacity guarantee. Dispatcharr stores and processes recordings;
Watch Now does not mount its recording directory or add a recording service.

Follow [installation](docs/installation.md). Keep Dispatcharr's administration
interface private and use [HTTPS hosting](docs/public-hosting.md) before exposing
Watch Now to the internet.

## Playback and compatibility

| Area | Behavior and limits |
| --- | --- |
| Ordinary Live TV | Watch Live tunes the current stream. It does not create a recording or promise a retained rewind buffer. |
| Active recording | Beginning starts at the earliest captured footage. Live joins the safe recorded edge, typically about twelve seconds behind capture with stock four-second segments. Missing footage before recording started cannot be recovered. |
| Pause and rewind | Available within retained captured footage. Resume stays at the paused position; Go Live deliberately resumes near the recorded edge. No position is saved across refresh, sign-out or restart. |
| iPhone/iPad | Active recording uses native HLS. Apple's fullscreen controls can differ from the inline controls. Finished-file playback still depends on container and codecs. |
| Browser video | There is no transcoding. An unsupported finished recording can be downloaded or opened in VLC. |
| Live show search | Requires a usable viewer-specific guide. Search covers 24 hours; Guide can show later available listings. |
| Permissions | Recordings are shared Dispatcharr resources, restricted by current DVR permissions and the viewer's channel lineup. |

The maintainer reported successful real iPhone recording playback through
completion, including pause and rewind. This is accepted feature feedback,
not a claim that every device, codec or the final public image has been tested.
See [release preparation](docs/release-readiness-1.4.0.md) for the evidence and
remaining checks.

To add the icon on iPhone/iPad, open Watch Now in Safari and choose
**Share → Add to Home Screen**. Remove and re-add an older shortcut if its icon
is cached. Home-screen picture-in-picture is deferred; it is not a promised
feature. The shortcut does not add offline playback.

### VLC and casting

Live channels, movies, episodes and playable finished recordings offer VLC
through their Watch menu. Desktop **Watch in VLC** downloads a temporary playlist;
Apple mobile **Open in VLC** hands off to the separately installed app.
Live channel VLC plays the ordinary live stream, not the active recording's
pause/rewind buffer.

Watch Now stops browser playback before external playback begins. Stop or switch
the external stream inside VLC. Sign-out revokes the session's handoffs.
Launch links last one minute; media links expire after ten minutes without a
request, with a six-hour maximum. Open playlists promptly and generate a new one
after expiry.

Use VLC's own cast-device selector. The receiving device must be able to reach
the Watch Now media endpoint. Codec/device support still applies; Watch Now does
not transcode or automatically choose a cast device. See
[VLC QA](docs/live-tv-vlc-qa.md) for earlier validation scope.

Opening Movie/Series details or starting media can cause stock Dispatcharr to
refresh shared metadata. Poster browsing adds no provider-detail calls. See
[VOD access behavior](docs/vod-current-eligibility.md).

## Privacy and telemetry

Watch Now includes no usage analytics, tracking pixels, advertising SDKs or
application telemetry, and does not phone home to the maintainer. It communicates
with the Dispatcharr endpoint you configure and services you deliberately place
around it, such as your reverse proxy.

GitHub and container registries can retain their own service logs and aggregate
download/traffic statistics. Those platform statistics are not collected by
Watch Now.

## Updates and support

Use **Menu → About** for the version and source link. Report the image tag/digest
or source commit, browser/device and reproduction steps. Never post credentials,
cookies, raw HAR files, playlists or tokenized media/provider URLs.

Pull and recreate to update; moving a registry tag does not update a running
container. Preserve the prior image/configuration and sharing key or volume for
rollback. Restart signs viewers out because sessions are held in memory.
`latest` is reserved for verified stable releases; drafts and release candidates
are excluded.

[Installation and troubleshooting](docs/installation.md) · [Support](SUPPORT.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[GNU AGPLv3](LICENSE). Contributors retain copyright in their contributions.
[Third-party notices](THIRD_PARTY_NOTICES.md) and [source provenance](PROVENANCE.md)
are retained. Modified deployments must provide corresponding source as required
by the license; the app includes a source link in About.
