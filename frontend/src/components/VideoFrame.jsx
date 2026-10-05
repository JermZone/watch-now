import { useLayoutEffect, useRef } from 'react';
import { PHONE_LAYOUT_QUERY } from '../layout';

// Keep desktop video within the viewport without changing phone playback sizing.
export default function VideoFrame({ children, contained = false }) {
  const frameRef = useRef(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const phone = window.matchMedia?.(PHONE_LAYOUT_QUERY);
    const resize = () => {
      if (phone?.matches || contained) {
        frame.style.removeProperty('max-width');
        return;
      }
      // Use document position so scrolling does not continually resize the video.
      // For players further down a long page, reserve at least half a screen.
      const top = Math.max(0, frame.getBoundingClientRect().top + window.scrollY);
      const height = Math.max(1, window.innerHeight - Math.min(top, window.innerHeight / 2) - 24);
      frame.style.maxWidth = `${height * 16 / 9}px`;
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(frame.parentElement.parentElement);
    window.addEventListener('resize', resize);
    phone?.addEventListener?.('change', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      phone?.removeEventListener?.('change', resize);
    };
  }, [contained]);

  return <div className="video-space"><div className="video-frame" ref={frameRef}>{children}</div></div>;
}
