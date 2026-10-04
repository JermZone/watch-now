# TV Guide (development source)

Live TV now has **Browse / Search / Guide** navigation. Guide is offered when
program search is enabled and the XC client supports bounded multi-day XMLTV.
No feed is fetched merely because the navigation button is visible.

Choose a group, channel or day. A compact day strip and half-hour time slider
move a three-hour window; **Now** returns to the current half-hour. Slider
requests wait until movement pauses, and listings include their dates. Listings
reload on returning to Guide and after the five-minute cache lifetime while
visible. Refresh waits while an airing dialog or slider interaction is active;
failed loads offer Retry instead of a permanent refresh button. Guide supports requests up to
seven days ahead, but channel listings may end sooner or have gaps. This is a
request limit, not a promise of seven days of source data. All times use the
browser's local timezone, shown beside the window. Calendar-date selection uses
local dates, including daylight-saving changes.

Desktop offers a channel/time grid or an agenda. Phones use the agenda.
Selecting a program opens its details without playback. Current programs offer
Watch live; current and future programs can open the existing DVR confirmation
flow. DVR permission checks still happen on the server. A channel's Watch live
button always tunes its current broadcast, regardless of the displayed date.
**View in Guide** in Browse/Search opens Guide filtered to that channel.

Guide filters do not change Browse/Search selections. Existing browser playback
stays mounted when switching Live TV discovery modes. Changing viewer sections
retains the existing playback teardown behavior. No future-airing playback,
catch-up, start-over, recurring recording, or new media engine is included.

## Bounded loading and access

`GET /api/live/guide` accepts UTC `start`/`end`, optional `category_id` and
`channel_id`, and channel page/snapshot parameters. Windows are at most three
hours, no more than three hours behind now, and no further than seven days ahead.
Pages contain at most 20 channels and 500 airings, with a 1 MiB serialized response
ceiling. Dense/oversized responses fail explicitly rather than hiding airings.
The UI can navigate to another window/channel or return to today.

**Load more channels** fetches another page from the same snapshot. To bound the
rendered list, batches hold no more than 60 channels and 500 airings; the next
batch replaces the previous one. A dense next page can also begin a new batch.
Refresh returns to the first page. A snapshot change requires refresh instead of
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

Real household coverage, multi-viewer peak memory, browser-rendered visual QA,
and device recording/playback checks have not been completed for this candidate.
Before release, measure 1/3/7-day feeds against the unchanged budgets; verify
restricted accounts, desktop/mobile guide navigation and exact later-airing
recording on an expendable program. No installation is changed by this source work.

The [draft specification](expanded-tv-guide-spec.md) includes additional proposed
work. This first implementation uses the shared XMLTV index for View in Guide
rather than adding a second per-channel XC schedule transport. A day-long agenda,
per-airing Load more, and broader Search remain follow-ups. The seven-day target
may need a shorter operational range on large feeds; do not increase resource
budgets without measurements.
