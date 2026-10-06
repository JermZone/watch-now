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

Generate a dedicated random key once:

```sh
openssl rand -hex 32
```

Keep it private and set `NOW_SHARE_KEY` in the provided Compose environment, or
mount a file containing just the hexadecimal key read-only and configure
`NOW_SHARE_KEY_FILE` with its container path. Use one source only. The non-root
container user (UID 65532) must be able to read the mounted file. For example,
add to the existing service (the host file must already exist):

```yaml
environment:
  NOW_SHARE_KEY: ""
  NOW_SHARE_KEY_FILE: /run/secrets/watch_now_share_key
volumes:
  - ./secrets/share-key.txt:/run/secrets/watch_now_share_key:ro
```

Keep the host secret directory private. Do not commit the key. Retain the same key
across recreations; changing it invalidates every old link. There is no per-link
revocation list or link database. Removing configuration disables creation and
resolution. Do not copy a development key into QA or production. An environment
key is visible to administrators inspecting the container; use a mounted file to
keep it out of environment metadata.

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
