import LoadingIndicator from './LoadingIndicator';
import { useEffect, useState } from 'react';

const DetailLoadingStatus = ({ label = 'Loading details…' }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="detail-loading-status">
      <p className="inline-status" role="status">
        <LoadingIndicator />
        <span>{label}</span>
      </p>
      <p aria-live="off" className="detail-loading-note">
        Request in progress{elapsed > 0 ? ` · ${elapsed}s elapsed` : ''}.
      </p>
    </div>
  );
};

export default DetailLoadingStatus;
