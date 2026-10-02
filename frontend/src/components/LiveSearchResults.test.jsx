import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getProgramSearch } from '../api';
import LiveSearchResults, { LiveSearchModes } from './LiveSearchResults';

vi.mock('../api', async (original) => ({ ...(await original()), getProgramSearch: vi.fn() }));
const channel = { id: '41', name: 'World News', channel_number: '7' };
const nowResult = { id: 'program1', title: 'Evening News', start: '2026-09-28T18:00:00Z', end: '2026-09-28T19:00:00Z', channel };
const props = () => ({ categoryID: '', channels: [channel], channelsLoading: false, debouncedQuery: 'news', onExpired: vi.fn(), onScopeChange: vi.fn(), onSelect: vi.fn(), onWatch: vi.fn(), query: 'news', scope: 'all' });
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
  it('groups results and offers Watch Now only for current shows', async () => {
    getProgramSearch.mockResolvedValue({ items: [nowResult], total: 1 });
    const data = props(); const user = userEvent.setup();
    render(<LiveSearchResults {...data} />);
    await screen.findByRole('button', { name: 'Watch Now' });
    expect(screen.getByRole('region', { name: 'On now search results' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upcoming search results' })).toHaveTextContent('Starts');
    expect(screen.getAllByRole('button', { name: 'Watch Now' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Watch Now' }));
    expect(data.onWatch).toHaveBeenCalledWith(channel);
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
