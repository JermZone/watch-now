import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TVGuide, { guideLanes, currentTitleStart } from './TVGuide';
import { APIError, changeDVR, getChannelRecordings, getTVGuide } from '../api';
vi.mock('../api', async (original) => ({ ...await original(), getTVGuide: vi.fn(), getChannelRecordings: vi.fn(), changeDVR: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });
const channel = { id: '41', name: 'News', channel_number: '7' };
const airing = (id = 'a', future = false) => ({ id, channel, title: `Program ${id}`, start: new Date(Date.now() + (future ? 86400000 : -3600000)).toISOString(), end: new Date(Date.now() + (future ? 90000000 : 3600000)).toISOString() });
const coverage = () => Array.from({ length: 8 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
const page = (id = 'a', more = false, number = 1) => ({ available_dates: coverage(), items: [{ channel: { ...channel, id }, programs: [airing(id)] }], snapshot: 's1', page: number, has_more: more });
const props = () => ({ active: true, categories: [], channels: [channel], isMobile: false, onExpired: vi.fn(), onWatch: vi.fn(), onRecord: vi.fn(), channelID: '', onChannelChange: vi.fn() });

it('loads only when opened and selects details without autoplay', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = props(); const view = render(<TVGuide {...p} active={false} />);
 expect(getTVGuide).not.toHaveBeenCalled();
 expect(screen.queryByText(/Three-hour view; listings vary by channel/)).not.toBeInTheDocument();
 view.rerender(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: /News, Program a/ }));
 expect(screen.getByRole('dialog')).toBeInTheDocument();
 expect(p.onWatch).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button', { name: 'Record' }));
 expect(p.onRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
});
it('appends channel pages using the snapshot and resets on date navigation', async () => {
 localStorage.setItem('watch-now-guide-layout', 'agenda');
 getTVGuide.mockResolvedValueOnce(page('a', true)).mockResolvedValueOnce(page('b', false, 2)).mockResolvedValue({ ...page('c'), items: [{ channel, programs: [airing('c', true)] }] });
 render(<TVGuide {...props()} />);
 await userEvent.click(await screen.findByRole('button', { name: 'Load more channels' }));
 expect(await screen.findByRole('button', { name: /Program b,/ })).toBeInTheDocument();
 expect(screen.getByRole('button', { name: /Program a,/ })).toBeInTheDocument();
 expect(getTVGuide.mock.calls[1][0]).toMatchObject({ page: 2, snapshot: 's1' });
 await userEvent.click(screen.getByRole('group', { name: 'Guide day' }).querySelectorAll('button[aria-pressed]')[1]);
 await screen.findByRole('button', { name: /Program c,/ });
 expect(screen.queryByRole('button', { name: /Program a,/ })).not.toBeInTheDocument();
});
it('rejects a stale snapshot instead of mixing generations', async () => {
 localStorage.setItem('watch-now-guide-layout', 'agenda');
 getTVGuide.mockResolvedValueOnce(page('a', true)).mockRejectedValueOnce(new APIError('Refresh the schedule', { status: 409, code: 'guide_changed' }));
 render(<TVGuide {...props()} />);
 await userEvent.click(await screen.findByRole('button', { name: 'Load more channels' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the schedule');
 expect(screen.queryByRole('button', { name: /Program a,/ })).not.toBeInTheDocument();
});
it('shows mobile agenda and future recording without a future Watch action', async () => {
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [airing('future', true)] }] });
 const p = props(); render(<TVGuide {...p} isMobile />);
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 await userEvent.click(await screen.findByRole('button', { name: /Program future,/ }));
 expect(screen.getByRole('dialog').querySelectorAll('button')).toHaveLength(2);
 expect(screen.getByRole('group', { name: 'Guide layout' })).toBeInTheDocument();
});
it('ignores a late response after changing the selected channel', async () => {
 let resolve; getTVGuide.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(page('new'));
 const p = props(); const view = render(<TVGuide {...p} />);
 view.rerender(<TVGuide {...p} channelID="42" />);
 await screen.findByRole('button', { name: /Program new,/ });
 resolve(page('old'));
 await waitFor(() => expect(screen.queryByRole('button', { name: /Program old,/ })).not.toBeInTheDocument());
});
it('groups overlapping programs into a single row and clips the viewport', () => {
 const programs = [{ start: new Date(0).toISOString(), end: new Date(200).toISOString() }, { start: new Date(150).toISOString(), end: new Date(300).toISOString() }];
 const result = guideLanes(programs, 100, 250);
 expect(result).toHaveLength(1);
 expect(result[0].programs).toHaveLength(2);
 expect(result[0].lane).toBe(0); expect(result[0].left).toBe(0); expect(result[0].width).toBeCloseTo(100);
});
it('supports keyboard movement between airings and reports expired sessions', async () => {
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [{ ...airing('a'), end: new Date(Date.now() + 60000).toISOString() }, { ...airing('b'), start: new Date(Date.now() + 60000).toISOString() }] }] });
 const p = props(); render(<TVGuide {...p} />);
 const first = await screen.findByRole('button', { name: /Program a,/ }); first.focus();
 fireEvent.keyDown(first, { key: 'ArrowRight' });
 expect(screen.getByRole('button', { name: /Program b,/ })).toHaveFocus();
 getTVGuide.mockRejectedValueOnce(new APIError('Expired', { status: 401 }));
 await userEvent.click(screen.getByRole('button', { name: 'Now', exact: true }));
 await waitFor(() => expect(p.onExpired).toHaveBeenCalled());
});

