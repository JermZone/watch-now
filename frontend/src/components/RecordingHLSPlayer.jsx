import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { APIError, createDVRActivePlayback, getDVRActivePlaybackStatus, stopDVRActivePlayback } from '../api';
import VideoFrame from './VideoFrame';
import RecordingPlayerControls from './RecordingPlayerControls';
import { isAppleMobile } from './vlc';
import RecordingStatus from './RecordingStatus';
import './RecordingHLSPlayer.css';

const RETRY_LIMIT = 8;
const POLL_INTERVAL = 15000;
const STARTUP_LIMIT = 90000;
const DEFAULT_LIVE_DELAY = 12;

// Descriptors are Watch Now-owned paths. Do not allow a server response to turn
// this player into a request to an upstream host or another recording.
export function validateActivePlayback(value, recordingID) {
  if (!value || typeof value.generation !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.generation)) throw new Error('Invalid recording playback response');
  const base = `/api/dvr/recordings/${encodeURIComponent(recordingID)}/active/${value.generation}`;
  if (value.manifest_url !== `${base}/index.m3u8` || value.status_url !== `${base}/status` || value.stop_url !== `${base}/stop`) throw new Error('Invalid recording playback response');
  return value;
}

export default function RecordingHLSPlayer({ recordingID, csrfToken, onFatalError, contained = false, initialPosition = 'beginning' }) {
  const videoRef = useRef(null);
  const navigationRef = useRef(null);
  const seekRef = useRef(null);
  const fatalRef = useRef(onFatalError);
  fatalRef.current = onFatalError;
  const [notice, setNotice] = useState('Waiting for the first recorded segment…');
  const [loading, setLoading] = useState(true);
  const [showLoadingHint, setShowLoadingHint] = useState(false);
  const [autoplayError, setAutoplayError] = useState('');
  const [captureRecording, setCaptureRecording] = useState(true);
  const [showCaptureStatus, setShowCaptureStatus] = useState(true);
  const [range, setRange] = useState({ available: false, start: 0, end: 0, position: 0, atLive: false });

  useEffect(() => {
    setShowLoadingHint(false);
    if (!loading) return undefined;
    const timer = setTimeout(() => setShowLoadingHint(true), 5000);
    return () => clearTimeout(timer);
  }, [loading, recordingID]);

  useEffect(() => {
    const video = videoRef.current;
    let active = true;
    let failed = false;
    let descriptor;
    let engine;
    let mode = 'waiting';
    let statusBusy = false;
    let queuedStatusReason;
    let creating = false;
    let retryTimer;
    let readyTimer;
    let pollTimer;
    let attempts = 0;
    let statusAttempts = 0;
    let retryIsStatusPoll = false;
    let mediaRecoveries = 0;
    let restore;
    let started = false;
    let initialApplied = false;
    let captureEnded = false;
    let liveDelay = DEFAULT_LIVE_DELAY;
    let deliberatePause = false;
    let resetting = false;
    let programmaticPause = false;
    let mediaEpoch = 0;
    let recoveringStartup = false;
    let fileURL = '';
    let fileReady = false;
    let startupTimer;
    let stopped = false;
    const controllers = new Set();
    const current = () => active && !failed;
    const updateRange = () => {
      if (!current()) return;
      let next = { available: false, start: 0, end: 0, position: 0, atLive: false };
      if (video.seekable.length) {
        const start = video.seekable.start(0);
        const end = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          const position = Math.max(start, Math.min(video.currentTime || 0, end));
          const seekEnd = mode === 'hls' && !captureEnded ? latestPosition(start, end) : Math.max(start, end - 0.01);
          next = { available: true, start, end, seekEnd, position, atLive: seekEnd - position <= 2 };
        }
      }
      setRange(previous => Object.keys(next).every(key => key === 'available' || key === 'atLive'
        ? previous[key] === next[key] : Math.floor(previous[key]) === Math.floor(next[key])) ? previous : next);
    };
    const destroyEngine = (after) => {
      const old = engine;
      engine = null;
      if (old) {
        // Retire callbacks before destroying an instance from its ERROR handler.
        old.stopLoad();
        queueMicrotask(() => { old.destroy(); if (after && current()) after(); });
      } else if (after && current()) after();
    };
    const stop = (value) => {
      if (stopped) return Promise.resolve();
      stopped = true;
      return stopDVRActivePlayback(value.stop_url, csrfToken, { keepalive: true }).catch(() => {});
    };
    const resetMedia = () => {
      mediaEpoch++;
      programmaticPause = true;
      resetting = true;
      video.pause(); video.removeAttribute('src'); video.load();
      resetting = false;
    };
    const fail = (message) => {
      if (!current()) return;
      failed = true;
      clearTimeout(retryTimer); clearTimeout(readyTimer); clearTimeout(startupTimer); clearInterval(pollTimer);
      destroyEngine();
      resetMedia();
      controllers.forEach((controller) => controller.abort());
      if (descriptor) void stop(descriptor);
      setLoading(false); setShowCaptureStatus(false);
      navigationRef.current = null;
      seekRef.current = null;
      fatalRef.current?.(message);
    };
    const cancelRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; retryIsStatusPoll = false; };
    const play = () => {
      const epoch = mediaEpoch;
      const rejected = (error) => {
        // Source reset and engine replacement intentionally abort pending play.
        if (!current() || epoch !== mediaEpoch || error?.name === 'AbortError') return;
        setAutoplayError(error?.name === 'NotAllowedError'
          ? 'Autoplay was prevented. Use the controls to start.'
          : 'Use the controls to start playback.');
      };
      try { Promise.resolve(video.play()).catch(rejected); }
      catch (error) { rejected(error); }
    };
    const snapshot = (recovering = false) => ({
      position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: recovering || video.error ? deliberatePause : video.paused,
    });
    const latestPosition = (earliest, latest) => {
      if (mode === 'file') return Math.max(earliest, latest - 3);
      const safe = Math.max(earliest, latest - liveDelay);
      const sync = engine?.liveSyncPosition;
      // A stalled EVENT playlist's estimated live sync can drift toward its end.
      // Never trade the server-checked captured margin for that stale estimate.
      return Number.isFinite(sync) && sync >= earliest ? Math.min(sync, safe) : safe;
    };
    const initialSeek = () => {
      const earliest = video.seekable.length ? video.seekable.start(0) : 0;
      const latest = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
      if (initialPosition === 'latest') {
        if (!Number.isFinite(latest) || latest <= earliest) return null;
        return latestPosition(earliest, latest);
      }
      return video.seekable.length || mode === 'file' ? earliest : null;
    };
    const ready = (event) => {
      if (!current() || mode === 'waiting' || video.error) return;
      const mediaReady = video.readyState >= 2 || ['canplay', 'playing'].includes(event?.type);
      if (restore) {
        const saved = restore;
        try {
          const earliest = video.seekable.length ? video.seekable.start(0) : 0;
          const latest = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
          if (!saved.applied) {
            const desired = saved.initial ? initialSeek() : saved.position;
            if (desired === null || (!video.seekable.length && mode !== 'file')) { updateRange(); return; }
            const position = Math.max(earliest, Number.isFinite(latest) ? Math.min(desired, latest) : desired);
            if (Math.abs(video.currentTime - position) > 0.001) video.currentTime = position;
            saved.applied = true;
            initialApplied = true;
          }
          if (mediaReady) {
            restore = null;
            deliberatePause = saved.paused;
            if (saved.paused) video.pause(); else play();
          }
        } catch { updateRange(); return; }
      } else if (!initialApplied) {
        try {
          const position = initialSeek();
          if (position === null) { updateRange(); return; }
          if (Math.abs(video.currentTime - position) > 0.001) video.currentTime = position;
          initialApplied = true;
        } catch { updateRange(); return; }
      }
      updateRange();
      if (!mediaReady || (!video.seekable.length && mode !== 'file')) return;
      started = true;
      if (queuedStatusReason === 'recovery') queuedStatusReason = undefined;
      cancelRetry();
      recoveringStartup = false;
      clearTimeout(startupTimer); clearTimeout(readyTimer);
      attempts = 0;
      if (mode === 'file') fileReady = true;
      setLoading(false);
    };
    const schedule = (message, callback, statusPoll = false) => {
      if (!current()) return;
      if (retryTimer) {
        if (!retryIsStatusPoll || statusPoll) return;
        cancelRetry(); // A media failure takes priority over a background retry.
      }
      const count = statusPoll ? ++statusAttempts : ++attempts;
      if (count > RETRY_LIMIT) {
        fail(started
          ? 'This recording could not be played in this browser. Try again from DVR.'
          : 'Recorded video could not be opened in this browser. Recording continues; try again from DVR.');
        return;
      }
      // Background status retries can run while retained video still plays.
      // Keep preparation UI for a real startup, source transition or media error.
      setLoading(!started || mode === 'waiting' || (mode === 'file' && !fileReady)
        || recoveringStartup || Boolean(video.error));
      setNotice(message);
      retryIsStatusPoll = statusPoll;
      retryTimer = setTimeout(() => {
        retryTimer = undefined; retryIsStatusPoll = false;
        if (current()) void callback();
      }, Math.min(2000 * count, 8000));
    };
    const watchReadiness = () => {
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        if (current()) void checkStatus('recovery');
      }, 20000);
    };
    const recoverStartup = () => {
      if (!current() || started || recoveringStartup) return;
      cancelRetry();
      recoveringStartup = true;
      restore = { ...snapshot(true), initial: true };
      initialApplied = false;
      clearTimeout(readyTimer);
      destroyEngine(() => {
        resetMedia();
        mode = 'waiting';
        schedule('Waiting for usable recorded video…', () => { recoveringStartup = false; return checkStatus('recovery'); });
      });
    };
    const attachHLS = () => {
      if (!current() || engine || mode === 'hls') return;
      cancelRetry();
      if (queuedStatusReason === 'recovery') queuedStatusReason = undefined;
      mode = 'hls';
      mediaEpoch++;
      setNotice('Preparing recording…');
      setLoading(true);
      watchReadiness();
      const nativeHLS = video.canPlayType('application/vnd.apple.mpegurl');
      const userAgent = navigator.userAgent;
      const appleWebKit = /AppleWebKit/i.test(userAgent) && (
        isAppleMobile() || (/Apple/i.test(navigator.vendor) && /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox/i.test(userAgent))
      );
      // Chromium can advertise native HLS while exposing no seekable EVENT
      // range. Keep native playback for Apple WebKit, with MSE elsewhere.
      if (Hls.isSupported() && !(nativeHLS && appleWebKit)) {
        const instance = new Hls({
          enableWorker: false, startPosition: initialPosition === 'latest' ? -1 : 0, liveSyncDurationCount: 3,
          initialLiveManifestSize: 3, backBufferLength: 60, maxBufferLength: 30,
          maxMaxBufferLength: 60, lowLatencyMode: false, liveDurationInfinity: false,
          // Retry policy is managed below so authorization failures cannot loop.
          manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 15000, timeoutRetry: null, errorRetry: null } },
          playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 15000, timeoutRetry: null, errorRetry: null } },
          fragLoadPolicy: { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 20000, timeoutRetry: { maxNumRetry: 1, retryDelayMs: 1000, maxRetryDelayMs: 1000 }, errorRetry: null } },
        });
        engine = instance;
        instance.on(Hls.Events.MEDIA_ATTACHED, () => { if (current() && engine === instance) instance.loadSource(descriptor.manifest_url); });
        instance.on(Hls.Events.MANIFEST_PARSED, () => { if (current() && engine === instance && !deliberatePause) play(); });
        instance.on(Hls.Events.FRAG_BUFFERED, () => { if (current() && engine === instance) ready({ type: 'buffered' }); });
        instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          if (current() && engine === instance && data.details?.live === false) {
            captureEnded = true; setCaptureRecording(false);
            setNotice('Recording finished; completing processing…');
            void checkStatus('finalized');
          }
        });
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!current() || engine !== instance) return;
          const status = data.response?.code || data.networkDetails?.status || 0;
          if (status === 401 || status === 403) {
            fail('Recording access has ended. Return to DVR to check your connection.');
            return;
          }
          if ([404, 409].includes(status) || (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR)) {
            if (!started) recoverStartup();
            else { instance.stopLoad(); void checkStatus('recovery'); }
          } else if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR && !started) {
            recoverStartup();
          } else if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) {
            instance.recoverMediaError();
          } else if (data.fatal) {
            fail('This recording could not be played in this browser. Try again after recording finishes.');
          }
        });
        instance.attachMedia(video);
      } else if (nativeHLS) {
        video.src = descriptor.manifest_url;
        video.load();
        if (!deliberatePause) play();
      } else {
        fail('Playback while recording is not supported by this browser.');
      }
    };
    const switchToFile = (url) => {
      if (!current()) return;
      if (url !== `/api/dvr/recordings/${encodeURIComponent(recordingID)}/active/${descriptor.generation}/file`) {
        fail('Watch Now returned an unsupported recording playback response.');
        return;
      }
      if (mode === 'file' && fileURL === url) {
        clearTimeout(retryTimer); retryTimer = undefined; attempts = 0;
        if (fileReady) setLoading(false);
        return;
      }
      captureEnded = true; setCaptureRecording(false);
      queuedStatusReason = undefined;
      restore = snapshot();
      if (!started) { restore.initial = true; restore.paused = deliberatePause; initialApplied = false; }
      clearTimeout(retryTimer); retryTimer = undefined;
      clearTimeout(readyTimer);
      mode = 'file'; fileURL = url; fileReady = false;
      setNotice('Opening the completed recording…'); setLoading(true);
      destroyEngine(() => {
        mediaEpoch++;
        programmaticPause = true;
        resetting = true; video.pause(); resetting = false;
        video.src = url;
        video.load();
        readyTimer = setTimeout(() => fail('The completed recording could not be opened. Return to DVR and try again.'), 20000);
      });
    };
    async function checkStatus(reason = 'poll') {
      if (!current() || !descriptor) return;
      if (statusBusy) {
        if (reason === 'finalized' || (reason === 'recovery' && queuedStatusReason !== 'finalized')) queuedStatusReason = reason;
        return;
      }
      statusBusy = true;
      const controller = new AbortController(); controllers.add(controller);
      try {
        const value = await getDVRActivePlaybackStatus(descriptor.status_url, { signal: controller.signal });
        if (!current()) return;
        if (typeof value?.recording === 'boolean') {
          if (!value.recording) captureEnded = true;
          setCaptureRecording(value.recording && !captureEnded);
        }
        if (Number.isFinite(value?.live_delay_seconds) && value.live_delay_seconds > 0 && value.live_delay_seconds <= 259200) liveDelay = value.live_delay_seconds;
        if (value?.mode === 'file') {
          switchToFile(value.stream_url);
        } else if (value?.mode === 'waiting') {
          // New captures wait for complete media without claiming they finished.
          schedule(value.recording === false ? 'Recording finished; waiting for processing…' : 'Waiting for recorded video to become available…', () => checkStatus('recovery'));
        } else if (value?.mode === 'hls') {
          if (!captureEnded && mode !== 'file') setCaptureRecording(true);
          if (mode === 'waiting' && !recoveringStartup) attachHLS();
          else if (reason === 'recovery') {
            schedule('Reconnecting to the recording…', () => {
              if (engine) engine.startLoad(started ? video.currentTime || 0 : initialPosition === 'latest' ? -1 : 0);
              else {
                restore = started ? snapshot(true) : { ...snapshot(true), initial: true };
                initialApplied = started;
                mediaEpoch++;
                programmaticPause = true;
                resetting = true; video.load(); resetting = false;
                if (!deliberatePause) play();
              }
              watchReadiness();
            });
          } else if (captureEnded) {
            if (started) setLoading(false);
            setNotice('Recording finished; completing processing…');
          }
        } else {
          fail('Watch Now returned an unsupported recording playback response.');
        }
        statusAttempts = 0;
        if (retryIsStatusPoll) cancelRetry();
        updateRange();
      } catch (error) {
        if (!current() || error.name === 'AbortError') return;
        if (error instanceof APIError && [401, 403, 404, 410].includes(error.status)) {
          fail('This recording is no longer available to your account. Return to DVR.');
        } else {
          const retryReason = ['poll', 'finalized'].includes(reason) ? reason : 'recovery';
          const statusPoll = started && ['poll', 'finalized'].includes(reason);
          schedule('The recording connection was interrupted. Retrying…', () => checkStatus(retryReason), statusPoll);
        }
      } finally {
        statusBusy = false; controllers.delete(controller);
        const pending = queuedStatusReason; queuedStatusReason = undefined;
        if (pending && current()) queueMicrotask(() => { if (current()) void checkStatus(pending); });
      }
    }
    const onVideoError = () => {
      if (!current() || video.error?.code === 1) return;
      if (mode === 'file') fail('The completed recording cannot be played by this browser. Return to DVR for VLC or download.');
      else if (!engine && [3, 4].includes(video.error?.code)) {
        if (!started) recoverStartup();
        else fail('This recording could not be decoded by this browser. Try again after recording finishes.');
      } else void checkStatus('recovery');
    };
    const onPause = () => {
      if (!current() || resetting || programmaticPause || video.error) return;
      deliberatePause = true;
      if (mode !== 'file') void checkStatus('poll');
    };
    const onPlay = () => {
      if (!current() || resetting || video.error) return;
      programmaticPause = false;
      deliberatePause = false;
      setAutoplayError('');
      if (mode !== 'file') void checkStatus('poll');
    };
    const onEnded = () => { captureEnded = true; setCaptureRecording(false); void checkStatus('finalized'); };
    const seek = (requested) => {
      if (!current() || !started || !video.seekable.length || !Number.isFinite(requested)) return false;
      const earliest = video.seekable.start(0);
      const latest = video.seekable.end(video.seekable.length - 1);
      const ceiling = mode === 'hls' && !captureEnded ? latestPosition(earliest, latest) : Math.max(earliest, latest - 0.01);
      let desired = Math.max(earliest, Math.min(requested, ceiling));
      // Seek only to retained media, including when a slider points into a gap.
      for (let i = video.seekable.length - 1; i >= 0; i--) {
        if (desired >= video.seekable.start(i)) { desired = Math.min(desired, video.seekable.end(i) - 0.01); break; }
      }
      try { video.currentTime = Math.max(earliest, desired); updateRange(); return true; }
      catch { return false; /* Wait for the next updated range. */ }
    };
    const navigate = (action) => {
      if (!current() || !started || !video.seekable.length) return;
      const earliest = video.seekable.start(0);
      const latest = video.seekable.end(video.seekable.length - 1);
      const requested = action === 'live' ? latestPosition(earliest, latest)
        : action === 'forward' ? video.currentTime + 15 : video.currentTime - 15;
      if (seek(requested) && action === 'live') {
        // Go Live is an explicit watch action; scrubbing and skips keep pause.
        deliberatePause = false; programmaticPause = false; play();
      }
    };
    navigationRef.current = navigate;
    seekRef.current = seek;
    const rangeEvents = ['durationchange', 'timeupdate', 'progress', 'seeking', 'seeked'];
    const onRangeChange = (event) => { if (!started) ready(event); else updateRange(); };
    video.addEventListener('loadedmetadata', ready);
    video.addEventListener('canplay', ready);
    video.addEventListener('playing', ready);
    video.addEventListener('error', onVideoError);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    video.addEventListener('ended', onEnded);
    rangeEvents.forEach(name => video.addEventListener(name, onRangeChange));
    setLoading(true); setAutoplayError(''); setCaptureRecording(true); setShowCaptureStatus(true);
    setRange({ available: false, start: 0, end: 0, position: 0, atLive: false });
    setNotice('Waiting for the first recorded segment…');
    startupTimer = setTimeout(() => fail('Recorded video could not be opened in this browser. Recording continues; try again from DVR.'), STARTUP_LIMIT);
    const create = async () => {
      if (!current() || creating || descriptor) return;
      creating = true;
      try {
        // A preparing response never creates a generation. A late successful
        // response is explicitly stopped; aborting a POST could orphan it.
        const value = await createDVRActivePlayback(recordingID, csrfToken);
        const validated = validateActivePlayback(value, recordingID);
        if (!current()) { void stop(validated); return; }
        descriptor = validated;
        void checkStatus('initial');
        pollTimer = setInterval(() => { if (current()) void checkStatus('poll'); }, POLL_INTERVAL);
      } catch (error) {
        if (!current()) return;
        if (error instanceof APIError && error.status === 409 && error.code === 'recording_preparing') {
          schedule('Waiting for the recording to start…', create);
        } else {
          fail(error instanceof APIError ? error.message : 'Could not start recording playback. Return to DVR and try again.');
        }
      } finally { creating = false; }
    };
    void create();
    return () => {
      active = false;
      clearInterval(pollTimer); clearTimeout(retryTimer); clearTimeout(readyTimer); clearTimeout(startupTimer);
      controllers.forEach((controller) => controller.abort());
      navigationRef.current = null;
      seekRef.current = null;
      destroyEngine();
      if (descriptor) void stop(descriptor);
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('playing', ready);
      video.removeEventListener('error', onVideoError);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('ended', onEnded);
      rangeEvents.forEach(name => video.removeEventListener(name, onRangeChange));
      resetMedia();
    };
  }, [recordingID, csrfToken, initialPosition]);

  const loadingMessage = /Reconnecting|interrupted/.test(notice) ? 'Reconnecting…'
    : /completed|processing/.test(notice) ? 'Finishing recording…' : 'Starting recording…';

  return <section className="native-player" aria-label="Recording playback">
    {showCaptureStatus && <div className="recording-player-status">
      <RecordingStatus recording={captureRecording} showFinished label="Now Recording" />
    </div>}
    <VideoFrame contained={contained}>
      <RecordingPlayerControls key={`${recordingID}:${initialPosition}`} videoRef={videoRef} range={range} loading={loading}
        recording={captureRecording} onNavigate={(action) => navigationRef.current?.(action)}
        onSeek={(position) => seekRef.current?.(position)}>
        <video aria-label="Recording player" slot="media" playsInline preload="metadata" ref={videoRef} />
      </RecordingPlayerControls>
    </VideoFrame>
    {loading && showLoadingHint && <p className="recording-player-notice" role="status">{loadingMessage}</p>}
    {autoplayError && <p className="playback-notice" role="status">{autoplayError}</p>}
  </section>;
}
