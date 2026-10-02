import { useEffect, useState } from 'react';

const PosterArtwork = ({ label, source }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return (
      <span className="poster-fallback" aria-label={`${label} artwork unavailable`}>
        <span aria-hidden="true">▶</span>
        <small>No artwork</small>
      </span>
    );
  }
  return <img alt={`${label} poster`} loading="lazy" onError={() => setFailed(true)} src={source} />;
};

export default PosterArtwork;