it('clears a retained group when View in Guide selects a channel outside it', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = { ...props(), categories: [{ id: '2', name: 'News' }, { id: '3', name: 'Sports' }], channels: [{ ...channel, category_id: '2' }] };
 const view = render(<TVGuide {...p} />);
 await screen.findByRole('button', { name: /Program a,/ });
 fireEvent.change(screen.getByLabelText('Guide group'), { target: { value: '3' } });
 view.rerender(<TVGuide {...p} channelID="41" />);
 await waitFor(() => expect(screen.getByLabelText('Guide group')).toHaveValue(''));
 await waitFor(() => expect(getTVGuide.mock.calls.at(-1)[0]).toMatchObject({ channelID: '41', categoryID: '' }));
});

it('debounces time scrubbing, keeps a three-hour window, and returns to Now', async () => {
 getTVGuide.mockResolvedValue(page());
 render(<TVGuide {...props()} />);
 await screen.findByRole('button', { name: /Program a,/ });
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 const days = screen.getByRole('group', { name: 'Guide day' }).querySelectorAll('button[aria-pressed]');
 expect(screen.getByRole('button', { name: 'Today', exact: true }).previousElementSibling).toBe(screen.getByRole('button', { name: 'Now', exact: true }));
 await userEvent.click(days[1]);
 await waitFor(() => expect(getTVGuide).toHaveBeenCalledTimes(3));
 const slider = screen.getByRole('slider', { name: 'Guide start time' });
 const noon = Number(slider.min) + 12 * 3600000;
 // Scrub to a different window even when the test runs during the noon hour.
 const target = Number(slider.value) === noon ? noon + 3600000 : noon;
 fireEvent.change(slider, { target: { value: String(target - 1800000) } });
 fireEvent.change(slider, { target: { value: String(target) } });
 expect(getTVGuide).toHaveBeenCalledTimes(3);
 await waitFor(() => expect(getTVGuide).toHaveBeenCalledTimes(4));
 const request = getTVGuide.mock.calls.at(-1)[0];
 expect(Date.parse(request.start)).toBe(target);
 expect(Date.parse(request.end) - Date.parse(request.start)).toBe(3 * 3600000);
 expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining(new Date(target).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })));
 await userEvent.click(screen.getByRole('button', { name: 'Now', exact: true }));
 await waitFor(() => expect(Date.parse(getTVGuide.mock.calls.at(-1)[0].start)).toBe(Math.floor(Date.now() / 1800000) * 1800000));
 await userEvent.click(days[days.length - 1]);
 fireEvent.change(slider, { target: { value: slider.max } });
 await waitFor(() => expect(Date.parse(getTVGuide.mock.calls.at(-1)[0].start)).toBe(Number(slider.max)));
 expect(Date.parse(getTVGuide.mock.calls.at(-1)[0].end)).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
 expect(screen.queryByRole('button', { name: 'Earlier' })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
});

it('refreshes stale listings, pauses while hidden, and reloads when Guide reopens', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  try {
    getTVGuide.mockImplementation(() => Promise.resolve({ ...page(), fetched_at: new Date().toISOString() }));
    const p = props();
    const view = render(<TVGuide {...p} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Refresh guide' })).not.toBeInTheDocument();
    expect(getTVGuide).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(getTVGuide).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getTVGuide).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(301000); });
    expect(getTVGuide).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {});
    expect(getTVGuide).toHaveBeenCalledTimes(3);
    view.rerender(<TVGuide {...p} active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(301000); });
    expect(getTVGuide).toHaveBeenCalledTimes(3);
    view.rerender(<TVGuide {...p} />);
    await act(async () => {});
    expect(getTVGuide).toHaveBeenCalledTimes(4);
  } finally { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); }
 });

