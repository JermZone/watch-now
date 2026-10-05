import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { APIError, getTVGuide } from '../api';
import Modal from './Modal';
import { airingTime } from './DVR';
import LoadingIndicator from './LoadingIndicator';
import ChannelArtwork from './ChannelArtwork';

const HOUR = 3600000;
const GRID_ROW_HEIGHT = 89;
const GRID_HEADER_HEIGHT = 40;
const GRID_MAX_CHANNELS = 500;
const GRID_MAX_PROGRAMS = 10000;
const programCount = (rows) => rows.reduce((count, row) => count + row.programs.length, 0);

// Keep the API's five-channel / 1 MiB pages; combine them only in the browser.
async function fetchGuideBatch(params, target, current) {
  let data;
  const items = [];
  let page = params.page || 1;
  let snapshot = params.snapshot || '';
  for (let requests = 0; requests < Math.ceil(target / 5); requests += 1) {
    data = await getTVGuide({ ...params, page, snapshot });
    if (params.signal.aborted || !current()) throw new DOMException('Canceled', 'AbortError');
    items.push(...data.items);
    if (!data.has_more || items.length >= target || !data.items.length) break;
    page = data.page + 1;
    snapshot = data.snapshot;
  }
  return { ...data, items };
}
const midnight = (value) => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };
const followingDay = (value) => { const day = new Date(value); day.setDate(day.getDate() + 1); return day.getTime(); };
const currentWindow = () => Math.floor(Date.now() / (HOUR / 2)) * (HOUR / 2);
const localDate = (value) => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const timeLabel = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dateLabel = (value) => new Date(value).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const empty = { items: [], loading: false, error: '', has_more: false, page: 0, snapshot: '' };

// Collapse exact duplicates and group conflicting airings into one selectable block.
export function guideLanes(programs, start, end) {
  const seen = new Set();
  const groups = [];
  for (const program of [...programs].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end))) {
    const signature = JSON.stringify([program.channel?.id, program.title, program.subtitle || '', program.description || '', program.start, program.end]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const left = Math.max(start, Date.parse(program.start));
    const right = Math.min(end, Date.parse(program.end));
    if (right <= left) continue;
    const previous = groups.at(-1);
    if (previous && left < previous.end) {
      previous.programs.push(program); previous.end = Math.max(previous.end, right);
    } else groups.push({ program, programs: [program], start: left, end: right });
  }
  return groups.map((group) => ({ ...group, lane: 0, left: (group.start - start) / (end - start) * 100, width: (group.end - group.start) / (end - start) * 100 }));
}

// Reserve a readable two-line title, borrowing only elapsed time from an ongoing show.
// Short shows stop at their real start; ended programs never determine the boundary.
export function currentTitleStart(rows, day, now) {
  let start = Math.max(day, now);
  for (const row of rows) for (const program of row.programs) {
    const begins = Date.parse(program.start), ends = Date.parse(program.end);
    if (begins > now || ends <= now || !Number.isFinite(begins) || !Number.isFinite(ends)) continue;
    const titleWidth = Math.min(300, Math.max(180, (program.title || '').length * 7.5 / 2 + 24));
    const neededStart = ends - titleWidth / 200 * HOUR;
    start = Math.min(start, Math.max(day, begins, neededStart));
  }
  return start;
}

