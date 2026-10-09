# Active recording playback in VLC

Watch Now 1.5.0 supports VLC playback while a recording is still in progress. Open **DVR → Recording → Watch options → Watch in VLC**. On desktop,
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

## Validation and compatibility

The maintainer reported successful desktop and iPhone VLC playback and confirmed
that the browser beginning selection works after the native HLS startup fix.
The candidate was accepted on the isolated QA installation. These reports do not
establish every VLC version, casting target, codec or long-pause/completion case.
See [1.5.0 release preparation](release-readiness-1.5.0.md) for evidence and limits.

No additional configuration, transcoder, storage service or recording filesystem
access is required. Existing DVR access and supported HTTP/HLS capabilities apply.
Download and recording sharing still require a playable finished recording.
Managers find Extend 30 minutes and Stop recording in **Recording options**;
watching or closing VLC does not perform either action.
