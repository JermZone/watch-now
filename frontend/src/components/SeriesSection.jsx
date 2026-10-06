import { useSavedState, useNavigationInitial } from '../navigation';
import LoadingIndicator from './LoadingIndicator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  APIError, createEpisodeVLC, episodeDownloadURL, episodeStreamURL,
  getSeries, getSeriesCategories, getSeriesDetail, seriesArtworkURL,
} from '../api';
import CategoryBrowser, { BrowseHeader } from './CategoryBrowser';
import VideoDetails from './VideoDetails.jsx';
import DetailLoadingStatus from './DetailLoadingStatus';
import PlaybackStage from './PlaybackStage';
import NativeVideoPlayer from './NativeVideoPlayer';
import Pagination from './Pagination';
import PosterArtwork from './PosterArtwork';
import WatchControl from './WatchControl';
import VLCPlaylistHandoff from './VLCPlaylistHandoff';
import { openVLC } from './vlc';

const PAGE_SIZE = 20;
const titleFor = (item) => item?.name || item?.title || 'Untitled series';
const episodeTitle = (item) => item?.title || item?.name || 'Untitled episode';
const descriptionFor = (item) => item?.description || item?.plot || '';
const formatDuration = (value) => {
  if (!value) return '';
  if (typeof value === 'string' && /[a-z:]/i.test(value)) return value;
  const minutes = Number(value) > 300 ? Math.round(Number(value) / 60) : Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? `${Math.round(minutes)}m` : '';
};
const seriesMeta = (item) => [item?.year, item?.rating].filter((value) => value !== '' && value != null).join(' · ');
const episodeMeta = (episode) => [episode?.air_date || episode?.release_date, formatDuration(episode?.duration || episode?.duration_secs), episode?.rating]
  .filter((value) => value !== '' && value != null).join(' · ');
const integerOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

export const groupSeriesSeasons = (detail) => {
  const raw = Array.isArray(detail?.seasons) ? detail.seasons : [];
  const groups = raw.map((season, index) => {
    const number = integerOrNull(season?.number ?? season?.season_number);
    const episodes = (Array.isArray(season?.episodes) ? season.episodes : []).map((episode) => ({
      ...episode,
      season_number: integerOrNull(episode?.season_number) ?? number,
    })).sort((left, right) => {
      const a = integerOrNull(left.episode_number) ?? Infinity;
      const b = integerOrNull(right.episode_number) ?? Infinity;
      return a - b || episodeTitle(left).localeCompare(episodeTitle(right)) || String(left.id).localeCompare(String(right.id));
    });
    return {
      key: number === null ? `unknown:${index}` : `season:${number}`,
      number,
      label: number === 0 ? 'Specials' : number > 0 ? `Season ${number}` : season?.name || 'Unknown season',
      episodes,
    };
  });
  return groups.sort((left, right) => {
    const rank = (group) => group.number === 0 ? -1 : group.number > 0 ? group.number : Infinity;
    return rank(left) - rank(right);
  });
};

