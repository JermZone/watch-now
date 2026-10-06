import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { APIError, getShareCapabilities, resolveShare } from './api';

const STORAGE = 'watch-now-navigation-v1';
const Navigation = createContext(null);
export const Sharing = createContext(null);
const scrollSelectors = ['window', '.channel-viewport', '.detail-panel', '.live-search-view', '.media-section', '.dvr-section', '.tv-guide-grid', '.tv-guide-agenda'];
const sections = ['live', 'movies', 'series', 'dvr'];
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\\/\x00]/.test(v);
const short = (v) => typeof v === 'string' && v.length <= 256;
const page = (v) => Number.isInteger(v) && v >= 1 && v <= 100000;
const validators = {
 sharedRecording: v => typeof v === 'boolean',
 sharedChannel: v => typeof v === 'boolean', sharedEpisode: v => typeof v === 'boolean',
 searchPages: v => v && typeof v.key === 'string' && v.key.length < 512 && ['channels','now','upcoming'].every(k=>page(v[k])),
 scroll: v => v && Object.keys(v).length <= 12 && Object.entries(v).every(([k,p])=>scrollSelectors.includes(k) && p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= 10000000 && p.y <= 10000000),
 section: (v) => sections.includes(v),
 searches: (v) => v && sections.every(k => short(v[k])),
 discoveryModes: (v) => v && sections.every(k => ['browse', 'search', ...(k === 'live' ? ['guide'] : [])].includes(v[k])),
 categoryID: (v) => v === '' || id(v), guideChannelID: (v) => v === '' || id(v),
 liveSearchScope: (v) => ['all', 'now', 'upcoming', 'channels'].includes(v),
 liveSearchDetail: (v) => typeof v === 'boolean', guidePlayerOpen: (v) => typeof v === 'boolean',
 liveIDs: (v) => v && ['browse', 'search', 'guide'].every(k => v[k] == null || id(v[k])),
 movieBrowse: (v) => v === null || v === 'all' || (v && id(v.id) && (v.name === undefined || short(v.name))),
 seriesBrowse: (v) => validators.movieBrowse(v),
 movieID: (v) => v === '' || id(v), seriesID: (v) => v === '' || id(v), episodeID: (v) => v === '' || id(v),
 season: short, moviePage: page, seriesPage: page, dvrPage: page,
 dvrScope: (v) => ['recorded','recording','scheduled','attention'].includes(v),
 recordingID: (v) => v === '' || id(v),
 guideCategory: (v) => v === '' || id(v),
 guideDay: (v) => Number.isFinite(v) && Math.abs(v - Date.now()) < 8 * 86400000,
 guideStart: (v) => Number.isFinite(v) && Math.abs(v - Date.now()) < 8 * 86400000,
};
export function cleanNavigation(value) {
 const clean = {};
 if (!value || typeof value !== 'object') return clean;
 for (const [key, valid] of Object.entries(validators)) if (valid(value[key])) clean[key] = value[key];
 return clean;
}
export function clearNavigation() { try { sessionStorage.removeItem(STORAGE); } catch { /* optional */ } }
function readNavigation(user) {
 try {
  const raw = sessionStorage.getItem(STORAGE);
  if (!raw || raw.length > 16384) return {};
  const saved = JSON.parse(raw);
  return saved.user === user ? cleanNavigation(saved.value) : {};
 } catch { return {}; }
}
export function useSavedState(key, fallback) {
 const nav = useContext(Navigation);
 const [value, setValue] = useState(() => nav && Object.hasOwn(nav.read(), key) ? nav.read()[key] : typeof fallback === 'function' ? fallback() : fallback);
 useEffect(() => { nav?.save(key, value); }, [key, nav, value]);
 return [value, setValue];
}
export function useNavigationInitial(key) { return useContext(Navigation)?.read()[key]; }
export function useNavigationSave() { return useContext(Navigation)?.save; }
export function targetNavigation(target) {
 const common = { searches: {live:'',movies:'',series:'',dvr:''}, discoveryModes: {live:'browse',movies:'browse',series:'browse',dvr:'browse'} };
 if (target.kind === 'live') return {...common, section:'live', liveIDs:{browse:target.id}, categoryID:'', sharedChannel:true};
 if (target.kind === 'movie') return {...common, section:'movies', movieBrowse:'all', movieID:target.id};
 if (target.kind === 'episode') return {...common, section:'series', seriesBrowse:'all', seriesID:target.id, episodeID:target.episode, sharedEpisode:true};
 return {...common, section:'dvr', recordingID:target.id, dvrScope:'recorded', sharedRecording:true};
}
export default function NavigationRoot({ session, onExpired, children }) {
 const user = session.user.username;
 const [initial, setInitial] = useState(() => readNavigation(user));
 const [generation, setGeneration] = useState(0);
 const current = useRef(initial);
 const timer = useRef(null);
 const [hash, setHash] = useState(() => window.location.hash);
 const [link, setLink] = useState({ loading: window.location.hash.startsWith('#/s/'), error: '' });
 const [retry, setRetry] = useState(0);
 const [enabled, setEnabled] = useState(false);
 const write = useCallback((value) => {
  current.current = cleanNavigation(value);
  try { sessionStorage.setItem(STORAGE, JSON.stringify({user, value:current.current})); } catch { /* optional */ }
 }, [user]);
 const restore = useCallback((value) => { clearTimeout(timer.current); write(value); setInitial(current.current); setGeneration(n => n+1); }, [write]);
 const save = useCallback((key, value) => {
  if (window.location.hash.startsWith('#/s/')) return;
  if (!validators[key]?.(value) || JSON.stringify(current.current[key]) === JSON.stringify(value)) return;
  const changesScreen = ['section','discoveryModes','movieID','seriesID','episodeID'].includes(key);
  write({...current.current, ...(changesScreen ? {scroll:{}} : {}), [key]: value});
  clearTimeout(timer.current);
  timer.current = setTimeout(() => {
   // Browser history contains only this tab's view state, never credentials or playback.
   const next = {watchNow: true, user, value:current.current};
   const before = window.history.state;
   const screen = v => JSON.stringify([v?.section, v?.discoveryModes, v?.movieID, v?.seriesID, v?.episodeID]);
   try { window.history[before?.watchNow && screen(before.value) !== screen(next.value) ? 'pushState' : 'replaceState'](next, '', window.location.pathname + window.location.search); } catch { /* optional */ }
  }, 250);
 }, [user, write]);
 const context = useRef(null);
 // Keep context stable between child state changes; replace only when restoring a view.
 if (!context.current || context.current.initial !== initial) context.current = {initial, save, read: () => current.current};
 useEffect(() => {
  const pop = () => {
   setHash(window.location.hash);
   if (!window.location.hash.startsWith('#/s/')) restore(window.history.state?.user === user ? window.history.state.value : {});
  };
  const hashChanged = () => setHash(window.location.hash);
  window.addEventListener('popstate', pop); window.addEventListener('hashchange', hashChanged);
  return () => { clearTimeout(timer.current); window.removeEventListener('popstate', pop); window.removeEventListener('hashchange', hashChanged); };
 }, [restore, user]);
 useEffect(() => {
  if (hash.startsWith('#/s/')) return;
  const saved = {...current.current.scroll};
  const pending = new Set(Object.keys(saved));
  let frame = null;
  const elements = () => scrollSelectors.map(key => [key, key === 'window' ? document.scrollingElement : document.querySelector(key)]).filter(([,node]) => node);
  const capture = () => {
   if (pending.size || frame !== null) return;
   frame = requestAnimationFrame(() => {
    frame = null;
    const scroll = {};
    for (const [key,node] of elements()) if (node.getClientRects().length) scroll[key] = {x:node.scrollLeft,y:node.scrollTop};
    write({...current.current, scroll});
   });
  };
  const restoreScroll = () => {
   for (const [key,node] of elements()) {
    if (!pending.has(key) || !node.getClientRects().length) continue;
    node.scrollLeft = saved[key].x; node.scrollTop = saved[key].y;
    if (Math.abs(node.scrollTop - saved[key].y) < 2 && Math.abs(node.scrollLeft - saved[key].x) < 2) pending.delete(key);
   }
  };
  const stopRestoring = () => pending.clear();
  const interval = setInterval(restoreScroll, 100);
  const deadline = setTimeout(() => { pending.clear(); clearInterval(interval); }, 5000);
  document.addEventListener('scroll', capture, true);
  document.addEventListener('wheel', stopRestoring, {passive:true});
  document.addEventListener('pointerdown', stopRestoring);
  document.addEventListener('keydown', stopRestoring);
  return () => {
   clearInterval(interval); clearTimeout(deadline); if(frame !== null) cancelAnimationFrame(frame);
   document.removeEventListener('scroll', capture, true); document.removeEventListener('wheel', stopRestoring);
   document.removeEventListener('pointerdown', stopRestoring); document.removeEventListener('keydown', stopRestoring);
  };
 }, [generation, hash, write]);
 useEffect(() => {
  const controller = new AbortController();
  getShareCapabilities({signal:controller.signal}).then(data => { if (!controller.signal.aborted) setEnabled(data.enabled === true); }).catch(() => {});
  return () => controller.abort();
 }, []);
 useEffect(() => {
  if (!hash.startsWith('#/s/')) return;
  clearTimeout(timer.current);
  const controller = new AbortController();
  const token = hash.slice(4);
  setLink({loading:true,error:''});
  if (!/^1[A-Za-z0-9_-]{39,399}$/.test(token)) { setLink({loading:false,error:'This share link is invalid or no longer available.'}); return; }
  resolveShare(token, session.csrf_token, {signal:controller.signal}).then(target => {
   if (controller.signal.aborted) return;
   restore(targetNavigation(target));
   window.history.replaceState({watchNow:true,user,value:current.current}, '', window.location.pathname + window.location.search);
   setHash(''); setLink({loading:false,error:''});
  }).catch(error => {
   if (controller.signal.aborted) return;
   if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
   else setLink({loading:false,error:error.message || 'This item is unavailable.'});
  });
  return () => controller.abort();
 }, [hash, retry, session.csrf_token, restore, user, onExpired]);
 const pending = hash.startsWith('#/s/');
 return <Sharing.Provider value={{enabled, session, onExpired}}>
  {pending ? <main className="splash"><h1>Shared item</h1>{link.loading ? <p role="status">Opening shared item…</p> : <><p role="alert">{link.error}</p><button onClick={() => setRetry(n=>n+1)}>Retry</button><button onClick={() => { window.history.replaceState(null,'',window.location.pathname); setHash(''); setLink({loading:false,error:''}); }}>Continue browsing</button></>}</main>
   : <Navigation.Provider value={context.current}><div key={generation}>{children}</div></Navigation.Provider>}
 </Sharing.Provider>;
}
