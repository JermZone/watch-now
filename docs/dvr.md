# DVR

DVR uses the supported HTTP APIs of stock Dispatcharr. Active-recording playback is validated with Dispatcharr 0.32.0; earlier completed-DVR checks used 0.31.0. Watch Now checks capabilities and permissions rather than rejecting newer versions by number. Playback depends on device, container and codecs. See [recording and live pause](watch-while-recording.md) for the viewing workflow.

## Viewer flow

Open **DVR** below Series in the menu. Server-managed DVR connects automatically; otherwise use **Connect DVR**. Paste the personal Dispatcharr API key for the same account used to sign into Watch Now. The existing XC streaming login remains separate. Watch Now compares the REST identity with the signed-in username; a Standard User cannot borrow an administrator's key. Manually entered keys stay only in the server session and must be reconnected after logout, expiry, or server restart. Administrators can instead provision each account’s key through Compose as described below. Refreshing the page retains the connection while that session is alive. The key is cleared from the input on submission and is never returned in API responses or saved in browser storage.

Admins can manage DVR. Standard Users follow Dispatcharr's `dvr_access` setting: `view` allows browsing and playback, `manage` also allows recording actions, and `none` disables DVR. A missing Standard User setting defaults to view; an unknown value fails closed. Streamer accounts have no DVR access. Every catalog, mutation, and file request rechecks the account. A rejected key disconnects DVR without logging the viewer out of XC playback.

- **Recorded** offers Watch and a dropdown for Download, VLC and Share link when configured, for finished/stopped recordings whose processing succeeded. Managers delete with the trash icon beside the title, with confirmation. Browser codec/container support still applies; use an external player when needed.
- **Recording** shows active jobs. Watch opens **Watch from Beginning** / **Watch Live** for available captured footage, with pause, rewind and Go Live. The Watch dropdown offers VLC with the same beginning/live choices. Managers use a separate **Recording options** menu for **Stop recording** and **Extend 30 minutes**, with confirmation. Stop playback is independent: capture continues when playback stops or the viewer leaves. Stop recording keeps the captured portion for processing.
- **Scheduled** shows upcoming/queued jobs and lets managers cancel them.
- **Attention** holds interrupted, failed, unknown, or not-yet-ready results. Use Dispatcharr to inspect or repair them. Managers may delete them.
- **Browse / Search** changes how the existing DVR catalog is explored. Search checks title, subtitle, description, and channel within the selected status. **Find something to record** appears only in a selected status with zero recordings and opens Live TV’s Upcoming search when program search is enabled. An empty search result in a nonempty status does not show the shortcut.

**Watch & Record** on a current airing starts one recording from now and opens near the latest captured footage after initial buffering. It requires management access and current guide data. Beginning cannot recover footage missed before capture started.

Record on a guide entry, search result, or selected-airing details opens a confirmation for that exact channel/start/end. The server verifies those times against the viewer's guide and copies upstream program metadata; the browser cannot create arbitrary manual schedules. Dispatcharr applies its configured recording padding. The accepted schedule is displayed after creation. Recording a program already on captures only what remains. Upcoming search retains its 24-hour horizon; the separate TV Guide supports later airings when available.

All rows and actions are intersected with the current XC channel lineup, even for administrators. This can be narrower than Dispatcharr's management view. Removing a channel from a viewer's lineup removes its recordings from this interface. Recordings are shared Dispatcharr resources, not a private per-viewer library: cancellation/deletion affects everyone with access. Destructive actions require confirmation.

## One master key through Compose

Set `NOW_DVR_MASTER_API_KEY` to a Dispatcharr Admin account's personal API key in the Compose environment (or the `.env` read by the provided Compose files):

```yaml
services:
  watch-now:
    environment:
      NOW_DVR_MASTER_API_KEY: "YOUR_DISPATCHARR_ADMIN_API_KEY"
```

