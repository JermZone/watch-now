# Share links and refresh restoration

Watch menus offer **Share link** for live channels, movies, series episodes, and
playable completed recordings when sharing is configured. The dialog creates a
link and provides Copy link plus a selectable field for browsers without clipboard
access. Sharing does not start playback, issue a VLC ticket, or grant access.

The recipient opens the Watch Now address, signs in if needed, and lands on the
selected screen with Watch available. Their current lineup and permissions are
checked before resolving the destination and again by existing content/media APIs.
For recording links, DVR must already be connected (server-managed DVR connects
automatically). A missing item, revoked access, invalid link, or rotated key gives
an error with Retry and Continue browsing. Links refer to the same Watch Now
installation and its configured Dispatcharr catalog; they are not portable across
unrelated installations. Live links select the channel's current broadcast, not a
past airing. There is no automatic playback or saved playback position.

## Server configuration

The supplied Compose files enable sharing automatically. Start the stack, sign in,
and choose **Share link** from an item's Watch menu. No key-generation command or
secret copying is needed. About shows whether sharing is ready.

A small named Docker volume at `/var/lib/watch-now` retains a randomly generated
32-byte key in `share-key`. The key is created once with private permissions and
reused on subsequent starts. Only the sharing key is persistent; sessions, viewer
credentials, catalogs and playback remain in memory. Keep and back up this volume
privately across upgrades. Removing it (including `docker compose down -v`) loses
the key and invalidates existing links. A normal `docker compose down` retains it.

For an existing custom Compose stack, add these entries to your existing service
and the top-level volume declaration (requires an image containing this feature):

```yaml
services:
  watch-now:
    environment:
      NOW_SHARE_KEY_DIR: /var/lib/watch-now
    volumes:
      - watch_now_share_data:/var/lib/watch-now
volumes:
  watch_now_share_data:
```

Retain your other settings and `read_only: true`. New Docker named volumes inherit
the image directory's UID 65532 ownership and mode 0700. Do not mount an arbitrary
host folder without setting equivalent private permissions. `NOW_SHARE_KEY_DIR`
opts into automatic storage: always point it at a persistent mount, never at an
ephemeral container folder. Direct image runs without this setting leave sharing
disabled unless an explicit key is supplied.

Existing `NOW_SHARE_KEY` and `NOW_SHARE_KEY_FILE` settings take precedence over
automatic storage. Keep your existing setting to preserve old links; adding a
volume does not copy or replace that explicit key. To migrate deliberately, stop
only Watch Now, securely place the same hexadecimal key in the volume's `share-key`
file (owned by UID 65532, mode 0600), and then remove the explicit setting. Keep a
private backup and verify an existing link before discarding the old file. Do not
reuse a development key in an unrelated installation.

Manual keys remain supported: generate 32 random bytes as 64 hexadecimal characters
and set `NOW_SHARE_KEY`, or mount a file read-only and set `NOW_SHARE_KEY_FILE` to
its container path. Use only one explicit source. The container user must be able
to read the file. Invalid explicit keys remain a startup error. Environment keys
are visible to administrators inspecting the container; a mounted file avoids that.

If automatic storage is missing, unwritable, unsafe or damaged, playback remains
available and sharing is disabled with a startup warning and an About message.
An existing damaged key is never silently replaced. Repair permissions or restore
the same key from backup, then recreate Watch Now. Never post the key in logs or
support reports. There is no per-link revocation list or link database. To disable
sharing completely, remove both the automatic directory setting and explicit keys.

Tokens use Go's standard-library AES-256-GCM with random 96-bit nonces and full
128-bit authentication tags, purpose-bound to a versioned Watch Now payload. The
payload contains only a type and bounded item IDs. Typical numeric-ID tokens are
44–55 characters; long catalog IDs can be longer (maximum 400). Titles, credentials,
upstream hostnames, and account details are excluded. No custom cipher, shortened
authentication tag, persistent session, or catalog storage is introduced.

The `#/s/` fragment stays out of HTTP page requests; the browser submits the token
only in a same-origin authenticated POST body with CSRF validation. App logs omit
request bodies and tokens. Sharing has a per-session 60/minute limiter with bounded
entries, four concurrent lookups maximum, and bounded request/payload sizes. API
responses are non-cacheable. HTTPS is still required for private network traffic
outside a trusted LAN. Anyone receiving the URL can forward it, but every recipient
must have their own authorized account.

## Refresh and navigation

Nonsecret view state is saved per tab in sessionStorage, scoped to the signed-in
username. Refresh restores section, discovery mode, search/filter, catalog page,
selected movie/series/episode, Live selection, Guide date/time/group, and DVR scope.
Data is fetched again under the current session; no credentials, playback tickets,
API keys, media, or catalogs are persisted. Signing out clears the saved view.
Changing accounts never restores another account's view. Browser history restores
screen navigation; search edits replace the current entry rather than adding an
entry per keystroke. Share link is the supported way to send a destination to
another browser; normal view state is local to the tab.

Visible pane scroll coordinates are restored on a best-effort basis for up to five
seconds while data loads. User interaction stops restoration; changed data, smaller
catalogs and bounded Guide batches can limit the restored position. Browser storage
restrictions fall back to an ordinary fresh view. Playback stops on refresh.

## Focused playback

Movies, episodes and completed recordings use a focused playback view with a
compact title/Stop row and video sized to the available viewport. Full metadata
opens in Playback details without tearing down the player. Stop returns to the
selected item's details. Normal and shared DVR cards show channel logos, with
initials when artwork is unavailable.

Live TV can switch between browsing and Focus player while retaining the running
stream. Long lists and details dialogs may still scroll intentionally. Layout
containment does not change supported codecs or add transcoding.

## Validation and rollout

For automatic sharing setup, the maintainer tested Docky build `1.3.1-qa`, revision
`9300b7f29a6e7db2b10d4e496b7a7285d12c6f2c`, and confirmed sharing worked as expected
on 2026-10-06. The tested feature tree matches GitHub commit
`fe81b2685a5f838b96989deec141c45bfec4a8ce`. Tests cover key reuse under concurrent
starts, existing overrides, damaged/unsafe storage, token resolution after server
recreation and hardened Docker storage behavior. All 211 frontend tests and
required GitHub CI passed. Docky's existing key was deliberately retained and
verified across recreation. No fresh full-device playback matrix is inferred.
See [1.3.1 preparation](release-readiness-1.3.1.md) for publication gates.

The following retained evidence describes the earlier v1.3.0 sharing/navigation
and playback rollout:

The maintainer confirmed Docky QA acceptance and authorized GitHub publication
on 2026-10-06. The accepted QA revision is
`0165850e354a617decb5bbf5327c33e6a8393fca`; its source tree matches feature commit
`59cce6c579db30c60d7f8789ff4d484c348f5565`.

Retained source evidence includes 209 frontend tests, Go tests/vet, frontend and
container builds, Compose checks and 96 normal/shared playback geometry cases.
Browser media responses were synthetic and tested layout/lifecycle rather than
upstream decoding. The temporary Firefox runtime lacked H.264 MediaSource support,
so its Live TV geometry cases were skipped. The maintainer's QA confirmation is
separate from these automated results and does not specify a complete device matrix.

Release CI and exact published-image checks must pass before production upgrade.
See the [QA checklist](https://github.com/JermZone/watch-now/blob/v1.3.0/docs/share-navigation-qa.md)
and [release preparation](https://github.com/JermZone/watch-now/blob/v1.3.0/docs/release-readiness-1.3.0.md).
