import LoadingIndicator from './LoadingIndicator';
import { useEffect, useRef, useState } from 'react';
import mpegts from 'mpegts.js';

import { liveStreamURL } from '../api';
import { installLiveTrackGuard } from './liveTrackGuard';

const PARTIAL_PLAYBACK_TIMEOUT = 10000;

const LivePlayer = ({ channel, onFatalError }) => {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const generationRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [autoplayError, setAutoplayError] = useState('');
  const [playbackWarning, setPlaybackWarning] = useState('');
  const fatalErrorRef = useRef(onFatalError);
  fatalErrorRef.current = onFatalError;

  useEffect(() => {
    const generation = ++generationRef.current;
    let player;
    let active = true;
    let retired = false;
    let playable = false;
    let partialPlaybackTimer;
    let trackGuard;
    const video = videoRef.current;
    const isCurrent = () => active && !retired && generationRef.current === generation && (!player || playerRef.current === player);
    const destroy = (defer = false) => {
      if (retired) return;
      retired = true;
      clearTimeout(partialPlaybackTimer);
      if (playerRef.current === player) playerRef.current = null;
      if (!player) return;
      // With workers disabled, mpegts queues callbacks in Promise microtasks.
      // Destroying inside its ERROR callback nulls emitters those callbacks still
      // need. Fence this instance now and dispose after the current task drains.
      const dispose = () => {
        for (const operation of ['pause', 'unload', 'detachMediaElement', 'destroy']) {
          try { player[operation]?.(); } catch { /* finish every teardown operation */ }
        }
      };
      if (defer) setTimeout(dispose, 0);
      else dispose();
    };
    const fail = (message) => {
      if (!isCurrent()) return;
      setLoading(false);
      destroy(true);
      fatalErrorRef.current?.(message);
    };

    setLoading(true);
    setAutoplayError('');
    setPlaybackWarning('');
    if (!mpegts.isSupported()) {
      setLoading(false);
      fatalErrorRef.current?.('Live playback is not supported by this browser.');
      return undefined;
    }
    const onPlayable = () => {
      if (!isCurrent()) return;
      playable = true;
      clearTimeout(partialPlaybackTimer);
      setLoading(false);
    };
    const onVideoError = () => {
      if (video.error?.code === 1) return; // A user-initiated abort is not a decode failure.
      fail(video.error?.code === 2
        ? 'The live stream connection failed. Try again.'
        : 'The browser could not decode this live stream. Try another browser.');
    };
    video.addEventListener('canplay', onPlayable);
    video.addEventListener('playing', onPlayable);
    video.addEventListener('error', onVideoError);
    try {
      player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: liveStreamURL(channel.id) }, { enableWorker: false, lazyLoad: false });
      playerRef.current = player;
      player.on(mpegts.Events.ERROR, (type, detail, info) => {
        if (!isCurrent()) return;
        // addSourceBuffer may reject one track while the other still plays.
        // Only DOM NotSupportedError (code 9) gets this bounded continuation;
        // network, decode, and other MSE errors retain fatal handling.
        if (type === mpegts.ErrorTypes.MEDIA_ERROR && detail === mpegts.ErrorDetails.MEDIA_MSE_ERROR && info?.code === 9) {
          const rejected = trackGuard?.rejectInitializingTrack();
          if (!rejected) {
            fail('The browser could not decode this live stream. Try another browser.');
            return;
          }
          if (rejected.allRejected) {
            fail('No supported stream tracks started playing. Try another browser.');
            return;
          }
          setLoading(false);
          setPlaybackWarning(rejected.track === 'audio'
            ? 'This browser cannot play the audio track. Video may continue without sound. Try another browser for audio.'
            : 'This browser cannot play the video track. Audio may continue without video. Try another browser for video.');
          if (!playable && !partialPlaybackTimer) {
            partialPlaybackTimer = setTimeout(() => {
              fail('No supported stream tracks started playing. Try another browser.');
            }, PARTIAL_PLAYBACK_TIMEOUT);
          }
          return;
        }
        fail(type === mpegts.ErrorTypes.NETWORK_ERROR
          ? 'The live stream connection failed. Try again.'
          : 'The browser could not decode this live stream. Try another browser.');
      });
      player.on(mpegts.Events.MEDIA_INFO, () => { if (isCurrent()) setLoading(false); });
      player.attachMediaElement(videoRef.current);
      trackGuard = installLiveTrackGuard(player, mpegts.version);
      player.load();
      Promise.resolve(player.play()).catch(() => {
        if (isCurrent()) {
          setLoading(false);
          setAutoplayError('Playback could not start automatically. Use the video controls to try again.');
        }
      });
    } catch {
      fail('This channel could not be played in this browser.');
    }

    return () => {
      active = false;
      generationRef.current += 1;
      video.removeEventListener('canplay', onPlayable);
      video.removeEventListener('playing', onPlayable);
      video.removeEventListener('error', onVideoError);
      destroy();
    };
  }, [channel.id]);

  return (
    <section className="live-player" aria-label={`Live playback for ${channel.name}`}>
      {playbackWarning && (
        <div className="playback-warning" role="status" aria-atomic="true">
          <span className="playback-warning-icon" aria-hidden="true">!</span>
          <div><strong>Playback warning</strong><p>{playbackWarning}</p></div>
        </div>
      )}
      <div className="video-frame">
        <video aria-label={`Live video for ${channel.name}`} controls key={channel.id} playsInline ref={videoRef} />
        {loading && <div className="playback-loading" role="status"><LoadingIndicator />Loading live stream…</div>}
      </div>
      {autoplayError && <p className="playback-notice" role="status">{autoplayError}</p>}
    </section>
  );
};

export default LivePlayer;
