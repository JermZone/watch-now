# Live TV search

The viewer's All, Channels, On now, and Upcoming modes are enabled by default when the XC client supports bulk XMLTV. Set `NOW_PROGRAM_SEARCH_ENABLED=false` to disable them and restore the previous discovery controls.

Browse / Search under the section navigation chooses one discovery interface at a time. Modes are remembered independently for Live TV, Movies and Series. Browse and Search keep separate Live TV selections. Browse remembers its group/channel; Search covers the full authorized lineup and retains its own query/result when you switch modes. Browse ignores stored search text. Movie/series title details reset between modes while their browse category and search text remain separate. Channel selection never autoplays; switching Live TV discovery mode does not stop existing playback. Browse groups never filter Search. Movies and Series show a title-search prompt instead of categories while their query is empty.

All groups channel matches, current program-title matches, and programs starting within the next 24 hours. Channels makes no show-search requests. Program results carry a title, local start/end times, and a viewer-authorized channel. Selecting opens that channel without autoplay; Watch Now explicitly starts current Live playback. Upcoming has no Watch Now action. All groups paginate independently in 20-result pages. Query/scope/category changes reset pages; superseded requests are canceled and stale results are ignored. Clearing restores ordinary browsing.

Search covers all channels in the viewer's authorized lineup. The Browse group is applied only to the Browse list, never to show search or search-channel guide/artwork requests. The API still supports explicit category filters for callers; the discovery UI sends no category for Search. XMLTV is joined against a fresh full viewer lineup.

## HTTP/XC and access

Only XC `get_live_streams` and `xmltv.php` are used for show discovery. The latter requests `days=1&prev_days=0&tvg_id_source=channel_number`. Guide parsing is streaming and retains titles/times only. Descriptions, provider URLs, and XML are not returned or stored. No direct provider calls, management API, database, external XML entities, or per-channel EPG fan-out.

Join only a unique `epg_channel_id` with a matching XMLTV channel display-name. Capture the stream ID at fill time; every later query obtains a fresh lineup and requires the ID, EPG key, and name to still match. Ambiguous IDs and inconsistent names are omitted; no valid mappings returns unavailable. Playback and selected-channel guide retain their fresh access checks. Cache entries use the opaque viewer session ID and cannot be shared across viewers. Logout during fill cannot return or cache completed results for a revoked session.

## Resource limits

- Decompressed transfer: minimum of existing upstream response limit and 32 MiB. Existing total HTTP timeout applies. Reject redirects.
- Retained title index: 8 MiB, including slice capacity estimate and string bytes; at most 50,000 retained programs.
- At most 200,000 scanned program elements. Titles capped at 160 Unicode characters, channel names at 512 bytes, join IDs at 128 bytes.
- At most two guide fills in progress globally. Overlapping fills for the same viewer share one request. A canceled leader aborts its fill; callers may retry.
- Index lifetime: five minutes inside the existing globally bounded cache; no disk persistence. Failed unsupported/oversized fills cool down for one minute. Busy fills do not impose a cooldown.
- Search response holds only one page of at most 50 results while counting matches; it does not allocate a full response per matching program. Index ordering is stable and duplicate programs are removed.

Large feeds remain unavailable rather than partially parsed or accepted with a higher response budget. Unavailable program results offer Search channels. No bulk feed is fetched merely by opening the app or typing in Channels mode.

## Validation and release gate

Go parser/real-XC tests cover XML validity, mapping collisions and mismatched names, duplicate/expired programs, cancellation, redirects, response byte budgets, credential redaction, viewer separation, warm-cache revocation, category/status validation, caching, failure cooldown, two-fill capacity, and logout during fill. Frontend tests cover scopes, grouped results, explicit playback, independent pages/reset, stale-response rejection, and fallback.

Synthetic benchmark: 190 channels with 48 programs each and 512-byte descriptions. Feed 5,878,909 bytes; retained index 1,831,988 estimated bytes. One development-machine parser run: about 123ms, 18,420,136 cumulative allocated bytes, process peak RSS 35,348 KiB. Peak includes benchmark fixture and test runtime; this is not deployed service RSS, HTTP latency, actual household feed size, or a production-load benchmark. The earlier 5,000-channel synthetic guide exceeded 32 MiB and still fails the transfer budget.

Successful guide fills log only aggregate transfer/index bytes, lineup/mapped channel counts, scanned/retained program counts, and duration. No viewer identifiers, credentials, query, channel names, or show titles are logged by this diagnostic.

Earlier development viewer validation (not a validation of the version-1 candidate): 190 of 190 channel mappings; 1,338,317 transfer bytes; 932,303 estimated index bytes; 4,021 scanned and 3,767 retained programs. First guide fetch plus parse/index took 854ms. A sampled isolated-container memory reading after fill was 7.895 MiB, not a peak/load measurement. Phone UI checked at 320px and 390px; real result selection matched the selected-channel guide and did not autoplay. Filters, scope modes, pagination and clearing were verified.

Real device testing confirmed program search and a Kids-only viewer lineup. Automated fixtures also cover separate/revoked lineups and logout during fill. Keep the byte/index/concurrency limits unchanged. This is not a multi-user production load test.

Selecting a channel or a show result, including Watch Now, keeps the Search query, scope, results, and result page. Selection hides the retained results and opens channel details; on phones those details receive focus. Back to search results restores the same results/page without stopping playback. Clicking Search, editing the query, or changing scope also returns to results. Use the clear-search button to remove the query explicitly.
