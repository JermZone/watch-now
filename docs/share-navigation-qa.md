# Sharing, navigation and playback QA

The maintainer confirmed acceptance of the private QA candidate on 2026-10-06 and
authorized the 1.3.0 GitHub release. The QA revision was
`0165850e354a617decb5bbf5327c33e6a8393fca`, version `qa-share-0165850`.
No fresh complete device/account matrix is claimed by that confirmation.

## Regression checklist

- Refresh each section after choosing an item/filter/page. Confirm restoration
  without automatic playback; check browser Back/Forward and sign-out.
- Create channel, movie, episode and completed-recording links. Check copying,
  opening in a fresh browser, sign-in, selection and return to browsing.
- Start normal and shared playback on desktop and phone. Check controls, details,
  Stop and Live TV return/focus behavior. Long lists may scroll intentionally.
- Check DVR logos, completed-recording playback, seeking, download and VLC.
- Use a restricted account: a link must not grant inaccessible content or DVR
  management rights. Check expired sessions and unavailable/deleted content.
- During a separately authorized maintenance test, retain the share key across
  recreation and confirm an old link resolves after signing in again.

## Deployment requirements

Generate a separate persistent share key for each installation; never reuse a
development key in production. Keep its directory private and mount the file
read-only, readable by UID 65532. Preserve it across upgrades to retain existing
links. See [configuration](share-navigation.md).

Keep production service names, ports, upstream/proxy settings and DVR secret mounts.
Retain the previous image/configuration for rollback. Release distribution checks
use an isolated stack and do not redeploy an existing installation.

Retained automated evidence includes 209 frontend tests, Go tests/vet, Compose
checks and 96 synthetic browser playback geometry cases. Firefox Live TV was not
covered in the temporary runtime because H.264 MediaSource support was unavailable.
Codec limits and the deferred [sign-in issue #11](https://github.com/JermZone/watch-now/issues/11) remain.
