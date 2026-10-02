import { useEffect, useState } from 'react';

import { APIError, getProgramSearch } from '../api';
import ChannelArtwork from './ChannelArtwork';

export const LiveSearchModes = ({ onChange, scope }) => (
  <nav aria-label="Live TV search scope" className="live-search-modes">
    {[['all', 'All'], ['channels', 'Channels'], ['now', 'On now'], ['upcoming', 'Upcoming']].map(([value, label]) => (
      <button aria-pressed={scope === value} className={scope === value ? 'is-active' : ''} key={value} onClick={() => onChange(value)} type="button">{label}</button>
    ))}
  </nav>
);

const PAGE_SIZE = 20;
const formatTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
};
const usePrograms = ({ categoryID, debouncedQuery, enabled, onExpired, page, query, status }) => {
  const [state, setState] = useState({ items: [], total: 0, loading: false, error: '', key: '' });
  const key = `${query}\0${categoryID}\0${page}`;
  useEffect(() => {
    if (!enabled || !query.trim()) { setState({ items: [], total: 0, loading: false, error: '', key }); return undefined; }
    if (query.trim() !== debouncedQuery.trim()) { setState({ items: [], total: 0, loading: true, error: '', key }); return undefined; }
    const controller = new AbortController();
    let active = true;
    setState({ items: [], total: 0, loading: true, error: '', key });
    getProgramSearch({ categoryID, search: debouncedQuery, status, page, pageSize: PAGE_SIZE, signal: controller.signal }).then((data) => {
      if (active) setState({ items: Array.isArray(data?.items) ? data.items : [], total: Number(data?.total) || 0, loading: false, error: '', key });
    }).catch((error) => {
      if (!active || error.name === 'AbortError') return;
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setState({ items: [], total: 0, loading: false, error: error.message || 'Show search could not be loaded. Search channels instead.', key });
    });
    return () => { active = false; controller.abort(); };
  }, [categoryID, debouncedQuery, enabled, key, onExpired, page, query, status]);
  return state.key === key ? state : { items: [], total: 0, loading: enabled, error: '' };
};

const Pager = ({ label, onChange, page, total }) => {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  return <div aria-label={`${label} pages`} className="pagination"><button aria-label={`Previous ${label} page`} disabled={page <= 1} onClick={() => onChange(page - 1)} type="button">Previous</button><span>Page {page} of {pages}</span><button aria-label={`Next ${label} page`} disabled={page >= pages} onClick={() => onChange(page + 1)} type="button">Next</button></div>;
};

export const ProgramSearchSection = ({ categoryID, label, onChannels, onPageChange, onSelect, onWatch, page, state, status }) => (
  <section aria-label={`${label} search results`} className="live-search-group">
    <h3>{label}</h3>
    {state.loading ? <p role="status">Searching {label}…</p> : state.error ? <div className="alert" role="alert"><p>{state.error}</p><button className="quiet-button" onClick={onChannels} type="button">Search channels</button></div> : <>
      {state.items.map((result) => <article className="program-search-card" key={result.id}>
        <button className="search-result-select" onClick={() => onSelect(result.channel)} type="button">
          <ChannelArtwork categoryID={categoryID} channel={result.channel} decorative />
          <span className="search-result-copy"><strong>{result.title}</strong><span>{result.channel.channel_number ? `${result.channel.channel_number} · ` : ''}{result.channel.name}</span><span>{formatTime(result.start)}–{formatTime(result.end)}</span>{status === 'upcoming' && <span>Starts {formatTime(result.start)}</span>}</span>
        </button>
        {status === 'now' && <button className="primary-button search-watch-now" onClick={() => onWatch(result.channel)} type="button">Watch Now</button>}
      </article>)}
      {state.items.length === 0 && <p className="section-hint">No matching shows {status === 'now' ? 'on now' : 'in the next 24 hours'}.</p>}
      <Pager label={label} onChange={onPageChange} page={page} total={state.total} />
    </>}
  </section>
);

const LiveSearchResults = ({ categoryID, channels, channelsLoading, debouncedQuery, onExpired, onScopeChange, onSelect, onWatch, query, scope }) => {
  const key = `${query}\0${scope}\0${categoryID}`;
  const [pages, setPages] = useState({ key, channels: 1, now: 1, upcoming: 1 });
  const active = pages.key === key ? pages : { key, channels: 1, now: 1, upcoming: 1 };
  const changePage = (status, page) => setPages({ ...active, [status]: page });
  const now = usePrograms({ categoryID, debouncedQuery, enabled: scope === 'all' || scope === 'now', onExpired, page: active.now, query, status: 'now' });
  const upcoming = usePrograms({ categoryID, debouncedQuery, enabled: scope === 'all' || scope === 'upcoming', onExpired, page: active.upcoming, query, status: 'upcoming' });
  return <div aria-label="Live TV search results" className="live-search-results">
    {(scope === 'all' || scope === 'channels') && <section aria-label="Channels search results" className="live-search-group"><h3>Channels</h3>
      {channelsLoading || query.trim() !== debouncedQuery.trim() ? <p role="status">Searching Channels…</p> : <>
        {channels.slice((active.channels - 1) * PAGE_SIZE, active.channels * PAGE_SIZE).map((channel) => <button className="search-result-select channel-search-result" key={channel.id} onClick={() => onSelect(channel)} type="button"><ChannelArtwork categoryID={categoryID} channel={channel} decorative /><span className="search-result-copy"><strong>{channel.name}</strong><span>{channel.channel_number ? `Channel ${channel.channel_number}` : 'Live channel'}</span></span></button>)}
        {channels.length === 0 && <p className="section-hint">No matching channels.</p>}
        <Pager label="Channels" onChange={(page) => changePage('channels', page)} page={active.channels} total={channels.length} />
      </>}
    </section>}
    {(scope === 'all' || scope === 'now') && <ProgramSearchSection categoryID={categoryID} label="On now" onChannels={() => onScopeChange('channels')} onPageChange={(page) => changePage('now', page)} onSelect={onSelect} onWatch={onWatch} page={active.now} state={now} status="now" />}
    {(scope === 'all' || scope === 'upcoming') && <ProgramSearchSection categoryID={categoryID} label="Upcoming" onChannels={() => onScopeChange('channels')} onPageChange={(page) => changePage('upcoming', page)} onSelect={onSelect} onWatch={onWatch} page={active.upcoming} state={upcoming} status="upcoming" />}
  </div>;
};

export default LiveSearchResults;
