import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TVGuide, { guideLanes } from './TVGuide';
import { APIError, getTVGuide } from '../api';
vi.mock('../api', async (original) => ({ ...await original(), getTVGuide: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const channel = { id: '41', name: 'News', channel_number: '7' };
const airing = (id = 'a', future = false) => ({ id, channel, title: `Program ${id}`, start: new Date(Date.now() + (future ? 86400000 : -3600000)).toISOString(), end: new Date(Date.now() + (future ? 90000000 : 3600000)).toISOString() });
const page = (id = 'a', more = false, number = 1) => ({ items: [{ channel: { ...channel, id }, programs: [airing(id)] }], snapshot: 's1', page: number, has_more: more });
const props = () => ({ active: true, categories: [], channels: [channel], isMobile: false, onExpired: vi.fn(), onWatch: vi.fn(), onRecord: vi.fn(), channelID: '', onChannelChange: vi.fn() });

it('loads only when opened and selects details without autoplay', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = props(); const view = render(<TVGuide {...p} active={false} />);
 expect(getTVGuide).not.toHaveBeenCalled();
 view.rerender(<TVGuide {...p} />);
 await userEvent.click(await screen.findByRole('button', { name: /News, Program a/ }));
 expect(screen.getByRole('dialog')).toBeInTheDocument();
 expect(p.onWatch).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button', { name: 'Record' }));
 expect(p.onRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
});
it('appends channel pages using the snapshot and resets on date navigation', async () => {
 getTVGuide.mockResolvedValueOnce(page('a', true)).mockResolvedValueOnce(page('b', false, 2)).mockResolvedValue(page('c'));
 render(<TVGuide {...props()} />);
 await userEvent.click(await screen.findByRole('button', { name: 'Load more channels' }));
 expect(await screen.findByRole('button', { name: /Program b,/ })).toBeInTheDocument();
 expect(screen.getByRole('button', { name: /Program a,/ })).toBeInTheDocument();
 expect(getTVGuide.mock.calls[1][0]).toMatchObject({ page: 2, snapshot: 's1' });
 await userEvent.click(screen.getByRole('button', { name: 'Later' }));
 await screen.findByRole('button', { name: /Program c,/ });
 expect(screen.queryByRole('button', { name: /Program a,/ })).not.toBeInTheDocument();
});
it('rejects a stale snapshot instead of mixing generations', async () => {
 getTVGuide.mockResolvedValueOnce(page('a', true)).mockRejectedValueOnce(new APIError('Refresh the schedule', { status: 409, code: 'guide_changed' }));
 render(<TVGuide {...props()} />);
 await userEvent.click(await screen.findByRole('button', { name: 'Load more channels' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the schedule');
 expect(screen.queryByRole('button', { name: /Program a,/ })).not.toBeInTheDocument();
});
it('shows mobile agenda and future recording without a future Watch action', async () => {
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [airing('future', true)] }] });
 const p = props(); render(<TVGuide {...p} isMobile />);
 await userEvent.click(await screen.findByRole('button', { name: /Program future,/ }));
 expect(screen.getByRole('dialog').querySelectorAll('button')).toHaveLength(2);
 expect(screen.queryByLabelText('Guide layout')).not.toBeInTheDocument();
});
it('ignores a late response after changing the selected channel', async () => {
 let resolve; getTVGuide.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(page('new'));
 const p = props(); const view = render(<TVGuide {...p} />);
 view.rerender(<TVGuide {...p} channelID="42" />);
 await screen.findByRole('button', { name: /Program new,/ });
 resolve(page('old'));
 await waitFor(() => expect(screen.queryByRole('button', { name: /Program old,/ })).not.toBeInTheDocument());
});
it('packs overlapping programs into separate lanes and clips the viewport', () => {
 const programs = [{ start: new Date(0).toISOString(), end: new Date(200).toISOString() }, { start: new Date(150).toISOString(), end: new Date(300).toISOString() }];
 const result = guideLanes(programs, 100, 250);
 expect(result.map((r) => r.lane)).toEqual([0, 1]);
 expect(result[0].left).toBe(0); expect(result[1].left + result[1].width).toBeCloseTo(100);
});
it('supports keyboard movement between airings and reports expired sessions', async () => {
 getTVGuide.mockResolvedValue({ ...page(), items: [{ channel, programs: [airing('a'), airing('b')] }] });
 const p = props(); render(<TVGuide {...p} />);
 const first = await screen.findByRole('button', { name: /Program a,/ }); first.focus();
 fireEvent.keyDown(first, { key: 'ArrowRight' });
 expect(screen.getByRole('button', { name: /Program b,/ })).toHaveFocus();
 getTVGuide.mockRejectedValueOnce(new APIError('Expired', { status: 401 }));
 await userEvent.click(screen.getByRole('button', { name: 'Refresh guide' }));
 await waitFor(() => expect(p.onExpired).toHaveBeenCalled());
});

it('clears a retained group when More schedule selects a channel outside it', async () => {
 getTVGuide.mockResolvedValue(page());
 const p = { ...props(), categories: [{ id: '2', name: 'News' }, { id: '3', name: 'Sports' }], channels: [{ ...channel, category_id: '2' }] };
 const view = render(<TVGuide {...p} />);
 await screen.findByRole('button', { name: /Program a,/ });
 fireEvent.change(screen.getByLabelText('Guide group'), { target: { value: '3' } });
 view.rerender(<TVGuide {...p} channelID="41" />);
 await waitFor(() => expect(screen.getByLabelText('Guide group')).toHaveValue(''));
 await waitFor(() => expect(getTVGuide.mock.calls.at(-1)[0]).toMatchObject({ channelID: '41', categoryID: '' }));
});
