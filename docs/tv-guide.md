# TV Guide (QA candidate)

Live TV now has **Browse / Search / Guide** navigation. Guide is offered when
program search is enabled and the XC client supports bounded multi-day XMLTV.
No feed is fetched merely because the navigation button is visible.

Choose a group, channel or day. Grid displays the selected local calendar day.
List uses a half-hour slider to move a three-hour window; **Now** returns to the current time. Slider
requests wait until movement pauses, and listings include their dates. Listings
reload on returning to Guide and after the five-minute cache lifetime while
visible. Refresh waits while an airing dialog or slider interaction is active;
failed loads offer Retry instead of a permanent refresh button. Guide supports requests up to
seven days ahead, but channel listings may end sooner or have gaps. Date buttons
(other than Today) appear only for confirmed listings in the filtered lineup.
Coverage uses the existing seven-day cache, falling back to three and one days
if feed limits are exceeded. The API returns at most eight local date strings;
feed, index and response limits remain unchanged; browser batching is bounded below. This is a
request limit, not a promise of seven days of source data. All times use the
browser's local timezone. Calendar-date selection uses
local dates, including daylight-saving changes.

Desktop and phones offer Grid / List, defaulting to Grid and remembering the
layout locally. Mobile Grid uses large sticky channel logos and horizontal
scrolling. A native desktop scrollbar above the grid stays synchronized with
horizontal scrolling without fetching another time window. Today leaves only the elapsed portion of ongoing shows needed to give their
titles readable space. Ended shows remain excluded, and the Now marker shows
the actual current time. Current titles can wrap; the boundary advances with
the guide clock. Future
days open at midnight. Phones retain swipe navigation.
Only List shows the time slider. Each layout retains its own day/time while sharing
channel filters; switching requests the appropriate window. Calendar days use
local midnight boundaries, including 23- and 25-hour daylight-saving days.
The feed cache retains current/upcoming airings only. Listings beyond the feed horizon can be absent on the final date.
Selecting a program opens its details without playback. Current programs offer
Watch live; current and future programs can open the existing DVR confirmation
flow. DVR permission checks still happen on the server. A channel's Watch live
button always tunes its current broadcast, regardless of the displayed date.
In Grid, tap the channel logo to open its Watch live option; opening the dialog
does not start playback. List retains its direct Watch live button.
**View in Guide** in Browse/Search opens Guide filtered to that channel.

Guide filters do not change Browse/Search selections. Existing browser playback
stays mounted when switching Live TV discovery modes. Changing viewer sections
retains the existing playback teardown behavior. No future-airing playback,
catch-up, start-over, recurring recording, or new media engine is included.

## Bounded loading and access

`GET /api/live/guide` accepts UTC `start`/`end`, optional `category_id` and
`channel_id`, browser IANA `timezone`, and channel page/snapshot parameters.
List windows are at most three hours, no more than three hours behind now, and
no further than seven days ahead. Grid windows span exactly one local calendar
day starting today or within the next seven days. The final day's window can
extend past the feed horizon without extending the upstream fetch.
List pages contain at most 20 channels; full-day pages contain at most five.
Both retain the 500-airing and 1 MiB serialized response ceilings.
Dense/oversized responses fail explicitly rather than hiding airings.
The UI can navigate to another window/channel or return to today.

Grid initially combines up to 50 channels from sequential five-channel API pages.
Scrolling near the bottom loads 10 more (two pages). Only visible rows plus a small
overscan are rendered, with fixed row heights preserving the scroll position.
Automatic loading does not move keyboard focus and pauses on errors or during playback.
List retains manual pagination with a 60-channel / 500-airing batch limit.
Grid retains at most 100 channels and 10,000 airings in memory; at the boundary,
**Next channels** begins a fresh batch. The per-response limits remain unchanged.
A manual **Load more channels** button remains available in Grid as a fallback.
Refresh returns to the initial batch. Snapshot changes require refresh instead of
mixing generations. Snapshot identifiers are bound to the session, window,
filters, guide generation, and freshly authorized channel lineup.

