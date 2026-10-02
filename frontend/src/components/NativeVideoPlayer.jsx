import LoadingIndicator from './LoadingIndicator';
import { useEffect, useRef, useState } from 'react';

const NativeVideoPlayer = ({ label = 'Video', onFatalError, source }) => {
  const videoRef = useRef(null);
  const generationRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [autoplayError, setAutoplayError] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return undefined;
    const generation = ++generationRef.current;
    let active = true;
    let fatalReported = false;
    const isCurrent = () => active && generationRef.current === generation;
    const ready = () => {
      if (!isCurrent()) return;
      setLoading(false);
      setAutoplayError('');
    };
    const failed = () => {
      if (!isCurrent() || fatalReported) return;
      fatalReported = true;
      setLoading(false);
      onFatalError?.(`This ${label.toLowerCase()} could not be played in this browser. Try again, or download it to play in VLC.`);
    };

    setLoading(true);
    setAutoplayError('');
    video.addEventListener('loadedmetadata', ready);
    video.addEventListener('canplay', ready);
    video.addEventListener('playing', ready);
    video.addEventListener('error', failed);
    video.setAttribute('src', source);
    try {
      Promise.resolve(video.play()).catch(() => {
        if (isCurrent()) {
          setLoading(false);
          setAutoplayError('Autoplay was prevented. Use the video controls to start.');
        }
      });
    } catch {
      if (isCurrent()) {
        setLoading(false);
        setAutoplayError('Use the video controls to start playback.');
      }
    }

    return () => {
      active = false;
      generationRef.current += 1;
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('playing', ready);
      video.removeEventListener('error', failed);
      try { video.pause(); } catch { /* best-effort media teardown */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* jsdom and partially initialized media */ }
    };
  }, [label, onFatalError, source]);

  return (
    <section className="native-player" aria-label={`${label} playback`}>
      <div className="video-frame">
        <video aria-label={`${label} player`} controls playsInline preload="metadata" ref={videoRef} />
        {loading && <div className="playback-loading" role="status"><LoadingIndicator />Preparing video…</div>}
      </div>
      {autoplayError && <p className="playback-notice" role="status">{autoplayError}</p>}
    </section>
  );
};

export default NativeVideoPlayer;
