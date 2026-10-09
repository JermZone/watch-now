import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { APIError, changeDVR, getChannelRecordings } from '../api';
import WatchControl from './WatchControl';
import RecordingStatus from './RecordingStatus';
import Modal from './Modal';
import './LiveRecordingControl.css';

function activeRows(value, channelID) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter(row => row && typeof row.id === 'string' && /^[0-9]{1,64}$/.test(row.id)
    && (row.channel_id === channelID || row.channel?.id === channelID)
    && row.status === 'recording' && row.can_watch_active === true);
}

export default function LiveRecordingControl({
  channel, currentProgram, enabled, interactionActive = true, csrfToken, onExpired, onWatchLive, onWatchRecording,
  onStop, onVLC, playing, recordingPlaying = false, playbackLoading, vlcLoading, shareTarget,
  presentation = 'channel', onRecord, loadRecordings = getChannelRecordings, refreshInterval = 15000,
}) {
  const [state, setState] = useState({ channelID: '', items: [], access: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState(null);
  const choiceTitleID = useId();
  const beginningRef = useRef(null);
  const watchRef = useRef(null);
  const guideChoiceOpen = useRef(false);
  const operation = useRef(0);
  const createController = useRef(null);
  const refreshRef = useRef(null);
  const latestExpired = useRef(onExpired);
  latestExpired.current = onExpired;
  const channelID = channel.id;
  const context = useRef(null);
  context.current = { channelID, active: enabled && interactionActive };

  useEffect(() => {
    let alive = true;
    let controller;
    let pending = false;
    operation.current++;
    setBusy(false); setError('');
    setState({ channelID, items: [], access: 'none' });
    const refresh = async () => {
      if (!alive || pending || !enabled || !interactionActive || (presentation === 'search' && document.visibilityState === 'hidden')) return;
      pending = true;
      controller = new AbortController();
      try {
        const value = await loadRecordings(channelID, { signal: controller.signal });
        if (!alive || controller.signal.aborted) return;
        setState({ channelID, items: activeRows(value?.items, channelID), access: ['view', 'manage'].includes(value?.access) ? value.access : 'none' });
      } catch (failure) {
        if (!alive || failure.name === 'AbortError') return;
        setState({ channelID, items: [], access: 'none' });
        if (failure instanceof APIError && failure.status === 401) latestExpired.current?.('Your viewer session expired. Sign in again.');
      } finally { pending = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = enabled && interactionActive ? setInterval(refresh, refreshInterval) : null;
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false; operation.current++;
      controller?.abort(); createController.current?.abort(); createController.current = null;
      clearInterval(timer); document.removeEventListener('visibilitychange', resume);
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, [channelID, enabled, interactionActive, loadRecordings, refreshInterval, presentation]);

  const access = state.channelID === channelID ? state.access : 'none';
  const active = state.channelID === channelID && enabled && interactionActive
    && ['view', 'manage'].includes(access) ? state.items[0] : null;
  const choiceVisible = choice?.channelID === channelID && choice.recordingID === active?.id
    && enabled && interactionActive && !playing && !busy && !playbackLoading;
  // Reset before paint: a delayed passive reset must not dismiss a newly opened chooser.
  useLayoutEffect(() => { setChoice(null); }, [channelID, active?.id, access, enabled, interactionActive, playing]);
  useLayoutEffect(() => {
    if (presentation !== 'guide') return;
    if (choiceVisible) beginningRef.current?.focus();
    else if (guideChoiceOpen.current) watchRef.current?.focus();
    guideChoiceOpen.current = Boolean(choiceVisible);
  }, [presentation, choiceVisible]);
  const now = Date.now();
  const canCreate = enabled && interactionActive && access === 'manage' && currentProgram
    && Date.parse(currentProgram.start) <= now && Date.parse(currentProgram.end) > now;
  const openChoice = (event, target = 'browser') => {
    if (!active || playing || busy || playbackLoading) return;
    watchRef.current = event?.currentTarget || document.activeElement;
    setError('');
    setChoice({ channelID, recordingID: active.id, target });
  };
  const watchRecording = (position) => {
    if (!choiceVisible || !active) return;
    setChoice(null); setError('');
    if (choice.target === 'vlc') onVLC?.(active, position);
    else onWatchRecording?.(active, position);
  };
  const recordAndWatch = async () => {
    if (!canCreate || createController.current) return;
    const requestID = ++operation.current;
    const controller = new AbortController(); createController.current = controller;
    const current = () => !controller.signal.aborted && requestID === operation.current && context.current.channelID === channelID && context.current.active;
    setBusy(true); setError('');
    try {
      const result = await changeDVR('recordings', 'POST', csrfToken, {
        channel_id: channelID, start: currentProgram.start, end: currentProgram.end,
      }, { signal: controller.signal });
      if (!current()) return;
      let row = activeRows([result?.recording], channelID)[0];
      let playbackAccess = access;
      const created = result?.recording;
      if (!row && created?.playable) {
        setError('This programme already has a recording. Open DVR to watch it.');
        return;
      }
      // Dispatcharr initially returns pending/scheduled while its recorder starts.
      // Wait for that exact recording; another capture must not claim this action.
      if (!row && typeof created?.id === 'string' && /^[0-9]{1,64}$/.test(created.id)
        && (created.channel_id === channelID || created.channel?.id === channelID)) {
        for (let attempt = 0; attempt < 10 && !row; attempt++) {
          if (!current()) return;
          const lookup = await getChannelRecordings(channelID, { signal: controller.signal });
          if (!current()) return;
          if (!['view', 'manage'].includes(lookup?.access)) throw new APIError('Recording access has ended.', { status: 403 });
          playbackAccess = lookup.access;
          row = activeRows(lookup.items, channelID).find(item => item.id === created.id);
          if (!row) await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      if (!current()) return;
      if (!row) {
        setError('Recording is still starting. It will keep recording; check DVR shortly.');
        void refreshRef.current?.();
        return;
      }
      if (!current()) return;
      setState({ channelID, access: playbackAccess, items: [row] });
      onWatchRecording?.(row, 'latest');
      void refreshRef.current?.();
    } catch (failure) {
      if (!current() || failure.name === 'AbortError') return;
      if (failure instanceof APIError && failure.status === 401) latestExpired.current?.('Your viewer session expired. Sign in again.');
      else setError(failure instanceof APIError ? failure.message : 'Recording could not start. Try again shortly.');
    } finally {
      if (createController.current === controller) createController.current = null;
      if (requestID === operation.current) setBusy(false);
    }
  };
  const actions = [
    ...(!active && canCreate
      ? [{ label: 'Watch & Record', description: 'Records from now. Keeps recording when you leave.', onSelect: recordAndWatch }] : []),
    ...(presentation === 'search' && !active && onRecord && currentProgram && Date.parse(currentProgram.end) > now
      ? [{ label: 'Record', onSelect: () => onRecord(currentProgram) }] : []),
  ];

  const choices = <div className="recording-watch-choices">
    <button className="quiet-button recording-watch-choice" aria-label="Watch from Beginning" onClick={() => watchRecording('beginning')} ref={beginningRef} type="button">
      <span className="recording-watch-choice-title">Watch from Beginning</span>
      <span className="recording-watch-choice-description">Start at the beginning of this recording.</span>
    </button>
    <button className="quiet-button recording-watch-choice" aria-label="Watch Live" onClick={() => watchRecording('latest')} type="button">
      <span className="recording-watch-choice-title">Watch Live</span>
      <span className="recording-watch-choice-description">Join what’s on now, with pause and rewind.</span>
    </button>
  </div>;

  const choiceModal = choiceVisible && presentation !== 'guide' && <Modal labelledBy={choiceTitleID} initialFocusRef={beginningRef} returnFocusRef={watchRef} onClose={() => setChoice(null)}>
    <h3 id={choiceTitleID}>{choice?.target === 'vlc' ? 'Watch recording in VLC' : 'Watch recording'}</h3>
    {choices}
    <div className="dialog-actions"><button className="quiet-button" onClick={() => setChoice(null)} type="button">Cancel</button></div>
  </Modal>;

  if (presentation === 'guide') return <div className="guide-recording-control">
    {choiceVisible && presentation === 'guide' ? <div aria-labelledby={choiceTitleID} role="group">
      <h3 id={choiceTitleID}>{choice?.target === 'vlc' ? 'Watch recording in VLC' : 'Watch recording'}</h3>
      {choices}
      <button className="quiet-button" onClick={() => setChoice(null)} type="button">Cancel</button>
    </div> : <div className={presentation + "-watch-actions" + (active ? " has-recording" : "")}>
      <button className="primary-button" aria-haspopup={active && presentation === "search" ? "dialog" : undefined} disabled={playbackLoading || busy} onClick={active ? openChoice : onWatchLive} ref={watchRef} type="button">
        {playbackLoading || busy ? 'Preparing…' : active ? 'Watch' : 'Watch Live'}
      </button>
      {active && <RecordingStatus recording label="Now Recording" />}
      {!active && canCreate && <button className="quiet-button" disabled={playbackLoading || busy} onClick={recordAndWatch} type="button">Watch &amp; Record</button>}
      {!active && onRecord && <button className="quiet-button" disabled={busy} onClick={() => onRecord(currentProgram)} type="button">Record</button>}
    </div>}
    {choiceModal}
    {error && <p className="live-recording-error" role="alert">{error}</p>}
  </div>;

  return <div className={presentation === 'search' ? "live-recording-control search-recording-control" : "live-recording-control"}>
    <div className={active && !recordingPlaying ? "live-recording-actions has-recording" : "live-recording-actions"}>
      {(presentation !== 'search' || interactionActive) && <WatchControl onWatch={active ? openChoice : onWatchLive} showMenuWatch={false}
        extraActions={actions} onStop={onStop} onVLC={active ? () => openChoice(null, 'vlc') : onVLC}
        playbackLoading={playbackLoading || busy} vlcLoading={vlcLoading} playing={playing}
        selectionKey={'live:' + channelID} watchLabel={active ? 'Watch' : 'Watch Live'}
        watchHasPopup={active ? 'dialog' : undefined} shareTarget={shareTarget} />}
      {active && !recordingPlaying && <RecordingStatus recording label="Now Recording" />}
    </div>
    {choiceModal}
    {error && <p className="live-recording-error" role="alert">{error}</p>}
  </div>;
}
