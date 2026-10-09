import './RecordingStatus.css';

export default function RecordingStatus({ recording, showFinished = false, title, label = 'Recording in progress' }) {
  if (!recording && !showFinished) return null;
  return <span className={`recording-status${recording ? ' is-recording' : ' is-finished'}`} role="status" aria-live="polite" aria-atomic="true">
    <span className="recording-status-dot" aria-hidden="true" />
    <span>{recording ? label : 'Recording finished'}</span>
    {title && <span className="recording-status-title">{title}</span>}
  </span>;
}
