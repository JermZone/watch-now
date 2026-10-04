import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DVRSection, { RecordDialog } from './DVR';
import { ProgramSearchSection } from './LiveSearchResults';

vi.mock('./NativeVideoPlayer', () => ({ default: ({ source }) => <div data-testid="recording-player" data-source={source} /> }));
vi.mock('./vlc', async (original) => ({ ...(await original()), openVLC: vi.fn(() => 'playlist') }));
import { openVLC } from './vlc';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const program = { id: 'airing', title: 'Football final', subtitle: 'Playoffs', description: 'Denver faces Seattle', start: '2099-01-01T20:00:00Z', end: '2099-01-01T23:00:00Z', channel: { id: '41', name: 'Sports' } };
const state = (overrides = {}) => ({ connected: true, access: 'manage', items: [], loading: false, busy: false, error: '', refresh: vi.fn(), change: vi.fn().mockResolvedValue({}), ...overrides });

describe('DVR foundation', () => {
  it('keeps the exact selected airing and its description match', () => {
    const onSelectProgram = vi.fn(); const onRecord = vi.fn();
    render(<ProgramSearchSection label="Upcoming" onSelectProgram={onSelectProgram} onRecord={onRecord} state={{ items: [{ ...program, match_field: 'description' }], total: 1 }} status="upcoming" page={1} />);
    fireEvent.click(screen.getByRole('button', { name: /Football final/ }));
    expect(onSelectProgram).toHaveBeenCalledWith(expect.objectContaining({ start: program.start, description: program.description }));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ channel: program.channel, start: program.start }));
    expect(screen.getByText('Matches program description')).toBeInTheDocument();
  });
  it('schedules only after confirmation and sends the exact airing without browser metadata', async () => {
    const dvr = state({ change: vi.fn().mockResolvedValue({ recording: program, already_scheduled: false }) });
    render(<RecordDialog dvr={dvr} program={program} onClose={vi.fn()} />);
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm recording' }));
    await screen.findByRole('heading', { name: 'Recording scheduled' });
    expect(dvr.change).toHaveBeenCalledWith('recordings', 'POST', { channel_id: '41', start: program.start, end: program.end });
  });
  it('offers no recording mutation for view-only users', () => {
    render(<RecordDialog dvr={state({ access: 'view' })} program={program} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Confirm recording' })).not.toBeInTheDocument();
    expect(screen.getByText(/administrator to enable DVR management/)).toBeInTheDocument();
  });
  it('clears the API key from the form when submitting', async () => {
    const dvr = state({ connected: false });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.change(screen.getByLabelText('Dispatcharr API key'), { target: { value: 'personal-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect DVR' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith('connection', 'POST', { api_key: 'personal-key' }));
    expect(screen.getByLabelText('Dispatcharr API key')).toHaveValue('');
  });
  it('separates search of the schedule from discovering new airings and confirms cancellation', async () => {
    const dvr = state({ items: [{ ...program, id: '7', status: 'scheduled', playable: false }, { ...program, id: '8', title: 'News', description: '', status: 'recorded', playable: true }] });
    const onFind = vi.fn();
    render(<DVRSection dvr={dvr} mode="search" search="Denver" onFind={onFind} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled (1)' }));
    expect(screen.getByRole('heading', { name: 'Football final' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'News' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find something to record' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recording (0)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find something to record' }));
    expect(onFind).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }));
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith('recordings/7', 'DELETE'));
  });
  it('never offers unfinished playback or view-only delete actions', () => {
    render(<DVRSection dvr={state({ access: 'view', items: [{ ...program, id: '7', status: 'recording', playable: false }] })} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    expect(screen.queryByRole('button', { name: 'Watch recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument();
    expect(screen.getByText(/Playback becomes available after processing/)).toBeInTheDocument();
  });
});


describe('DVR shared playback controls', () => {
  const recording = { ...program, id: '7', status: 'recorded', playable: true };
  it('uses Watch and Stop, with download, VLC and confirmed delete in the dropdown', async () => {
    const dvr = state({ items: [recording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    expect(screen.getByTestId('recording-player')).toHaveAttribute('data-source', '/api/dvr/recordings/7/stream');
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('recording-player')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /VLC/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith('recordings/7', 'DELETE'));
  });
  it('allows view-only VLC playback but omits delete', async () => {
    const dvr = state({ access: 'view', items: [recording], change: vi.fn().mockResolvedValue({ launch_url: '/api/vlc/launch/test' }) });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /VLC/ }));
    await waitFor(() => expect(openVLC).toHaveBeenCalledWith('/api/vlc/launch/test', recording.title));
    expect(dvr.change).toHaveBeenCalledWith('recordings/7/vlc', 'POST');
  });
  it('ignores a pending VLC handoff after leaving the current view', async () => {
    let resolve;
    const dvr = state({ items: [recording], change: vi.fn(() => new Promise((done) => { resolve = done; })) });
    const { unmount } = render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /VLC/ }));
    unmount();
    resolve({ launch_url: '/api/vlc/launch/stale' });
    await waitFor(() => expect(dvr.change).toHaveBeenCalled());
    expect(openVLC).not.toHaveBeenCalled();
  });
});

