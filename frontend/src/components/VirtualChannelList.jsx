import { useEffect, useId, useRef, useState } from 'react';

import ChannelArtwork from './ChannelArtwork';

const COMFORTABLE_ROW_HEIGHT = 76;
const COMPACT_ROW_HEIGHT = 64;
const OVERSCAN = 5;

const channelLabel = (channel) =>
  channel.channel_number ? `${channel.channel_number} · ${channel.name}` : channel.name;

const VirtualChannelList = ({ categoryID, channels, compact = false, selectedID, onSelect }) => {
  const listID = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const viewportRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : COMFORTABLE_ROW_HEIGHT;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const updateHeight = () => setViewportHeight(viewport.clientHeight || 520);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setScrollTop(0);
    setActiveIndex(0);
  }, [channels]);

  if (channels.length === 0) {
    return <p className="empty-state">No live channels are available in this category.</p>;
  }

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
  const last = Math.min(channels.length, first + visibleCount);
  const visibleChannels = channels.slice(first, last);

  const moveFocus = (event) => {
    let next = activeIndex;
    if (event.key === 'ArrowDown') next = Math.min(channels.length - 1, activeIndex + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, activeIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = channels.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (channels[activeIndex]) onSelect(channels[activeIndex]);
      return;
    } else return;
    event.preventDefault();
    setActiveIndex(next);
    const top = next * rowHeight;
    const viewport = viewportRef.current;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowHeight > viewport.scrollTop + viewportHeight) viewport.scrollTop = top + rowHeight - viewportHeight;
    setScrollTop(viewport.scrollTop);
  };

  return (
    <div
      aria-activedescendant={activeIndex >= first && activeIndex < last ? `${listID}-${activeIndex}` : undefined}
      onKeyDown={moveFocus}
      aria-label="Live channels"
      className={`channel-viewport ${compact ? 'is-compact' : ''}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={viewportRef}
      role="listbox"
      tabIndex={0}
    >
      <div className="channel-spacer" style={{ height: channels.length * rowHeight }}>
        {visibleChannels.map((channel, index) => {
          const rowIndex = first + index;
          const selected = channel.id === selectedID;
          return (
            <button
              id={`${listID}-${rowIndex}`}
              tabIndex={-1}
              aria-posinset={rowIndex + 1}
              aria-setsize={channels.length}
              aria-label={channelLabel(channel)}
              aria-selected={selected}
              className={`channel-row ${selected ? 'is-selected' : ''} ${rowIndex === activeIndex ? 'is-focused' : ''}`}
              key={channel.id}
              onClick={() => { setActiveIndex(rowIndex); viewportRef.current?.focus(); onSelect(channel); }}
              role="option"
              style={{ height: rowHeight - (compact ? 6 : 8), transform: `translateY(${rowIndex * rowHeight}px)` }}
              type="button"
            >
              <span className="channel-number">{channel.channel_number || '—'}</span>
              <ChannelArtwork categoryID={categoryID} channel={channel} decorative />
              <span className="channel-name">{channel.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default VirtualChannelList;