it('keeps Retry available after an automatic reload fails', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  try {
    getTVGuide.mockResolvedValueOnce({ ...page(), fetched_at: new Date().toISOString() })
      .mockRejectedValueOnce(new Error('Guide temporarily unavailable'))
      .mockResolvedValue(page());
    render(<TVGuide {...props()} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(301000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Guide temporarily unavailable');
    await act(async () => { await vi.advanceTimersByTimeAsync(301000); });
    expect(getTVGuide).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry guide' }));
    await act(async () => {});
    expect(getTVGuide).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  } finally { cleanup(); vi.useRealTimers(); }
 });

it('offers mobile grid by default and remembers List time while fetching separate windows', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = props(); const view = render(<TVGuide {...p} isMobile />);
 await screen.findByRole('button', { name: /Program a,/ });
 expect(screen.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true');
 expect(screen.getByRole('region', { name: /Schedule grid/ })).toBeInTheDocument();
 expect(screen.queryByRole('slider')).not.toBeInTheDocument();
 const calls = getTVGuide.mock.calls.length;
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 const selected = screen.getByRole('slider').value;
 expect(getTVGuide).toHaveBeenCalledTimes(calls + 1);
 expect(localStorage.getItem('watch-now-guide-layout')).toBe('agenda');
 await userEvent.click(screen.getByRole('button', { name: 'Grid', exact: true }));
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 expect(screen.getByRole('slider').value).toBe(selected);
 view.unmount();
 render(<TVGuide {...p} isMobile />);
 expect(screen.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

it('shows only confirmed dates and clears coverage when the channel changes', async () => {
 getTVGuide.mockResolvedValue({ ...page(), available_dates: [coverage()[2]] });
 const p = props(); const view = render(<TVGuide {...p} />);
 await screen.findByRole('button', { name: /Program a,/ });
 expect(screen.getByRole('group', { name: 'Guide day' }).querySelectorAll('button[aria-pressed]')).toHaveLength(2);
 getTVGuide.mockResolvedValue({ ...page(), available_dates: [] });
 view.rerender(<TVGuide {...p} channelID="42" />);
 await waitFor(() => expect(screen.getByRole('group', { name: 'Guide day' }).querySelectorAll('button[aria-pressed]')).toHaveLength(1));
 expect(screen.getByRole('button', { name: 'Today', exact: true })).toBeInTheDocument();
});

it('uses shared logos in Grid with an accessible missing-logo fallback and names in List', async () => {
 const logoChannel = { ...channel, has_artwork: true };
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel: logoChannel, programs: [] }] });
 render(<TVGuide {...props()} isMobile />);
 const logo = await screen.findByRole('img', { name: 'News logo' });
 expect(logo).toHaveAttribute('src', '/api/live/channels/41/artwork');
 expect(logo.parentElement).toHaveClass('channel-artwork');
 expect(screen.getByRole('group', { name: '7 News' })).toBeInTheDocument();
 await act(async () => {});
 fireEvent.error(logo);
 expect(screen.queryByRole('img', { name: 'News logo' })).not.toBeInTheDocument();
 expect(screen.getByText('N')).toBeInTheDocument();
 expect(screen.getByRole('group', { name: '7 News' })).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 expect(screen.getByText('7 News')).toBeVisible();
});

it('opens channel options from the Grid logo without autoplay and restores focus on close', async () => {
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [] }] });
 const p = props(); render(<TVGuide {...p} isMobile />);
 const logo = await screen.findByRole('button', { name: 'Options for News' });
 expect(screen.queryByRole('button', { name: 'Watch Live', exact: true })).not.toBeInTheDocument();
 await userEvent.click(logo);
 expect(screen.getByRole('dialog')).toHaveAccessibleName('News');
 expect(p.onWatch).not.toHaveBeenCalled();
 expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: 'Close' }));
 expect(logo).toHaveFocus();
 await userEvent.click(logo);
 await userEvent.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
 expect(p.onWatch).toHaveBeenCalledWith(channel);
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('removes exact duplicates but keeps conflicting listings selectable with original times', async () => {
 const first = airing('a'); const second = airing('b');
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [first, { ...first, id: 'duplicate' }, second] }] });
 const p = props(); render(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: 'News, 2 overlapping listings' }));
 expect(screen.getByRole('dialog')).toHaveAccessibleName('Overlapping listings');
 expect(p.onWatch).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button', { name: /Program b/ }));
 expect(screen.getByRole('dialog')).toHaveAccessibleName('Program b');
 await userEvent.click(screen.getByRole('button', { name: 'Record' }));
 expect(p.onRecord).toHaveBeenCalledWith(second);
});

it('places the desktop layout switch beside dates while retaining the phone controls', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = props();
 const view = render(<TVGuide {...p} />);
 await screen.findByRole('button', { name: /News, Program a/ });
 expect(screen.getByRole('group', { name: 'Guide layout' }).parentElement).toBe(screen.getByRole('group', { name: 'Guide day' }).parentElement);
 view.rerender(<TVGuide {...p} isMobile />);
 expect(screen.getByRole('group', { name: 'Guide layout' }).parentElement).toContainElement(screen.getByLabelText('Guide channel'));
});

it('loads local midnight to midnight for Grid, preserves the List window, and scrolls without fetching', async () => {
 getTVGuide.mockResolvedValue(page());
 render(<TVGuide {...props()} />);
 await screen.findByRole('button', { name: /Program a,/ });
 const first = getTVGuide.mock.calls.at(-1)[0];
 expect(new Date(first.start).getHours()).toBe(0);
 const next = new Date(first.start); next.setDate(next.getDate() + 1);
 expect(first.end).toBe(next.toISOString());
 const grid = screen.getByRole('region', { name: /Schedule grid/ });
 Object.defineProperties(grid, { clientWidth: { value: 900, configurable: true }, scrollWidth: { value: 4980, configurable: true } });
 grid.scrollLeft = 0;
 fireEvent.scroll(grid);
 const scrollbar = screen.getByRole('region', { name: 'Schedule horizontal scrollbar' });
 expect(scrollbar.firstChild.style.width).toBe('4980px');
 expect(screen.queryByRole('button', { name: /Scroll schedule/ })).not.toBeInTheDocument();
 const calls = getTVGuide.mock.calls.length;
 scrollbar.scrollLeft = 720; fireEvent.scroll(scrollbar);
 expect(grid.scrollLeft).toBe(720);
 expect(getTVGuide).toHaveBeenCalledTimes(calls);
 grid.scrollLeft = 1500; fireEvent.scroll(grid);
 expect(scrollbar.scrollLeft).toBe(1500);
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 const listTime = screen.getByRole('slider').value;
 await userEvent.click(screen.getByRole('button', { name: 'Grid', exact: true }));
 const days = screen.getByRole('group', { name: 'Guide day' }).querySelectorAll('button[aria-pressed]');
 await userEvent.click(days[1]);
 const future = getTVGuide.mock.calls.at(-1)[0];
 expect(new Date(future.start).getDate()).toBe(next.getDate());
 expect(new Date(future.start).getHours()).toBe(0);
 expect(grid.scrollLeft).toBe(0);
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 expect(screen.getByRole('slider').value).toBe(listTime);
 expect(Date.parse(getTVGuide.mock.calls.at(-1)[0].end) - Date.parse(getTVGuide.mock.calls.at(-1)[0].start)).toBe(3 * 3600000);
});

