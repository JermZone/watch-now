import { useEffect, useRef, useState } from 'react';
import { MediaController, MediaControlBar, MediaFullscreenButton, MediaMuteButton, MediaPlayButton, MediaVolumeRange } from 'media-chrome/react';
import './RecordingPlayerControls.css';

const HIDE_DELAY = 3000;
const SPINNER_DELAY = 400;
const STALL_CONFIRM_DELAY = 800;
const clamp = (value, start, end) => Math.max(start, Math.min(value, end));
const formatTime = (seconds) => {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const tail = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`;
};

function SkipIcon({ forward = false }) {
  return <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d={forward ? 'M25 5v7h-7M25 12a10 10 0 1 0 1 8' : 'M7 5v7h7M7 12a10 10 0 1 1-1 8'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <text x="16" y="22" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="700">15</text>
  </svg>;
}

// The playback engine owns all seeking. Media Chrome only controls play, audio,
// and fullscreen, so a pause or a drag cannot jump to live or into a media gap.
export default function RecordingPlayerControls({ videoRef, range, loading, recording, onNavigate, onSeek, children }) {
  const controllerRef = useRef(null);
  const callbacksRef = useRef({ onNavigate, onSeek });
  callbacksRef.current = { onNavigate, onSeek };
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const scrubbingRef = useRef(false);
  const loadingRef = useRef(loading || !range.available);
  loadingRef.current = loading || !range.available;
  const modalityRef = useRef('keyboard');
  const draftRef = useRef(null);
  const [draft, setDraft] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [paused, setPaused] = useState(true);
  const [mediaBuffering, setMediaBuffering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hoveringControls, setHoveringControls] = useState(false);
  const [visible, setVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [showSpinner, setShowSpinner] = useState(false);

  const start = Number.isFinite(range.start) ? range.start : 0;
  const end = Number.isFinite(range.seekEnd) ? range.seekEnd : Number.isFinite(range.end) ? range.end : start;
  const available = range.available && end > start + 0.01;
  const position = clamp(draft ?? range.position ?? start, start, Math.max(start, end));
  const busy = loading || (mediaBuffering && !paused);
  const atLive = range.atLive && !paused;
  const reveal = () => { setVisible(true); setActivity(value => value + 1); };

  const seek = (value) => {
    const currentRange = rangeRef.current;
    const latest = Number.isFinite(currentRange.seekEnd) ? currentRange.seekEnd : currentRange.end;
    if (!currentRange.available || !Number.isFinite(value) || !Number.isFinite(latest) || latest <= currentRange.start) return;
    callbacksRef.current.onSeek?.(clamp(value, currentRange.start, latest));
  };
  const finishScrub = (cancel = false) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    if (!cancel && !loadingRef.current && draftRef.current !== null) seek(draftRef.current);
    draftRef.current = null;
    setDraft(null);
    reveal();
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    controllerRef.current?.setAttribute('role', 'group');
    controllerRef.current?.setAttribute('aria-label', 'Recording player controls');
    setPaused(video.paused);
    setMediaBuffering(false);
    let monitorTimer;
    let monitoring = false;
    let buffering = false;
    let lastTime = video.currentTime;
    const clearBuffering = () => {
      monitoring = false;
      clearTimeout(monitorTimer);
      if (buffering) { buffering = false; setMediaBuffering(false); }
      lastTime = video.currentTime;
    };
    const progressed = () => {
      const position = video.currentTime;
      if (!Number.isFinite(position) || position <= lastTime + 0.01) return false;
      lastTime = position;
      if (buffering) { buffering = false; setMediaBuffering(false); }
      return true;
    };
    const scheduleCheck = () => {
      clearTimeout(monitorTimer);
      monitorTimer = setTimeout(checkProgress, STALL_CONFIRM_DELAY);
    };
    const checkProgress = () => {
      if (!monitoring) return;
      if (video.paused || video.ended) { clearBuffering(); return; }
      if (!progressed() && !buffering) { buffering = true; setMediaBuffering(true); }
      scheduleCheck();
    };
    const onPlay = () => { setPaused(false); clearBuffering(); };
    const onPause = () => { setPaused(true); clearBuffering(); };
    const onWaiting = () => {
      // A network stall can be reported while buffered video keeps playing.
      // Confirm a stopped media clock before interrupting the watching view.
      if (video.paused || video.ended || monitoring) return;
      monitoring = true;
      lastTime = video.currentTime;
      scheduleCheck();
    };
    const onTimeUpdate = () => {
      if (monitoring && progressed()) scheduleCheck();
    };
    const onReady = () => clearBuffering();
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onWaiting);
    video.addEventListener('error', onWaiting);
    video.addEventListener('timeupdate', onTimeUpdate);
    ['playing', 'canplay', 'seeking', 'seeked', 'emptied'].forEach(name => video.addEventListener(name, onReady));
    return () => {
      monitoring = false;
      clearTimeout(monitorTimer);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('error', onWaiting);
      video.removeEventListener('timeupdate', onTimeUpdate);
      ['playing', 'canplay', 'seeking', 'seeked', 'emptied'].forEach(name => video.removeEventListener(name, onReady));
    };
  }, [videoRef]);

  useEffect(() => {
    if (!busy) { setShowSpinner(false); return; }
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY);
    return () => clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    setVisible(true);
    if (paused || busy || focused || hoveringControls || scrubbing) return;
    const timer = setTimeout(() => setVisible(false), HIDE_DELAY);
    return () => clearTimeout(timer);
  }, [paused, busy, focused, hoveringControls, scrubbing, activity]);

  useEffect(() => {
    if (!loading && available) return;
    scrubbingRef.current = false;
    draftRef.current = null;
    setDraft(null);
    setScrubbing(false);
  }, [loading, available]);

  useEffect(() => {
    const complete = () => finishScrub();
    const cancel = () => finishScrub(true);
    const rememberKeyboard = () => { modalityRef.current = 'keyboard'; };
    window.addEventListener('keydown', rememberKeyboard, true);
    window.addEventListener('pointerup', complete);
    window.addEventListener('pointercancel', cancel);
    return () => {
      scrubbingRef.current = false;
      draftRef.current = null;
      window.removeEventListener('keydown', rememberKeyboard, true);
      window.removeEventListener('pointerup', complete);
      window.removeEventListener('pointercancel', cancel);
    };
  }, []);

  const navigate = (action) => { reveal(); callbacksRef.current.onNavigate?.(action); };
  const onKeyDown = (event) => {
    modalityRef.current = 'keyboard';
    setFocused(true);
    reveal();
    // Native inputs and buttons keep their own keyboard behavior.
    if (event.target !== controllerRef.current && event.target !== videoRef.current) return;
    const video = videoRef.current;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      reveal();
      try {
        if (video?.paused) Promise.resolve(video.play()).catch(() => {});
        else video?.pause();
      } catch { /* The engine owns playback errors and retries. */ }
    } else if (available && !loading && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      reveal();
      if (event.key === 'ArrowLeft') navigate('back');
      else if (event.key === 'ArrowRight') navigate('forward');
      else if (event.key === 'Home') seek(start);
      else if (recording) navigate('live');
      else seek(end);
    }
  };

  return <MediaController
    className="recording-player-controls"
    ref={controllerRef}
    role="group"
    aria-label="Recording player controls"
    tabIndex={0}
    data-controls-visible={visible ? 'true' : 'false'}
    data-recording={recording ? 'true' : 'false'}
    noAutoSeekToLive
    noAutohide
    noHotkeys
    noVolumePref
    noMutedPref
    gesturesDisabled
    autohide={-1}
    onPointerMove={reveal}
    onPointerDown={() => { modalityRef.current = 'pointer'; setFocused(false); reveal(); }}
    onKeyDown={onKeyDown}
    onFocusCapture={() => { setFocused(modalityRef.current === 'keyboard'); reveal(); }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
  >
    {children}
    {showSpinner && <div slot="centered-chrome" noautohide="" className="recording-player-buffering" role="status" aria-label="Buffering recording"><span aria-hidden="true" /></div>}
    <MediaControlBar
      className="recording-player-chrome"
      noautohide=""
      onPointerEnter={event => { if (event.pointerType === 'mouse') setHoveringControls(true); }}
      onPointerLeave={() => setHoveringControls(false)}
    >
      <input
        className="recording-player-timeline"
        type="range"
        aria-label="Recording timeline"
        aria-valuetext={`${formatTime(position - start)} of ${formatTime(end - start)} captured`}
        min={start}
        max={Math.max(start, end)}
        step="0.1"
        value={position}
        disabled={loading || !available}
        style={{ '--recording-progress': `${available ? 100 * (position - start) / (end - start) : 0}%` }}
        onPointerDown={event => {
          if (event.currentTarget.disabled) return;
          scrubbingRef.current = true;
          draftRef.current = position;
          setDraft(position);
          setScrubbing(true);
          reveal();
        }}
        onPointerUp={() => finishScrub()}
        onPointerCancel={() => finishScrub(true)}
        onBlur={() => finishScrub()}
        onKeyDown={event => { if (event.key === 'Escape' && scrubbingRef.current) { event.preventDefault(); finishScrub(true); } }}
        onChange={event => {
          const value = event.currentTarget.valueAsNumber;
          if (!Number.isFinite(value)) return;
          reveal();
          if (scrubbingRef.current) { draftRef.current = value; setDraft(value); }
          else seek(value);
        }}
      />
      <div className="recording-player-transport">
        <MediaPlayButton disabled={loading && !available} noTooltip />
        <button className="recording-player-button" aria-label="Back 15 seconds" title="Back 15 seconds" type="button" disabled={loading || !available || position <= start + 0.25} onClick={() => navigate('back')}><SkipIcon /></button>
        <button className="recording-player-button" aria-label="Forward 15 seconds" title="Forward 15 seconds" type="button" disabled={loading || !available || position >= end - 0.25} onClick={() => navigate('forward')}><SkipIcon forward /></button>
      </div>
      <span className="recording-player-time" aria-hidden="true" title={recording && !range.atLive ? `${formatTime(end - position)} behind live` : undefined}>{recording && !range.atLive ? `−${formatTime(end - position)}` : formatTime(position - start)}{!recording && <span> / {formatTime(Math.max(0, end - start))}</span>}</span>
      {recording && <button className={`recording-player-button recording-player-live${atLive ? ' is-live' : ''}`} type="button" aria-label={atLive ? 'LIVE' : 'Go Live'} disabled={loading || !available || atLive} onClick={() => navigate('live')}><span aria-hidden="true" className="recording-player-live-dot" />{atLive ? 'LIVE' : 'Go Live'}</button>}
      <div className="recording-player-audio">
        <MediaMuteButton noTooltip />
        <MediaVolumeRange aria-label="Volume" />
      </div>
      <MediaFullscreenButton className="recording-player-fullscreen" noTooltip />
    </MediaControlBar>
  </MediaController>;
}
