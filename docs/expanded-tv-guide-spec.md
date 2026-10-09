# Expanded TV schedule and guide — draft specification

Date: 2026-10-04. Baseline: `qa/dvr` at `5dd49e388a959e870d504ae16d24df76b95b0450`.
Working branch: `codex/expanded-tv-guide-spec`.
Status: draft design. The first Guide implementation is on `codex/expanded-tv-guide`;
see [implemented behavior and remaining QA](tv-guide.md) for the delivered scope.

## Recommendation

Deliver a longer selected-channel schedule first, using **Load more** and day
navigation. Then build a desktop channel/time grid and a mobile agenda using
the same normalized airing model. Target **up to seven days**, subject to the
listings actually supplied and the existing resource budgets. Seven days is a
proposed product ceiling, not a measured promise about this installation.

Keep the DVR QA checkpoint intact. Guide implementation and its validation belong
on a separate feature branch. Existing DVR household sign-off remains separate.

## What we know about schedule depth

| Layer | Current behavior | Meaning |
| --- | --- | --- |
| Selected channel | `LiveEPG` requests XC `get_short_epg` with `limit=6` | Six airings, not six hours or six days |
| Selected-channel response/UI | `guideAt` and `ProgramGuide` expose current and next only | Most fetched future airings are not displayed |
| Show search transfer | XMLTV requested with `days=1`, `prev_days=0` | Requests a one-day forward window |
| Search parser and query | Both independently enforce `now + 24 hours` | Changing only the fetch parameter will not extend search |
| Actual household feed | Not measured in this investigation | Coverage varies by channel and refresh; no verified maximum yet |

