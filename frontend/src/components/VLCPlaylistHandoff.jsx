import { useEffect, useId, useRef } from 'react';

const VLCPlaylistHandoff = ({ error, loading, onBack, onRetry, title }) => {
  const headingId = useId();
  const headingRef = useRef(null);

  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);

  return <section aria-labelledby={headingId} className="vlc-handoff">
    <div className="vlc-handoff-content">
      <p className="vlc-handoff-label">Ready to watch in VLC</p>
      <h3 id={headingId} ref={headingRef} tabIndex="-1">{title}</h3>
      <p role="status">Open the downloaded playlist in VLC right away. Its link expires shortly.</p>
      <p>If too much time has passed, choose Watch in VLC again to download a fresh playlist.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="vlc-handoff-actions">
        <button className="primary-button" disabled={loading} onClick={onRetry} type="button">{loading ? 'Preparing VLC…' : 'Watch in VLC again'}</button>
        <button className="quiet-button" onClick={onBack} type="button">Back to details</button>
      </div>
    </div>
  </section>;
};

export default VLCPlaylistHandoff;
