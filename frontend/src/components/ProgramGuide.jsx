import { RecordButton } from './DVR';
import LoadingIndicator from './LoadingIndicator';
const timeFormatter = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

const formatTime = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : timeFormatter.format(parsed);
};

const ProgramTime = ({ program }) => (
  <p className="program-time">
    <time dateTime={program.start}>{formatTime(program.start)}</time>
    <span aria-hidden="true">–</span>
    <time dateTime={program.end}>{formatTime(program.end)}</time>
  </p>
);

const ProgramGuide = ({ error, guide, loading, now, onRecord, onRetry }) => {
  if (loading) {
    return <div className="guide-status" role="status"><LoadingIndicator />Loading program guide…</div>;
  }
  if (error) {
    return (
      <div className="guide-status guide-error" role="alert">
        <p>{error}</p>
        <button className="quiet-button" onClick={onRetry} type="button">Retry guide</button>
      </div>
    );
  }
  if (!guide?.current && !guide?.upcoming) {
    return (
      <div className="guide-empty">
        <p className="guide-kicker">Guide unavailable</p>
        <p>No program information is available for this channel right now.</p>
      </div>
    );
  }

  const current = guide.current;
  const start = current ? new Date(current.start).getTime() : 0;
  const end = current ? new Date(current.end).getTime() : 0;
  const progress = end > start ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : null;

  return (
    <div className="program-guide">
      {current ? (
        <article className="program-card current-program">
          <p className="guide-kicker"><span className="live-dot" />Now</p>
          <h3>{current.title || 'Untitled program'}</h3>
          <ProgramTime program={current} />
          {progress !== null && (
            <div
              aria-label={`${Math.round(progress)}% through current program`}
              aria-valuemax="100"
              aria-valuemin="0"
              aria-valuenow={Math.round(progress)}
              className="program-progress"
              role="progressbar"
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          {current.description && <p className="program-description">{current.description}</p>}
          <RecordButton program={current} onRecord={onRecord} />
        </article>
      ) : (
        <p className="between-programs">No program is currently listed.</p>
      )}

      {guide.upcoming && (
        <article className="program-card upcoming-program">
          <p className="guide-kicker">Up next</p>
          <h3>{guide.upcoming.title || 'Untitled program'}</h3>
          <ProgramTime program={guide.upcoming} />
          <RecordButton program={guide.upcoming} onRecord={onRecord} />
        </article>
      )}
    </div>
  );
};

export default ProgramGuide;
