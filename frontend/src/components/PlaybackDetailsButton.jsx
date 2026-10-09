// The information action stays with its title in every playback header.
export default function PlaybackDetailsButton({ onClick, ref }) {
  return <button className="playback-details-button" aria-haspopup="dialog" onClick={onClick} ref={ref} type="button">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 10.5v6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
    </svg>
    <span>Details</span>
  </button>;
}