it('leaves title context before Now, removes expired programs, and keeps phone swipe navigation', async () => {
 vi.useFakeTimers();
 try {
  const now = new Date(2026, 9, 5, 12, 0, 0).getTime();
  vi.setSystemTime(now);
  const program = (id, start, end) => ({ ...airing(id), start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program('past', now - 7200000, now - 3600000), program('current', now - 3600000, now + 20000), program('next', now + 20000, now + 3600000)] }] });
  render(<TVGuide {...props()} isMobile />);
  await act(async () => {});
  const current = screen.getByRole('button', { name: /Program current,/ });
  expect(current.style.left).toBe('0%');
  expect(screen.queryByRole('button', { name: /Program past,/ })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: /Schedule grid/ }).querySelector('.tv-guide-time-labels')).toHaveTextContent('Now');
  expect(screen.queryByRole('region', { name: 'Schedule horizontal scrollbar' })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(screen.queryByRole('button', { name: /Program current,/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Program next,/ }).style.left).toBe('0%');
  expect(getTVGuide).toHaveBeenCalledTimes(1);
 } finally { cleanup(); vi.useRealTimers(); }
});

it('loads 50 Grid channels, renders visible rows, and appends 10 once near the bottom', async () => {
 getTVGuide.mockImplementation(async ({ page: number = 1 }) => ({
  ...page(), page: number, has_more: number < 16,
  items: Array.from({ length: 5 }, (_, i) => {
   const id = String((number - 1) * 5 + i + 1);
   const ch = { ...channel, id, name: `Channel ${id}` };
   return { channel: ch, programs: [{ ...airing(id), channel: ch }] };
  }),
 }));
 render(<TVGuide {...props()} />);
 await screen.findByText('Showing 50 channels in this batch.');
 expect(screen.queryByRole('button', { name: 'Load more channels' })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Next channels' })).not.toBeInTheDocument();
 expect(getTVGuide).toHaveBeenCalledTimes(10);
 expect(getTVGuide.mock.calls.slice(1).every(([request]) => request.snapshot === 's1')).toBe(true);
 expect(document.querySelectorAll('[data-guide-row]').length).toBeLessThan(20);
 const grid = screen.getByRole('region', { name: /Schedule grid/ });
 Object.defineProperties(grid, { clientHeight: { value: 500, configurable: true }, scrollHeight: { value: 4490, configurable: true } });
 grid.scrollTop = 3900; fireEvent.scroll(grid);
 grid.scrollTop = 3910; fireEvent.scroll(grid);
 await screen.findByText('Showing 60 channels in this batch.');
 expect(getTVGuide).toHaveBeenCalledTimes(12);
 expect(grid.scrollTop).toBe(3910);
 expect(screen.getByRole('button', { name: /Options for Channel 50/ })).toBeInTheDocument();
 expect(document.querySelectorAll('[data-guide-row]').length).toBeLessThan(20);
 grid.scrollLeft = 500; fireEvent.scroll(grid);
 expect(getTVGuide).toHaveBeenCalledTimes(12);
});

it('cancels the remaining initial Grid pages when the selected channel changes', async () => {
 let finishOld;
 getTVGuide.mockResolvedValueOnce(page('old', true, 1))
  .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
  .mockResolvedValue(page('new'));
 const p = props(); const view = render(<TVGuide {...p} />);
 await waitFor(() => expect(getTVGuide).toHaveBeenCalledTimes(2));
 const signal = getTVGuide.mock.calls[1][0].signal;
 view.rerender(<TVGuide {...p} channelID="42" />);
 await screen.findByRole('button', { name: /Program new,/ });
 expect(signal.aborted).toBe(true);
 await act(async () => { finishOld(page('stale', true, 2)); });
 expect(getTVGuide).toHaveBeenCalledTimes(3);
 expect(screen.queryByRole('button', { name: /Program stale,/ })).not.toBeInTheDocument();
});

it('stops automatic loading at 500 retained channels and continues with an explicit fresh batch', async () => {
 getTVGuide.mockImplementation(async ({ page: number = 1 }) => ({ ...page(), page: number, has_more: number < 104,
  items: Array.from({ length: 5 }, (_, i) => ({ channel: { ...channel, id: String((number - 1) * 5 + i), name: `Channel ${(number - 1) * 5 + i}` }, programs: [] })),
 }));
 render(<TVGuide {...props()} />);
 await screen.findByText('Showing 50 channels in this batch.');
 expect(screen.queryByRole('button', { name: 'Load more channels' })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Next channels' })).not.toBeInTheDocument();
 const grid = screen.getByRole('region', { name: /Schedule grid/ });
 Object.defineProperty(grid, 'clientHeight', { value: 500, configurable: true });
 for (let count = 50; count < 500; count += 10) {
  Object.defineProperty(grid, 'scrollHeight', { value: 40 + count * 89, configurable: true });
  grid.scrollTop = 40 + count * 89 - 500; fireEvent.scroll(grid);
  await screen.findByText(`Showing ${count + 10} channels in this batch.`);
  expect(document.querySelectorAll('[data-guide-row]').length).toBeLessThan(20);
  if (count + 10 < 500) expect(screen.queryByRole('button', { name: 'Next channels' })).not.toBeInTheDocument();
 }
 const calls = getTVGuide.mock.calls.length;
 Object.defineProperty(grid, 'scrollHeight', { value: 44540, configurable: true });
 grid.scrollTop = 44040; fireEvent.scroll(grid);
 expect(getTVGuide).toHaveBeenCalledTimes(calls);
 await userEvent.click(screen.getByRole('button', { name: 'Next channels' }));
 await screen.findByText('Showing 10 channels in this batch.');
 expect(grid.scrollTop).toBe(0);
 expect(getTVGuide).toHaveBeenCalledTimes(calls + 2);
}, 15000); // Exercise all 100 API pages and 45 incremental scroll loads.

it('borrows only the title space needed from a current airing, never from an ended show', () => {
 const now = new Date(2026, 9, 5, 12).getTime();
 const day = new Date(2026, 9, 5).getTime();
 const program = (start, end) => ({ title: 'The current show', start: new Date(start).toISOString(), end: new Date(end).toISOString() });
 const ended = program(now - 5 * 3600000, now);
 const endingSoon = program(now - 3600000, now + 5 * 60000);
 const start = currentTitleStart([{ programs: [ended, endingSoon] }], day, now);
 expect(start).toBe(now - 49 * 60000);
 expect((Date.parse(endingSoon.end) - start) / 3600000 * 200).toBe(180);
 expect(currentTitleStart([{ programs: [ended, program(now - 3600000, now + 2 * 3600000)] }], day, now)).toBe(now);
 expect(currentTitleStart([{ programs: [program(now - 5 * 60000, now + 5 * 60000)] }], day, now)).toBe(now - 5 * 60000);
});

it('offers matching Guide watch actions and records the exact current airing before watching', async () => {
 const program = airing('current');
 const recording = { ...program, id: '7', channel_id: channel.id, status: 'recording', can_watch_active: true };
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program] }] });
 getChannelRecordings.mockResolvedValue({ items: [], access: 'manage' });
 changeDVR.mockResolvedValue({ recording, already_scheduled: false });
 const p = { ...props(), dvrEnabled: true, csrfToken: 'guide-csrf', onWatchRecording: vi.fn() };
 render(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: /News, Program current,/ }));
 const watchAndRecord = await screen.findByRole('button', { name: 'Watch & Record', exact: true });
 expect(screen.getByRole('button', { name: 'Watch Live', exact: true })).toHaveClass('primary-button');
 expect(watchAndRecord).toHaveClass('quiet-button');
 expect(screen.getByRole('button', { name: 'Record', exact: true })).toHaveClass('quiet-button');
 expect(screen.getByRole('button', { name: 'Close', exact: true })).toHaveClass('quiet-button');
 await userEvent.click(watchAndRecord);
 await waitFor(() => expect(p.onWatchRecording).toHaveBeenCalledWith(channel, recording, 'latest'));
 expect(changeDVR).toHaveBeenCalledTimes(1);
 expect(changeDVR).toHaveBeenCalledWith('recordings', 'POST', 'guide-csrf', {
  channel_id: channel.id, start: program.start, end: program.end,
 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
 expect(p.onWatch).not.toHaveBeenCalled();
 expect(p.onRecord).not.toHaveBeenCalled();
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each([
 ['Watch from Beginning', 'beginning'],
 ['Watch Live', 'latest'],
])('keeps Guide recording choices in one modal and watches %s without creating a recording', async (label, position) => {
 const program = airing('current');
 const recording = { ...program, id: '7', channel_id: channel.id, status: 'recording', can_watch_active: true };
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program] }] });
 getChannelRecordings.mockResolvedValue({ items: [recording], access: 'view' });
 const p = { ...props(), dvrEnabled: true, csrfToken: 'guide-csrf', onWatchRecording: vi.fn() };
 render(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: /News, Program current,/ }));
 const watch = await screen.findByRole('button', { name: 'Watch', exact: true });
 expect(screen.getByText('Now Recording')).toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Watch & Record', exact: true })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Record', exact: true })).not.toBeInTheDocument();
 await userEvent.click(watch);
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 expect(screen.getByRole('button', { name: 'Watch from Beginning', exact: true })).toHaveFocus();
 expect(screen.queryByRole('button', { name: 'Watch', exact: true })).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: label, exact: true }));
 expect(p.onWatchRecording).toHaveBeenCalledWith(channel, recording, position);
 expect(p.onWatch).not.toHaveBeenCalled();
 expect(changeDVR).not.toHaveBeenCalled();
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps future Guide airings record-only without recording discovery', async () => {
 const program = airing('future', true);
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program] }] });
 const p = { ...props(), dvrEnabled: true, csrfToken: 'guide-csrf', onWatchRecording: vi.fn() };
 render(<TVGuide {...p} />);
 await userEvent.click(screen.getByRole('button', { name: 'List', exact: true }));
 await userEvent.click(await screen.findByRole('button', { name: /News, Program future,/ }));
 expect(getChannelRecordings).not.toHaveBeenCalled();
 expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /Watch/ })).not.toBeInTheDocument();
 const record = screen.getByRole('button', { name: 'Record', exact: true });
 expect(record).toHaveClass('quiet-button');
 expect(screen.getByRole('button', { name: 'Close', exact: true })).toHaveClass('quiet-button');
 await userEvent.click(record);
 expect(p.onRecord).toHaveBeenCalledWith(program);
 expect(changeDVR).not.toHaveBeenCalled();
 expect(p.onWatchRecording).not.toHaveBeenCalled();
});

