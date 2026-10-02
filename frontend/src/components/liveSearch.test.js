import { describe, expect, it } from 'vitest';

import { filterLiveChannels } from './liveSearch';

describe('loaded Live channel search', () => {
  it('matches names and numbers across whitespace and case while preserving loaded order', () => {
    const accessible = [
      { id: '2', name: '  Sports   Plus ', channel_number: '  8 ' },
      { id: '3', name: 'SPORTS Plus 2', channel_number: '18' },
      { id: '4', name: 'World News', channel_number: '7' },
    ];
    expect(filterLiveChannels(accessible, '  sports   plus ')).toEqual(accessible.slice(0, 2));
    expect(filterLiveChannels(accessible, ' 8 ')).toEqual(accessible.slice(0, 2));
    expect(filterLiveChannels(accessible, '   ')).toBe(accessible);
    expect(filterLiveChannels(accessible, 'music')).toEqual([]);
  });

  it('scans a synthetic 10,000-channel loaded lineup without changing its entries', () => {
    const loaded = Array.from({ length: 10_000 }, (_, index) => ({
      id: String(index), name: `Station ${index}`, channel_number: String(index + 1),
    }));
    const match = filterLiveChannels(loaded, 'Station   9999');
    expect(match).toEqual([loaded[9999]]);
    expect(loaded).toHaveLength(10_000);
  });
});
