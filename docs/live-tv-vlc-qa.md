# Live TV VLC QA evidence

## Maintainer device checks — October 2, 2026

The maintainer tested an existing separate QA installation, with the public
production installation left on its existing release. These are reported device
results; automated checks do not establish device playback compatibility.

| Candidate | Image digest | Reported result |
| --- | --- | --- |
| `dev-ced29241bbe4` | `sha256:4a71435cc596bd9e7f236a64da90b2f68e73582a5ee0cfebe0a4702a7de8210f` | Successful sign-in, Live TV opening in VLC, and Chromecast casting reported to work great. |
| `dev-0af0fa8012f0` | `sha256:caebbff7e53b7cb0fd3f7742b2c1c6c2baa715b28b19c4e5f53cb4602058ec4b` | Adjusted Stop button looks good; Movie casting still works; Series casting seems to work. After the stopping/switching check was requested, the maintainer reported everything working as expected and approved moving forward. |

The final interaction uses a plain Stop button during browser playback, matching
Movies and Series. Stopping restores Watch Live and the VLC option. Stop external
playback inside VLC; browsing another channel does not stop it. Watch Now sign-out
revokes external relay access.

Exact device/OS/VLC versions and measured sustained-playback duration were not
supplied. Concurrent upstream stream counts were not independently observed.
No claim is made for every Chromecast model, channel codec, browser, or network.
The recorded results apply to these development images, not an unbuilt stable
release or unrelated future changes. No new logout/device-expiry check was
reported during this session; automated tests cover expiry, logout cancellation,
viewer isolation, current channel permissions, and pending handoff cancellation.

## Automated validation

Both candidates passed frontend and Go tests, vet/race checks, vulnerability
audits, Compose/release checks, Docker builds, HIGH/CRITICAL image scans, and an
isolated non-root/read-only container health check. The Stop adjustment includes
regression checks for desktop/Apple VLC options after Stop and existing
Movie/Series controls. There were 147 frontend tests on the tested candidate.

Latest candidate [CI](https://github.com/JermZone/watch-now/actions/runs/37067106214)
and [development image run](https://github.com/JermZone/watch-now/actions/runs/37067102805).
Source changes and subsequent checks are tracked on
[PR #17](https://github.com/JermZone/watch-now/pull/17).