it('does not start late Guide playback after closing while Watch & Record is pending', async () => {
 const program = airing('current');
 const recording = { ...program, id: '7', channel_id: channel.id, status: 'recording', can_watch_active: true };
 let finishCreate;
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program] }] });
 getChannelRecordings.mockResolvedValue({ items: [], access: 'manage' });
 changeDVR.mockImplementation(() => new Promise(resolve => { finishCreate = resolve; }));
 const p = { ...props(), dvrEnabled: true, csrfToken: 'guide-csrf', onWatchRecording: vi.fn() };
 render(<TVGuide {...p} />);
 const programButton = await screen.findByRole('button', { name: /News, Program current,/ });
 await userEvent.click(programButton);
 await userEvent.click(await screen.findByRole('button', { name: 'Watch & Record', exact: true }));
 await waitFor(() => expect(finishCreate).toBeTypeOf('function'));
 const signal = changeDVR.mock.calls[0][4].signal;
 await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(signal.aborted).toBe(true);
 expect(programButton).toHaveFocus();
 await act(async () => finishCreate({ recording }));
 expect(p.onWatchRecording).not.toHaveBeenCalled();
 expect(p.onWatch).not.toHaveBeenCalled();
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('returns from Guide recording choices to its actions without nesting or starting playback', async () => {
 const program = airing('current');
 const recording = { ...program, id: '7', channel_id: channel.id, status: 'recording', can_watch_active: true };
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [program] }] });
 getChannelRecordings.mockResolvedValue({ items: [recording], access: 'view' });
 const p = { ...props(), dvrEnabled: true, csrfToken: 'guide-csrf', onWatchRecording: vi.fn() };
 render(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: /News, Program current,/ }));
 await userEvent.click(await screen.findByRole('button', { name: 'Watch', exact: true }));
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 await userEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 expect(screen.getByRole('button', { name: 'Watch', exact: true })).toHaveFocus();
 expect(screen.queryByRole('button', { name: 'Watch from Beginning', exact: true })).not.toBeInTheDocument();
 expect(p.onWatchRecording).not.toHaveBeenCalled();
 expect(changeDVR).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});