The backend chooses a cumulative 1-, 3- or 7-day XMLTV horizon for the requested
window. These downloads are not remote pagination. Pages reuse the process-local
cache; there is no per-channel upstream fan-out. Separate horizon cache entries
share the existing global cache budget. A failed longer-range fill leaves a
previously cached shorter range available; the UI offers Show today. It never
labels a failed fetch as an empty schedule.

Existing limits remain: at most 32 MiB decompressed feed (or the smaller configured
upstream limit), 8 MiB retained index, 50,000 retained programs, 200,000 scanned
programs, two concurrent fills globally, five-minute successful cache lifetime
and one-minute failure cooldown. Credentials and upstream responses are not
logged or sent to the browser. Every page intersects fresh XC channel access;
channel-key/name mapping checks and logout-during-fill checks still apply.

DVR canonical-airing validation now chooses the same bounded longer horizon
when the selected program is beyond 24 hours. Browser-supplied metadata is not
trusted. Existing search remains capped at 24 hours; extending search is a
separate follow-up to this guide implementation.

## Validation and remaining QA

Automated tests cover horizon retention, real-XC window requests, overlapping
programs, cached pagination, snapshot/filter changes, fresh lineup revocation,
invalid ranges, canonical DVR airings beyond 24 hours, stale frontend responses,
mobile agenda rendering, keyboard movement, and playback preservation between
Browse, Search, and Guide (including an empty Browse group). Recording tests
cover warm-cache boundaries at 24 and 72 hours and reject altered airings.
Existing parser budget/concurrency/security tests are reused.

Development feedback confirmed desktop/iPhone controls, grid layout, channel
scrolling, and Search playback return behavior. The maintainer approved production
publication on 2026-10-05 after the private QA deployment. This does not establish
that all manual scenarios below were repeated on the published image. Preserve
multi-viewer memory, restricted-account, exact future-airing recording, and
playback/VLC checks as explicit validation limits unless separately recorded.
Use expendable recordings only. Keep the previous image and Compose configuration
for rollback; restarting requires viewers to sign in again.

Final QA checklist:
- Desktop/iPhone: Grid/List, dates, Now title context, desktop scrollbar and swipe.
- Grid: 50 initial channels, 10 more on scroll, explicit new batch at 100 channels.
- Guide/Search: Watch, Stop/restart and Back restore the expected screen and position.
- Browse Up next description and compact Search airing times.
- One disposable later-airing recording, restricted access, DVR and VLC playback.
- Two simultaneous viewers: responsiveness and memory; Live/Movies/Series regression.

Record release CI and exact published-image checks in the GitHub release record.

The [draft specification](expanded-tv-guide-spec.md) includes additional proposed
work. This first implementation uses the shared XMLTV index for View in Guide
rather than adding a second per-channel XC schedule transport. A day-long agenda,
per-airing Load more, and broader Search remain follow-ups. The seven-day target
may need a shorter operational range on large feeds; do not increase resource
budgets without measurements.

## Guide playback and conflicting listings

Watch live opens a dedicated player view with Back to Guide, channel identity,
current program information when available, and playback controls. Stop ends
playback while leaving the player view open for restarting. Back
stops the stream and restores the mounted Guide's filters, time, and grid scroll
position. Guide auto-refresh pauses while the dedicated player is open.

Grid removes exact duplicate listings and combines overlapping airings into one
block, keeping one row per channel. Tapping a conflict opens a choice of the
original listings; their start/end times and recording actions remain unchanged.
This is a display treatment, not a correction to the provider's EPG data.

Browse shows the supplied description for both Now and Up next. Upcoming shows
retain their own title, times and recording action; only the current show has
a progress indicator. No extra guide request is needed for the description.

Search playback scrolls to and focuses the player. Back to search results stops
playback and restores the retained query, results and page position. Stop alone
leaves channel details open. A stream retained when switching discovery modes
is hidden on the results screen and can be reopened with Return to player.