export default function TVGuide({ active, suspended = false, categories, channels, isMobile, onExpired, onWatch, onRecord, channelID, onChannelChange }) {
  const [listStart, setStart] = useState(currentWindow);
  const [gridDay, setGridDay] = useState(() => midnight(Date.now()));
  const [sliderStart, setSliderStart] = useState(currentWindow);
  const [categoryID, setCategoryID] = useState('');
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem('watch-now-guide-layout') === 'agenda' ? 'agenda' : 'grid'; } catch { return 'grid'; } });
  const [state, setState] = useState(empty);
  const [retry, setRetry] = useState(0);
  const [details, setDetails] = useState(null);
  const [clock, setClock] = useState(Date.now);
  const requestRef = useRef(null);
  const generation = useRef(0);
  const paging = useRef(false);
  const [viewport, setViewport] = useState({ top: 0, height: 520 });
  const lastScrollTop = useRef(0);
  const moreRef = useRef(null);
  const pageStatusRef = useRef(null);
  const pageFocusPending = useRef(false);
  const agenda = layout === 'agenda';
  const start = agenda ? listStart : gridDay;
  const end = agenda ? start + 3 * HOUR : followingDay(gridDay);
  const currentStart = useMemo(() => currentTitleStart(state.items, gridDay, clock), [state.items, gridDay, clock]);
  const displayStart = agenda ? start : currentStart;
  const timelineWidth = Math.max(600, (end - displayStart) / HOUR * 200);
  const scrollbarRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const gridScrollKey = useRef('');
  const gridScrollPending = useRef(true);
  const laneHeight = 88;
  const gridRef = useRef(null);
  const scrollPosition = useRef({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!suspended && gridRef.current) {
      gridRef.current.scrollLeft = scrollPosition.current.left;
      gridRef.current.scrollTop = scrollPosition.current.top;
      setViewport((value) => ({ ...value, top: gridRef.current.scrollTop }));
    }
  }, [suspended]);
  const watch = (channel) => {
    if (gridRef.current) scrollPosition.current = { left: gridRef.current.scrollLeft, top: gridRef.current.scrollTop };
    onWatch(channel);
  };
  useEffect(() => { try { localStorage.setItem('watch-now-guide-layout', layout); } catch { /* Storage is optional. */ } }, [layout]);
  const syncScrollbar = () => {
    const grid = gridRef.current;
    const scrollbar = scrollbarRef.current;
    if (grid) setViewport((value) => {
      const height = grid.clientHeight || 520;
      return value.height === height ? value : { ...value, height };
    });
    if (!grid || !scrollbar || !grid.clientWidth) return;
    scrollbar.style.width = `${grid.clientWidth}px`;
    scrollbarTrackRef.current.style.width = `${grid.scrollWidth}px`;
    if (scrollbar.scrollLeft !== grid.scrollLeft) scrollbar.scrollLeft = grid.scrollLeft;
  };
  const scrollToDay = () => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.scrollLeft = 0;
    syncScrollbar();
  };
  useLayoutEffect(() => {
    const key = `${active}:${agenda}:${gridDay}`;
    if (gridScrollKey.current !== key) { gridScrollKey.current = key; gridScrollPending.current = true; }
    if (!agenda && active && !state.loading && state.items.length && gridScrollPending.current) {
      scrollToDay(); gridScrollPending.current = false;
    }
    syncScrollbar();
  }, [active, agenda, gridDay, displayStart, isMobile, state.loading, state.items.length]);
  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncScrollbar);
    if (gridRef.current) observer?.observe(gridRef.current);
    window.addEventListener('resize', syncScrollbar);
    return () => { observer?.disconnect(); window.removeEventListener('resize', syncScrollbar); };
  }, []);
  useEffect(() => {
    if (active && !agenda && gridDay < midnight(clock)) setGridDay(midnight(clock));
  }, [active, agenda, gridDay, clock]);
  const today = localDate(clock);
  const latestStart = Math.floor((clock + 7 * 24 * HOUR - 3 * HOUR - 1000) / (HOUR / 2)) * (HOUR / 2);
  const dayStart = new Date(sliderStart); dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart); nextDay.setDate(nextDay.getDate() + 1);
  const sliderMin = Math.max(dayStart.getTime(), currentWindow());
  const sliderMax = Math.max(sliderMin, Math.min(nextDay.getTime() - HOUR / 2, latestStart));
  const days = [];
  for (let day = new Date(clock), i = 0; i < 8; i += 1) {
    day.setHours(0, 0, 0, 0);
    if (day.getTime() > (agenda ? latestStart : clock + 7 * 24 * HOUR)) break;
    if (localDate(day) === today || state.available_dates?.includes(localDate(day))) days.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  useEffect(() => {
    if (!active || !agenda || sliderStart === listStart) return undefined;
    const timer = setTimeout(() => { setDetails(null); setStart(sliderStart); }, 250);
    return () => clearTimeout(timer);
  }, [active, agenda, sliderStart, listStart]);

  useEffect(() => {
    const selected = channels.find((channel) => channel.id === channelID);
    if (selected && categoryID && selected.category_id !== categoryID) setCategoryID('');
  }, [channelID, channels, categoryID]);

  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active) { setDetails(null); return undefined; }
    // A saved window may be behind us after a long visit to another section.
    if ((agenda && start < Date.now() - 3 * HOUR) || (!agenda && gridDay < midnight(Date.now()))) { setStart(currentWindow()); setSliderStart(currentWindow()); setGridDay(midnight(Date.now())); return undefined; }
    const controller = new AbortController();
    requestRef.current?.abort(); requestRef.current = controller;
    const version = ++generation.current;
    paging.current = false;
    if (gridRef.current) gridRef.current.scrollTop = 0;
    lastScrollTop.current = 0;
    setViewport((value) => ({ ...value, top: 0 }));
    setState((previous) => ({ ...empty, available_dates: previous.coverageKey === `${categoryID}:${channelID}` ? previous.available_dates : [], coverageKey: `${categoryID}:${channelID}`, loading: true }));
    const params = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), categoryID, channelID, signal: controller.signal };
    (agenda ? getTVGuide(params) : fetchGuideBatch(params, 50, () => version === generation.current)).then((data) => {
      if (!controller.signal.aborted && version === generation.current) setState({ ...data, coverageKey: `${categoryID}:${channelID}`, receivedAt: Date.now(), loading: false, error: '' });
    }).catch((error) => {
      if (controller.signal.aborted || version !== generation.current) return;
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setState({ ...empty, error: error.message || 'Guide unavailable.' });
    });
    return () => { controller.abort(); generation.current += 1; };
  }, [active, start, end, categoryID, channelID, retry, onExpired]);

  useEffect(() => {
    if (!active || suspended || state.loading || state.error || !state.receivedAt || details || (agenda && sliderStart !== start)) return undefined;
    const fetched = Date.parse(state.fetched_at);
    const expiresAt = (Number.isFinite(fetched) ? fetched : state.receivedAt) + 5 * 60 * 1000 + 1000;
    let requested = false;
    const refreshIfStale = () => {
      if (requested || document.visibilityState === 'hidden' || Date.now() < expiresAt) return;
      requested = true;
      setRetry((value) => value + 1);
    };
    // Avoid tight retries if an upstream/cache timestamp is unexpectedly old.
    const timer = setTimeout(refreshIfStale, Math.max(30000, expiresAt - Date.now()));
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refreshIfStale); };
  }, [active, suspended, state.loading, state.error, state.fetched_at, state.receivedAt, details, sliderStart, start, agenda]);

  useEffect(() => {
    if (!state.loading && pageFocusPending.current) {
      pageFocusPending.current = false;
      (moreRef.current || pageStatusRef.current)?.focus();
    }
  }, [state.loading, state.has_more]);

  const batchLimit = agenda
    ? state.items.length >= 60 || programCount(state.items) >= 500
    : state.items.length >= GRID_MAX_CHANNELS || programCount(state.items) >= GRID_MAX_PROGRAMS;
  const loadMore = async (automatic = false) => {
    if (state.loading || paging.current || !state.has_more || (automatic && (state.error || batchLimit || suspended))) return;
    paging.current = true;
    const controller = new AbortController(); requestRef.current = controller;
    const version = generation.current;
    setState((value) => ({ ...value, loading: true, error: '' }));
    try {
      const params = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), categoryID, channelID, page: state.page + 1, snapshot: state.snapshot, signal: controller.signal };
      const data = agenda ? await getTVGuide(params) : await fetchGuideBatch(params, 10, () => version === generation.current);
      if (!controller.signal.aborted && version === generation.current) {
        const combined = [...state.items, ...data.items];
        const replace = batchLimit || programCount(combined) > (agenda ? 500 : GRID_MAX_PROGRAMS);
        pageFocusPending.current = !automatic;
        if (replace && gridRef.current) {
          gridRef.current.scrollTop = 0; lastScrollTop.current = 0;
          setViewport((value) => ({ ...value, top: 0 }));
        }
        setState({ ...data, coverageKey: `${categoryID}:${channelID}`, receivedAt: Date.now(), items: replace ? data.items : combined, loading: false, error: '' });
      }
    } catch (error) {
      if (controller.signal.aborted || version !== generation.current) return;
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setState((value) => error.code === 'guide_changed' ? { ...empty, error: error.message } : { ...value, loading: false, error: error.message });
    } finally {
      if (version === generation.current) paging.current = false;
    }
  };
  const handleGridScroll = () => {
    syncScrollbar();
    const grid = gridRef.current;
    if (!grid || agenda) return;
    const movingDown = grid.scrollTop > lastScrollTop.current;
    lastScrollTop.current = grid.scrollTop;
    setViewport((value) => value.top === grid.scrollTop ? value : { ...value, top: grid.scrollTop });
    if (movingDown && active && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 3 * GRID_ROW_HEIGHT) loadMore(true);
  };
  const firstRow = agenda ? 0 : Math.min(Math.max(0, state.items.length - 1), Math.max(0, Math.floor((viewport.top - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT) - 3));
  const lastRow = agenda ? state.items.length : Math.min(state.items.length, firstRow + Math.ceil(viewport.height / GRID_ROW_HEIGHT) + 6);
  const visibleRows = state.items.slice(firstRow, lastRow);
  // A paging request is also canceled when leaving the mode or unmounting.
  useEffect(() => () => requestRef.current?.abort(), [active, start, end, categoryID, channelID]);

  const changeDay = (value) => {
    if (!agenda) { setDetails(null); gridScrollPending.current = midnight(value) !== gridDay; if (midnight(value) === gridDay) scrollToDay(); setGridDay(midnight(value)); return; }
    const next = new Date(value);
    next.setHours(new Date(sliderStart).getHours(), new Date(sliderStart).getMinutes());
    const target = Math.max(currentWindow(), Math.min(next.getTime(), latestStart));
    setDetails(null); setSliderStart(target); setStart(target);
  };
  const keyNavigation = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !event.target.matches('[data-airing]')) return;
    const row = event.target.closest('[data-guide-row]');
    const rows = [...event.currentTarget.querySelectorAll('[data-guide-row]')];
    const buttons = [...row.querySelectorAll('[data-airing]')];
    let target;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = buttons[buttons.indexOf(event.target) + (event.key === 'ArrowLeft' ? -1 : 1)];
    else {
      const nextRow = rows[rows.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)];
      const candidates = [...(nextRow?.querySelectorAll('[data-airing]') || [])];
      target = candidates.sort((a, b) => Math.abs(Number(a.dataset.start) - Number(event.target.dataset.start)) - Math.abs(Number(b.dataset.start) - Number(event.target.dataset.start)))[0];
    }
    if (target) { event.preventDefault(); target.focus(); }
  };
  const resetNow = () => { setDetails(null); setSliderStart(currentWindow()); setStart(currentWindow()); setGridDay(midnight(Date.now())); gridScrollPending.current = true; if (!agenda) scrollToDay(); setRetry((value) => value + 1); };
  const programButton = (program, style) => <button data-airing data-start={Date.parse(program.start)} style={style} className={`tv-guide-program${Date.parse(program.start) <= clock && Date.parse(program.end) > clock ? ' is-current' : ''}`} title={program.title} key={program.id} onClick={() => setDetails(program)} type="button" aria-label={`${program.channel.name}, ${program.title}, ${airingTime(program)}`}><strong>{program.title || 'Untitled program'}</strong><span>{dateLabel(program.start)} · {timeLabel(program.start)} – {localDate(program.start) !== localDate(program.end) ? `${dateLabel(program.end)} · ` : ''}{timeLabel(program.end)}</span>{program.subtitle && <span>{program.subtitle}</span>}</button>;

  const layoutControl = <div className="tv-guide-layout" role="group" aria-label="Guide layout"><button type="button" aria-pressed={!agenda} onClick={() => setLayout('grid')}>Grid</button><button type="button" aria-pressed={agenda} onClick={() => setLayout('agenda')}>List</button></div>;

  return <section className="tv-guide" hidden={!active} aria-label="TV Guide">
    <div className="tv-guide-controls">
      <label>Guide group<select value={categoryID} onChange={(e) => { setCategoryID(e.target.value); onChannelChange(''); }}><option value="">All channels</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Guide channel<select value={channelID} onChange={(e) => onChannelChange(e.target.value)}><option value="">All channels</option>{channels.filter((c) => !categoryID || c.category_id === categoryID).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {isMobile && layoutControl}
    </div>
    <div className={isMobile ? undefined : "tv-guide-daybar"}>
    <div className="tv-guide-days" role="group" aria-label="Guide day"><button onClick={resetNow} type="button">Now</button>{days.map((day) => <button key={day} type="button" aria-pressed={localDate(day) === localDate(agenda ? sliderStart : gridDay)} onClick={() => changeDay(day)}>{localDate(day) === today ? 'Today' : dateLabel(day)}</button>)}</div>
      {!isMobile && layoutControl}
    </div>
    <div className="tv-guide-timeline" hidden={!agenda}>
      <label className="tv-guide-slider">Guide time
        <span>{dateLabel(sliderStart)} · {timeLabel(sliderStart)} – {localDate(sliderStart) !== localDate(sliderStart + 3 * HOUR) ? `${dateLabel(sliderStart + 3 * HOUR)} · ` : ''}{timeLabel(sliderStart + 3 * HOUR)}</span>
        <input type="range" min={sliderMin} max={sliderMax} step={HOUR / 2} value={Math.max(sliderMin, Math.min(sliderStart, sliderMax))} aria-label="Guide start time" aria-valuetext={`${dateLabel(sliderStart)}, ${timeLabel(sliderStart)}`} onChange={(event) => setSliderStart(Number(event.target.value))} />
        <span className="tv-guide-slider-ends"><span>{localDate(sliderMin) === today ? 'Now' : timeLabel(sliderMin)}</span><span>{timeLabel(sliderMax)}</span></span>
      </label>
    </div>
    {state.error && <div role="alert" className="alert"><p>{state.error}</p><button onClick={() => setRetry((value) => value + 1)} type="button">Retry guide</button><button onClick={resetNow} type="button">Show today</button></div>}
    {state.loading && state.items.length === 0 && <p role="status"><LoadingIndicator />Loading guide…</p>}
    {!agenda && !isMobile && <div ref={scrollbarRef} className="tv-guide-scrollbar" role="region" aria-label="Schedule horizontal scrollbar" tabIndex={0} onScroll={() => { if (gridRef.current && scrollbarRef.current.scrollLeft !== gridRef.current.scrollLeft) gridRef.current.scrollLeft = scrollbarRef.current.scrollLeft; }}><div ref={scrollbarTrackRef} /></div>}
    <div aria-busy={state.loading} onScroll={handleGridScroll} style={agenda ? undefined : { '--guide-time-width': `${timelineWidth}px`, '--guide-channel-width': isMobile ? '108px' : '180px' }} ref={gridRef} tabIndex={agenda ? undefined : 0} role={agenda ? undefined : "region"} aria-label={agenda ? undefined : "Schedule grid, scroll for more times"} className={agenda ? 'tv-guide-agenda' : 'tv-guide-grid'} onKeyDown={keyNavigation}>
      {!agenda && <div className="tv-guide-heading"><span>Channel</span><div className="tv-guide-time-labels"><span hidden={clock > displayStart && clock < end && (clock - displayStart) / (end - displayStart) * timelineWidth < 65} style={{ left: 0 }}>{displayStart === clock ? 'Now' : timeLabel(displayStart)}</span>{Array.from({ length: Math.max(0, Math.ceil((end - displayStart) / (HOUR / 2))) }, (_, i) => Math.ceil(displayStart / (HOUR / 2)) * (HOUR / 2) + i * HOUR / 2).filter((time) => time > displayStart && time < end && (time - displayStart) / (end - displayStart) * timelineWidth > 55 && (clock < displayStart || clock >= end || Math.abs(time - clock) / (end - displayStart) * timelineWidth > 55)).map((time) => <span key={time} style={{ left: `${(time - displayStart) / (end - displayStart) * 100}%` }}>{timeLabel(time)}</span>)}{clock > displayStart && clock < end && <span className="tv-guide-now-label" style={{ left: `${(clock - displayStart) / (end - displayStart) * 100}%` }}>Now</span>}</div></div>}
      {!agenda && firstRow > 0 && <div aria-hidden="true" style={{ height: firstRow * GRID_ROW_HEIGHT }} />}
      {visibleRows.map((row) => {
        const lanes = guideLanes(row.programs.filter((program) => Date.parse(program.end) > clock), displayStart, end);
        const laneCount = Math.max(1, ...lanes.map((p) => p.lane + 1));
        return <div className="tv-guide-row" data-guide-row key={row.channel.id}>
          <div className="tv-guide-channel" role="group" aria-label={`${row.channel.channel_number || ''} ${row.channel.name}`.trim()} title={row.channel.name}>{agenda ? <><strong>{row.channel.channel_number} {row.channel.name}</strong><button onClick={() => watch(row.channel)} type="button">Watch live</button></> : <button className="tv-guide-logo-button" aria-label={`Options for ${row.channel.name}`} aria-haspopup="dialog" onClick={() => setDetails({ channelOnly: true, channel: row.channel, title: row.channel.name })} type="button"><ChannelArtwork channel={row.channel} categoryID={categoryID} size="compact" /></button>}</div>
          <div className="tv-guide-airings" style={agenda ? undefined : { height: `${laneCount * laneHeight}px` }}>
            {!row.programs.length && <p className="section-hint">No listings supplied for this time.</p>}
            {agenda ? row.programs.map((program) => programButton(program)) : lanes.map(({ program, programs, lane, left, width }) => programs.length === 1 ? programButton(program, { left: `${left}%`, width: `${width}%`, top: `${lane * laneHeight}px` }) : <button className="tv-guide-program" data-airing data-start={Date.parse(program.start)} key={program.id} style={{ left: `${left}%`, width: `${width}%`, top: 0 }} type="button" aria-label={`${row.channel.name}, ${programs.length} overlapping listings`} onClick={() => setDetails({ conflicts: programs, channel: row.channel, title: 'Overlapping listings' })}><strong>{program.title}</strong><span>{programs.length} overlapping listings</span><span>Tap to choose a program</span></button>)}
            {!agenda && clock >= displayStart && clock < end && <span className="tv-guide-now" aria-hidden="true" style={{ left: `${(clock - displayStart) / (end - displayStart) * 100}%` }} />}
          </div>
        </div>;
      })}
      {!agenda && lastRow < state.items.length && <div aria-hidden="true" style={{ height: (state.items.length - lastRow) * GRID_ROW_HEIGHT }} />}
    </div>
    {!state.loading && !state.error && state.items.length === 0 && <p>No channels available in this view.</p>}
    <p ref={pageStatusRef} tabIndex="-1" className="section-hint" aria-live="polite">{state.items.length > 0 ? `Showing ${state.items.length} channels in this batch.` : ''}</p>
    {state.has_more && (agenda || batchLimit) && <button ref={moreRef} disabled={state.loading} onClick={() => loadMore()} type="button">{state.loading ? 'Loading channels…' : batchLimit ? 'Next channels' : 'Load more channels'}</button>}
    {state.items.length > 0 && !state.has_more && <p className="section-hint">End of channels in this view. Choose another day or time to browse more schedule.</p>}
    {details && active && <Modal key={details.id || (details.conflicts ? 'conflicts' : 'channel')} labelledBy="guide-airing-title" onClose={() => setDetails(null)}>
      <h2 id="guide-airing-title">{details.title}</h2>{details.conflicts ? <><p>The guide supplies conflicting times for {details.channel.name}. Choose a listing to see its details.</p><div className="guide-conflict-list">{details.conflicts.map((program, index) => <button key={index} type="button" onClick={() => setDetails(program)}><strong>{program.title}</strong><span>{airingTime(program)}</span>{program.subtitle && <span>{program.subtitle}</span>}</button>)}</div></> : details.channelOnly ? <p>Watch this channel’s current live broadcast.</p> : <><p>{details.channel.name}</p><p>{airingTime(details)}</p></>}{details.subtitle && <h3>{details.subtitle}</h3>}{details.description && <p>{details.description}</p>}
      {(details.channelOnly || (Date.parse(details.start) <= clock && Date.parse(details.end) > clock)) && <button onClick={() => { watch(details.channel); setDetails(null); }} type="button">Watch live</button>}
      {onRecord && Date.parse(details.end) > clock && <button onClick={() => { setDetails(null); onRecord(details); }} type="button">Record</button>}
      <button onClick={() => setDetails(null)} type="button">Close</button>
    </Modal>}
  </section>;
}
