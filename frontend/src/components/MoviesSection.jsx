import LoadingIndicator from './LoadingIndicator';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  APIError, createMovieVLC, getMovie, getMovieCategories, getMovies,
  movieArtworkURL, movieDownloadURL, movieStreamURL,
} from '../api';
import { BrowseHeader } from './CategoryBrowser';
import CategoryBrowser from './CategoryBrowser';
import VideoDetails from './VideoDetails.jsx';
import DetailLoadingStatus from './DetailLoadingStatus';
import NativeVideoPlayer from './NativeVideoPlayer';
import Pagination from './Pagination';
import PosterArtwork from './PosterArtwork';
import WatchControl from './WatchControl';
import VLCPlaylistHandoff from './VLCPlaylistHandoff';
import { openVLC } from './vlc';

const PAGE_SIZE = 20;
const titleFor = (item) => item?.name || item?.title || 'Untitled movie';
const descriptionFor = (item) => item?.description || item?.plot || '';
const durationFor = (item) => item?.runtime || item?.duration || item?.duration_secs;
const formatDuration = (value) => {
  if (!value) return '';
  if (typeof value === 'string' && /[a-z:]/i.test(value)) return value;
  const minutes = Number(value) > 300 ? Math.round(Number(value) / 60) : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` : `${Math.round(minutes)}m`;
};
const metadataFor = (item) => [item?.year, formatDuration(durationFor(item)), item?.rating]
  .filter((value) => value !== '' && value !== null && value !== undefined).join(' · ');

const MoviesSection = ({
  browseSelection, categories, onBrowseSelectionChange, onCategoriesLoaded,
  onExpired, search, session,
}) => {
  const showingCategories = !search.trim() && browseSelection === null;
  const [categoryState, setCategoryState] = useState({ loading: !Array.isArray(categories), error: '', retry: 0 });
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState({ items: [], total: 0, loading: false, error: '' });
  const [selected, setSelected] = useState(null);
  const [detailState, setDetailState] = useState({ detail: null, loading: false, error: '' });
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [vlcState, setVlcState] = useState({ loading: false, error: '', ready: false, title: '' });
  const listRequestRef = useRef(0);
	const categoryRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const detailControllerRef = useRef(null);
  const vlcRequestRef = useRef(0);
  const detailsRef = useRef(null);
  const pendingDetailRevealRef = useRef(false);

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
    setPlaying(false);
    setPlaybackError('');
    setVlcState({ loading: false, error: '', ready: false, title: '' });
    setSelected(null);
    setDetailState({ detail: null, loading: false, error: '' });
  }, []);

  useEffect(() => {
    if (!showingCategories || Array.isArray(categories)) {
      setCategoryState((state) => ({ ...state, loading: false, error: '' }));
      return undefined;
    }
    const controller = new AbortController();
	const requestID = ++categoryRequestRef.current;
    setCategoryState((state) => ({ ...state, loading: true, error: '' }));
    getMovieCategories({ signal: controller.signal })
      .then((data) => {
		if (requestID !== categoryRequestRef.current) return;
        onCategoriesLoaded(Array.isArray(data) ? data : []);
        setCategoryState((state) => ({ ...state, loading: false, error: '' }));
      })
      .catch((error) => {
		if (requestID === categoryRequestRef.current && error.name !== 'AbortError') setCategoryState((state) => ({ ...state, loading: false, error: expireOrMessage(error, 'Movie categories could not be loaded.') }));
      });
	return () => { categoryRequestRef.current += 1; controller.abort(); };
  }, [categories, categoryState.retry, expireOrMessage, onCategoriesLoaded, showingCategories]);

  const contextKey = useMemo(() => JSON.stringify({
    category: browseSelection === 'all' ? 'all' : browseSelection?.id || '',
    search: search.trim(),
  }), [browseSelection, search]);
  const previousContextRef = useRef(contextKey);
  useEffect(() => {
    if (previousContextRef.current === contextKey) return;
    previousContextRef.current = contextKey;
    setPage(1);
    closeDetail();
  }, [closeDetail, contextKey]);

  const browseActive = Boolean(search.trim() || browseSelection);
  const catalogKey = `${contextKey}:${page}`;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!browseActive) {
      setCatalog({ items: [], total: 0, loading: false, error: '' });
      return undefined;
    }
    const requestID = ++listRequestRef.current;
    const controller = new AbortController();
    setCatalog((state) => ({ ...state, loading: true, error: '' }));
    getMovies({
      categoryID: !search.trim() && browseSelection !== 'all' ? browseSelection?.id : '',
      search, page, pageSize: PAGE_SIZE, signal: controller.signal,
    }).then((data) => {
      if (requestID !== listRequestRef.current) return;
      const items = Array.isArray(data?.items) ? data.items.slice(0, PAGE_SIZE) : [];
      const total = Number(data?.total) || 0;
      const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > lastPage) { setPage(lastPage); return; }
      setCatalog({ items, total, loading: false, error: '', key: catalogKey });
    }).catch((error) => {
      if (requestID === listRequestRef.current && error.name !== 'AbortError') {
        setCatalog({ items: [], total: 0, loading: false, error: expireOrMessage(error, 'Movies could not be loaded.') });
      }
    });
    return () => { listRequestRef.current += 1; controller.abort(); };
  }, [browseActive, browseSelection, catalogKey, expireOrMessage, page, retry, search]);

  useEffect(() => () => {
	categoryRequestRef.current += 1;
    listRequestRef.current += 1;
    detailRequestRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    vlcRequestRef.current += 1;
  }, []);

  const selectMovie = (movie) => {
    detailControllerRef.current?.abort();
    const requestID = ++detailRequestRef.current;
    vlcRequestRef.current += 1;
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setPlaying(false);
    setPlaybackError('');
    pendingDetailRevealRef.current = true;
    setSelected(movie);
    setDetailState({ detail: movie, loading: true, error: '' });
    getMovie(movie.id, { signal: controller.signal }).then((detail) => {
      if (requestID !== detailRequestRef.current) return;
      setDetailState({ detail: detail && typeof detail === 'object' ? detail : movie, loading: false, error: '' });
    }).catch((error) => {
      if (requestID === detailRequestRef.current && error.name !== 'AbortError') {
        setDetailState({ detail: movie, loading: false, error: expireOrMessage(error, 'Movie details could not be loaded.') });
      }
    }).finally(() => {
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    });
  };

  useLayoutEffect(() => {
    if (!selected || !pendingDetailRevealRef.current) return;
    pendingDetailRevealRef.current = false;
    detailsRef.current?.focus({ preventScroll: true });
    detailsRef.current?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
  }, [selected]);

  const download = () => {
    if (!selected) return;
    const link = document.createElement('a');
    link.href = movieDownloadURL(selected.id);
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const openInVLC = async () => {
    if (!selected || vlcState.loading) return;
    const selectedID = selected.id;
    const title = titleFor(detailState.detail || selected);
    const requestID = ++vlcRequestRef.current;
    setVlcState((state) => ({ ...state, loading: true, error: '' }));
    try {
      const result = await createMovieVLC(selectedID, session.csrf_token);
      if (requestID !== vlcRequestRef.current || selected?.id !== selectedID) return;
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

  return (
    <section className="media-section" aria-labelledby="movies-heading">
      <h2 className="sr-only" id="movies-heading">Movies</h2>
      {selected ? (
        <div aria-label={titleFor(detail)} className="media-detail-view" ref={detailsRef} role="region" tabIndex="-1">
          <button className="back-button" onClick={closeDetail} type="button">← {search.trim() ? 'Back to search results' : 'Back to Movies'}</button>
          {vlcState.ready ? <VLCPlaylistHandoff error={vlcState.error} loading={vlcState.loading} onBack={closeVLCHandoff} onRetry={openInVLC} title={vlcState.title} /> : <>
          <section aria-label={`Playback controls for ${titleFor(detail)}`} className="media-watch-area">
            <div className="media-watch-header">
              <h3 id="selected-movie-heading">{titleFor(detail)}</h3>
              <WatchControl onDownload={download} onStop={stop} onVLC={openInVLC} onWatch={() => { setPlaybackError(''); setPlaying(true); }} playing={playing} selectionKey={`movie:${selected.id}`} vlcLoading={vlcState.loading} />
              <VideoDetails streamInfo={detail?.stream_info} />
            </div>
            {vlcState.error && <div className="alert" role="alert">{vlcState.error}</div>}
            {playbackError && <div className="alert" role="alert">{playbackError}</div>}
          </section>
          {playing && <NativeVideoPlayer label="Movie" onFatalError={fatalPlayback} source={movieStreamURL(selected.id)} />}
          <article className="media-detail" aria-label={`Selected movie: ${titleFor(detail)}`}>
            <div className="detail-poster"><PosterArtwork label={titleFor(detail)} source={detail?.has_artwork ? movieArtworkURL(selected.id) : ''} /></div>
            <div className="media-detail-copy">
              {metadataFor(detail) && <p className="media-meta">{metadataFor(detail)}</p>}
              {detail?.genre && <p className="media-genre">{detail.genre}</p>}
              {descriptionFor(detail) && <p className="media-description">{descriptionFor(detail)}</p>}
              {detailState.loading && <DetailLoadingStatus key={selected.id} />}
			  {detailState.error && <div className="panel-error" role="alert"><p>{detailState.error}</p><button onClick={() => selectMovie(selected)} type="button">Retry details</button></div>}
			  {detail?.director && <p className="media-credit"><strong>Director:</strong> {detail.director}</p>}
			  {detail?.cast && <p className="media-credit"><strong>Cast:</strong> {detail.cast}</p>}
			  {detail?.country && <p className="media-credit"><strong>Country:</strong> {detail.country}</p>}
            </div>
          </article>
          </>}
        </div>
      ) : showingCategories ? (
        <CategoryBrowser categories={categories || []} error={categoryState.error} label="Movies" loading={categoryState.loading} onRetry={() => setCategoryState((state) => ({ ...state, retry: state.retry + 1 }))} onSelect={(value) => onBrowseSelectionChange(value)} />
      ) : (
        <div className="media-results">
          {!search.trim() && <BrowseHeader onBack={() => onBrowseSelectionChange(null)} selection={browseSelection} />}
          {catalog.loading ? <div className="loading-state" role="status"><LoadingIndicator />Loading movies…</div>
            : catalog.error ? <div className="panel-error" role="alert"><p>{catalog.error}</p><button onClick={() => setRetry((value) => value + 1)} type="button">Retry</button></div>
              : catalog.items.length === 0 ? <p className="empty-state">{search.trim() ? 'No movies match your search.' : 'No movies are available.'}</p>
                : <div className="poster-grid">{catalog.items.map((movie) => <button className="poster-card" key={movie.id} onClick={() => selectMovie(movie)} type="button"><span className="poster-image"><PosterArtwork label={titleFor(movie)} source={movie.has_artwork ? movieArtworkURL(movie.id) : ''} /></span><strong>{titleFor(movie)}</strong>{metadataFor(movie) && <small>{metadataFor(movie)}</small>}</button>)}</div>}
          {!catalog.loading && !catalog.error && <Pagination onChange={(value) => { closeDetail(); setPage(value); }} page={page} pageSize={PAGE_SIZE} total={catalog.total} />}
        </div>
      )}
    </section>
  );
};

export default MoviesSection;
