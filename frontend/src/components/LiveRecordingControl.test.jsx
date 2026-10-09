import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LiveRecordingControl from './LiveRecordingControl';
import { Sharing } from '../navigation';

const channel = { id: '41', name: 'World News' };
const currentProgram = { title: 'News', start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 3600000).toISOString() };
const recording = { id: '7', channel_id: '41', title: 'News', ...currentProgram, status: 'recording', can_watch_active: true };
const response = value => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
const props = { channel, currentProgram, enabled: true, csrfToken: 'token', onExpired: vi.fn(), onWatchLive: vi.fn(), onWatchRecording: vi.fn(), onStop: vi.fn(), onVLC: vi.fn() };
function setup(data = { items: [], access: 'manage' }, overrides = {}) {
  const fetch = vi.fn(() => response(data)); vi.stubGlobal('fetch', fetch);
  const callbacks = { ...props, onWatchLive: vi.fn(), onWatchRecording: vi.fn(), onStop: vi.fn(), onExpired: vi.fn(), ...overrides };
  const view = render(<LiveRecordingControl {...callbacks} />);
  return { ...view, fetch, callbacks };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Live recording choices', () => {
  it('does not reopen playback when the viewer leaves while recording starts', async () => {
    let resolveCreate;
    const { callbacks, fetch, rerender } = setup();
    fetch.mockImplementation((path, options = {}) => options.method === 'POST'
      ? new Promise(resolve => { resolveCreate = resolve; }) : response({ items: [], access: 'manage' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
    rerender(<LiveRecordingControl {...callbacks} interactionActive={false} />);
    await act(async () => resolveCreate(new Response(JSON.stringify({ recording }))));
    expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each(['view', 'none'])('honours changed access while waiting for capture (%s)', async (access) => {
    let created = false;
    const { callbacks, fetch } = setup();
    fetch.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') {
        created = true;
        return response({ recording: { ...recording, status: 'scheduled', can_watch_active: false } });
      }
      return response({ items: created ? [recording] : [], access: created ? access : 'manage' });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    if (access === 'view') {
      await waitFor(() => expect(callbacks.onWatchRecording).toHaveBeenCalledWith(recording, 'latest'));
    } else {
      await screen.findByRole('alert');
      expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Recording access has ended.');
    }
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it('shows an arriving viewer two recording choices only after pressing Watch', async () => {
    const { callbacks, fetch } = setup({ items: [recording], access: 'view' });
    const watch = await screen.findByRole('button', { name: 'Watch', exact: true });
    expect(watch).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByText('Now Recording')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(watch);
    expect(screen.getByRole('dialog', { name: 'Watch recording' })).toBeInTheDocument();
    expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
    expect(callbacks.onWatchRecording).toHaveBeenCalledWith(recording, 'latest');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(watch);
    fireEvent.click(screen.getByRole('button', { name: 'Watch from Beginning' }));
    expect(callbacks.onWatchRecording).toHaveBeenLastCalledWith(recording, 'beginning');
    expect(callbacks.onWatchLive).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
  });
  it('keeps playback choices out of the active recording dropdown', async () => {
    const callbacks = { ...props, shareTarget: { kind: 'live', id: channel.id } };
    vi.stubGlobal('fetch', vi.fn(() => response({ items: [recording], access: 'view' })));
    render(<Sharing.Provider value={{ enabled: true }}><LiveRecordingControl {...callbacks} /></Sharing.Provider>);
    await screen.findByText('Now Recording');
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Watch in VLC', 'Share link']);
    expect(screen.queryByText('Watch with pause')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Watch Live|Watch live|Watch in Browser|Watch from Beginning|Watch from beginning/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('focuses the first choice, traps Tab and returns focus after Escape or Cancel', async () => {
    setup({ items: [recording], access: 'view' });
    const watch = await screen.findByRole('button', { name: 'Watch', exact: true });
    fireEvent.click(watch);
    const beginning = screen.getByRole('button', { name: 'Watch from Beginning' });
    const live = screen.getByRole('button', { name: 'Watch Live', exact: true });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(beginning).toHaveFocus();
    fireEvent.keyDown(beginning, { key: 'Tab' });
    expect(live).toHaveFocus();
    fireEvent.keyDown(live, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(beginning).toHaveFocus();
    fireEvent.keyDown(beginning, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(watch).toHaveFocus();
    fireEvent.click(watch);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(watch).toHaveFocus();
  });
  it.each([
    ['channel', { channel: { id: '42', name: 'Sports' } }],
    ['navigation', { interactionActive: false }],
    ['DVR disabled', { enabled: false }],
    ['playback started', { playing: true }],
  ])('dismisses a popup when its context changes (%s)', async (_, overrides) => {
    const { callbacks, rerender } = setup({ items: [recording], access: 'view' });
    fireEvent.click(await screen.findByRole('button', { name: 'Watch', exact: true }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<LiveRecordingControl {...callbacks} {...overrides} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
  });
  it.each([
    ['capture ends', { items: [], access: 'view' }],
    ['permission ends', { items: [recording], access: 'none' }],
    ['recording changes', { items: [{ ...recording, id: '8' }], access: 'view' }],
  ])('dismisses an open popup on discovery changes (%s)', async (_, updated) => {
    vi.useFakeTimers();
    const { fetch, callbacks } = setup({ items: [recording], access: 'view' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fetch.mockImplementation(() => response(updated));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
  });
  it('creates one recording with CSRF and starts latest playback directly', async () => {
    const { callbacks, fetch } = setup();
    fetch.mockImplementation((path, options = {}) => options.method === 'POST'
      ? response({ recording, already_scheduled: false }) : response({ items: [], access: 'manage' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(callbacks.onWatchRecording).toHaveBeenCalledWith(recording, 'latest'));
    const mutations = fetch.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(mutations).toHaveLength(1);
    expect(mutations[0][0]).toBe('/api/dvr/recordings');
    expect(JSON.parse(mutations[0][1].body)).toEqual({ channel_id: '41', start: currentProgram.start, end: currentProgram.end });
    expect(mutations[0][1].headers.get('X-CSRF-Token')).toBe('token');
  });
  it('waits for the exact pending recording before opening playback', async () => {
    let created = false;
    const { callbacks, fetch } = setup();
    fetch.mockImplementation((path, options = {}) => {
      if (options.method === 'POST') { created = true; return response({ recording: { ...recording, status: 'scheduled', can_watch_active: false } }); }
      return response({ items: created ? [recording] : [], access: 'manage' });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(callbacks.onWatchRecording).toHaveBeenCalledWith(recording, 'latest'));
  });
  it('keeps viewer-only and unavailable DVR browsing usable without creation', async () => {
    const { rerender, callbacks } = setup({ items: [], access: 'view' });
    await screen.findByRole('button', { name: 'Watch Live' });
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.queryByRole('menuitem', { name: 'Watch & Record' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Watch live|Watch in Browser/ })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Watch Live' }));
    expect(callbacks.onWatchLive).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<LiveRecordingControl {...callbacks} enabled={false} />);
    expect(screen.getByRole('button', { name: 'Watch Live' })).toBeInTheDocument();
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
  });
  it('ignores late channel discovery after switching channels', async () => {
    let resolveOld;
    const fetch = vi.fn(path => String(path).includes('/41/')
      ? new Promise(resolve => { resolveOld = resolve; }) : response({ items: [], access: 'view' }));
    vi.stubGlobal('fetch', fetch);
    const view = render(<LiveRecordingControl {...props} />);
    view.rerender(<LiveRecordingControl {...props} channel={{ id: '42', name: 'Sports' }} />);
    await act(async () => resolveOld(new Response(JSON.stringify({ items: [recording], access: 'manage' }))));
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch Live' })).toBeInTheDocument();
  });
  it('does not open an old recording when creation completes after channel change', async () => {
    let resolveCreate;
    const { callbacks, fetch, rerender } = setup();
    fetch.mockImplementation((path, options = {}) => options.method === 'POST'
      ? new Promise(resolve => { resolveCreate = resolve; }) : response({ items: [], access: 'manage' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Watch & Record' }));
    await waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
    rerender(<LiveRecordingControl {...callbacks} channel={{ id: '42', name: 'Sports' }} />);
    await act(async () => resolveCreate(new Response(JSON.stringify({ recording }))));
    expect(callbacks.onWatchRecording).not.toHaveBeenCalled();
  });
  it('updates the indicator when capture ends or permission is removed', async () => {
    vi.useFakeTimers();
    const { fetch, callbacks, rerender } = setup({ items: [recording], access: 'view' });
    await act(async () => {});
    expect(screen.getByText('Now Recording')).toBeInTheDocument();
    fetch.mockImplementation(() => response({ items: [], access: 'none' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch Live' })).toBeInTheDocument();
    rerender(<LiveRecordingControl {...callbacks} playing />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(callbacks.onStop).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
  });
  it('does not duplicate the player recording badge', async () => {
    setup({ items: [recording], access: 'view' }, { playing: true, recordingPlaying: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument());
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
  });
  it('leaves live playback available when optional discovery fails', async () => {
    const { fetch, callbacks } = setup();
    fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'DVR unavailable' } }), { status: 503 })));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Watch Live' }));
    expect(callbacks.onWatchLive).toHaveBeenCalledOnce();
  });
});
