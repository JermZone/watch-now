import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TVGuide, { guideLanes, currentTitleStart } from './TVGuide';
import { APIError, getTVGuide } from '../api';
vi.mock('../api', async (original) => ({ ...await original(), getTVGuide: vi.fn() }));
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
 const target = Number(slider.min) + 12 * 3600000;
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
 expect(screen.queryByRole('button', { name: 'Watch live', exact: true })).not.toBeInTheDocument();
 await userEvent.click(logo);
 expect(screen.getByRole('dialog')).toHaveAccessibleName('News');
 expect(p.onWatch).not.toHaveBeenCalled();
 expect(screen.queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: 'Close' }));
 expect(logo).toHaveFocus();
 await userEvent.click(logo);
 await userEvent.click(screen.getByRole('button', { name: 'Watch live', exact: true }));
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

it('stops automatic loading at 100 retained channels and continues with an explicit fresh batch', async () => {
 getTVGuide.mockImplementation(async ({ page: number = 1 }) => ({ ...page(), page: number, has_more: number < 24,
  items: Array.from({ length: 5 }, (_, i) => ({ channel: { ...channel, id: String((number - 1) * 5 + i), name: `Channel ${(number - 1) * 5 + i}` }, programs: [] })),
 }));
 render(<TVGuide {...props()} />);
 await screen.findByText('Showing 50 channels in this batch.');
 const grid = screen.getByRole('region', { name: /Schedule grid/ });
 Object.defineProperty(grid, 'clientHeight', { value: 500, configurable: true });
 for (let count = 50; count < 100; count += 10) {
  Object.defineProperty(grid, 'scrollHeight', { value: 40 + count * 89, configurable: true });
  grid.scrollTop = 40 + count * 89 - 500; fireEvent.scroll(grid);
  await screen.findByText(`Showing ${count + 10} channels in this batch.`);
 }
 const calls = getTVGuide.mock.calls.length;
 Object.defineProperty(grid, 'scrollHeight', { value: 8940, configurable: true });
 grid.scrollTop = 8440; fireEvent.scroll(grid);
 expect(getTVGuide).toHaveBeenCalledTimes(calls);
 await userEvent.click(screen.getByRole('button', { name: 'Next channels' }));
 await screen.findByText('Showing 10 channels in this batch.');
 expect(grid.scrollTop).toBe(0);
 expect(getTVGuide).toHaveBeenCalledTimes(calls + 2);
});

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
