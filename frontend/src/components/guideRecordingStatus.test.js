import { describe, expect, it } from 'vitest';
import { buildGuideRecordingIndex, guideRecordingStatus } from './guideRecordingStatus';

const now = Date.parse('2026-10-09T17:30:00Z');
const program = { id: 'a'.repeat(32), channel: { id: '41' }, title: 'Evening News', subtitle: 'Tonight', start: '2026-10-09T17:00:00Z', end: '2026-10-09T18:00:00Z' };
const row = { id: '7', channel_id: '41', title: program.title, subtitle: program.subtitle, start: program.start, end: program.end, status: 'recording' };
const status = (rows, show = program) => guideRecordingStatus(show, buildGuideRecordingIndex(rows), now);

describe('guide recording matching', () => {
  it.each(['recording', 'scheduled'])('marks the owning airing as %s with padded capture times', (value) => {
    expect(status([{ ...row, status: value, start: '2026-10-09T16:55:00Z', end: '2026-10-09T18:05:00Z', airing_id: program.id, title: 'Changed upstream title' }])).toBe(value);
  });
  it('does not transfer an explicit owner to an adjacent same-title repeat reached by padding', () => {
    const next = { ...program, id: 'b'.repeat(32), start: program.end, end: '2026-10-09T19:00:00Z' };
    expect(status([{ ...row, end: '2026-10-09T19:05:00Z', airing_id: program.id }], next)).toBe('');
  });
  it('matches partial Watch & Record captures by their original airing ID', () => {
    expect(status([{ ...row, start: '2026-10-09T17:29:00Z', airing_id: program.id }])).toBe('recording');
  });
  it('matches equivalent time-zone offsets and normalizes title spacing', () => {
    expect(status([{ ...row, title: '  EVENING   NEWS ', start: '2026-10-09T11:00:00-06:00', end: '2026-10-09T12:00:00-06:00' }])).toBe('recording');
  });
  it('supports legacy scheduled and late recordings while respecting title and subtitle', () => {
    expect(status([{ ...row, status: 'scheduled', start: '2026-10-09T16:55:00Z', end: '2026-10-09T18:05:00Z' }])).toBe('scheduled');
    expect(status([{ ...row, start: '2026-10-09T17:29:00Z' }])).toBe('recording');
    expect(status([{ ...row, title: 'Another show', start: '2026-10-09T16:55:00Z', end: '2026-10-09T18:05:00Z' }])).toBe('');
    expect(status([{ ...row, subtitle: 'Another episode' }])).toBe('');
  });
  it('supports complete generic captures but does not guess at partial generic captures', () => {
    expect(status([{ ...row, title: 'Recording' }])).toBe('recording');
    expect(status([{ ...row, title: '', start: '2026-10-09T17:29:00Z' }])).toBe('');
  });
  it('requires a positive overlap, even with an owning identifier', () => {
    expect(status([{ ...row, start: program.end, end: '2026-10-09T19:00:00Z', airing_id: program.id }])).toBe('');
    expect(status([{ ...row, start: '2026-10-09T16:00:00Z', end: program.start, airing_id: program.id }])).toBe('');
  });
  it('does not mark a short unrelated fragment or an earlier same-title capture', () => {
    expect(status([{ ...row, end: '2026-10-09T17:40:00Z' }])).toBe('');
    expect(status([{ ...row, start: '2026-10-09T16:00:00Z', end: '2026-10-09T17:40:00Z' }])).toBe('');
  });
  it.each(['recorded', 'attention', 'cancelled', 'failed', 'stopped'])('omits %s recordings', (value) => {
    expect(status([{ ...row, status: value }])).toBe('');
  });
  it('omits other channels, expired schedules, invalid dates, reversed intervals, and invalid IDs', () => {
    for (const changes of [{ channel_id: '42' }, { start: 'bad' }, { end: 'bad' }, { end: program.start }, { id: 'invalid' }]) {
      expect(status([{ ...row, ...changes }])).toBe('');
    }
    expect(status([{ ...row, status: 'scheduled', start: '2026-10-09T15:00:00Z', end: '2026-10-09T16:00:00Z' }])).toBe('');
    expect(status([row], { ...program, start: 'bad' })).toBe('');
  });
  it('prefers recording now over a scheduled duplicate', () => {
    expect(status([{ ...row, status: 'scheduled' }, row])).toBe('recording');
  });
  it('bounds retained entries and tolerates missing catalogs', () => {
    expect(buildGuideRecordingIndex(null).size).toBe(0);
    expect(buildGuideRecordingIndex(Array(5001).fill(row)).get('41')).toHaveLength(5000);
  });
});