const SeriesSection = ({
  browseSelection, categories, onBrowseSelectionChange, onCategoriesLoaded,
  onExpired, search, session,
}) => {
  const showingCategories = !search.trim() && browseSelection === null;
  const [categoryState, setCategoryState] = useState({ loading: !Array.isArray(categories), error: '', retry: 0 });
  const [page, setPage] = useSavedState('seriesPage', 1);
  const [retry, setRetry] = useState(0);
  const [catalog, setCatalog] = useState({ items: [], total: 0, loading: false, error: '' });
  const [sharedEpisode, setSharedEpisode] = useSavedState('sharedEpisode', false);
  const [savedID, setSavedID] = useSavedState('seriesID', '');
  const [savedEpisode, setSavedEpisode] = useSavedState('episodeID', '');
  const initialSelection = useRef({id:savedID,episode:savedEpisode,season:useNavigationInitial('season')});
  const [selected, setSelected] = useState(null);
  const [detailState, setDetailState] = useState({ detail: null, loading: false, error: '' });
  const [selectedSeason, setSelectedSeason] = useSavedState('season', '');
  const [selectedEpisode, setSelectedEpisode] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [vlcState, setVlcState] = useState({ loading: false, error: '', ready: false, title: '' });
  const listRequestRef = useRef(0);
	const categoryRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const detailControllerRef = useRef(null);
  const vlcRequestRef = useRef(0);
  const detailsRef = useRef(null);

  const expireOrMessage = useCallback((error, fallback) => {
    if (error instanceof APIError && error.status === 401) {
      onExpired('Your viewer session expired. Sign in again.');
      return '';
    }
    return fallback;
  }, [onExpired]);
  const stop = useCallback(() => setPlaying(false), []);
  const closeDetail = useCallback(() => {
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    detailRequestRef.current += 1;
    vlcRequestRef.current += 1;
    setSharedEpisode(false);
    setSavedID('');
    setSavedEpisode('');
    setSelected(null);
    setDetailState({ detail: null, loading: false, error: '' });
    setSelectedSeason('');
    setSelectedEpisode(null);
    setPlaying(false);
    setPlaybackError('');
    setVlcState({ loading: false, error: '', ready: false, title: '' });
  }, []);

  useEffect(() => {
    if (!showingCategories || Array.isArray(categories)) {
      setCategoryState((state) => ({ ...state, loading: false, error: '' }));
      return undefined;
    }
    const controller = new AbortController();
	const requestID = ++categoryRequestRef.current;
    setCategoryState((state) => ({ ...state, loading: true, error: '' }));
    getSeriesCategories({ signal: controller.signal }).then((data) => {
	  if (requestID !== categoryRequestRef.current) return;
      onCategoriesLoaded(Array.isArray(data) ? data : []);
      setCategoryState((state) => ({ ...state, loading: false, error: '' }));
    }).catch((error) => {
	  if (requestID === categoryRequestRef.current && error.name !== 'AbortError') setCategoryState((state) => ({ ...state, loading: false, error: expireOrMessage(error, 'Series categories could not be loaded.') }));
    });
	return () => { categoryRequestRef.current += 1; controller.abort(); };
  }, [categories, categoryState.retry, expireOrMessage, onCategoriesLoaded, showingCategories]);

  const contextKey = `${search.trim()}|${browseSelection === 'all' ? 'all' : browseSelection?.id || ''}`;
  const previousContextRef = useRef(contextKey);
  useEffect(() => {
    if (previousContextRef.current === contextKey) return;
    previousContextRef.current = contextKey;
    setPage(1);
    closeDetail();
  }, [closeDetail, contextKey]);

  const browseActive = !sharedEpisode && Boolean(search.trim() || browseSelection);
  useEffect(() => {
    if (!browseActive) {
      setCatalog({ items: [], total: 0, loading: false, error: '' });
      return undefined;
    }
    const requestID = ++listRequestRef.current;
    const controller = new AbortController();
    setCatalog((state) => ({ ...state, loading: true, error: '' }));
    getSeries({
      categoryID: !search.trim() && browseSelection !== 'all' ? browseSelection?.id : '',
      search, page, pageSize: PAGE_SIZE, signal: controller.signal,
    }).then((data) => {
      if (requestID !== listRequestRef.current) return;
      const items = Array.isArray(data?.items) ? data.items : [];
      const total = Number(data?.total) || 0;
      const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setCatalog({ items, total, loading: false, error: '' });
    }).catch((error) => {
      if (requestID === listRequestRef.current && error.name !== 'AbortError') setCatalog({ items: [], total: 0, loading: false, error: expireOrMessage(error, 'Series could not be loaded.') });
    });
    return () => { listRequestRef.current += 1; controller.abort(); };
  }, [browseActive, browseSelection, expireOrMessage, page, retry, search]);

  useEffect(() => () => {
	categoryRequestRef.current += 1;
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    vlcRequestRef.current += 1;
  }, []);

  const loadDetail = useCallback((item, restore = null) => {
    detailControllerRef.current?.abort();
    const requestID = ++detailRequestRef.current;
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailState({ detail: item, loading: true, error: '' });
    getSeriesDetail(item.id, { signal: controller.signal }).then((detail) => {
      if (requestID !== detailRequestRef.current) return;
      const next = detail && typeof detail === 'object' ? detail : item;
		const groups = groupSeriesSeasons(next);
		setDetailState({ detail: next, loading: false, error: '' });
		const restoredGroup = restore?.episode ? groups.find(g => g.episodes.some(e => e.id === restore.episode)) : groups.find(g => g.key === restore?.season);
      setSelectedSeason(restoredGroup?.key || groups.find((group) => group.episodes.length > 0)?.key || groups[0]?.key || '');
      setSelectedEpisode(restoredGroup?.episodes.find(e => e.id === restore?.episode) || null);
      if (restore?.episode && !restoredGroup) setPlaybackError('This episode is no longer available.');
      const reveal = () => detailsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      if (window.requestAnimationFrame) window.requestAnimationFrame(reveal);
      else reveal();
    }).catch((error) => {
      if (requestID === detailRequestRef.current && error.name !== 'AbortError') setDetailState({ detail: item, loading: false, error: expireOrMessage(error, 'Series details could not be loaded.') });
    }).finally(() => {
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    });
  }, [expireOrMessage]);

  const selectSeries = (item) => {
    vlcRequestRef.current += 1;
    setSavedID(item.id);
    setSavedEpisode('');
    setSelected(item);
    setPlaying(false);
    setPlaybackError('');
    setVlcState({ loading: false, error: '', ready: false, title: '' });
    loadDetail(item);
  };
  useEffect(() => {
    const restore = initialSelection.current;
    if (restore?.id) { setSelected({id:restore.id}); loadDetail({id:restore.id}, restore); initialSelection.current = null; }
  }, []);
  const groups = useMemo(() => groupSeriesSeasons(detailState.detail), [detailState.detail]);
  const hasEpisodes = groups.some((group) => group.episodes.length > 0);
  const activeGroup = groups.find((group) => group.key === selectedSeason);
  const selectSeason = (value) => {
    vlcRequestRef.current += 1;
    setSelectedSeason(value);
    setSavedEpisode('');
    setSelectedEpisode(null);
    setPlaying(false);
    setPlaybackError('');
    setVlcState({ loading: false, error: '', ready: false, title: '' });
  };
  const selectEpisode = (episode) => {
    vlcRequestRef.current += 1;
    setSavedEpisode(episode.id);
    setSelectedEpisode(episode);
    setPlaying(false);
    setPlaybackError('');
    setVlcState({ loading: false, error: '', ready: false, title: '' });
  };
  const download = () => {
    if (!selected || !selectedEpisode) return;
    const link = document.createElement('a');
    link.href = episodeDownloadURL(selected.id, selectedEpisode.id);
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const openInVLC = async () => {
    if (!selected || !selectedEpisode || vlcState.loading) return;
    const seriesID = selected.id;
    const episodeID = selectedEpisode.id;
    const title = `${titleFor(detailState.detail || selected)} - ${episodeTitle(selectedEpisode)}`;
    const requestID = ++vlcRequestRef.current;
    setVlcState((state) => ({ ...state, loading: true, error: '' }));
    try {
      const result = await createEpisodeVLC(seriesID, episodeID, session.csrf_token);
      if (requestID !== vlcRequestRef.current) return;
      setPlaying(false);
      const mode = openVLC(result.launch_url, title);
      setVlcState({ loading: false, error: '', ready: mode === 'playlist', title: mode === 'playlist' ? title : '' });
    } catch (error) {
      if (requestID === vlcRequestRef.current) setVlcState((state) => ({ ...state, loading: false, error: expireOrMessage(error, 'VLC handoff could not be completed.') }));
    }
  };
  const closeVLCHandoff = () => {
    vlcRequestRef.current += 1;
    setVlcState({ loading: false, error: '', ready: false, title: '' });
  };
  const fatalPlayback = useCallback((message) => { setPlaying(false); setPlaybackError(message); }, []);
  const detail = detailState.detail || selected;

  if (playing && selectedEpisode) return <PlaybackStage title={`${titleFor(detail)} — ${episodeTitle(selectedEpisode)}`} backLabel="Back to episode details" onBack={stop} onStop={stop} details={<><p>{activeGroup?.label} · Episode {selectedEpisode.episode_number}</p><VideoDetails streamInfo={selectedEpisode.stream_info} /><p>{episodeMeta(selectedEpisode)}</p><p>{descriptionFor(selectedEpisode)}</p><p>{descriptionFor(detail)}</p></>}>
    <NativeVideoPlayer contained label="Episode" onFatalError={fatalPlayback} source={episodeStreamURL(selected.id, selectedEpisode.id)} />
  </PlaybackStage>;

  return (
    <section className="media-section" aria-labelledby="series-heading">
      <h2 className="sr-only" id="series-heading">Series</h2>
      {selected ? <div className="media-detail-view" ref={detailsRef}>
        <button className="back-button" onClick={sharedEpisode ? () => setSharedEpisode(false) : closeDetail} type="button">← {sharedEpisode ? 'Back to all show details' : search.trim() ? 'Back to search results' : 'Back to Series'}</button>
        {vlcState.ready ? <VLCPlaylistHandoff error={vlcState.error} loading={vlcState.loading} onBack={closeVLCHandoff} onRetry={openInVLC} title={vlcState.title} /> :
        <article className="media-detail series-detail" aria-label={`Selected series: ${titleFor(detail)}`}>
          <div className="detail-poster"><PosterArtwork label={titleFor(detail)} source={detail?.has_artwork ? seriesArtworkURL(selected.id) : ''} /></div>
          <div className="media-detail-copy">
            <h3>{titleFor(detail)}</h3>
            {seriesMeta(detail) && <p className="media-meta">{seriesMeta(detail)}</p>}
            {detail?.genre && <p className="media-genre">{detail.genre}</p>}
            {descriptionFor(detail) && <p className="media-description">{descriptionFor(detail)}</p>}
            {detailState.loading ? <DetailLoadingStatus key={selected.id} label="Loading series details…" />
              : detailState.error ? <div className="panel-error" role="alert"><p>{detailState.error}</p><button onClick={() => loadDetail(selected, {episode:savedEpisode,season:selectedSeason})} type="button">Retry details</button></div>
                : !hasEpisodes ? <div className="episode-empty"><p>No episodes are currently available for this series.</p><button className="quiet-button" onClick={() => loadDetail(selected, {episode:savedEpisode,season:selectedSeason})} type="button">Retry episodes</button></div>
                  : <div className="episode-browser">
                    {sharedEpisode && !selectedEpisode && <p role="alert">This episode is no longer available.</p>}
                    {!sharedEpisode && <label>Season<select aria-label="Season" onChange={(event) => selectSeason(event.currentTarget.value)} value={selectedSeason}>{groups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label>}
                    <div className="episode-list">{(sharedEpisode ? (selectedEpisode ? [selectedEpisode] : []) : activeGroup?.episodes)?.map((episode) => {
                      const active = selectedEpisode?.id === episode.id;
                      const number = integerOrNull(episode.episode_number) !== null ? `Episode ${integerOrNull(episode.episode_number)} · ` : '';
                      return <div className="episode-entry" key={episode.id}>
                        {!sharedEpisode && <button aria-pressed={active} className={active ? 'is-selected' : ''} onClick={() => selectEpisode(episode)} type="button"><strong>{number}{episodeTitle(episode)}</strong>{episode.air_date && <small>{episode.air_date}</small>}</button>}
                        {active && <div className="episode-actions" aria-label={`Selected episode: ${episodeTitle(episode)}`}>
                          {sharedEpisode && <p className="guide-kicker">Shared episode · {activeGroup?.label}{integerOrNull(episode.episode_number) !== null ? ` · Episode ${episode.episode_number}` : ''}</p>}
                          <h4>{episodeTitle(episode)}</h4>
                          <WatchControl shareTarget={{kind:"episode",id:selected.id,episode:selectedEpisode.id}} onDownload={download} onStop={stop} onVLC={openInVLC} onWatch={() => { setPlaybackError(''); setPlaying(true); }} playing={playing} selectionKey={`episode:${selected.id}:${selectedEpisode.id}`} vlcLoading={vlcState.loading} />
                          <VideoDetails streamInfo={selectedEpisode?.stream_info} />
                          {vlcState.error && <div className="alert" role="alert">{vlcState.error}</div>}
                          {playbackError && <div className="alert" role="alert">{playbackError}</div>}
                          {episodeMeta(episode) && <p className="media-meta">{episodeMeta(episode)}</p>}
                          {descriptionFor(episode) && <p className="media-description">{descriptionFor(episode)}</p>}
                        </div>}
                      </div>;
                    })}</div>
                  </div>}
          </div>
        </article>}
      </div> : showingCategories ? <CategoryBrowser categories={categories || []} error={categoryState.error} label="Series" loading={categoryState.loading} onRetry={() => setCategoryState((state) => ({ ...state, retry: state.retry + 1 }))} onSelect={onBrowseSelectionChange} />
        : <div className="media-results">
          {!search.trim() && <BrowseHeader onBack={() => onBrowseSelectionChange(null)} selection={browseSelection} />}
          {catalog.loading ? <div className="loading-state" role="status"><LoadingIndicator />Loading series…</div>
            : catalog.error ? <div className="panel-error" role="alert"><p>{catalog.error}</p><button onClick={() => setRetry((value) => value + 1)} type="button">Retry</button></div>
              : catalog.items.length === 0 ? <p className="empty-state">{search.trim() ? 'No series match your search.' : 'No series are available.'}</p>
                : <div className="poster-grid">{catalog.items.map((item) => <button className="poster-card" key={item.id} onClick={() => selectSeries(item)} type="button"><span className="poster-image"><PosterArtwork label={titleFor(item)} source={item.has_artwork ? seriesArtworkURL(item.id) : ''} /></span><strong>{titleFor(item)}</strong>{seriesMeta(item) && <small>{seriesMeta(item)}</small>}</button>)}</div>}
          {!catalog.loading && !catalog.error && <Pagination onChange={(value) => { closeDetail(); setPage(value); }} page={page} pageSize={PAGE_SIZE} total={catalog.total} />}
        </div>}
    </section>
  );
};

export default SeriesSection;
