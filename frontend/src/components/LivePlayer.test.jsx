import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mpegtsMock = vi.hoisted(() => ({ supported: true, players: [], createPlayer: vi.fn() }));
const guardMock = vi.hoisted(() => ({ available: true, rejection: { track: 'audio', allRejected: false } }));
vi.mock('./liveTrackGuard', () => ({ installLiveTrackGuard: () => guardMock.available
  ? { rejectInitializingTrack: () => guardMock.rejection } : null }));
vi.mock('mpegts.js', () => ({ default: {
  Events: { ERROR: 'error', MEDIA_INFO: 'media-info' },
  ErrorTypes: { MEDIA_ERROR: 'MediaError', NETWORK_ERROR: 'NetworkError' },
  ErrorDetails: { MEDIA_MSE_ERROR: 'MediaMSEError' },
  isSupported: () => mpegtsMock.supported,
  createPlayer: (...args) => mpegtsMock.createPlayer(...args),
} }));

import LivePlayer from './LivePlayer';

const makePlayer = () => {
  const handlers = new Map();
  const player = {
    on: vi.fn((event, handler) => handlers.set(event, handler)), attachMediaElement: vi.fn(),
    load: vi.fn(), play: vi.fn(() => Promise.resolve()), pause: vi.fn(), unload: vi.fn(),
    detachMediaElement: vi.fn(), destroy: vi.fn(), emit: (event, ...args) => handlers.get(event)?.(...args),
  };
  mpegtsMock.players.push(player);
  return player;
};