Relevant code: [XC client](https://github.com/JermZone/watch-now/blob/v1.4.0/internal/dispatcharr/client.go),
[XMLTV parser](https://github.com/JermZone/watch-now/blob/v1.4.0/internal/dispatcharr/guide.go),
[EPG response](https://github.com/JermZone/watch-now/blob/v1.4.0/internal/httpapi/server.go),
[search](https://github.com/JermZone/watch-now/blob/v1.4.0/internal/httpapi/program_search.go), and
[channel guide](https://github.com/JermZone/watch-now/blob/v1.4.0/frontend/src/components/ProgramGuide.jsx).

Public Dispatcharr v0.31.0 interface implementation confirms:

- XC `get_simple_data_table` can return a channel's longer schedule with a
  positive `days` parameter. It has no offset/cursor pagination in this handler;
  `limit` controls the short-EPG path. Stored short-EPG listings are count-limited.
  [XC reference](https://github.com/Dispatcharr/Dispatcharr/blob/v0.31.0/apps/output/views.py#L785)
- XMLTV accepts positive forward-day requests, bounded upstream to 365. Zero
  removes the forward cutoff for stored listings; it does not create additional
  data. The inspected exporter has no arbitrary future-window offset. Generated
  schedules can also appear, so distant entries alone do not prove real coverage.
  [XMLTV reference](https://github.com/Dispatcharr/Dispatcharr/blob/v0.31.0/apps/output/epg.py#L38)
- REST program search supports time filters, exact channel filtering, field
  selection and pagination. It introduces REST authentication and requires a
  separate authorization review; it is not the default transport proposed here.
  [REST reference](https://github.com/Dispatcharr/Dispatcharr/blob/v0.31.0/apps/epg/api_views.py#L118)

These are source-verified interface capabilities, not live installation tests.
Watch Now must continue checking capabilities/response shapes rather than
requiring an exact Dispatcharr version. Public source inspection does not imply
runtime access to Dispatcharr internals.

## First implementation gate: measure the installed feed

Use an existing authorized test XC account through supported HTTP interfaces.
The account/session or credential-file location has been requested; credentials
must not be pasted into the specification. Do not inspect Dispatcharr storage or
change its settings, guide sources, recordings, or refresh jobs.

1. Fetch the viewer's current lineup. Sample a small, explicit set of accessible
   channels spanning ordinary schedules, sports/event schedules and missing EPG.
2. Probe selected-channel schedules for 1, 3 and 7 days, sequentially. Compare
   actual timestamps and record response sizes and durations. If entries reach
   the seven-day boundary, a bounded 14-day research probe may establish a lower
   bound beyond it; this does not expand the proposed product scope.
3. Probe viewer XMLTV at 1, 3 and 7 days only while each preceding request fits
   existing byte/time limits. Parse in memory as a stream; never save raw feeds.
4. Report channel counts, mapped counts, observed latest start/end, coverage
   distribution at 24/72/168 hours, gaps, program counts, transfer/index bytes,
   duration and process peak RSS. Report sample size and whether results describe
   samples or the full lineup. Distinguish known placeholders from real listings;
   label provenance unknown where the interface cannot establish it.
5. Repeat the relevant access tests with a restricted viewer. A schedule must
   never expose channels outside its fresh XC lineup.

Use redacted failures and aggregate evidence only: no usernames, passwords,
cookies, tokenized URLs, upstream bodies or program descriptions in diagnostics.
Never call an observed final timestamp the definitive provider maximum: request
windows, gaps, generated listings and incomplete refreshes can affect it.

## User experience

### Stage 1: a useful channel schedule

- Preserve the fast Now/Up next view. Add **More schedule** beneath it; entering
  this view explicitly requests the extended channel schedule.
- Display a chronological agenda with Today/Tomorrow/date headings, local start
  and end times, title and episode subtitle when supplied. Descriptions open in
  airing details rather than filling every list row.
- Show 20 airings initially. **Load more** appends the next 20 from the same
  schedule snapshot without repeating the earlier entries or shifting focus.
- Provide a day selector and **Back to now**. Show dates within the requested
  range even when that day has no listings; an empty day is not proof later days
  are empty. Preserve channel, selected day, scroll position and airing when
  returning from details during the same session.
- Cap retained rendered rows at 200; virtualize or use explicit page navigation
  beyond that point. Do not grow the DOM indefinitely.
- Loading more never starts, stops or switches playback. Selecting an airing
  opens details; **Watch live** is explicit and available for current airings.
  Future airings offer details and permission-appropriate **Record**, not future
  playback. Ended airings cannot be scheduled or played as catch-up.
- A failed extension keeps the existing Now/Up next view and offers Retry.
  Changing channels cancels obsolete loads and ignores late responses.

Distinguish these messages:

| State | Suggested copy/action |
| --- | --- |
| More entries in the loaded snapshot | Load more |
| Selected day has no listings | No listings supplied for this day |
| End of a valid loaded schedule | No more listings supplied in this date range |
| Request failed | More schedule is unavailable. Retry |
| Response exceeded a budget | This schedule is too large to load. Try a shorter range |
| Seven-day product boundary | Showing up to seven days |

Do not display “seven days available” merely because seven days were requested.
Coverage labels mean observed listings, not continuous completeness.

### Stage 2: TV Guide

Add **Guide** alongside Live TV's Browse and Search. Leave their existing
selections independent. Guide has its own channel-group filter, selected date,
time and focus position; filters never expand authorization.

| Desktop/tablet with sufficient width | Narrow/mobile layout |
| --- | --- |
| Channel rows and a three-hour time window | Day selector and channel-group selector |
| Sticky channel column and time headings | Channel picker and chronological agenda |
| 30-minute markers and a Now indicator | Large tap targets and date headings |
| Previous/next three hours, date picker, Back to now | Load more with preserved scroll/focus |
| Program details on explicit selection | Same airing details and actions |

Offer an agenda alternative on desktop too. Render only visible rows plus a
small overscan. Clip long programs visually at window boundaries, but keep their
true start/end for details and recording. Represent gaps explicitly. Preserve
overlapping listings without pretending either is definitive; both must remain
reachable in agenda/details. No hover-only information or required drag gestures.

Keyboard requirements: arrows move through grid channels/airings, Enter opens
details, Escape closes details and restores focus, and controls are reachable by
Tab. Announce channel, title, date/time and current/recording state. Keep a focused
item mounted while virtualizing. Test touch, keyboard, screen reader and 200%
zoom, including 320px and 390px widths.

Use the browser's timezone consistently and identify it near date navigation.
Compute calendar-day boundaries in that zone; do not assume every day is 24
hours. API instants use UTC and comparisons use half-open intervals. Include
airings that overlap the displayed window, even if they began earlier.

The channel/time grid, group filtering and selected-program details are familiar
patterns described by [Channels](https://getchannels.com/docs/apps/usage/browsing-whats-on/)
and [Plex](https://support.plex.tv/articles/225877387-program-guide/).
The proposed mobile agenda and explicit playback behavior are Watch Now design
choices. No new artwork dependency, favorites system or copied UI assets are
needed for the first guide.

## Data and API design

### Selected-channel transport

Prefer XC `get_simple_data_table` for Stage 1, only for the channel the viewer
opens. Request an explicit bounded horizon and discard historical entries,
invalid intervals and known no-guide fallback entries. Retain the existing
short-EPG route as the fast fallback. Do not call this endpoint for every channel
to construct a grid.

Proposed conservative limits: request seven days initially, maximum 2 MiB
decompressed response or the smaller configured upstream limit, 2,000 scanned
listings and 1 MiB retained normalized data per channel snapshot. Keep the
existing total timeout. These are proposed ceilings to validate against the
measurement gate, not reasons to silently truncate a successful schedule.
On overflow, offer an explicit one-day retry; do not retry progressively in an
unbounded loop. No unbounded `days=0` application request.

Add a Now-owned route, provisionally
`GET /api/live/channels/{channel_id}/schedule`, with allowed horizons 1/3/7 days,
page size 20 (maximum 50) and an opaque continuation cursor. A new day filter
resets pagination. Validate all parameters before upstream work.

Return narrow airing fields plus requested-window start/end, observed latest
listing end, fetch time, snapshot ID and nullable next cursor. The cursor is
bound to viewer, channel, window, filter and snapshot; it contains no credentials.
Stable order is start/end/airing ID with duplicate suppression. Expired or evicted
snapshots return a specific refresh-required response; the UI replaces the list
instead of appending a new generation. “Has more” means more rows in this
snapshot, never proof of more upstream days.

Recheck the current lineup and session on every page, including cached pages.
Use the existing globally bounded process-local cache, two concurrent guide fills
globally across old/new routes, same-key coalescing, cancellation and a one-minute
failure cooldown. Cache selected-channel snapshots for at most two minutes.
Count normalized strings, slice capacities and metadata toward cache costs.
No additional persistent state or per-user background refresh jobs.

### Grid and search transport

Use the existing viewer-specific XMLTV mechanism for grid-wide data. Begin with
one day; explicit navigation can request a three-day or seven-day snapshot.
These are cumulative upstream downloads, not incremental remote pages. **Load
more rows** is local/API pagination and must not refetch XMLTV each time.

Preserve the current 32 MiB maximum decompressed transfer, 8 MiB retained guide
index, 50,000 retained programs, 200,000 scanned elements, five-minute cache TTL,
shared global cache budget and two-fill limit. Use the smaller configured limits
where applicable. An extension replaces the smaller snapshot atomically only
after a complete successful parse; on failure the earlier valid window remains
usable and the failed range is clearly unavailable. Account for both old/new
live allocations during fill and measure their peak, not just cached bytes.

Treat an 8 MiB per-index limit as a genuine constraint: simply retaining seven
times the current descriptions may not fit. Benchmark the current description
model before committing to seven-day grid support. A later compact summary index
with bounded on-demand details is a separate optimization decision; increasing
budgets or introducing storage is not assumed. If the grid cannot meet the
limits, ship Stage 1 and keep the grid's supported range shorter.

Provisional grid route: `GET /api/live/guide`, with an explicit UTC window
(maximum three hours per response), category and channel-page cursor. Return
20 channels per page (maximum 50), including authorized channels with no guide.
Paginate any unusually dense program response rather than silently dropping
airings; cap each response at 500 airings and 1 MiB. Program mapping must retain
the current unique-key/name checks and fresh stream-ID intersection.

Extend show search only with the shared multi-day guide work. Keep 24 hours as
the default and let the user explicitly select a broader supported range. Update
fetch, parser, query filters, cache identity and result/empty-state wording
together. Failed broader searches must not imply “no matches”; identify the
available narrower range. Preserve title/subtitle/description search behavior.

REST's paginated program search is a future alternative if cumulative XMLTV
transfer proves unsuitable. It must not make basic guide browsing require DVR
permission or silently borrow administrator visibility. Any optional REST mode
needs explicit credentials/role semantics and exact XC lineup intersection.

### DVR integration

The existing `dvrProgram` validates only short EPG or the current one-day index.
Extending the display alone would therefore leave later Record actions failing.
Before enabling Record on later airings, make canonical validation use the
bounded extended selected-channel schedule for the requested horizon. Recheck
permissions, lineup, session and the exact channel/start/end; copy trusted
upstream metadata. A cached browser airing is never authorization.

Changed/missing airings require refresh and confirmation. Preserve one-time
recording, duplicate protection and upstream padding. Scheduling a program a
week away is not recurring/series recording. This work does not add catch-up,
growing-file playback, pause-live, start-over or saved progress.

## Acceptance and release gates

1. Record the actual coverage measurements and choose tested range defaults.
   If credentials remain unavailable, mark this gate pending; source inspection
   alone cannot answer how much data the household currently has.
2. Fixture tests cover different channel horizons, no listings, invalid/dummy
   entries, duplicates, overlaps, gaps, cross-midnight/DST programs, dense feeds,
   cursor tampering/expiry, refresh mid-pagination and all byte/count limits.
3. Access tests cover restricted accounts, warm-cache revocation, mapping
   collisions, logout during fill, credential redaction and concurrency limits.
4. UI tests cover load-more/reset, independent modes, keyboard focus, stale
   response cancellation, preserved playback and truthful end/error states.
5. DVR tests schedule a canonical airing beyond 24 hours, reject an altered or
   revoked airing, and confirm duplicate protection with the extended horizon.
6. Benchmark cold/warm loads at 1/3/7 days, description-heavy fixtures, the
   measured household lineup and simultaneous viewers. Record transfer, index,
   peak RSS and upstream requests. Provisional responsiveness targets: warm
   page results within 500ms and cold household loads within 3s on the test LAN;
   report actual results and revise before release if necessary.
7. Run the repository's Go/frontend checks and Docker build. Perform household
   desktop/mobile guide, permission, recording and playback regression QA on
   the exact candidate before promotion. No deployment/publication is included
   in this specification task.

## Decisions still open

- User preference: incremental channel agenda first (recommended), or grid first.
- Live test account/session for measuring actual data; no secrets in this file.
- Seven-day target versus a shorter validated default after measurement.
- Whether Stage 2's broader search and grid ship together or separately.

The plan is implementable in stages without a database, transcoder, new service,
or direct provider access. Stage 1 can deliver useful extra schedule visibility
even if a full multi-day grid needs additional memory/performance work.
