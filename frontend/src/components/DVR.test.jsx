import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DVRSection, { RecordDialog } from './DVR';
import { ProgramSearchSection } from './LiveSearchResults';
import { Sharing } from '../navigation';
import { createShare } from '../api';

const activeMock = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('./RecordingHLSPlayer', async () => {
  const { useEffect } = await import('react');
  return { default: ({ recordingID, initialPosition }) => {
    useEffect(() => { activeMock.mounts += 1; return () => { activeMock.unmounts += 1; }; }, []);
    return <div data-testid="active-recording-player" data-recording={recordingID} data-position={initialPosition} />;
  } };
});
vi.mock('../api', async (original) => ({ ...(await original()), createShare: vi.fn() }));
vi.mock('./NativeVideoPlayer', () => ({ default: ({ source }) => <div data-testid="recording-player" data-source={source} /> }));
vi.mock('./vlc', async (original) => ({ ...(await original()), openVLC: vi.fn(() => 'playlist') }));
import { openVLC } from './vlc';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const program = { id: 'airing', title: 'Football final', subtitle: 'Playoffs', description: 'Denver faces Seattle', start: '2099-01-01T20:00:00Z', end: '2099-01-01T23:00:00Z', channel: { id: '41', name: 'Sports' } };
const state = (overrides = {}) => ({ connected: true, access: 'manage', items: [], loading: false, busy: false, error: '', refresh: vi.fn(), change: vi.fn().mockResolvedValue({}), ...overrides });

