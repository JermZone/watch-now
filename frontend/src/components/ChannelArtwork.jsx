import { useEffect, useMemo, useState } from 'react';

import { artworkURL } from '../api';

const initialsFor = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'TV';
};

const ChannelArtwork = ({ channel, categoryID = '', decorative = false, size = 'row' }) => {
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => (channel?.has_artwork ? artworkURL(channel.id, categoryID) : ''),
    [channel?.has_artwork, channel?.id, categoryID],
  );

  useEffect(() => setFailed(false), [source]);

  const className = `channel-artwork channel-artwork-${size}`;
  if (!source || failed) {
    return (
      <span aria-hidden={decorative || undefined} className={`${className} artwork-fallback`}>
        {initialsFor(channel?.name)}
      </span>
    );
  }

  return (
    <span className={className}>
      <img
        alt={decorative ? '' : `${channel.name} logo`}
        loading="lazy"
        onError={() => setFailed(true)}
        src={source}
      />
    </span>
  );
};

export default ChannelArtwork;
