import DVRSection, { airingTime, RecordButton, RecordDialog, useDVR } from './DVR';
import Modal from './Modal';
import LoadingIndicator from './LoadingIndicator';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { APIError, createLiveVLC, getCategories, getChannels, getEPG, getLiveSearchCapabilities, logout } from '../api';
import ChannelArtwork from './ChannelArtwork';
import LivePlayer from './LivePlayer';
import MoviesSection from './MoviesSection';
import ProgramGuide from './ProgramGuide';
import TVGuide from './TVGuide';
import SeriesSection from './SeriesSection';
import SearchField from './SearchField';
import LiveSearchResults, { LiveSearchModes } from './LiveSearchResults';
import VirtualChannelList from './VirtualChannelList';
import { filterLiveChannels } from './liveSearch';
import { applyAppearance, readAppearance } from '../appearance';
import WatchControl from './WatchControl';
import VLCPlaylistHandoff from './VLCPlaylistHandoff';
import { openVLC } from './vlc';

export const PHONE_LAYOUT_QUERY = '(max-width: 600px), (max-height: 500px) and (max-width: 950px) and (orientation: landscape) and (hover: none) and (pointer: coarse)';

const useMobileLayout = () => {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(PHONE_LAYOUT_QUERY).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia(PHONE_LAYOUT_QUERY);
    const update = (event) => setIsMobile(event.matches);
    setIsMobile(mediaQuery.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', update);
      return () => mediaQuery.removeEventListener('change', update);
    }
    mediaQuery.addListener?.(update);
    return () => mediaQuery.removeListener?.(update);
  }, []);
  return isMobile;
};

const useDebouncedValue = (value, delay = 400) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === '') { setDebounced(''); return undefined; }
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return value === '' ? '' : debounced;
};

