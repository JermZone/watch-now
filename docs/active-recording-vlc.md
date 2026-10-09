# Active recording VLC prototype

This QA candidate extends the 1.4.0 DVR VLC handoff to active
recordings. Open **DVR → Recording → Watch options → Watch in VLC**. On desktop,
open the downloaded playlist promptly; on iPhone/iPad, use the existing VLC
app handoff. Choose **Watch from Beginning** or **Watch Live** in the recording
popup before VLC opens. The same chooser appears from Live TV Browse/Search when
a recording is available; otherwise Live TV VLC opens the ordinary live channel.
Both recording choices reuse the capture without starting another recording.

Beginning selects the earliest captured footage; Live requests a safe point near
the recorded edge. VLC supplies its own playback controls. Exact seeking and
casting behavior still depend on the player/device. A new
capture must publish three complete segments before a handoff is offered by the
server. If it is still preparing, wait a few seconds and try again.

## Completion and pause

Existing external sessions keep requesting the recording's HLS playlist and
segments after capture finishes, including its final ENDLIST marker. New opens
of a playable finished recording use the existing completed-file VLC flow.

Dispatcharr 0.32.0 retains temporary segments while HTTP segment requests refresh
its viewer heartbeat. Cleanup can follow a pause or disconnect after completion;
there is also an upstream four-hour cleanup safety cap. VLC may prefetch or pause
requests differently across devices. If media disappears, return to DVR and open
the finished recording in VLC, then seek manually. This prototype does not switch
an existing HLS demuxer to MKV or restore its position automatically. It does not
keep recordings alive with artificial segment requests or store media locally.

Closing VLC stops viewing only. Recording continues. Signing out, DVR disconnect,
permission/lineup removal and authorization expiry revoke further media access.
The launch ticket lasts 60 seconds; media authorization has a rolling ten-minute
idle limit and a six-hour maximum, bounded by the viewer session lifetime.

## Implementation and checks

Each playlist and segment uses an opaque Watch Now authorization bound to its
owner and recording. All requests repeat REST identity/DVR access, current XC
lineup and recording checks. Upstream API keys stay in server headers; browser
cookies are unnecessary in VLC. Playlists are parsed through the existing strict
HLS adapter, then segment URLs are rewritten to protected Watch Now endpoints.
Requests use bounded concurrency, response sizes, buffers and deadlines. No
transcoder, recording-directory mount, persistence or additional service is added.

Automated fixtures cover cookie-free handoff and segment playback, CSRF,
preparation, completed-but-retained HLS, removed HLS, byte-zero probes, forbidden
ranges/assets, credential redaction and access revocation. Existing completed DVR
and other media regression suites remain applicable.

## Household acceptance

- Open an established recording on desktop VLC and iPhone VLC; note device and VLC version.
- Try a fresh capture, beginning/rewind, seek near its edge, and pause/resume.
- Stay behind live through natural completion and through Stop recording.
- Pause across completion, reopen the finished recording if needed, and check reconnect behavior.
- Close the browser while VLC plays; separately confirm sign-out stops further access.
- Test casting separately, then recheck ordinary Live TV and completed DVR VLC.

The maintainer accepted the Loki behavior and requested QA promotion on
2026-10-09. The maintainer subsequently authorized committing the candidate and deploying
it to Docky QA. The device reports below cover Loki, not a fresh
QA image. Casting and the extended completion/pause matrix remain unverified.

## Loki preview 1 — 2026-10-09

Version: `active-recording-vlc-preview-1`, based on release commit `97b4ff5`
with uncommitted prototype changes on `codex/active-recording-vlc`.

Go tests and vet passed, HTTP/VLC race checks passed, all 479 frontend tests
passed, frontend and Docker builds passed, and `git diff --check` passed.
The deployed container passed liveness, upstream readiness, preview-version and
unauthenticated access checks, including invalid external playlist/segment tokens.
Its existing environment, read-only secret mounts, network/port bindings and
non-root resource/security settings were preserved. The previous container was
retained for rollback. Device VLC/seek/pause/completion/casting results remain
pending household testing.

## Beginning/live chooser — preview 2

The maintainer reported preview 1 working as expected. Preview 2 adds the same
beginning/live decision before active-recording VLC handoff in DVR and Live TV.
Cancel makes no handoff request. Ordinary live channels and finished-file opens
retain their existing flow. The selected position is validated server-side and
stored with the opaque authorization; external requests cannot change it.

VLC 3 does not reliably apply EXT-X-START to a live HLS playlist. Beginning
therefore initially exposes the first three complete segments, with the original
sequence/discontinuity metadata. Repeat playlist probes see the same prefix.
Once an authorized segment delivers bytes, subsequent playlist reloads expose
the full timeline. The prefix does not carry a premature ENDLIST. Live keeps the
full timeline with a safe-edge start hint. HLS updates never reset an established
player's position. Device acceptance of the new choices is pending.

Preview 2 is deployed on Loki as `active-recording-vlc-preview-2`. Validation:
488 frontend tests, frontend build, Go tests/vet, HTTP/VLC race checks, Docker
build and diff whitespace checks passed. Deployment liveness/readiness, version,
security configuration and unauthenticated asset checks passed. Preview 1 is
retained for rollback. No commit or push was made.