describe('DVR foundation', () => {
  it('shows the channel logo on ordinary recording cards with an initials fallback', () => {
    render(<DVRSection dvr={state({items:[{...program,id:'7',status:'recorded',playable:true,channel:{...program.channel,has_artwork:true}}]})} mode="browse" search="" />);
    const logo=screen.getByRole('img',{name:'Sports logo'});
    expect(logo.getAttribute('src')).toContain('/api/live/channels/41/artwork');
    fireEvent.error(logo);
    expect(screen.getByText('S')).toBeInTheDocument();
    expect(screen.getByRole('heading',{name:program.title})).toBeInTheDocument();
  });
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
  it('uses Watch and Stop, with download and VLC in the dropdown and confirmed trash deletion', async () => {
    const dvr = state({ items: [recording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    const player = screen.getByTestId('recording-player');
    expect(player).toHaveAttribute('data-source', '/api/dvr/recordings/7/stream');
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    const details = screen.getByRole('button', { name: 'Details', exact: true });
    expect(details.previousElementSibling).toBe(screen.getByRole('heading', { name: recording.title, exact: true }));
    expect(details.closest('.playback-stage-navigation')).toBeNull();
    fireEvent.click(details);
    const dialog = screen.getByRole('dialog', { name: 'Playback details' });
    expect(dialog).toHaveTextContent(recording.description);
    expect(screen.getByTestId('recording-player')).toBe(player);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(details).toHaveFocus();
    expect(screen.getByTestId('recording-player')).toBe(player);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('recording-player')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /VLC/ })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete recording: Football final' }));
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith('recordings/7', 'DELETE'));
  });
  it('allows view-only VLC playback but omits delete', async () => {
    const dvr = state({ access: 'view', items: [recording], change: vi.fn().mockResolvedValue({ launch_url: '/api/vlc/launch/test' }) });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete recording:/ })).not.toBeInTheDocument();
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


describe('DVR trash action', () => {
  const recording = { ...program, id: '7', status: 'recorded', playable: true };
  const trashName = 'Delete recording: Football final';

  it('puts a named trash action beside the title and deletes only the selected recording after confirmation', async () => {
    const dvr = state({ items: [recording, { ...recording, id: '8', title: 'Evening News' }] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    const trash = screen.getByRole('button', { name: trashName });
    expect(trash).toHaveAttribute('title', trashName);
    expect(trash.closest('.dvr-recording-heading')).toContainElement(screen.getByRole('heading', { name: program.title }));
    expect(trash.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(trash);
    const dialog = screen.getByRole('dialog', { name: 'Delete this recording?' });
    expect(within(dialog).getByText(program.title)).toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledExactlyOnceWith('recordings/7', 'DELETE'));
  });

  it.each(['Keep unchanged', 'Escape'])('keeps the recording and restores trash focus after %s', (method) => {
    const dvr = state({ items: [recording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    const trash = screen.getByRole('button', { name: trashName });
    fireEvent.click(trash);
    const dialog = screen.getByRole('dialog', { name: 'Delete this recording?' });
    if (method === 'Keep unchanged') fireEvent.click(within(dialog).getByRole('button', { name: method }));
    else fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trash).toHaveFocus();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it('uses the same confirmed trash action for attention rows and keeps scheduled cancellation as text', () => {
    const dvr = state({ items: [{ ...recording, status: 'attention', playable: false }, { ...recording, id: '8', status: 'scheduled', playable: false }] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Attention (1)' }));
    fireEvent.click(screen.getByRole('button', { name: trashName }));
    expect(screen.getByRole('dialog', { name: 'Delete this recording?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep unchanged' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled (1)' }));
    expect(screen.queryByRole('button', { name: trashName })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }));
    expect(screen.getByRole('dialog', { name: 'Cancel this recording?' })).toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each([false, true])('omits trash during active capture when completed-file playback is %s', (playable) => {
    const dvr = state({ items: [{ ...recording, status: 'recording', playable, can_watch_active: !playable }] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    expect(screen.queryByRole('button', { name: trashName })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it('disables trash and confirmation while another DVR action is busy', () => {
    const dvr = state({ items: [recording] });
    const view = render(<DVRSection dvr={{ ...dvr, busy: true }} mode="browse" search="" />);
    const trash = screen.getByRole('button', { name: trashName });
    expect(trash).toBeDisabled();
    fireEvent.click(trash);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(trash);
    view.rerender(<DVRSection dvr={{ ...dvr, busy: true }} mode="browse" search="" />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Delete this recording?' })).toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each([
    ['management permission loss', { access: 'view' }],
    ['disconnect', { connected: false }],
    ['recording removed', { items: [] }],
    ['recording restarted', { items: [{ ...recording, status: 'recording' }] }],
  ])('retires pending trash deletion after %s', (label, update) => {
    const dvr = state({ items: [recording] });
    const view = render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: trashName }));
    expect(screen.getByRole('dialog', { name: 'Delete this recording?' })).toBeInTheDocument();
    view.rerender(<DVRSection dvr={{ ...dvr, ...update }} mode="browse" search="" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it('returns later recording management confirmation to its own menu after dismissing trash', () => {
    const dvr = state({ items: [recording, { ...recording, id: '8', status: 'recording', playable: false, can_watch_active: true }] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: trashName }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep unchanged' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    const options = screen.getByRole('button', { name: 'Watch options' });
    fireEvent.click(options);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop recording' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep unchanged' }));
    expect(options).toHaveFocus();
    expect(dvr.change).not.toHaveBeenCalled();
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

describe('DVR watch while recording', () => {
  const activeRecording = { ...program, id: '7', status: 'recording', playable: false, can_watch_active: true };
  it('offers active watch to a viewer without unfinished download, VLC, share or management', async () => {
    const dvr = state({ access: 'view', csrfToken: 'csrf', items: [activeRecording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch from Beginning' }));
    await screen.findByTestId('active-recording-player');
    expect(screen.queryByTestId('recording-player')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each([['Watch from Beginning', 'beginning'], ['Watch Live', 'latest']])('keeps the same active player started with %s through refresh and processing, then removes it when access ends', async (label, position) => {
    activeMock.mounts = 0; activeMock.unmounts = 0;
    const dvr = state({ csrfToken: 'csrf', items: [activeRecording] });
    const view = render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByTestId('active-recording-player');
    const player = screen.getByTestId('active-recording-player');
    expect(player).toHaveAttribute('data-position', position);
    view.rerender(<DVRSection dvr={{ ...dvr, loading: true }} mode="browse" search="" />);
    view.rerender(<DVRSection dvr={{ ...dvr, items: [{ ...activeRecording, status: 'attention', can_watch_active: false }] }} mode="browse" search="" />);
    expect(screen.getByTestId('active-recording-player')).toBe(player);
    expect(player).toHaveAttribute('data-position', position);
    expect(activeMock.mounts).toBe(1);
    expect(activeMock.unmounts).toBe(0);
    view.rerender(<DVRSection dvr={{ ...dvr, items: [] }} mode="browse" search="" />);
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    expect(activeMock.unmounts).toBe(1);
  });

  it('keeps stopping playback separate from a manager stopping capture', async () => {
    const dvr = state({ csrfToken: 'csrf', items: [activeRecording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch from Beginning' }));
    await screen.findByTestId('active-recording-player');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop recording' }));
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith('recordings/7/stop', 'POST'));
  });
});

describe('DVR recording Watch chooser', () => {
  const activeRecording = { ...program, id: '7', status: 'recording', playable: false, can_watch_active: true };
  const sharing = { enabled: true, session: { csrf_token: 'share-csrf' }, onExpired: vi.fn() };
  const openRecording = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    return screen.getByRole('dialog', { name: 'Watch recording' });
  };

  it.each([
    ['Watch from Beginning', 'beginning'],
    ['Watch Live', 'latest'],
  ])('opens an existing capture with %s without creating another recording', async (label, position) => {
    const dvr = state({ access: 'view', csrfToken: 'csrf', items: [activeRecording] });
    render(<Sharing.Provider value={sharing}><DVRSection dvr={dvr} mode="browse" search="" /></Sharing.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    const card = screen.getByRole('heading', { name: activeRecording.title }).closest('article');
    expect(within(card).getByText('Now Recording')).toBeInTheDocument();
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    expect(within(card).queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /VLC|Share|Download|Extend|Stop recording/ })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Watch' }));
    const dialog = screen.getByRole('dialog', { name: 'Watch recording' });
    expect(within(dialog).getAllByRole('button').map(button => button.getAttribute('aria-label') || button.textContent)).toEqual(['Watch from Beginning', 'Watch Live', 'Cancel']);
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: label }));
    const player = await screen.findByTestId('active-recording-player');
    expect(player).toHaveAttribute('data-recording', '7');
    expect(player).toHaveAttribute('data-position', position);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each(['Cancel', 'Escape'])('dismisses the chooser with %s and restores Watch focus', (method) => {
    const dvr = state({ items: [activeRecording] });
    render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    const watch = screen.getByRole('button', { name: 'Watch', exact: true });
    fireEvent.click(watch);
    const dialog = screen.getByRole('dialog', { name: 'Watch recording' });
    expect(within(dialog).getByRole('button', { name: 'Watch from Beginning' })).toHaveFocus();
    if (method === 'Cancel') fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    else fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(watch).toHaveFocus();
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each([
    ['Extend 30 minutes', 'extend', 'Extend by 30 minutes?'],
    ['Stop recording', 'stop', 'Stop this recording?'],
  ])('requires confirmation for the manager menu action %s', async (label, action, heading) => {
    const dvr = state({ items: [activeRecording] });
    render(<Sharing.Provider value={sharing}><DVRSection dvr={dvr} mode="browse" search="" /></Sharing.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Extend 30 minutes', 'Stop recording']);
    expect(screen.queryByRole('menuitem', { name: /VLC|Share|Download/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: label }));
    const dialog = screen.getByRole('dialog', { name: heading });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(dvr.change).toHaveBeenCalledWith(`recordings/7/${action}`, 'POST'));
    expect(dvr.change).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
  });

  it.each([
    ['disconnect', { connected: false }],
    ['access removal', { access: 'none' }],
    ['recording removal', { items: [] }],
    ['processing', { items: [{ ...activeRecording, status: 'attention', can_watch_active: false }] }],
  ])('dismisses an unplayed chooser after %s', (label, update) => {
    const dvr = state({ items: [activeRecording] });
    const view = render(<DVRSection dvr={dvr} mode="browse" search="" />);
    openRecording();
    view.rerender(<DVRSection dvr={{ ...dvr, ...update }} mode="browse" search="" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it('closes an unplayed chooser when its search context changes', () => {
    const dvr = state({ items: [activeRecording] });
    const view = render(<DVRSection dvr={dvr} mode="search" search="Football" />);
    openRecording();
    view.rerender(<DVRSection dvr={dvr} mode="search" search="News" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('active-recording-player')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it.each([
    ['management permission loss', { access: 'view' }],
    ['all access removed', { access: 'none' }],
    ['disconnect', { connected: false }],
    ['recording removed', { items: [] }],
    ['capture completed', { items: [{ ...activeRecording, status: 'recorded', playable: true, can_watch_active: false }] }],
  ])('retires a pending recording management confirmation after %s', (label, update) => {
    const dvr = state({ items: [activeRecording] });
    const view = render(<DVRSection dvr={dvr} mode="browse" search="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recording (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop recording' }));
    expect(screen.getByRole('dialog', { name: 'Stop this recording?' })).toBeInTheDocument();
    view.rerender(<DVRSection dvr={{ ...dvr, ...update }} mode="browse" search="" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dvr.change).not.toHaveBeenCalled();
  });

  it('shares the exact completed recording with its viewer CSRF token and restores menu focus', async () => {
    const token = '1' + 'a'.repeat(39);
    createShare.mockResolvedValue({ token });
    const dvr = state({ items: [{ ...program, id: '8', status: 'recorded', playable: true }] });
    render(<Sharing.Provider value={sharing}><DVRSection dvr={dvr} mode="browse" search="" /></Sharing.Provider>);
    const options = screen.getByRole('button', { name: 'Watch options' });
    fireEvent.click(options);
    expect(screen.queryByRole('menuitem', { name: 'Watch in Browser' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Watch in VLC', 'Download', 'Share link']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share link' }));
    await screen.findByLabelText('Link');
    expect(createShare).toHaveBeenCalledWith({ kind: 'recording', id: '8' }, 'share-csrf', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByLabelText('Link')).toHaveValue(`${window.location.origin}${window.location.pathname}#/s/${token}`);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Share link' })).getByRole('button', { name: 'Close' }));
    expect(options).toHaveFocus();
    expect(dvr.change).not.toHaveBeenCalled();
  });
});