beforeEach(() => {
  mpegtsMock.supported = true;
  guardMock.available = true;
  guardMock.rejection = { track: 'audio', allRejected: false };
  mpegtsMock.players = [];
  mpegtsMock.createPlayer.mockReset();
  mpegtsMock.createPlayer.mockImplementation(makePlayer);
});
afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('LivePlayer lifecycle-only ownership', () => {
  it('starts immediately with the narrow Now stream URL and renders no action button', () => {
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={vi.fn()} />);
    expect(mpegtsMock.createPlayer).toHaveBeenCalledWith({ type: 'mpegts', isLive: true, url: '/api/live/channels/41/stream' }, { enableWorker: false, lazyLoad: false });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    fireEvent.playing(screen.getByLabelText('Live video for World News'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports unsupported playback to its owner', () => {
    mpegtsMock.supported = false;
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining('not supported'));
    expect(mpegtsMock.createPlayer).not.toHaveBeenCalled();
  });

  it('destroys every player operation on unmount', async () => {
    const { unmount } = render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={vi.fn()} />);
    const player = mpegtsMock.players[0];
    unmount();
    await waitFor(() => expect(player.destroy).toHaveBeenCalledOnce());
    expect(player.pause).toHaveBeenCalled();
    expect(player.unload).toHaveBeenCalled();
    expect(player.detachMediaElement).toHaveBeenCalled();
    expect(player.destroy).toHaveBeenCalled();
  });

  it('preserves supported playback after a source buffer rejects one track', () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    const player = mpegtsMock.players[0];
    act(() => player.emit('error', 'MediaError', 'MediaMSEError', { code: 9, msg: "Can't play type" }));
    expect(screen.getByText(/cannot play the audio track/)).toBeInTheDocument();
    expect(player.destroy).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    fireEvent.playing(screen.getByLabelText('Live video for World News'));
    act(() => vi.advanceTimersByTime(10000));
    expect(fatal).not.toHaveBeenCalled();
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it('bounds the partial-playback attempt when no supported track starts', () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    const player = mpegtsMock.players[0];
    act(() => player.emit('error', 'MediaError', 'MediaMSEError', { code: 9 }));
    // Metadata alone is not evidence of playable media. Repeated errors must
    // not extend the deadline indefinitely.
    act(() => { vi.advanceTimersByTime(5000); player.emit('media-info'); player.emit('error', 'MediaError', 'MediaMSEError', { code: 9 }); });
    act(() => vi.advanceTimersByTime(5000));
    expect(fatal).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining('supported stream tracks'));
    act(() => vi.runOnlyPendingTimers());
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it('lets queued library callbacks finish before fatal teardown and destroys once', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    const { unmount } = render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    const player = mpegtsMock.players[0];
    let callbackObservedLivePlayer = false;
    act(() => {
      player.emit('error', 'NetworkError', 'Exception', { msg: 'private upstream URL' });
      Promise.resolve().then(() => { callbackObservedLivePlayer = player.destroy.mock.calls.length === 0; });
    });
    expect(fatal).toHaveBeenCalledWith('The live stream connection failed. Try again.');
    expect(player.destroy).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(callbackObservedLivePlayer).toBe(true);
    unmount();
    act(() => vi.runOnlyPendingTimers());
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it('keeps other MSE failures fatal and never exposes library error details', () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    act(() => mpegtsMock.players[0].emit('error', 'MediaError', 'MediaMSEError', { code: 3, msg: 'private upstream URL' }));
    expect(fatal).toHaveBeenCalledWith('The browser could not decode this live stream. Try another browser.');
  });

  it('cancels the partial-playback deadline on unmount and ignores late errors', () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    const { unmount } = render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    const player = mpegtsMock.players[0];
    act(() => player.emit('error', 'MediaError', 'MediaMSEError', { code: 9 }));
    unmount();
    act(() => { vi.advanceTimersByTime(10000); player.emit('error', 'NetworkError'); });
    expect(fatal).not.toHaveBeenCalled();
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it('stops on a native video decode failure after partial playback', () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    act(() => mpegtsMock.players[0].emit('error', 'MediaError', 'MediaMSEError', { code: 9 }));
    const video = screen.getByLabelText('Live video for World News');
    fireEvent.playing(video);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    expect(fatal).toHaveBeenCalledOnce();
  });

  it('cannot detach the new channel video during deferred cleanup of a failed player', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={vi.fn()} />);
    const old = mpegtsMock.players[0];
    const oldVideo = old.attachMediaElement.mock.calls[0][0];
    old.detachMediaElement.mockImplementation(() => oldVideo.removeAttribute('src'));
    act(() => old.emit('error', 'NetworkError'));
    rerender(<LivePlayer channel={{ id: '42', name: 'Sports' }} onFatalError={vi.fn()} />);
    const newVideo = screen.getByLabelText('Live video for Sports');
    newVideo.setAttribute('src', 'blob:new-channel');
    act(() => vi.runOnlyPendingTimers());
    expect(newVideo.getAttribute('src')).toBe('blob:new-channel');
    expect(old.destroy).toHaveBeenCalledOnce();
  });

  it('fails safely if the pinned library track adapter is unavailable', () => {
    vi.useFakeTimers();
    guardMock.available = false;
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    act(() => mpegtsMock.players[0].emit('error', 'MediaError', 'MediaMSEError', { code: 9 }));
    expect(fatal).toHaveBeenCalledOnce();
  });

  it('stops immediately when both tracks are unsupported', () => {
    vi.useFakeTimers();
    guardMock.rejection = { track: 'video', allRejected: true };
    const fatal = vi.fn();
    render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    act(() => mpegtsMock.players[0].emit('error', 'MediaError', 'MediaMSEError', { code: 9 }));
    expect(fatal).toHaveBeenCalledWith(expect.stringContaining('No supported stream tracks'));
  });

  it('fences stale callbacks after a channel switch', async () => {
    const fatal = vi.fn();
    const { rerender } = render(<LivePlayer channel={{ id: '41', name: 'World News' }} onFatalError={fatal} />);
    const old = mpegtsMock.players[0];
    rerender(<LivePlayer channel={{ id: '42', name: 'Sports' }} onFatalError={fatal} />);
    await waitFor(() => expect(old.destroy).toHaveBeenCalled());
    old.emit('error');
    expect(fatal).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Live video for Sports')).toBeInTheDocument();
  });
});
