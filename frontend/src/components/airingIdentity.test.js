import { describe, expect, it } from 'vitest';
import { mergeSelectedAiring, sameAiring } from './airingIdentity';
const current = { title: 'Morning News', start: '2026-10-08T17:00:00Z', end: '2026-10-08T18:00:00Z', description: 'Short' };
const selected = { ...current, channel: { id: '41' }, subtitle: 'World events', description: 'A longer selected description' };
describe('Selected airing identity', () => {
  it('merges one exact current programme across timezone and title formatting', () => {
    const airing = { ...selected, title: ' morning   NEWS ', start: '2026-10-08T11:00:00-06:00', end: '2026-10-08T12:00:00-06:00' };
    expect(sameAiring(airing, current, '41')).toBe(true);
    const merged = mergeSelectedAiring({ current }, airing, '41');
    expect(merged.current.subtitle).toBe('World events');
    expect(merged.current.description).toBe(airing.description);
  });
  it.each([
    [{ ...selected, channel: { id: '42' } }],
    [{ ...selected, start: '2026-10-08T17:01:00Z' }],
    [{ ...selected, title: 'Another programme' }],
    [{ ...selected, start: 'invalid' }],
    [{ ...selected, end: selected.start }],
    [{ ...selected, title: '' }],
  ])('does not hide a distinct or invalid selection %#', (airing) => {
    expect(sameAiring(airing, current, '41')).toBe(false);
    const guide = { current };
    expect(mergeSelectedAiring(guide, airing, '41')).toBe(guide);
  });
});