// Guide markers describe DVR state without changing the airing's action.
const markerNow = new Date('2026-10-09T12:00:00Z').getTime();
const markerProgram = (id, fromMinutes, durationMinutes, overrides = {}) => ({
  id, channel, title: `Marker program ${id}`,
  start: new Date(markerNow + fromMinutes * 60000).toISOString(),
  end: new Date(markerNow + (fromMinutes + durationMinutes) * 60000).toISOString(),
  ...overrides,
});
const markerRecording = (program, status = 'recording', overrides = {}) => ({
  id: `7${program.id.length}`, channel_id: program.channel.id, title: program.title,
  start: program.start, end: program.end, status, ...overrides,
});
const markerPage = (programs, rows) => ({
  available_dates: ['2026-10-09', '2026-10-10'], snapshot: 'markers', page: 1, has_more: false,
  items: rows || [{ channel, programs }],
});
const settleMarkers = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const withMarkerClock = async (task) => {
  vi.useFakeTimers();
  vi.setSystemTime(markerNow);
  try { await task(); }
  finally { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); }
};
const markerProps = (recordings = []) => ({
  ...props(), dvrEnabled: true, recordingsAvailable: true, recordings,
});

it.each(['Grid', 'List'])('shows only recording and scheduled guide markers in %s, with accessible status on each airing', (layout) => withMarkerClock(async () => {
  if (layout === 'List') localStorage.setItem('watch-now-guide-layout', 'agenda');
  const current = markerProgram('active', -30, 60);
  const scheduled = markerProgram('scheduled', 30, 30);
  const ordinary = markerProgram('ordinary', 60, 30);
  const failed = markerProgram('failed', 90, 30);
  const completed = markerProgram('completed', 120, 30);
  getTVGuide.mockResolvedValue(markerPage([current, scheduled, ordinary, failed, completed]));
  render(<TVGuide {...markerProps([
    markerRecording(current), markerRecording(scheduled, 'scheduled'),
    markerRecording(failed, 'failed'), markerRecording(completed, 'recorded'),
  ])} />);
  await settleMarkers();
  for (const [program, status, label] of [[current, 'recording', 'Recording now'], [scheduled, 'scheduled', 'Scheduled recording']]) {
    const button = screen.getByRole('button', { name: new RegExp(`${program.title},.*${label}$`) });
    expect(button).toHaveAttribute('title', expect.stringContaining(program.title));
    expect(button).toHaveAttribute('title', expect.stringContaining(label));
    const dot = button.querySelector('.tv-guide-recording-dot');
    expect(dot).toHaveAttribute('data-recording-status', status);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(button.textContent).not.toContain(label);
  }
  for (const program of [ordinary, failed, completed]) {
    expect(screen.getByRole('button', { name: new RegExp(program.title) }).querySelector('.tv-guide-recording-dot')).toBeNull();
  }
  expect(document.querySelectorAll('.tv-guide-recording-dot')).toHaveLength(2);
  expect(getChannelRecordings).not.toHaveBeenCalled();
}));