it('does not ask for personal keys when the server manages DVR', () => {
 const { rerender } = render(<DVRSection dvr={state({ managed: true, access: 'view' })} mode="browse" search="" />);
 expect(screen.queryByText('Connected by your Watch Now administrator.')).not.toBeInTheDocument();
 expect(screen.queryByRole('heading', { name: 'DVR' })).not.toBeInTheDocument();
 expect(screen.queryByText(/You can (manage|watch) recordings/)).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Disconnect DVR' })).not.toBeInTheDocument();
 expect(screen.queryByLabelText('Dispatcharr API key')).not.toBeInTheDocument();
 rerender(<DVRSection dvr={state({ managed: true, connected: false, error: 'Server DVR unavailable' })} mode="browse" search="" />);
 expect(screen.getByText(/Ask your Watch Now administrator/)).toBeInTheDocument();
 expect(screen.queryByLabelText('Dispatcharr API key')).not.toBeInTheDocument();
});


it('shows discovery only for a zero-count section, not an empty search result', () => {
 const dvr = state({ items: [{ ...program, id: '7', status: 'recorded', playable: true }] });
 const { rerender } = render(<DVRSection dvr={dvr} mode="search" search="unmatched term" onFind={vi.fn()} />);
 expect(screen.getByText('No matching recordings in this view.')).toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Find something to record' })).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: 'Scheduled (0)' }));
 expect(screen.getByRole('button', { name: 'Find something to record' })).toBeInTheDocument();
 rerender(<DVRSection dvr={{ ...dvr, loading: true }} mode="search" search="unmatched term" onFind={vi.fn()} />);
 expect(screen.queryByRole('button', { name: 'Find something to record' })).not.toBeInTheDocument();
});


it('omits routine refresh and storage copy but offers retry after an error', () => {
 const dvr = state({ managed: true });
 const { rerender } = render(<DVRSection dvr={dvr} mode="browse" search="" />);
 expect(screen.queryByText('Recordings are stored and managed by Dispatcharr.')).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
 rerender(<DVRSection dvr={{ ...dvr, error: 'DVR could not be loaded' }} mode="browse" search="" />);
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 expect(dvr.refresh).toHaveBeenCalledOnce();
 rerender(<DVRSection dvr={{ ...dvr, error: 'DVR could not be loaded', loading: true }} mode="browse" search="" />);
 expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
});


it('uses the Attention section for recordings that need checking', () => {
 const dvr = state({ items: [{ ...program, id: '7', status: 'attention', playable: false }] });
 render(<DVRSection dvr={dvr} mode="browse" search="" onFind={vi.fn()} />);
 fireEvent.click(screen.getByRole('button', { name: 'Attention (1)' }));
 expect(screen.getByText('This recording is incomplete, processing, or needs attention in Dispatcharr.')).toBeInTheDocument();
 expect(screen.queryByRole('button', { name: 'Find something to record' })).not.toBeInTheDocument();
});
