import { useState } from 'react';
import Modal from './Modal';

// One layout for every in-browser player. Metadata never competes with video height.
export default function PlaybackStage({ title, artwork, backLabel, onBack, onStop, details, children }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <section className="playback-stage" aria-label={`Watching ${title}`}>
    <div className="playback-stage-navigation">
      <button className="back-button" onClick={onBack} type="button">← {backLabel}</button>
      {details && <button className="quiet-button" onClick={() => setDetailsOpen(true)} type="button">Playback details</button>}
    </div>
    <div className="playback-stage-card">
      <div className="playback-stage-heading">{artwork}<h2 title={title}>{title}</h2><button className="primary-button watch-primary is-stop" onClick={onStop} type="button">Stop</button></div>
      {children}
    </div>
    {detailsOpen && <Modal labelledBy="playback-details-heading" onClose={() => setDetailsOpen(false)}><h2 id="playback-details-heading">Playback details</h2><h3>{title}</h3>{details}<button onClick={() => setDetailsOpen(false)} type="button">Close</button></Modal>}
  </section>;
}