it.each([
  ['DVR is disabled', { dvrEnabled: false }],
  ['the catalog is unavailable', { recordingsAvailable: false }],
  ['the catalog availability was not supplied', { recordingsAvailable: undefined }],
])('omits guide markers when %s', (_label, override) => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60);
  getTVGuide.mockResolvedValue(markerPage([program]));
  render(<TVGuide {...markerProps([markerRecording(program)])} {...override} />);
  await settleMarkers();
  const button = screen.getByRole('button', { name: new RegExp(program.title) });
  expect(button.querySelector('.tv-guide-recording-dot')).toBeNull();
  expect(button).not.toHaveAttribute('title', expect.stringContaining('Recording now'));
  expect(button).not.toHaveAccessibleName(expect.stringContaining('Recording now'));
}));

it.each([
  ['a legacy full capture with the same title', {}, true],
  ['a legacy generic capture covering the airing', { title: 'Recording' }, true],
  ['a legacy untitled capture covering the airing', { title: '' }, true],
  ['a partial capture ending with the airing', { start: new Date(markerNow).toISOString() }, true],
  ['a partial capture that ends before the airing', { start: new Date(markerNow).toISOString(), end: new Date(markerNow + 10 * 60000).toISOString() }, false],
  ['another title during the same time', { title: 'Different programme' }, false],
  ['a different episode subtitle', { subtitle: 'Another episode' }, false],
  ['a matching explicit airing ID with a changed title', { airing_id: 'a'.repeat(32), title: 'Updated title', start: new Date(markerNow).toISOString() }, true],
  ['a different explicit airing ID despite matching times', { airing_id: 'b'.repeat(32) }, false],
  ['the same ID outside the airing interval', { airing_id: 'a'.repeat(32), start: new Date(markerNow + 40 * 60000).toISOString(), end: new Date(markerNow + 50 * 60000).toISOString() }, false],
  ['a zero-length recording interval', { end: new Date(markerNow - 30 * 60000).toISOString() }, false],
  ['invalid recording times', { start: 'invalid' }, false],
])('matches guide markers correctly for %s', (_label, override, matched) => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60, { id: 'a'.repeat(32), subtitle: 'Episode one' });
  getTVGuide.mockResolvedValue(markerPage([program]));
  render(<TVGuide {...markerProps([markerRecording(program, 'recording', override)])} />);
  await settleMarkers();
  const button = screen.getByRole('button', { name: new RegExp(program.title) });
  expect(Boolean(button.querySelector('.tv-guide-recording-dot'))).toBe(matched);
  if (matched) expect(button).toHaveAccessibleName(expect.stringMatching(/Recording now$/));
}));

it('does not mark repeated titles at another time or on another channel', () => withMarkerClock(async () => {
  const current = markerProgram('active', -30, 60, { title: 'Daily bulletin' });
  const later = markerProgram('later', 30, 60, { title: current.title });
  const otherChannel = { ...channel, id: '42', name: 'Other news' };
  const elsewhere = { ...current, id: 'other', channel: otherChannel };
  getTVGuide.mockResolvedValue(markerPage([], [
    { channel, programs: [current, later] },
    { channel: otherChannel, programs: [elsewhere] },
  ]));
  render(<TVGuide {...markerProps([markerRecording(current)])} channels={[channel, otherChannel]} />);
  await settleMarkers();
  const sameChannel = within(screen.getByRole('group', { name: '7 News' }).closest('[data-guide-row]')).getAllByRole('button', { name: /Daily bulletin/ });
  expect(sameChannel[0].querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'recording');
  expect(sameChannel[1].querySelector('.tv-guide-recording-dot')).toBeNull();
  const otherButton = screen.getByRole('button', { name: /Other news, Daily bulletin/ });
  expect(otherButton.querySelector('.tv-guide-recording-dot')).toBeNull();
}));

