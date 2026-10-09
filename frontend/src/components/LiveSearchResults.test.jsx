import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { changeDVR, createShare, getChannelRecordings, getProgramSearch } from '../api';
import { Sharing } from '../navigation';
import LiveSearchResults, { LiveSearchModes } from './LiveSearchResults';

vi.mock('../api', async (original) => ({
  ...(await original()), getProgramSearch: vi.fn(), getChannelRecordings: vi.fn(), changeDVR: vi.fn(), createShare: vi.fn(),
}));
const channel = { id: '41', name: 'World News', channel_number: '7' };
const nowResult = { id: 'program1', title: 'Evening News', start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 3600000).toISOString(), channel };
const futureResult = { ...nowResult, id: 'program2', title: 'Tomorrow News', start: new Date(Date.now() + 7200000).toISOString(), end: new Date(Date.now() + 10800000).toISOString() };
const recording = { id: '7', channel_id: channel.id, title: nowResult.title, start: nowResult.start, end: nowResult.end, status: 'recording', can_watch_active: true };
const props = () => ({ categoryID: '', channels: [channel], channelsLoading: false, debouncedQuery: 'news', onExpired: vi.fn(), onScopeChange: vi.fn(), onSelect: vi.fn(), onWatch: vi.fn(), onWatchRecording: vi.fn(), onVLC: vi.fn(), query: 'news', scope: 'all' });
const enableDVR = () => ({ ...props(), dvrEnabled: true, csrfToken: 'search-csrf', onRecord: vi.fn() });
const searchResults = () => getProgramSearch.mockImplementation(({ status }) => Promise.resolve({ items: [status === 'now' ? nowResult : futureResult], total: 1 }));
beforeEach(() => {
  getChannelRecordings.mockResolvedValue({ items: [], access: 'manage' });
  createShare.mockResolvedValue({ token: '1' + 'a'.repeat(39) });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('Live TV search modes and results', () => {
  it('offers the embedded modes and preserves accessible active selection', async () => {
    const onChange = vi.fn(); const user = userEvent.setup();
    render(<LiveSearchModes onChange={onChange} scope="now" />);
    expect(screen.getByRole('button', { name: 'On now' })).toHaveAttribute('aria-pressed', 'true');
    for (const [label, value] of [['All','all'], ['Channels','channels'], ['Upcoming','upcoming']]) {
      await user.click(screen.getByRole('button', { name: label })); expect(onChange).toHaveBeenLastCalledWith(value);
    }
  });
  it('does not fetch programs in Channels mode', async () => {
    const data = props(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="channels" />);
    await user.click(screen.getByRole('button', { name: /World News/ }));
    expect(data.onSelect).toHaveBeenCalledWith(channel);
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(getProgramSearch).not.toHaveBeenCalled();
  });
  it('groups results and offers Watch Live only for current shows', async () => {
    searchResults();
    const data = props(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} />);
    await screen.findByRole('button', { name: 'Watch Live' });
    expect(screen.getByRole('region', { name: 'On now search results' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upcoming search results' })).not.toHaveTextContent('Starts');
    expect(screen.getAllByRole('button', { name: 'Watch Live' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Watch Live' }));
    expect(data.onWatch).toHaveBeenCalledWith(channel);
    expect(getChannelRecordings).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('opens show details without starting playback', async () => {
    searchResults();
    const data = { ...props(), onSelectProgram: vi.fn() }; const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: /Evening News/ }));
    expect(data.onSelectProgram).toHaveBeenCalledWith(nowResult);
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
  });
  it('pages results and resets page when the search changes', async () => {
    getProgramSearch.mockResolvedValue({ items: [nowResult], total: 25 });
    const data = props(); const user = userEvent.setup();
    const { rerender } = render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: 'Next On now page' }));
    await waitFor(() => expect(getProgramSearch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, status: 'now', pageSize: 20 })));
    rerender(<LiveSearchResults {...data} query="sports" debouncedQuery="sports" scope="now" />);
    await waitFor(() => expect(getProgramSearch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, search: 'sports' })));
  });
  it('aborts superseded results and never displays an old response', async () => {
    let resolveOld;
    getProgramSearch.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ items: [], total: 0 });
    const data = props();
    const { rerender } = render(<LiveSearchResults {...data} scope="now" />);
    const oldSignal = getProgramSearch.mock.calls[0][0].signal;
    rerender(<LiveSearchResults {...data} query="sports" debouncedQuery="sports" scope="now" />);
    expect(oldSignal.aborted).toBe(true);
    resolveOld({ items: [nowResult], total: 1 });
    await screen.findByText('No matching shows on now.');
    expect(screen.queryByText('Evening News')).not.toBeInTheDocument();
  });
  it('shows a fallback to channel search if the guide is unavailable', async () => {
    getProgramSearch.mockRejectedValue(new Error('Show search is unavailable for this guide.'));
    const data = props(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: 'Search channels' }));
    expect(data.onScopeChange).toHaveBeenCalledWith('channels');
  });
});

