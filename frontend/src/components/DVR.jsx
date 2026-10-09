import { useSavedState } from '../navigation';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { APIError, changeDVR, dvrFileURL, getDVRConnection, getDVRRecordings } from '../api';
import Modal from './Modal';
import RecordingStatus from './RecordingStatus';
import RecordingOptions from './RecordingOptions';
import ChannelArtwork from './ChannelArtwork';
import { flushSync } from 'react-dom';
import WatchControl from './WatchControl';
import VLCPlaylistHandoff from './VLCPlaylistHandoff';
import { openVLC } from './vlc';
import PlaybackStage from './PlaybackStage';
import NativeVideoPlayer from './NativeVideoPlayer';
const RecordingHLSPlayer = lazy(() => import('./RecordingHLSPlayer'));

export const airingTime = (program) => `${new Date(program.start).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${new Date(program.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

export function useDVR(enabled, session, onExpired) {
  const [state, setState] = useState({ connected: false, access: 'none', items: [], loading: false, busy: false, error: '', managed: false });
  const loadRef = useRef(null);
  const mutationRef = useRef(null);
  const alive = useRef(true);
  const fail = useCallback((error) => {
    if (error.name === 'AbortError' || !alive.current) return;
    if (error instanceof APIError && error.status === 401) { onExpired('Your viewer session expired. Sign in again.'); return; }
    setState((s) => ({ ...s, loading: false, error: error.message, ...(error.code === 'dvr_service_unavailable' ? { managed: true, connected: false, access: 'none', items: [] } : {}), ...(error.code === 'dvr_permission_denied' ? { access: 'none', items: [] } : {}), ...(['dvr_reconnect_required', 'dvr_connect_required'].includes(error.code) ? { connected: false, access: 'none', items: [] } : {}) }));
  }, [onExpired]);
  const refresh = useCallback(async () => {
    loadRef.current?.abort();
    const controller = new AbortController(); loadRef.current = controller;
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const connection = await getDVRConnection({ signal: controller.signal });
      const data = connection.connected && connection.access !== 'none' ? await getDVRRecordings({ signal: controller.signal }) : { items: [] };
      if (!controller.signal.aborted && alive.current) setState((s) => ({ ...s, ...connection, access: data.access || connection.access, items: data.items || [], loading: false, error: '' }));
    } catch (error) { if (!controller.signal.aborted) fail(error); }
  }, [fail]);
  useEffect(() => {
    alive.current = true;
    if (enabled) refresh();
    return () => { alive.current = false; loadRef.current?.abort(); mutationRef.current?.abort(); };
  }, [enabled, refresh]);
  const change = async (path, method, body) => {
    if (mutationRef.current) return null;
    loadRef.current?.abort();
    const controller = new AbortController(); mutationRef.current = controller;
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const result = await changeDVR(path, method, session.csrf_token, body, { signal: controller.signal });
      if (!controller.signal.aborted && alive.current) { await refresh(); return result || {}; }
    } catch (error) { fail(error); }
    finally { if (mutationRef.current === controller) mutationRef.current = null; if (alive.current) setState((s) => ({ ...s, busy: false })); }
    return null;
  };
  return { ...state, refresh, change, csrfToken: session.csrf_token };
}

export const RecordButton = ({ program, onRecord }) => new Date(program.end).getTime() > Date.now() && onRecord ? <button className="quiet-button record-button" onClick={() => onRecord(program)} type="button">Record</button> : null;

export function RecordDialog({ dvr, program, onClose, onConnect }) {
  const [success, setSuccess] = useState(null);
  const submit = async () => {
    const result = await dvr.change('recordings', 'POST', { channel_id: program.channel.id, start: program.start, end: program.end });
    if (result) setSuccess(result);
  };
  return <Modal labelledBy="record-heading" onClose={() => { if (!dvr.busy) onClose(); }}>
    <h2 id="record-heading">{success ? (success.already_scheduled ? 'Already scheduled' : 'Recording scheduled') : 'Record this airing?'}</h2>
    <h3>{program.title}</h3><p>{program.channel.name}</p><p>{airingTime(success?.recording || program)}</p>
    {success ? <p>Dispatcharr will keep recording when you leave Watch Now. Find it in DVR.</p> : <>
      <p>Uses Dispatcharr’s recording padding. For a program already on, only the remaining portion can be recorded.</p>
      {dvr.error && <p role="alert">{dvr.error}</p>}
      {dvr.loading ? <p role="status">Checking DVR access…</p> : !dvr.connected && dvr.managed ? <p>DVR is managed by your Watch Now administrator. Its connection is currently unavailable.</p> : !dvr.connected ? <><p>Connect your own Dispatcharr API key to record.</p><button onClick={onConnect} type="button">Connect DVR</button></> : dvr.access !== 'manage' ? <p>Your account can’t schedule recordings. Ask your Dispatcharr administrator to enable DVR management.</p> : <button className="primary-button" disabled={dvr.busy} onClick={submit} type="button">{dvr.busy ? 'Scheduling…' : 'Confirm recording'}</button>}
    </>}
    <button className="quiet-button" disabled={dvr.busy} onClick={onClose} type="button">{success ? 'Done' : 'Cancel'}</button>
  </Modal>;
}

const canManageRecordingAction = (dvr, confirmation) => {
  if (!confirmation || !dvr.connected || dvr.access !== 'manage') return false;
  const row = dvr.items.find(item => item.id === confirmation.row.id);
  if (!row) return false;
  return confirmation.action === 'delete' ? row.status !== 'recording' : row.status === 'recording' && !row.playable;
};

const scopes = [['recorded', 'Recorded'], ['recording', 'Recording'], ['scheduled', 'Scheduled'], ['attention', 'Attention']];
export default function DVRSection({ dvr, mode, search, onFind, sharedRecording = false, onBackToDVR }) {
  const [recordingID, setRecordingID] = useSavedState('recordingID', '');
  const restoreID = useRef(recordingID);
  const focusID = useRef(recordingID);
  const [apiKey, setAPIKey] = useState('');
  const [scope, setScope] = useSavedState('dvrScope', 'recorded');
  const [page, setPage] = useSavedState('dvrPage', 1);
  const [confirmation, setConfirmation] = useState(null);
  const confirmationReturnRef = useRef(null);
  const [playing, setPlaying] = useState(null);
  const [watchChoice, setWatchChoice] = useState(null);
  const watchReturnRef = useRef(null);
  const [playbackError, setPlaybackError] = useState('');
  const [vlcState, setVlcState] = useState({ loading: false, row: null, ready: false });
  const vlcGeneration = useRef(0);
  const latestDVR = useRef(dvr);
  latestDVR.current = dvr;
  useEffect(() => {
    vlcGeneration.current += 1;
    setVlcState({ loading: false, row: null, ready: false });
    setPlaying(null); setWatchChoice(null);
    return () => { vlcGeneration.current += 1; };
  }, [scope, search, mode, page, dvr.connected]);
  useEffect(() => {
    if (!restoreID.current || !dvr.connected || dvr.loading) return;
    const row = dvr.items.find(row => row.id === restoreID.current);
    if (row) {
      setScope(row.status);
      const index = dvr.items.filter(r => r.status === row.status).sort((a,b) => row.status === 'scheduled' ? new Date(a.start)-new Date(b.start) : new Date(b.start)-new Date(a.start)).findIndex(r => r.id === row.id);
      setPage(Math.floor(index / 20) + 1);
    } else setPlaybackError('This recording is no longer available to your account.');
    restoreID.current = '';
  }, [dvr.connected, dvr.loading, dvr.items]);
  useEffect(() => {
    if (!focusID.current || dvr.loading) return;
    const node = [...document.querySelectorAll('[data-recording-id]')].find(n => n.dataset.recordingId === focusID.current);
    node?.scrollIntoView?.({block:'nearest'});
    if (node) { node.focus({preventScroll:true}); focusID.current = ''; }
  }, [recordingID, page, dvr.loading]);
  const fatalPlayback = useCallback((message) => { setPlaying(null); setPlaybackError(message); }, []);
  const download = (row) => {
    const link = document.createElement('a');
    link.href = dvrFileURL(row.id, true); link.download = '';
    document.body.appendChild(link); link.click(); link.remove();
  };
  const openInVLC = async (row, position) => {
    if (row.can_watch_active && !position) {
      watchReturnRef.current = document.activeElement;
      setWatchChoice({ ...row, target: 'vlc' });
      return;
    }
    if (dvr.busy || vlcState.loading) return;
    const generation = ++vlcGeneration.current;
    setPlaybackError('');
    setVlcState({ loading: true, row, ready: false });
    const result = position
      ? await dvr.change(`recordings/${encodeURIComponent(row.id)}/vlc`, 'POST', { position })
      : await dvr.change(`recordings/${encodeURIComponent(row.id)}/vlc`, 'POST');
    if (generation !== vlcGeneration.current) return;
    if (!result?.launch_url || !latestDVR.current.connected || !latestDVR.current.items.some((r) => r.id === row.id && (r.playable || r.can_watch_active))) { setVlcState({ loading: false, row: null, ready: false }); return; }
    try {
      flushSync(() => setPlaying(null));
      const mode = openVLC(result.launch_url, row.title);
      setVlcState({ loading: false, row, ready: mode === 'playlist' });
    } catch {
      setPlaybackError('VLC handoff could not be completed. Please try again.');
      setVlcState({ loading: false, row: null, ready: false });
    }
  };
  const filterKey = `${scope}:${search}:${mode}`;
  const previousFilter = useRef(filterKey);
  useEffect(() => { if (previousFilter.current !== filterKey) { previousFilter.current = filterKey; setPage(1); } }, [filterKey]);
  useEffect(() => {
    if (!dvr.connected) return undefined;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden' && !dvr.busy) dvr.refresh(); }, 30000);
    return () => clearInterval(timer);
  }, [dvr.connected, dvr.busy, dvr.refresh]);
  useEffect(() => {
    if (playing && (!dvr.connected || dvr.access === 'none' || !dvr.items.some((r) => r.id === playing.id && (playing.activePlayback || r.playable)))) setPlaying(null);
  }, [dvr.connected, dvr.access, dvr.items, playing]);
  useEffect(() => {
    if (watchChoice && (!dvr.connected || dvr.access === 'none' || !dvr.items.some(row => row.id === watchChoice.id && (row.can_watch_active || row.playable)))) setWatchChoice(null);
  }, [dvr.connected, dvr.access, dvr.items, watchChoice]);
  const watchActiveRecording = (position) => {
    const row = latestDVR.current.items.find(item => item.id === watchChoice?.id && (item.can_watch_active || item.playable));
    if (!row || !latestDVR.current.connected || latestDVR.current.access === 'none') { setWatchChoice(null); return; }
    if (watchChoice.target === 'vlc') { setWatchChoice(null); void openInVLC(row, position); return; }
    vlcGeneration.current += 1;
    setVlcState({ loading: false, row: null, ready: false });
    setPlaybackError(''); setRecordingID(row.id); setWatchChoice(null);
    setPlaying({ ...row, activePlayback: true, initialPosition: position });
  };
  const connect = async (event) => { event.preventDefault(); const key = apiKey; setAPIKey(''); await dvr.change('connection', 'POST', { api_key: key }); };
  const query = mode === 'search' ? search.trim().toLocaleLowerCase() : '';
  const items = dvr.items.filter((r) => r.status === scope && (!query || `${r.title} ${r.subtitle || ''} ${r.description || ''} ${r.channel.name}`.toLocaleLowerCase().includes(query))).sort((a, b) => scope === 'scheduled' ? new Date(a.start) - new Date(b.start) : new Date(b.start) - new Date(a.start));
  const pages = Math.max(1, Math.ceil(items.length / 20));
  const currentPage = Math.min(page, pages);
  const visibleItems = sharedRecording ? dvr.items.filter(row => row.id === recordingID) : items.slice((currentPage - 1) * 20, currentPage * 20);
  useEffect(() => {
    if (confirmation && !canManageRecordingAction(dvr, confirmation)) setConfirmation(null);
  }, [dvr.connected, dvr.access, dvr.items, confirmation]);
  const requestConfirmation = (row, action, event) => {
    confirmationReturnRef.current = event?.currentTarget || null;
    event?.currentTarget.focus();
    setConfirmation({ row, action });
  };
  const perform = async () => {
    if (latestDVR.current.busy || !confirmation) return;
    if (!canManageRecordingAction(latestDVR.current, confirmation)) { setConfirmation(null); return; }
    const { row, action } = confirmation;
    const result = await dvr.change(`recordings/${encodeURIComponent(row.id)}${action === 'delete' ? '' : `/${action}`}`, action === 'delete' ? 'DELETE' : 'POST');
    if (result) setConfirmation(null);
  };
  const returnToDVR = () => { setPlaying(null); void latestDVR.current.refresh(); };
  if (playing) return <PlaybackStage title={playing.title} artwork={<ChannelArtwork channel={playing.channel} size="compact" />} backLabel={sharedRecording ? 'Back to recording details' : 'Back to DVR'} onBack={returnToDVR} onStop={returnToDVR} details={<>{playing.subtitle && <p>{playing.subtitle}</p>}<p>{playing.channel.name} · {airingTime(playing)}</p>{playing.description && <p>{playing.description}</p>}</>}>
    {playing.activePlayback
      ? <Suspense fallback={<p role="status">Preparing recording…</p>}><RecordingHLSPlayer contained recordingID={playing.id} initialPosition={playing.initialPosition || 'beginning'} csrfToken={dvr.csrfToken} onFatalError={fatalPlayback} /></Suspense>
      : <NativeVideoPlayer contained label="Recording" onFatalError={fatalPlayback} source={dvrFileURL(playing.id)} />}
  </PlaybackStage>;
  return <section className="dvr-section" aria-label="DVR">
    {sharedRecording && <button className="back-button" onClick={onBackToDVR} type="button">← Back to DVR</button>}
    {dvr.error && <div className="alert" role="alert"><p>{dvr.error}</p><button disabled={dvr.loading || dvr.busy} onClick={dvr.refresh} type="button">Retry</button></div>}
    {dvr.loading && <p role="status">Refreshing DVR…</p>}
    {dvr.loading && !dvr.connected ? null : !dvr.connected && dvr.managed ? <p>DVR is configured on the server. Ask your Watch Now administrator to check the connection.</p> : !dvr.connected ? <form className="dvr-connect" onSubmit={connect}>
      <h3>Connect your Dispatcharr account</h3><p>Enter your personal API key from Dispatcharr. It must belong to the account you used to sign in here. The key is kept only for this Watch Now session.</p>
      <label htmlFor="dvr-api-key">Dispatcharr API key</label><input autoComplete="off" id="dvr-api-key" maxLength={512} onChange={(e) => setAPIKey(e.target.value)} required type="password" value={apiKey} />
      <button className="primary-button" disabled={dvr.busy || dvr.loading} type="submit">Connect DVR</button>
    </form> : <>
      {dvr.access === 'none' && <p className="section-hint">DVR access is disabled for your Dispatcharr account.</p>}
      {!dvr.managed && <button className="quiet-button" disabled={dvr.busy} onClick={() => dvr.change('connection', 'DELETE')} type="button">Disconnect DVR</button>}
      {dvr.access !== 'none' && <>
        {!sharedRecording && <nav aria-label="DVR status" className="live-search-modes">{scopes.map(([value, label]) => <button aria-pressed={scope === value} className={scope === value ? 'is-active' : ''} key={value} onClick={() => setScope(value)} type="button">{label} ({dvr.items.filter((r) => r.status === value).length})</button>)}</nav>}
        {!sharedRecording && mode === 'search' && <p className="section-hint">Search filters your recordings and schedule in the selected status.</p>}
        {playbackError && <p role="alert">{playbackError}</p>}
        {vlcState.row?.can_watch_active && <p className="section-hint">VLC recording preview: recording continues when you close VLC. After a long pause at completion, you may need to reopen the finished recording.</p>}
        {vlcState.ready && <VLCPlaylistHandoff loading={vlcState.loading} title={vlcState.row.title} onBack={() => { vlcGeneration.current += 1; setVlcState({ loading: false, row: null, ready: false }); }} onRetry={() => openInVLC(vlcState.row)} />}
        {visibleItems.map((row) => <article className="program-card dvr-recording" key={row.id} data-recording-id={row.id} tabIndex="-1">
          <div className="dvr-recording-heading">
          <ChannelArtwork channel={row.channel} size="compact" />
          <div className="dvr-recording-title">{sharedRecording && <p className="guide-kicker">Shared recording</p>}<h3 title={row.title}>{row.title}</h3></div>
          {dvr.access === 'manage' && row.status !== 'recording' && row.status !== 'scheduled' && <button className="quiet-button dvr-delete-button" aria-label={`Delete recording: ${row.title}`} title={`Delete recording: ${row.title}`} disabled={dvr.busy} onClick={(event) => requestConfirmation(row, 'delete', event)} type="button">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></svg>
          </button>}</div>{row.subtitle && <p>{row.subtitle}</p>}<p>{row.channel.name} · {airingTime(row)}</p>{row.description && <p>{row.description}</p>}
          {row.status === 'attention' && <p>This recording is incomplete, processing, or needs attention in Dispatcharr.</p>}
          {row.status === 'recording' && <p>{row.can_watch_active ? 'Watch from the beginning or join live while recording continues.' : 'Recording continues in Dispatcharr. Playback becomes available after processing finishes.'}</p>}
          <div className="dvr-actions">
            {row.can_watch_active && !row.playable && <div className="dvr-recording-control">
              <WatchControl showMenuWatch={false} onVLC={() => openInVLC(row)} vlcLoading={vlcState.loading && vlcState.row?.id === row.id} watchHasPopup="dialog" selectionKey={`recording:${row.id}`}
                playbackLoading={dvr.busy || vlcState.loading}
                onWatch={(event) => { watchReturnRef.current = event.currentTarget; event.currentTarget.focus(); setWatchChoice(row); }}
              />
              <RecordingStatus recording label="Now Recording" />
            </div>}
            {row.playable && <WatchControl showMenuWatch={false} shareTarget={{kind:"recording",id:row.id}} selectionKey={`recording:${row.id}`} playing={playing?.id === row.id}
              onWatch={() => { vlcGeneration.current += 1; setVlcState({ loading: false, row: null, ready: false }); setPlaybackError(''); setRecordingID(row.id); setPlaying(row); }}
              onStop={() => setPlaying(null)} onDownload={() => download(row)} onVLC={() => openInVLC(row)}
              vlcLoading={vlcState.loading && vlcState.row?.id === row.id} playbackLoading={dvr.busy || vlcState.loading} />}
            {dvr.access === 'manage' && !row.playable && row.status === 'recording' &&
              <RecordingOptions disabled={dvr.busy} onSelect={(action, event) => requestConfirmation(row, action, event)} />}
            {dvr.access === 'manage' && !row.playable && !row.can_watch_active && row.status === 'scheduled' &&
              <button className="quiet-button" disabled={dvr.busy} onClick={(event) => requestConfirmation(row, 'delete', event)} type="button">Cancel recording</button>}
          </div>
        </article>)}
        {sharedRecording && visibleItems.length === 0 && !dvr.loading && !playbackError && <p role="alert">This recording is no longer available to your account.</p>}
        {!sharedRecording && items.length === 0 && !dvr.loading && <div className="empty-state dvr-empty-state"><p>No {query ? 'matching ' : ''}recordings in this view.</p>{onFind && !dvr.items.some((row) => row.status === scope) && <button className="quiet-button" onClick={onFind} type="button">Find something to record</button>}</div>}
        {!sharedRecording && pages > 1 && <nav aria-label="DVR pages" className="pagination"><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Previous</button><span>Page {currentPage} of {pages}</span><button disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></nav>}
      </>}
    </>}
    {watchChoice && <Modal labelledBy="dvr-watch-heading" returnFocusRef={watchReturnRef} onClose={() => setWatchChoice(null)}>
      <h2 id="dvr-watch-heading">{watchChoice.target === 'vlc' ? 'Watch recording in VLC' : 'Watch recording'}</h2><p>{watchChoice.title}</p>
      <div className="recording-watch-choices">
        <button className="quiet-button recording-watch-choice" aria-label="Watch from Beginning" onClick={() => watchActiveRecording('beginning')} type="button">
          <strong>Watch from Beginning</strong><span>Start at the earliest captured footage.</span>
        </button>
        <button className="quiet-button recording-watch-choice" aria-label="Watch Live" onClick={() => watchActiveRecording('latest')} type="button">
          <strong>Watch Live</strong><span>Join the latest captured footage. Pause and rewind available.</span>
        </button>
      </div>
      <div className="dialog-actions"><button className="quiet-button" onClick={() => setWatchChoice(null)} type="button">Cancel</button></div>
    </Modal>}
    {confirmation && <Modal labelledBy="dvr-action-heading" returnFocusRef={confirmationReturnRef} onClose={() => { if (!dvr.busy) setConfirmation(null); }}>
      <h2 id="dvr-action-heading">{confirmation.action === 'extend' ? 'Extend by 30 minutes?' : confirmation.action === 'stop' ? 'Stop this recording?' : confirmation.row.status === 'scheduled' ? 'Cancel this recording?' : 'Delete this recording?'}</h2><p>{confirmation.row.title}</p>
      <p>{confirmation.action === 'extend' ? 'Dispatcharr will capture another 30 minutes.' : confirmation.action === 'stop' ? 'Dispatcharr will stop capturing and keep the portion already recorded.' : 'This removes the schedule and any recorded file from Dispatcharr for everyone with access.'}</p>
      {dvr.error && <p role="alert">{dvr.error}</p>}<div className="dialog-actions dvr-confirmation-actions"><button className="quiet-button" disabled={dvr.busy} onClick={() => setConfirmation(null)} type="button">Keep unchanged</button><button className="primary-button" disabled={dvr.busy} onClick={perform} type="button">Confirm</button></div>
    </Modal>}
  </section>;
}