Alternatively, store just the key in `secrets/dvr-master-api-key.txt` and use [compose.dvr-master.yaml](../compose.dvr-master.yaml). The overlay mounts it read-only and sets `NOW_DVR_MASTER_API_KEY_FILE=/run/secrets/watch_now_dvr_master_key`. Follow the private-directory/non-root file permissions described below. Environment values are visible to administrators inspecting the container; the file option avoids putting the value in Compose or container environment metadata. Do not commit real keys.

For a published image installation, prepare the secret file and run:

```sh
docker compose -f compose.yaml -f compose.dvr-master.yaml pull
docker compose -f compose.yaml -f compose.dvr-master.yaml up -d
```

Keep the same project name and Compose files on subsequent updates. In Portainer,
merge the overlay's environment and secret mount into the existing service.

For isolated source testing:

```sh
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml -f compose.dvr-master.yaml up -d --build
```

Use either master-key mode or per-user key-file mode, not both. Supplying both master environment and master file sources also fails startup. Config changes require a restart. A master key is server configuration and is never copied into browser responses, sessions, cookies, playlists, or media links. Users sign in normally; DVR connects automatically and does not ask for a personal key. Personal connect/disconnect endpoints are disabled in this mode.

Before each DVR operation (including browser/download and external VLC requests), Watch Now verifies that the key belongs to an Admin, looks up the **exact signed-in username** through `/api/accounts/users/`, and derives DVR access from that user's `user_level` and `custom_properties.dvr_access`. No permissions are borrowed from the key owner. Missing/ambiguous users, missing roles, unsupported responses, and unavailable checks fail closed. View-only users can watch but cannot create, extend, stop, or delete recordings. The current XC channel lineup still restricts all recording access, including for managers. Account metadata is read under the existing response limits, capped at 5,000 users, and decoded into a narrow model; other users' keys and properties are neither stored nor returned. Permissions are not cached across operations.

Dispatcharr receives these requests as the key's Admin account. Its 0.31.0 user serializer does not expose `is_active`, and its XC interface does not enforce that flag; Watch Now therefore cannot independently infer that flag through these interfaces. Revoke viewer DVR access with `dvr_access=none`, a Streamer role, removal of the user/channel access, or revoked XC credentials. If a future response includes `is_active=false`, Watch Now denies DVR access. This limitation concerns the separate active-account flag, not the exposed DVR role/settings checks.

A bad/revoked master key shows a server-configuration error, never a request for viewers to enter individual keys. XC sign-in is not revoked by a master-key failure. Current requests recheck permissions before use; an already-open stream retains the existing bounded lifetime/logout cancellation behavior.

## Configure keys through Compose

With Watch Now 1.2.0 or later, you can provision keys once so viewers sign in normally without pasting them. Create `secrets/dvr-api-keys.json` on the Docker host:

```json
{
  "your-standard-username": "that-standard-users-personal-api-key",
  "your-admin-username": "that-admin-users-personal-api-key"
}
```

Use the exact usernames returned for those Dispatcharr accounts. There is no shared administrator fallback. In per-user mode, Watch Now selects a key only after successful XC login, then verifies that its REST identity matches before allowing any DVR access. Accounts omitted from the file can still connect manually.

The optional [compose.dvr.yaml](../compose.dvr.yaml) overlay sets:

```yaml
services:
  watch-now:
    environment:
      NOW_DVR_API_KEYS_FILE: /run/secrets/watch_now_dvr_keys
    secrets:
      - watch_now_dvr_keys
secrets:
  watch_now_dvr_keys:
    file: ./secrets/dvr-api-keys.json
```

Keep the host `secrets` directory private (`chmod 700 secrets`). The mounted file must be readable by the container's non-root UID 65532; for a local Compose file-backed secret, `chmod 444 secrets/dvr-api-keys.json` inside that private directory allows this. Compose does not encrypt a local file-backed secret. The repository and Docker build context already exclude `secrets/`; never commit the real keys.

For an isolated source build, use the installation guide's separate project/port and include the overlay:

```sh
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml -f compose.dvr.yaml config --quiet
docker compose -p watch-now-source-test -f compose.yaml -f compose.build.yaml -f compose.dvr.yaml up -d --build
```