const ViewerShell = ({ session, onExpired }) => {
  const [section, setSection] = useState('live');
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appearance, setAppearance] = useState(readAppearance);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);
  const [dvrEnabled, setDVREnabled] = useState(false);
  const dvr = useDVR(dvrEnabled, session, onExpired);
  const [recordProgram, setRecordProgram] = useState(null);
  const [selectedAiring, setSelectedAiring] = useState(null);
  const [programSearchEnabled, setProgramSearchEnabled] = useState(false);
  const [tvGuideEnabled, setTVGuideEnabled] = useState(false);
  const [guideChannelID, setGuideChannelID] = useState('');
  const [liveSearchScope, setLiveSearchScope] = useState('all');
  const [liveSearchDetail, setLiveSearchDetail] = useState(false);
  const [searches, setSearches] = useState({ live: '', movies: '', series: '', dvr: '' });
  const debouncedMoviesSearch = useDebouncedValue(searches.movies);
  const debouncedSeriesSearch = useDebouncedValue(searches.series);
  const debouncedLiveSearch = useDebouncedValue(searches.live, 500);
  const [movieBrowse, setMovieBrowse] = useState(null);
  const [seriesBrowse, setSeriesBrowse] = useState(null);
  const [movieCategories, setMovieCategories] = useState(null);
  const [seriesCategories, setSeriesCategories] = useState(null);

  const [categories, setCategories] = useState([]);
  const [categoryID, setCategoryID] = useState('');
  const [channels, setChannels] = useState([]);
  const [liveSelections, setLiveSelections] = useState({ browse: null, search: null });
  const [categoriesState, setCategoriesState] = useState({ loading: true, error: '' });
  const [channelsState, setChannelsState] = useState({ loading: true, error: '' });
  const [categoryRetry, setCategoryRetry] = useState(0);
  const [channelRetry, setChannelRetry] = useState(0);
  const [guideRetry, setGuideRetry] = useState(0);
  const [guideState, setGuideState] = useState({ loading: false, error: '', guide: null });
  const [actionError, setActionError] = useState('');
  const [livePlaybackError, setLivePlaybackError] = useState('');
  const [activeLiveID, setActiveLiveID] = useState(null);
  const [guidePlayerOpen, setGuidePlayerOpen] = useState(false);
  const guideReturnRef = useRef(null);
  const guideScrollY = useRef(0);
  const returningToGuide = useRef(false);
  const [vlcState, setVlcState] = useState({ loading: false, error: '', ready: false, title: '' });
  const vlcRequestRef = useRef(0);
  const vlcControllerRef = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  const [channelSelectorOpen, setChannelSelectorOpen] = useState(false);
  const [discoveryModes, setDiscoveryModes] = useState({ live: 'browse', movies: 'browse', series: 'browse', dvr: 'browse' });
  const browseOpen = programSearchEnabled && discoveryModes.live === 'browse';
  const discoveryMode = discoveryModes[section];
  const selectDiscoveryMode = (mode) => {
    setGuidePlayerOpen(false);
    setDiscoveryModes((current) => ({ ...current, [section]: mode }));
    if (section === 'live' && mode === 'search') setLiveSearchDetail(false);
    setChannelSelectorOpen(false);
  };
  const liveMode = programSearchEnabled ? discoveryModes.live : 'browse';
  const selected = liveSelections[liveMode] || (liveMode === 'guide' ? liveSelections.browse : null) || ((liveMode === 'search' || liveMode === 'guide') && activeLiveID ? channels.find((channel) => channel.id === activeLiveID) : null);
  const vlcContextKey = `${section}:${liveMode}:${categoryID}:${selected?.id || ''}`;
  useLayoutEffect(() => {
    vlcRequestRef.current += 1;
    vlcControllerRef.current?.abort();
    vlcControllerRef.current = null;
    setVlcState({ loading: false, error: '', ready: false, title: '' });
    return () => {
      vlcRequestRef.current += 1;
      vlcControllerRef.current?.abort();
      vlcControllerRef.current = null;
    };
  }, [vlcContextKey]);
  const setSelected = (value) => setLiveSelections((current) => ({ ...current, [liveMode]: typeof value === 'function' ? value(current[liveMode]) : value }));
  const guideCategoryID = programSearchEnabled && liveMode !== 'browse' ? '' : categoryID;
  const catalogCategoryID = programSearchEnabled ? '' : categoryID;
  const effectiveMoviesSearch = programSearchEnabled && discoveryModes.movies === 'browse' ? '' : debouncedMoviesSearch;
  const effectiveSeriesSearch = programSearchEnabled && discoveryModes.series === 'browse' ? '' : debouncedSeriesSearch;
  const detailRef = useRef(null);
  const livePlayerRef = useRef(null);
  const [guideWatchRequest, setGuideWatchRequest] = useState(0);
  useEffect(() => {
    if (!guideWatchRequest) return;
    // Run after the airing dialog closes and restores its previous focus.
    livePlayerRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [guideWatchRequest]);
  useEffect(() => {
    if (guidePlayerOpen || !returningToGuide.current) return;
    returningToGuide.current = false;
    guideReturnRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: guideScrollY.current, behavior: 'instant' });
  }, [guidePlayerOpen]);
  const searchResultsRef = useRef(null);
  const pendingSearchFocus = useRef(false);
  const pendingDetailFocus = useRef(false);
  const guideRequestRef = useRef(0);
	const categoriesRequestRef = useRef(0);
	const channelsRequestRef = useRef(0);
  const isMobile = useMobileLayout();
  const searchingLive = programSearchEnabled && liveMode === 'search' && searches.live.trim() !== '';
  useEffect(() => {
    const controller = new AbortController();
    getLiveSearchCapabilities({ signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) { setProgramSearchEnabled(data.program_search === true); setDVREnabled(data.dvr === true); setTVGuideEnabled(data.guide === true); }
    }).catch((error) => {
      if (!controller.signal.aborted && error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
    });
    return () => controller.abort();
  }, [onExpired]);


  const handleError = useCallback((error, setter) => {
    if (error instanceof APIError && error.status === 401) {
      onExpired('Your viewer session expired. Sign in again.');
      return;
    }
    setter({ loading: false, error: error.message || 'The request failed.' });
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
	const requestID = ++categoriesRequestRef.current;
    setCategoriesState({ loading: true, error: '' });
    getCategories({ signal: controller.signal }).then((data) => {
	  if (requestID !== categoriesRequestRef.current) return;
      setCategories(Array.isArray(data) ? data : []);
      setCategoriesState({ loading: false, error: '' });
	}).catch((error) => { if (requestID === categoriesRequestRef.current && error.name !== 'AbortError') handleError(error, setCategoriesState); });
	return () => { categoriesRequestRef.current += 1; controller.abort(); };
  }, [categoryRetry, handleError]);

  useEffect(() => {
    const controller = new AbortController();
	const requestID = ++channelsRequestRef.current;
    setChannelsState({ loading: true, error: '' });
    if (!programSearchEnabled) { setSelected(null); setActiveLiveID(null); }
    getChannels(catalogCategoryID, { signal: controller.signal }).then((data) => {
	  if (requestID !== channelsRequestRef.current) return;
      const next = Array.isArray(data) ? data : [];
      setChannels(next);
      if (programSearchEnabled) {
        setLiveSelections((current) => {
          const inBrowse = next.filter((channel) => !categoryID || channel.category_id === categoryID);
          return { ...current, guide: next.find((channel) => channel.id === current.guide?.id) || null, browse: inBrowse.find((channel) => channel.id === current.browse?.id) || inBrowse[0] || null, search: next.find((channel) => channel.id === current.search?.id) || null };
        });
      } else setSelected(next[0] || null);
      setChannelsState({ loading: false, error: '' });
	}).catch((error) => { if (requestID === channelsRequestRef.current && error.name !== 'AbortError') handleError(error, setChannelsState); });
	return () => { channelsRequestRef.current += 1; controller.abort(); };
  }, [catalogCategoryID, channelRetry, handleError, programSearchEnabled]);

  useEffect(() => {
    if (!programSearchEnabled || channelsState.loading || channelsState.error) return;
    const available = channels.filter((channel) => !categoryID || channel.category_id === categoryID);
    setLiveSelections((current) => ({ ...current, browse: available.find((channel) => channel.id === current.browse?.id) || available[0] || null }));
  }, [categoryID, channels, channelsState.loading, channelsState.error, programSearchEnabled]);

  useEffect(() => {
    if (!selected) {
      guideRequestRef.current += 1;
      setGuideState({ loading: false, error: '', guide: null });
      return undefined;
    }
    const requestID = ++guideRequestRef.current;
    const controller = new AbortController();
    setGuideState({ loading: true, error: '', guide: null });
    getEPG(selected.id, guideCategoryID, { signal: controller.signal }).then((guide) => {
      if (requestID === guideRequestRef.current) setGuideState({ loading: false, error: '', guide });
    }).catch((error) => {
      if (requestID !== guideRequestRef.current || error.name === 'AbortError') return;
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setGuideState({ loading: false, error: error.message || 'The program guide could not be loaded.', guide: null });
    });
    return () => { guideRequestRef.current += 1; controller.abort(); };
  }, [guideCategoryID, guideRetry, onExpired, selected]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selected || section !== 'live' || guideState.loading || guideState.error) return undefined;
    const guide = guideState.guide;
    const boundaries = [guide?.current?.end, guide?.upcoming?.start]
      .map((value) => Date.parse(value)).filter((value) => value > Date.now());
    // Retry empty/stale guides slowly. Only the selected channel is refreshed.
    const delay = boundaries.length ? Math.min(...boundaries) - Date.now() + 100 : 120_000;
    const timer = window.setTimeout(() => { setNow(Date.now()); setGuideRetry((value) => value + 1); }, Math.max(1000, Math.min(delay, 120_000)));
    const resume = () => { if (document.visibilityState === 'visible') setGuideRetry((value) => value + 1); };
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [guideState, section, selected]);
  useEffect(() => { if (!isMobile) setChannelSelectorOpen(false); }, [isMobile]);
  useEffect(() => {
    if (pendingDetailFocus.current && !channelSelectorOpen && selected) {
      pendingDetailFocus.current = false;
      detailRef.current?.focus();
    }
  }, [channelSelectorOpen, selected, liveSearchDetail]);

  useEffect(() => {
    if (!liveSearchDetail && pendingSearchFocus.current) {
      pendingSearchFocus.current = false;
      searchResultsRef.current?.focus();
    }
  }, [liveSearchDetail]);

  const selectedCategory = useMemo(() => categories.find((category) => category.id === categoryID), [categories, categoryID]);
  const visibleChannels = useMemo(() => {
    const lineup = programSearchEnabled && liveMode === 'browse' ? channels.filter((channel) => !categoryID || channel.category_id === categoryID) : channels;
    return filterLiveChannels(lineup, programSearchEnabled && liveMode === 'browse' ? '' : debouncedLiveSearch);
  }, [channels, debouncedLiveSearch, categoryID, liveMode, programSearchEnabled]);

  const signOut = async () => {
    vlcRequestRef.current += 1;
    vlcControllerRef.current?.abort();
    vlcControllerRef.current = null;
    setVlcState({ loading: false, error: '', ready: false, title: '' });
    setMenuOpen(false);
    setActionError('');
    setActiveLiveID(null);
    try {
      await logout(session.csrf_token);
      onExpired('You signed out.');
    } catch (error) {
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setActionError(error.message || 'Sign out could not be completed.');
    }
  };
  const selectChannel = (channel) => {
    setSelectedAiring(null);
    setLivePlaybackError('');
    setSelected(channel);
    if (isMobile) { pendingDetailFocus.current = true; setChannelSelectorOpen(false); }
  };
  const changeSection = (next) => {
    setGuidePlayerOpen(false);
    if (next !== 'live') setActiveLiveID(null);
    setLivePlaybackError('');
    setMenuOpen(false);
    setSection(next);
    menuButtonRef.current?.focus();
  };
  const fatalLivePlayback = useCallback((message) => {
    setActiveLiveID(null);
    setLivePlaybackError(message || 'Live playback failed. Please try again.');
  }, []);
  const openLiveInVLC = async () => {
    if (!selected || vlcControllerRef.current) return;
    const channel = selected;
    const requestID = ++vlcRequestRef.current;
    const controller = new AbortController();
    vlcControllerRef.current = controller;
    setVlcState((state) => ({ ...state, loading: true, error: '' }));
    try {
      const result = await createLiveVLC(channel.id, session.csrf_token, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== vlcRequestRef.current) return;
      // Complete LivePlayer teardown before navigating to VLC or downloading
      // its playlist, including when another channel is playing in the browser.
      flushSync(() => { setSelected(channel); setActiveLiveID(null); setLivePlaybackError(''); });
      const mode = openVLC(result.launch_url, channel.name);
      setVlcState({ loading: false, error: '', ready: mode === 'playlist', title: mode === 'playlist' ? channel.name : '' });
    } catch (error) {
      if (controller.signal.aborted || requestID !== vlcRequestRef.current) return;
      if (error instanceof APIError && error.status === 401) onExpired('Your viewer session expired. Sign in again.');
      else setVlcState((state) => ({ ...state, loading: false, error: 'VLC handoff could not be completed. Please try again.' }));
    } finally {
      if (vlcControllerRef.current === controller) vlcControllerRef.current = null;
    }
  };
  const closeLiveVLCHandoff = () => {
    vlcRequestRef.current += 1;
    vlcControllerRef.current?.abort();
    vlcControllerRef.current = null;
    setVlcState({ loading: false, error: '', ready: false, title: '' });
  };
  const playingChannel = channels.find((channel) => channel.id === activeLiveID) || (liveSelections.guide?.id === activeLiveID ? liveSelections.guide : null);
  const returnToGuide = () => {
    closeLiveVLCHandoff(); setActiveLiveID(null); setGuidePlayerOpen(false);
    returningToGuide.current = true;
  };
  const dedicatedGuidePlayer = section === 'live' && liveMode === 'guide' && guidePlayerOpen;
  const selectorLabel = channelsState.loading ? 'Loading channels…' : selected?.name || (channels.length === 0 ? 'No channels available' : 'Choose a channel');
  const sectionLabel = section === 'live' ? 'Live TV' : section === 'movies' ? 'Movies' : section === 'dvr' ? 'DVR' : 'Series';

  return (
    <main className="viewer-shell">
      {recordProgram && <RecordDialog dvr={dvr} program={recordProgram} onClose={() => setRecordProgram(null)} onConnect={() => { setRecordProgram(null); changeSection('dvr'); }} />}
      <header className="topbar">
        <div className="viewer-brand" ref={menuRef}>
          <h1 className="sr-only">Watch Now</h1>
          <button aria-controls={menuOpen ? 'viewer-menu' : undefined} aria-expanded={menuOpen} aria-label={`${menuOpen ? 'Close' : 'Open'} menu, current section ${sectionLabel}`} className="viewer-menu-trigger" onClick={() => setMenuOpen((open) => !open)} ref={menuButtonRef} type="button"><span aria-hidden="true" className="viewer-menu-icon"><span /><span /><span /></span><span className="viewer-menu-label" aria-hidden="true">{sectionLabel}</span></button>
          {menuOpen && <div className="viewer-menu-panel" id="viewer-menu">
            <p className="viewer-menu-brand">Watch Now</p>
            <nav aria-label="Viewer sections" className="viewer-menu-sections">
              {[['live', 'Live TV'], ['movies', 'Movies'], ['series', 'Series'], ...(dvrEnabled ? [['dvr', 'DVR']] : [])].map(([value, label]) => <button aria-current={section === value ? 'page' : undefined} className={section === value ? 'is-active' : ''} key={value} onClick={() => changeSection(value)} type="button">{label}</button>)}
            </nav>
            <div aria-label="Appearance" className="viewer-menu-appearance" role="group">
              <label htmlFor="viewer-color">Color</label>
              <select id="viewer-color" value={appearance} onChange={(event) => { const color = event.target.value; setAppearance(color); applyAppearance(color); }}>
                <option value="blue">Blue</option>
                <option value="green">Green</option>
              </select>
            </div>
            <button className="viewer-menu-signout" onClick={() => { setMenuOpen(false); setAboutOpen(true); }} type="button">About</button><button aria-label={`Sign out ${session.user.username}`} className="viewer-menu-signout" onClick={signOut} type="button">Sign out</button>
          </div>}
        </div>
      </header>

      <div hidden={dedicatedGuidePlayer} className={`viewer-navigation${programSearchEnabled ? ' is-discovery' : ''}`}>
        {(programSearchEnabled || section === 'dvr') && <nav aria-label={section === 'live' && tvGuideEnabled ? 'Browse, search or guide' : 'Browse or search'} className="discovery-mode-nav">{['browse', 'search', ...(section === 'live' && tvGuideEnabled ? ['guide'] : [])].map((mode) => <button aria-pressed={discoveryMode === mode} className={discoveryMode === mode ? 'is-active' : ''} key={mode} onClick={() => selectDiscoveryMode(mode)} type="button">{mode === 'browse' ? 'Browse' : mode === 'guide' ? 'Guide' : 'Search'}</button>)}</nav>}
        <div hidden={(programSearchEnabled || section === 'dvr') && discoveryMode !== 'search'} aria-label={section === 'live' && programSearchEnabled ? 'Live TV search' : undefined} className={`viewer-search${section === 'live' && programSearchEnabled ? ' is-scoped' : ''}`} role={section === 'live' && programSearchEnabled ? 'group' : undefined}>
        <SearchField
          label={sectionLabel}
          onChange={(value) => { setSearches((current) => ({ ...current, [section]: value })); if (section === 'live') { setLiveSearchDetail(false); if (value.trim()) setChannelSelectorOpen(false); } }}
          placeholder={section === 'live' ? (programSearchEnabled ? 'Search channels or shows…' : 'Search channel names or numbers') : `Search ${sectionLabel}…`}
          value={searches[section]}
        />
        {section === 'live' && programSearchEnabled && <LiveSearchModes onChange={(scope) => { setLiveSearchScope(scope); setLiveSearchDetail(false); }} scope={liveSearchScope} />}
        </div>
      </div>

      {actionError && <div className="alert" role="alert">{actionError}</div>}

      {section === 'dvr' ? <DVRSection dvr={dvr} mode={discoveryMode} search={searches.dvr} onFind={programSearchEnabled ? () => { changeSection('live'); setDiscoveryModes((m) => ({ ...m, live: 'search' })); setLiveSearchScope('upcoming'); setLiveSearchDetail(false); } : undefined} /> : programSearchEnabled && section !== 'live' && discoveryMode === 'search' && !(section === 'movies' ? effectiveMoviesSearch : effectiveSeriesSearch).trim() ? <p className="empty-state">{section === 'movies' ? 'Search for a movie by title.' : 'Search for a series by title.'}</p> : section === 'movies' ? <MoviesSection key={programSearchEnabled ? discoveryMode : 'legacy'} browseSelection={movieBrowse} categories={movieCategories} onBrowseSelectionChange={setMovieBrowse} onCategoriesLoaded={setMovieCategories} onExpired={onExpired} search={effectiveMoviesSearch} session={session} />
        : section === 'series' ? <SeriesSection key={programSearchEnabled ? discoveryMode : 'legacy'} browseSelection={seriesBrowse} categories={seriesCategories} onBrowseSelectionChange={setSeriesBrowse} onCategoriesLoaded={setSeriesCategories} onExpired={onExpired} search={effectiveSeriesSearch} session={session} />
          : <>
            {tvGuideEnabled && <div hidden={dedicatedGuidePlayer} ref={guideReturnRef} tabIndex="-1"><TVGuide suspended={dedicatedGuidePlayer} active={liveMode === 'guide'} categories={categories} channels={channels} isMobile={isMobile} onExpired={onExpired} channelID={guideChannelID} onChannelChange={setGuideChannelID} onWatch={(channel) => { closeLiveVLCHandoff(); setLiveSelections((current) => ({ ...current, guide: channel })); setLivePlaybackError(''); setActiveLiveID(channel.id); guideScrollY.current = window.scrollY; setGuidePlayerOpen(true); setGuideWatchRequest((value) => value + 1); }} onRecord={dvrEnabled ? setRecordProgram : undefined} /></div>}
            {liveMode === 'guide' && !guidePlayerOpen && playingChannel && <button type="button" onClick={() => { setLiveSelections((current) => ({ ...current, guide: playingChannel })); guideScrollY.current = window.scrollY; setGuidePlayerOpen(true); setGuideWatchRequest((value) => value + 1); }}>Return to player</button>}
            {dedicatedGuidePlayer && <button className="back-button" type="button" onClick={returnToGuide}>← Back to Guide</button>}
            <section hidden={liveMode === 'guide'} className={`catalog-toolbar${programSearchEnabled ? ' compact-browsing' : ''}`} aria-labelledby="live-heading">
              <div className="live-summary"><h2 className="sr-only" id="live-heading">Live TV</h2>{(!programSearchEnabled || browseOpen) && <p aria-live="polite">{visibleChannels.length} {visibleChannels.length === 1 ? 'channel' : 'channels'}</p>}</div>
              <div className="browse-controls" hidden={programSearchEnabled && !browseOpen} id="live-browse-controls">
                <label className="category-control"><span>Category</span><select aria-label="Category" disabled={categoriesState.loading} onChange={(event) => { setSelected(null); setActiveLiveID(null); setChannelSelectorOpen(false); setCategoryID(event.currentTarget.value); }} value={categoryID}><option value="">All channels</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                {isMobile && <button aria-controls="mobile-channel-list" aria-expanded={channelSelectorOpen} aria-label={selected ? `Choose channel, current channel ${selected.name}` : 'Choose channel'} className={`mobile-channel-trigger ${channelSelectorOpen ? 'is-open' : ''}`} onClick={() => setChannelSelectorOpen((open) => !open)} title={selected?.name || selectorLabel} type="button">{selected ? <ChannelArtwork categoryID={guideCategoryID} channel={selected} decorative /> : <span className="channel-artwork channel-artwork-row artwork-fallback" aria-hidden="true">TV</span>}<strong>{selectorLabel}</strong><span className="selector-chevron" aria-hidden="true" /></button>}
              </div>
            </section>
            {categoriesState.error && <div className="alert action-alert" role="alert"><span>{categoriesState.error}</span><button onClick={() => setCategoryRetry((value) => value + 1)} type="button">Retry</button></div>}
            {searchingLive && !browseOpen && <>
              {liveSearchDetail && <button className="back-button" onClick={() => { pendingSearchFocus.current = true; setLiveSearchDetail(false); }} type="button">← Back to search results</button>}
              <div hidden={liveSearchDetail} ref={searchResultsRef} tabIndex="-1"><LiveSearchResults onRecord={dvrEnabled ? setRecordProgram : undefined} onSelectProgram={(program) => { selectChannel(program.channel); setSelectedAiring(program); setLiveSearchDetail(true); }} categoryID="" channels={visibleChannels} channelsLoading={channelsState.loading} debouncedQuery={debouncedLiveSearch} onExpired={onExpired} onScopeChange={(scope) => { setLiveSearchScope(scope); setLiveSearchDetail(false); }} onSelect={(channel) => { selectChannel(channel); setLiveSearchDetail(true); }} onWatch={(channel) => { selectChannel(channel); setActiveLiveID(channel.id); setLiveSearchDetail(true); }} query={searches.live} scope={liveSearchScope} /></div>
            </>}
            <div className={`viewer-grid ${searchingLive || (programSearchEnabled && !browseOpen) ? 'is-searching' : ''}`}>
              <section aria-busy={channelsState.loading} aria-label="Channel list" className="channel-panel" hidden={(programSearchEnabled ? !browseOpen : searchingLive) || (isMobile && !channelSelectorOpen)}>
                <div id="mobile-channel-list">{channelsState.loading ? <div className="loading-state" role="status"><LoadingIndicator />Loading channels…</div> : channelsState.error ? <div className="panel-error" role="alert"><p>{channelsState.error}</p><button onClick={() => setChannelRetry((value) => value + 1)} type="button">Retry channels</button></div> : <VirtualChannelList categoryID={categoryID} channels={visibleChannels} compact={!isMobile} onSelect={selectChannel} selectedID={selected?.id} />}</div>
              </section>
              <section aria-label={selected ? `Program guide for ${selected.name}` : 'Channel details'} className="detail-panel" hidden={liveMode === 'guide' && !guidePlayerOpen} ref={detailRef} tabIndex="-1">
                {selected ? vlcState.ready ? <VLCPlaylistHandoff error={vlcState.error} loading={vlcState.loading} onBack={closeLiveVLCHandoff} onRetry={openLiveInVLC} title={vlcState.title} /> : <>
                  <div aria-label={`Selected channel: ${selected.name}`} className="channel-identity" role="region">
                    {!isMobile && <><ChannelArtwork categoryID={guideCategoryID} channel={selected} size="compact" /><div className="selected-channel-copy"><h2 title={selected.name}>{selected.name}</h2><p className="detail-meta"><span>{guideCategoryID ? selectedCategory?.name || 'Selected group' : 'All channels'}</span><span aria-hidden="true">·</span><span>{selected.channel_number ? `Channel ${selected.channel_number}` : 'Live channel'}</span></p></div></>}
                    {isMobile && <span className={programSearchEnabled && !browseOpen ? 'selected-mobile-channel' : 'sr-only'}>{selected.name}</span>}
                    <WatchControl onStop={() => { closeLiveVLCHandoff(); setActiveLiveID(null); }} onVLC={openLiveInVLC} onWatch={() => { setLivePlaybackError(''); setActiveLiveID(selected.id); }} playbackLoading={vlcState.loading && activeLiveID !== selected.id} playing={activeLiveID === selected.id} selectionKey={`live:${selected.id}`} vlcLoading={vlcState.loading} watchLabel="Watch Live" />
                  </div>
                  {vlcState.error && <div className="alert" role="alert">{vlcState.error}</div>}
                  {playingChannel && <>
                    {playingChannel.id !== selected.id && <p className="playback-notice">Playing {playingChannel.name} <button onClick={() => setActiveLiveID(null)} type="button">Stop playback</button></p>}
                    <div aria-label="Live playback" ref={livePlayerRef} role="region" tabIndex="-1"><LivePlayer channel={playingChannel} onFatalError={fatalLivePlayback} /></div>
                  </>}
                  {livePlaybackError && <div className="alert playback-error" role="alert">{livePlaybackError}</div>}
                  {liveMode === 'search' && liveSearchDetail && selectedAiring && selectedAiring.channel.id === selected.id && <article className="program-card selected-airing"><p className="guide-kicker">Selected airing</p><h3>{selectedAiring.title}</h3>{selectedAiring.subtitle && <p>{selectedAiring.subtitle}</p>}<p>{airingTime(selectedAiring)}</p>{selectedAiring.description && <p>{selectedAiring.description}</p>}<RecordButton program={selectedAiring} onRecord={dvrEnabled ? setRecordProgram : undefined} /></article>}
                  {dedicatedGuidePlayer && guideState.guide?.current && <p className="guide-playing-title">Now playing: <strong>{guideState.guide.current.title}</strong></p>}
                  {liveMode !== 'guide' && <ProgramGuide onRecord={dvrEnabled ? (program) => setRecordProgram({ ...program, channel: selected }) : undefined} error={guideState.error} guide={guideState.guide} loading={guideState.loading} now={now} onRetry={() => setGuideRetry((value) => value + 1)} />}
                  {tvGuideEnabled && liveMode !== 'guide' && <button onClick={() => { setGuideChannelID(selected.id); selectDiscoveryMode('guide'); }} type="button">View in Guide</button>}
                </> : <p className="empty-state">{programSearchEnabled && liveMode === 'search' ? 'Search for a channel or show.' : 'Choose a category with available channels.'}</p>}
              </section>
            </div>
          </>}
      {aboutOpen && <Modal labelledBy="about-title" onClose={() => setAboutOpen(false)} returnFocusRef={menuButtonRef}><h2 id="about-title">Watch Now</h2><p>Version {__APP_VERSION__}</p><p>A web player for Dispatcharr.</p><p>An independent, open-source project. Not affiliated with or endorsed by Dispatcharr or VideoLAN.</p><p><a href={__APP_SOURCE__} target="_blank" rel="noopener noreferrer">Source code and support</a> · <a href="https://github.com/JermZone/watch-now/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPLv3 license</a></p><button onClick={() => setAboutOpen(false)} type="button">Close</button></Modal>}
    </main>
  );
};

export default ViewerShell;