describe('Search recording actions', () => {
  it('limits an oversized current-search response to twenty visible cards and discoveries', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      ...nowResult, id: `overflow-${index}`, title: `Overflow airing ${index + 1}`,
      channel: { ...channel, id: String(400 + index) },
    }));
    getProgramSearch.mockResolvedValue({ items, total: items.length });
    render(<LiveSearchResults {...enableDVR()} scope="now" />);
    await screen.findByText('Overflow airing 1');
    expect(screen.getAllByRole('button', { name: /Overflow airing/ })).toHaveLength(20);
    expect(screen.queryByText('Overflow airing 21')).not.toBeInTheDocument();
    await waitFor(() => expect(getChannelRecordings).toHaveBeenCalledTimes(20));
    expect(new Set(getChannelRecordings.mock.calls.map(([id]) => id)).size).toBe(20);
    expect(getProgramSearch).toHaveBeenCalledTimes(1);
  });
  it('pauses discovery while the browser is hidden and refreshes on return and each visible minute', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    searchResults();
    getChannelRecordings.mockResolvedValue({ items: [recording], access: 'view' });
    const data = enableDVR();
    const view = render(<LiveSearchResults {...data} scope="now" />);
    try {
      await screen.findByText('Evening News');
      expect(getChannelRecordings).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
      expect(getChannelRecordings).not.toHaveBeenCalled();

      visibility.mockReturnValue('visible');
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(await screen.findByText('Now Recording')).toBeInTheDocument();
      expect(getChannelRecordings).toHaveBeenCalledTimes(1);

      getChannelRecordings.mockResolvedValue({ items: [], access: 'manage' });
      await act(async () => { await vi.advanceTimersByTimeAsync(59999); });
      expect(getChannelRecordings).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(getChannelRecordings).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
      expect(screen.getByRole('menuitem', { name: 'Watch & Record' })).toBeInTheDocument();

      view.rerender(<LiveSearchResults {...data} scope="now" active={false} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120000);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(getChannelRecordings).toHaveBeenCalledTimes(2);
      expect(getProgramSearch).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });
  it('offers manager actions for current shows and Record only for future shows', async () => {
    searchResults();
    const data = enableDVR(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} />);
    const current = screen.getByRole('region', { name: 'On now search results' });
    const upcoming = screen.getByRole('region', { name: 'Upcoming search results' });
    await within(current).findByRole('button', { name: 'Watch options' });
    expect(within(current).getByRole('button', { name: 'Watch Live' })).toHaveClass('primary-button');
    expect(within(current).getByRole('button', { name: 'Watch options' })).toHaveClass('watch-options-button');
    await user.click(within(current).getByRole('button', { name: 'Watch options' }));
    expect(await screen.findByRole('menuitem', { name: 'Watch & Record' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Record', exact: true }));
    expect(data.onRecord).toHaveBeenLastCalledWith(nowResult);
    await user.click(await within(upcoming).findByRole('button', { name: 'Record', exact: true }));
    expect(data.onRecord).toHaveBeenLastCalledWith(futureResult);
    expect(within(upcoming).queryByRole('button', { name: /Watch/ })).not.toBeInTheDocument();
    expect(getChannelRecordings).toHaveBeenCalledTimes(1);
    expect(changeDVR).not.toHaveBeenCalled();
  });
  it.each(['view', 'none'])('keeps Watch & Record unavailable without manager access (%s)', async (access) => {
    searchResults(); getChannelRecordings.mockResolvedValue({ items: [], access });
    const data = enableDVR(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    await waitFor(() => expect(getChannelRecordings).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Watch & Record' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
    expect(data.onWatch).toHaveBeenCalledWith(channel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(changeDVR).not.toHaveBeenCalled();
  });
  it('records the exact selected airing with CSRF then watches its latest captured footage', async () => {
    searchResults(); changeDVR.mockResolvedValue({ recording });
    const data = enableDVR(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: 'Watch options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(data.onWatchRecording).toHaveBeenCalledWith(channel, recording, 'latest'));
    expect(changeDVR).toHaveBeenCalledTimes(1);
    expect(changeDVR).toHaveBeenCalledWith('recordings', 'POST', 'search-csrf', {
      channel_id: channel.id, start: nowResult.start, end: nowResult.end,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each([['Watch from Beginning', 'beginning'], ['Watch Live', 'latest']])('opens the recording chooser and starts %s without creating another capture', async (label, position) => {
    searchResults(); getChannelRecordings.mockResolvedValue({ items: [recording], access: 'view' });
    const data = enableDVR(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    const watch = await screen.findByRole('button', { name: 'Watch', exact: true });
    expect(screen.getByText('Now Recording')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Watch & Record' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Record', exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(watch);
    const chooser = screen.getByRole('dialog', { name: 'Watch recording' });
    expect(within(chooser).getByRole('button', { name: 'Watch from Beginning' })).toHaveFocus();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    await user.click(within(chooser).getByRole('button', { name: label, exact: true }));
    expect(data.onWatchRecording).toHaveBeenCalledWith(channel, recording, position);
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(changeDVR).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('does not discover recordings or offer recording actions when DVR is disabled', async () => {
    searchResults();
    const user = userEvent.setup();
    render(<LiveSearchResults {...props()} scope="now" />);
    await screen.findByRole('button', { name: 'Watch Live' });
    expect(getChannelRecordings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Record', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Watch & Record' })).not.toBeInTheDocument();
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
  });
  it('does not discover channel recordings for upcoming-only results', async () => {
    searchResults();
    render(<LiveSearchResults {...enableDVR()} scope="upcoming" />);
    await screen.findByRole('button', { name: 'Record', exact: true });
    expect(getChannelRecordings).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Watch/ })).not.toBeInTheDocument();
  });
  it('does not offer Watch & Record for a stale current result that already ended', async () => {
    getProgramSearch.mockResolvedValue({ items: [{ ...nowResult, start: new Date(Date.now() - 120000).toISOString(), end: new Date(Date.now() - 60000).toISOString() }], total: 1 });
    const user = userEvent.setup();
    render(<LiveSearchResults {...enableDVR()} scope="now" />);
    await screen.findByText('Evening News');
    await waitFor(() => expect(getChannelRecordings).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Watch & Record' })).not.toBeInTheDocument();
  });
  it('dismisses the recording chooser when search results become inactive', async () => {
    searchResults(); getChannelRecordings.mockResolvedValue({ items: [recording], access: 'view' });
    const data = enableDVR(); const user = userEvent.setup();
    const { rerender } = render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: 'Watch', exact: true }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<LiveSearchResults {...data} scope="now" active={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    expect(changeDVR).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'query edit', 'unmount'])('cancels discovery and ignores its late result after %s', async (exit) => {
    searchResults(); let resolveLookup;
    getChannelRecordings.mockImplementation(() => new Promise(resolve => { resolveLookup = resolve; }));
    const data = enableDVR();
    const { rerender, unmount } = render(<LiveSearchResults {...data} scope="now" />);
    await waitFor(() => expect(getChannelRecordings).toHaveBeenCalledTimes(1));
    const signal = getChannelRecordings.mock.calls[0][1].signal;
    if (exit === 'unmount') unmount();
    else rerender(<LiveSearchResults {...data} scope="now" {...(exit === 'inactive' ? { active: false } : { query: 'sports' })} />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolveLookup({ items: [recording], access: 'manage' }));
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    expect(changeDVR).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'query edit', 'unmount'])('does not open playback for a late recording creation after %s', async (exit) => {
    searchResults(); let resolveCreate;
    changeDVR.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    const data = enableDVR(); const user = userEvent.setup();
    const { rerender, unmount } = render(<LiveSearchResults {...data} scope="now" />);
    await user.click(await screen.findByRole('button', { name: 'Watch options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(changeDVR).toHaveBeenCalledTimes(1));
    const signal = changeDVR.mock.calls[0][4].signal;
    if (exit === 'unmount') unmount();
    else rerender(<LiveSearchResults {...data} scope="now" {...(exit === 'inactive' ? { active: false } : { query: 'sports' })} />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolveCreate({ recording }));
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Compact search watch options', () => {
  it.each([false, true])('keeps only the main watch action and dropdown trigger on a current card (recording: %s)', async (activeRecording) => {
    searchResults();
    getChannelRecordings.mockResolvedValue({ items: activeRecording ? [recording] : [], access: 'manage' });
    render(<LiveSearchResults {...enableDVR()} scope="now" />);
    const watch = await screen.findByRole('button', { name: activeRecording ? 'Watch' : 'Watch Live', exact: true });
    const controls = watch.closest('.search-recording-control');
    expect(within(controls).getAllByRole('button')).toHaveLength(2);
    expect(within(controls).getByRole('button', { name: 'Watch options' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(controls).queryByRole('button', { name: 'Watch & Record' })).not.toBeInTheDocument();
    expect(within(controls).queryByRole('button', { name: 'Record', exact: true })).not.toBeInTheDocument();
    if (activeRecording) expect(within(controls).getByText('Now Recording')).toBeInTheDocument();
  });
  it.each([false, true])('shares the live channel from search and returns focus after Close (recording: %s)', async (activeRecording) => {
    searchResults();
    getChannelRecordings.mockResolvedValue({ items: activeRecording ? [recording] : [], access: 'manage' });
    const data = enableDVR(); const user = userEvent.setup();
    const sharing = { enabled: true, session: { csrf_token: 'share-csrf' }, onExpired: vi.fn() };
    render(<Sharing.Provider value={sharing}><LiveSearchResults {...data} scope="now" /></Sharing.Provider>);
    await screen.findByRole('button', { name: activeRecording ? 'Watch' : 'Watch Live', exact: true });
    const trigger = screen.getByRole('button', { name: 'Watch options' });
    await user.click(trigger);
    if (activeRecording) {
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Watch in VLC', 'Share link']);
    } else {
      expect(await screen.findByRole('menuitem', { name: 'Watch & Record' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Record', exact: true })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('menuitem', { name: 'Share link' }));
    const dialog = screen.getByRole('dialog', { name: 'Share link' });
    const link = await within(dialog).findByRole('textbox', { name: 'Link' });
    expect(link).toHaveValue(`${window.location.origin}${window.location.pathname}#/s/${'1' + 'a'.repeat(39)}`);
    expect(within(dialog).getByText('Live TV channel link')).toBeInTheDocument();
    expect(createShare).toHaveBeenCalledTimes(1);
    expect(createShare).toHaveBeenCalledWith({ kind: 'live', id: channel.id }, 'share-csrf', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(changeDVR).not.toHaveBeenCalled();
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('omits Share link when sharing is disabled', async () => {
    searchResults();
    const user = userEvent.setup();
    render(<Sharing.Provider value={{ enabled: false }}><LiveSearchResults {...enableDVR()} scope="now" /></Sharing.Provider>);
    await user.click(await screen.findByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Share link' })).not.toBeInTheDocument();
    expect(createShare).not.toHaveBeenCalled();
  });
  it('opens VLC for the chosen result channel without starting browser playback', async () => {
    const secondChannel = { id: '42', name: 'Sports Plus', channel_number: '8' };
    const secondResult = { ...nowResult, id: 'sports1', title: 'Evening Sports', channel: secondChannel };
    getProgramSearch.mockResolvedValue({ items: [nowResult, secondResult], total: 2 });
    const data = enableDVR(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} scope="now" />);
    const result = await screen.findByRole('button', { name: /Evening Sports/ });
    await user.click(within(result.closest('article')).getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));
    expect(data.onVLC).toHaveBeenCalledTimes(1);
    expect(data.onVLC).toHaveBeenCalledWith(secondChannel);
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(changeDVR).not.toHaveBeenCalled();
  });
  it.each(['menu', 'share'])('closes the open %s when search results become inactive', async (surface) => {
    searchResults();
    const data = enableDVR(); const user = userEvent.setup();
    const sharing = { enabled: true, session: { csrf_token: 'share-csrf' }, onExpired: vi.fn() };
    let resolveShare;
    if (surface === 'share') createShare.mockImplementation(() => new Promise(resolve => { resolveShare = resolve; }));
    const content = (active) => <Sharing.Provider value={sharing}><LiveSearchResults {...data} scope="now" active={active} /></Sharing.Provider>;
    const view = render(content(true));
    await user.click(await screen.findByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    if (surface === 'share') {
      await user.click(screen.getByRole('menuitem', { name: 'Share link' }));
      expect(screen.getByRole('dialog', { name: 'Share link' })).toBeInTheDocument();
      await waitFor(() => expect(createShare).toHaveBeenCalledTimes(1));
    }
    view.rerender(content(false));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    if (surface === 'share') {
      expect(createShare.mock.calls[0][2].signal.aborted).toBe(true);
      await act(async () => resolveShare({ token: '1' + 'a'.repeat(39) }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }
    expect(data.onWatch).not.toHaveBeenCalled();
    expect(data.onWatchRecording).not.toHaveBeenCalled();
    expect(data.onVLC).not.toHaveBeenCalled();
  });
});

it.each([
  ['2026-10-05T00:00:00', '2026-10-05T01:00:00', 'Oct 5 12:00am – 1:00am'],
  ['2026-10-05T11:30:00', '2026-10-05T12:30:00', 'Oct 5 11:30am – 12:30pm'],
  ['2026-10-05T23:00:00', '2026-10-06T01:00:00', 'Oct 5 11:00pm – Oct 6 1:00am'],
  ['invalid', 'invalid', 'Time unavailable'],
])('shows a single compact local airing range for %s', async (start, end, expected) => {
  getProgramSearch.mockResolvedValue({ items: [{ ...nowResult, start, end }], total: 1 });
  render(<LiveSearchResults {...props()} scope="upcoming" />);
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.queryByText(/^Starts /)).not.toBeInTheDocument();
});