it('shows a recording marker on a conflict block and the correct marker on each selectable listing', () => withMarkerClock(async () => {
  const first = markerProgram('first', -30, 60);
  const second = markerProgram('second', -15, 60);
  getTVGuide.mockResolvedValue(markerPage([first, second]));
  getChannelRecordings.mockResolvedValue({ items: [], access: 'view' });
  const p = markerProps([markerRecording(first, 'scheduled'), markerRecording(second)]);
  render(<TVGuide {...p} />);
  await settleMarkers();
  const group = screen.getByRole('button', { name: /News, 2 overlapping listings.*Recording now$/ });
  expect(group.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'recording');
  expect(group).toHaveAttribute('title', expect.stringContaining('Recording now'));
  fireEvent.click(group);
  const choices = within(screen.getByRole('dialog', { name: 'Overlapping listings' }));
  const scheduled = choices.getByRole('button', { name: new RegExp(`${first.title},.*Scheduled recording$`) });
  const recording = choices.getByRole('button', { name: new RegExp(`${second.title},.*Recording now$`) });
  expect(scheduled.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'scheduled');
  expect(recording.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'recording');
  fireEvent.click(recording);
  await settleMarkers();
  expect(screen.getByRole('dialog')).toHaveAccessibleName(second.title);
  expect(p.onWatch).not.toHaveBeenCalled();
  expect(p.onRecord).not.toHaveBeenCalled();
  expect(changeDVR).not.toHaveBeenCalled();
}));

it('updates guide markers immediately from the shared catalog after create, start, and cancellation', () => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60);
  getTVGuide.mockResolvedValue(markerPage([program]));
  const p = markerProps();
  const view = render(<TVGuide {...p} />);
  await settleMarkers();
  const requestCount = getTVGuide.mock.calls.length;
  expect(document.querySelector('.tv-guide-recording-dot')).toBeNull();
  view.rerender(<TVGuide {...p} recordings={[markerRecording(program, 'scheduled')]} />);
  expect(document.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'scheduled');
  view.rerender(<TVGuide {...p} recordings={[markerRecording(program)]} />);
  expect(document.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'recording');
  view.rerender(<TVGuide {...p} recordings={[]} />);
  expect(document.querySelector('.tv-guide-recording-dot')).toBeNull();
  expect(getTVGuide).toHaveBeenCalledTimes(requestCount);
  expect(getChannelRecordings).not.toHaveBeenCalled();
}));

it('refreshes the shared recording catalog on guide entry, every thirty seconds, and visible resume', () => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60);
  getTVGuide.mockResolvedValue(markerPage([program]));
  const refresh = vi.fn().mockResolvedValue();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const p = { ...markerProps(), onRefreshRecordings: refresh };
  const view = render(<TVGuide {...p} active={false} />);
  await settleMarkers();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(<TVGuide {...p} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(3);
  view.rerender(<TVGuide {...p} suspended />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  fireEvent(document, new Event('visibilitychange'));
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(3);
  view.rerender(<TVGuide {...p} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(4);
  view.rerender(<TVGuide {...p} active={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(refresh).toHaveBeenCalledTimes(4);
  view.rerender(<TVGuide {...p} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(5);
}));

it('skips overlapping recording refreshes and can refresh again after a rejected request', () => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60);
  getTVGuide.mockResolvedValue(markerPage([program]));
  let complete;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockRejectedValueOnce(new Error('Catalog temporarily unavailable')).mockResolvedValue();
  render(<TVGuide {...markerProps()} onRefreshRecordings={refresh} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  fireEvent(document, new Event('visibilitychange'));
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { complete(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
}));

it('waits for parent DVR operations and skips refreshes when the guide is hidden or disabled', () => withMarkerClock(async () => {
  getTVGuide.mockResolvedValue(markerPage([]));
  const refresh = vi.fn().mockResolvedValue();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const p = { ...markerProps(), onRefreshRecordings: refresh };
  const view = render(<TVGuide {...p} recordingsBusy />);
  await settleMarkers();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refresh).not.toHaveBeenCalled();
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await settleMarkers();
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(<TVGuide {...p} recordingsBusy={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(<TVGuide {...p} dvrEnabled={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  fireEvent(document, new Event('visibilitychange'));
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
}));

it('refreshes an unavailable catalog and displays markers only after the parent confirms current data', () => withMarkerClock(async () => {
  const program = markerProgram('active', -30, 60);
  const recordings = [markerRecording(program)];
  getTVGuide.mockResolvedValue(markerPage([program]));
  const refresh = vi.fn().mockResolvedValue({ items: recordings });
  const p = { ...markerProps(recordings), onRefreshRecordings: refresh };
  const view = render(<TVGuide {...p} recordingsAvailable={false} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.tv-guide-recording-dot')).toBeNull();
  view.rerender(<TVGuide {...p} recordingsAvailable />);
  expect(document.querySelector('.tv-guide-recording-dot')).toHaveAttribute('data-recording-status', 'recording');
  view.rerender(<TVGuide {...p} recordingsAvailable={false} />);
  expect(document.querySelector('.tv-guide-recording-dot')).toBeNull();
  expect(getTVGuide).toHaveBeenCalledTimes(1);
}));

it('does not retain refresh listeners or start additional requests after unmount with a pending refresh', () => withMarkerClock(async () => {
  getTVGuide.mockResolvedValue(markerPage([]));
  let complete;
  const refresh = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<TVGuide {...markerProps()} onRefreshRecordings={refresh} />);
  await settleMarkers();
  expect(refresh).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { complete({ items: [markerRecording(markerProgram('active', -30, 60))] }); });
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.tv-guide-recording-dot')).toBeNull();
}));