## Separate recording controls — preview 3

Active DVR cards now put Extend 30 minutes and Stop recording in a separate
Recording options menu, available only to managers. Watch options contains only
Watch in VLC. Existing confirmation, permission revalidation, and focus return
remain in place. Recordings still preparing for playback use the same management
menu. Keyboard navigation, dismissal, busy state, viewer permissions, and the
separation of playback and management are covered by frontend tests.

Validation: 490 frontend tests, Go tests/vet, frontend build, and diff whitespace
checks passed. The synthetic playback script expectations were updated; that
optional device/decode script was not run for this UI change.

Preview 3 is deployed on Loki as `active-recording-vlc-preview-3`. Docker build,
liveness/readiness, frontend version, security configuration and unauthenticated
route checks passed. Preview 2 is retained for rollback. No commit or push was made.

## Native browser beginning selection — preview 4

The maintainer confirmed the recording-options UI and VLC playback on desktop
and iPhone, but reported that browser Watch from Beginning started live on iPhone.
The native player could consume the initial seek while metadata still reported
zero, before native HLS selected its live default. Native startup now waits for
media readiness and leaves an ignored or pending initial seek unconfirmed. A
quarter-second tolerance prevents repeated seeks for native frame rounding.
Established playback and later user seeks retain their positions.

Native beginning requests additionally use a viewer-owned `start=beginning`
manifest hint, producing `EXT-X-START:TIME-OFFSET=0,PRECISE=YES` while retaining
the complete growing playlist. The query is not forwarded upstream. Browser
session, generation ownership, and per-request authorization remain in place.
VLC transport is unchanged. This is a candidate fix pending an actual iPhone retest.

Regression tests cover metadata initially reporting zero before live selection,
ignored seeks, pending seeks, frame rounding, preserved later seeks, and the
manifest hint without timeline truncation. All 493 frontend tests, Go tests/vet,
frontend build and diff checks passed.

Timing reference: [WebKit issue 201216](https://bugs.webkit.org/show_bug.cgi?id=201216)
documents native HLS seeks made before the underlying player is ready.

Preview 4 is deployed on Loki as `active-recording-vlc-preview-4`. Docker build,
liveness/readiness, frontend version, security configuration, and unauthenticated
route checks (including the beginning-hint manifest) passed. Preview 3 remains
available for rollback. No commit or push was made.

## QA handoff — 2026-10-09

The maintainer confirmed preview 4 resolves browser Watch from Beginning on
iPhone and requested promotion to QA. Earlier reports confirmed browser start
selection on desktop, VLC behavior on desktop and iPhone, and the separate
recording-management menu. Device/browser/VLC versions were not supplied.

Accepted Loki image: `watch-now:active-recording-vlc-preview-4`, image ID
`sha256:f1320a8eb74de163b8b8c9240fdc516fba410801b59fd98a6d31289a5221f0b1`.
Source: `codex/active-recording-vlc`, based on 1.4.0 commit `97b4ff5`, with
the accepted feature changes. Commit subject: **Add VLC playback for active recordings**.

Candidate scope:

- Authenticated, bounded HLS relay for active-recording VLC playback.
- Beginning/live chooser for VLC in DVR and Live TV Browse/Search.
- Separate manager-only Recording options with existing confirmations.
- Native browser startup correction and beginning hint for iPhone/Safari.
- Regression tests and behavior/validation documentation.

Docky preflight confirmed the existing isolated QA container is healthy.
Promotion follows [the QA deployment procedure](dvr-qa.md): commit the candidate,
build a unique revision-labelled image, transfer and verify its identity, update
only the QA image, preserve configuration and sharing data, and retain rollback.
The existing QA image is `watch-now:qa-standard-player-99a899c`; private deployment
paths and runtime configuration are recorded separately. No production promotion
is authorized by this handoff.

### QA acceptance checklist

Record candidate revision, device/browser/VLC version and account access for each
result. Loki reports do not substitute for checks on the exact QA image.

| Check | Required QA result |
| --- | --- |
| DVR browser, desktop and iPhone | Beginning starts at earliest captured footage; Live joins near the edge |
| DVR VLC, desktop and iPhone | Both starting choices work; Cancel makes no handoff request |
| Live TV Browse/Search | Active-recording VLC uses the same choice; non-recording channels still open live |
| Recording management | Watch menu contains playback only; separate manager menu confirms extend/stop |
| Viewer permissions | View-only accounts cannot manage; restricted channels remain inaccessible |
| Seek and pause | Rewind, seek, Go Live, pause/resume and later playlist updates preserve intended position |
| Completion | Stay behind live through natural completion and an explicitly stopped disposable recording |
| Long pause/reconnect | Check retained HLS behavior across completion; document when reopening finished recording is needed |
| Session revocation | Sign-out or DVR disconnect invalidates subsequent external VLC requests |
| Regression | Ordinary live, finished recordings, Movies and Series still browse and play |
| Casting | Test separately if in intended release scope; no casting acceptance inferred |

Only use disposable recordings for mutation checks. Release acceptance remains
pending QA results; no public version bump is included in this candidate.

The maintainer explicitly authorized the candidate commit and Docky QA deployment
on 2026-10-09 after the handoff checks passed. Exact commit/image identity and
rollback evidence are recorded with the private QA deployment.