`NOW_DVR_KEYS_HOST_FILE` can select a different host file. For Portainer, mount the file on the Docker endpoint host read-only at `/run/secrets/watch_now_dvr_keys` and set `NOW_DVR_API_KEYS_FILE` to that container path; a workstation-local file is not available to a remote Docker endpoint. This setting requires Watch Now 1.2.0 or later.

The file is read at startup (256 KiB / 256 accounts maximum). Invalid files stop startup with a redacted error. Edit the file and restart Watch Now to rotate keys; this also ends existing viewer sessions. Configured keys remain server configuration across restarts and are copied into new matching sessions. Disconnect DVR clears the current session's copy; a new login reconnects from the configured file.

## HTTP and resource boundaries

Uses `/api/accounts/users/me/`, `/api/channels/recordings/`, and the recording detail/delete, `stop/`, `extend/`, `file/` and recording HLS endpoints. Server-managed mode also checks `/api/accounts/users/`. REST credentials travel only in the server's `X-API-Key` header. No provider requests, database/Redis access, mounted recording directory, Docker socket, transcoder, or additional service is added.

Metadata responses are capped at the smaller of the configured upstream limit and 8 MiB, with a 5,000-record ceiling. Unknown fields are ignored; unsupported response shapes fail closed. Eight concurrent DVR requests, a single non-queued mutation slot, and 30 mutations per session per minute bound work. The frontend renders 20 records per page and refreshes the visible DVR section every 30 seconds. Catalog responses expose only Watch Now-owned fields, never upstream file paths, URLs, task IDs, or account properties.

Mutation endpoints retain origin/CSRF checks. Recording creation checks for an existing airing and serializes local changes. This prevents duplicate clicks through one Watch Now process, but Dispatcharr offers no atomic idempotency across separate clients. Ambiguous network failures are not automatically retried; refresh the schedule before trying again.

Completed media supports validated single HTTP byte ranges, bounded relay buffers, idle/write timeouts, session lifetime bounds, and logout cancellation. It uses existing playback/download limits. Redirects are rejected rather than following an unfinished recording's HLS URL. File downloads and browser playback remain behind the viewer cookie; upstream credentials never appear in media links. The DVR connection can be disconnected independently from the viewer login.

## Playback limits

Active playback keeps the player open through recording completion and preserves pause/position when switching to the finished file. Native HLS on iPhone does not guarantee support for every finished MKV; VLC/download remain available afterward for playable finished recordings. The captured timeline cannot seek into missing footage. Ordinary live playback does not create a retained buffer. See [recording and live pause](watch-while-recording.md).

No saved cross-session resume positions, catch-up of uncaptured broadcasts, automatic commercial skipping or recurring/series rules are added. Refresh/restart ends playback. Recordings remain in Dispatcharr, and its retention settings still apply.

Web Video Caster was canceled by the maintainer on 2026-10-05. Its separate
prototype and test deployment were removed; it is not part of Watch Now.

## Validation

Automated tests cover same-account connection, Standard/Admin permissions, permission revocation, session isolation, key compare-and-swap/logout, bounded and redacted Compose key configuration, configured-account matching, channel restrictions, canonical-airing validation, duplicate creation, incomplete-playback rejection, file range relay, redirect rejection, response/key limits, private-field redaction, description matching/bounds, exact-airing selection, confirmation flows, and view-only UI restrictions.

The maintainer reported real iPhone active-recording playback through completion with pause and rewind working. Automated fixtures and that feature feedback do not establish a complete device/account matrix or exact published-image acceptance. The current evidence and remaining device coverage and publication gates are in [1.5.0 release preparation](release-readiness-1.5.0.md).

Active and completed DVR recordings use a short-lived, opaque VLC handoff. See [active recording VLC](active-recording-vlc.md) for the active HLS flow and its completion limits. Every external request rechecks the owner session, REST identity/permissions, current XC lineup, and selected recording. DVR disconnect or logout revokes the handoff. API keys never appear in playlists or VLC URLs.

[DVR QA](dvr-qa.md) retains the historical foundation checkpoint. Current recording-player acceptance is recorded in [1.5.0 release preparation](release-readiness-1.5.0.md).
