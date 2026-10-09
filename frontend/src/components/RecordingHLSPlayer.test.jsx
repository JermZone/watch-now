import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordingHLSPlayer, { validateActivePlayback } from './RecordingHLSPlayer';
import { APIError, createDVRActivePlayback, getDVRActivePlaybackStatus, stopDVRActivePlayback } from '../api';

const mock = vi.hoisted(() => ({ instances: [], supported: true }));
// Engine tests keep transport/readiness assertions independent of the UI toolkit.
// RecordingPlayerControls and the real-browser suite cover the actual controls.
vi.mock('./RecordingPlayerControls', () => ({
  default: ({ children, range, loading, recording, onNavigate, onSeek }) => <>
    {children}
    {loading && <span role="status" aria-label="Buffering recording" />}
    <div role="group" aria-label="Recording player controls">
      <input aria-label="Recording timeline" type="range" min={range.start}
        max={range.seekEnd ?? range.end} value={range.position}
        disabled={loading || !range.available} onChange={(event) => onSeek(Number(event.target.value))} />
      <button disabled={loading || !range.available || range.position <= range.start + .25} onClick={() => onNavigate('back')}>Back 15 seconds</button>
      <button disabled={loading || !range.available || range.position >= (range.seekEnd ?? range.end) - .25} onClick={() => onNavigate('forward')}>Forward 15 seconds</button>
      {recording && <button disabled={loading || !range.available || range.atLive} onClick={() => onNavigate('live')}>Go Live</button>}
    </div>
  </>,
}));
vi.mock('hls.js', () => {
  class HlsMock {
    static isSupported() { return mock.supported; }
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', FRAG_BUFFERED: 'buffered', LEVEL_LOADED: 'level', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    constructor(config) { this.config = config; this.listeners = {}; mock.instances.push(this); }
    on(name, callback) { this.listeners[name] = callback; }
    emit(name, value = {}) { this.listeners[name]?.(name, value); }
    attachMedia = vi.fn(() => this.emit('attached'));
    loadSource = vi.fn();
    stopLoad = vi.fn();
    startLoad = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
  }
  return { default: HlsMock };
});
vi.mock('../api', async (original) => ({
  ...(await original()), createDVRActivePlayback: vi.fn(), getDVRActivePlaybackStatus: vi.fn(), stopDVRActivePlayback: vi.fn(),
}));
const descriptor = { generation: 'gen1', manifest_url: '/api/dvr/recordings/7/active/gen1/index.m3u8', status_url: '/api/dvr/recordings/7/active/gen1/status', stop_url: '/api/dvr/recordings/7/active/gen1/stop' };
const file = '/api/dvr/recordings/7/active/gen1/file';
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => {
  mock.instances.length = 0; mock.supported = true;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  createDVRActivePlayback.mockResolvedValue(descriptor);
  getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: true });
  stopDVRActivePlayback.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('RecordingHLSPlayer', () => {
  it('starts at the earliest recorded point without moving a later user seek', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    const instance = mock.instances[0];
    expect(instance.config).toMatchObject({ startPosition: 0, enableWorker: false, backBufferLength: 60 });
    expect(instance.loadSource).toHaveBeenCalledWith(descriptor.manifest_url);
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    video.currentTime = 220;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
    video.currentTime = 80;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(80);
  });

  it('preserves position and pause through a checked finalized-file transition', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    fireEvent.canPlay(video);
    video.currentTime = 125;
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    act(() => mock.instances[0].emit('error', { fatal: true, type: 'network', response: { code: 409 } }));
    await settle();
    expect(mock.instances[0].destroy).toHaveBeenCalledOnce();
    expect(video).toHaveAttribute('src', file);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(125);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
  });

  it('checks finalization after the playlist ends and uses native HLS when MSE is unavailable', async () => {
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    expect(mock.instances).toHaveLength(0);
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 80 } });
    fireEvent.canPlay(video);
    video.currentTime = 40;
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    fireEvent.ended(video);
    await settle();
    expect(video).toHaveAttribute('src', file);
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(40);
  });

  it('stops immediately on an authorization failure without a retry loop', async () => {
    const fatal = vi.fn();
    const view = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    act(() => mock.instances[0].emit('error', { fatal: false, response: { code: 403 } }));
    await settle();
    expect(fatal).toHaveBeenCalledOnce();
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledOnce();
    view.unmount();
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).toHaveBeenCalledWith(descriptor.stop_url, 'csrf', { keepalive: true });
  });

  it('bounds waiting for the first segment and tears down after the limit', async () => {
    vi.useFakeTimers();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'waiting' });
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    for (let i = 0; i < 12; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fatal).toHaveBeenCalledOnce();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(mock.instances).toHaveLength(0);
  });

  it('stops a startup response that arrives after the viewer leaves', async () => {
    let resolve;
    createDVRActivePlayback.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    view.unmount();
    await act(async () => { resolve(descriptor); });
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(getDVRActivePlaybackStatus).not.toHaveBeenCalled();
    expect(mock.instances).toHaveLength(0);
  });

  it('aborts an in-flight status request and ignores its late result', async () => {
    let resolve;
    getDVRActivePlaybackStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const signal = getDVRActivePlaybackStatus.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve({ mode: 'file', stream_url: file }); });
    expect(mock.instances).toHaveLength(0);
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('rejects remote descriptors and a completed-file URL from another recording', async () => {
    expect(() => validateActivePlayback({ ...descriptor, manifest_url: 'https://upstream.example/index.m3u8' }, '7')).toThrow();
    const fatal = vi.fn();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: '/api/dvr/recordings/8/stream' });
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    expect(fatal).toHaveBeenCalledWith('Watch Now returned an unsupported recording playback response.');
    expect(screen.getByLabelText('Recording player')).not.toHaveAttribute('src');
  });

  it('does not create a new playback generation when only the parent callback changes', async () => {
    const view = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={vi.fn()} />);
    await settle();
    view.rerender(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={vi.fn()} />);
    await settle();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(mock.instances).toHaveLength(1);
    view.unmount();
    await settle();
    expect(mock.instances[0].destroy).toHaveBeenCalledOnce();
  });
  it('bounds a player that never becomes ready even when metadata keeps saying HLS', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    for (let i = 0; i < 12; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fatal).toHaveBeenCalledOnce();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(mock.instances[0].startLoad.mock.calls.length).toBeLessThanOrEqual(8);
  });


  it('continues authorization and keepalive polls past ten minutes in the completed-file phase without reloading', async () => {
    vi.useFakeTimers();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    fireEvent.canPlay(video);
    video.currentTime = 125;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(630000); });
    expect(getDVRActivePlaybackStatus.mock.calls.length).toBeGreaterThanOrEqual(43);
    expect(video.currentTime).toBe(125);
    expect(video.paused).toBe(false);
    expect(HTMLMediaElement.prototype.load.mock.calls.length).toBe(loads);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(video.currentTime).toBe(125);
    expect(video.paused).toBe(true);
    expect(HTMLMediaElement.prototype.load.mock.calls.length).toBe(loads);
  });

  it('stops native completed-file playback immediately when a status poll rejects permission', async () => {
    vi.useFakeTimers();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    fireEvent.canPlay(video);
    expect(video).toHaveAttribute('src', file);
    const pauses = HTMLMediaElement.prototype.pause.mock.calls.length;
    getDVRActivePlaybackStatus.mockRejectedValueOnce(new APIError('Denied', { status: 403 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fatal).toHaveBeenCalledOnce();
    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.pause.mock.calls.length).toBe(pauses + 1);
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    const statusRequests = getDVRActivePlaybackStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(getDVRActivePlaybackStatus.mock.calls.length).toBe(statusRequests);
  });

  it.each([
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'],
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'],
  ])('prefers built-in HLS in %s when both playback engines are supported', async (_browser, userAgent) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    mock.supported = true;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    expect(mock.instances).toHaveLength(0);
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    video.currentTime = 200;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
    video.currentTime = 85;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(85);
  });

  it.each([
    ['Chromium', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', 'Google Inc.'],
    ['Chrome on Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36', 'Google Inc.'],
  ])('uses hls.js for %s even when native canPlayType returns maybe', async (_browser, userAgent, vendor) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue(vendor);
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(mock.instances).toHaveLength(1);
    expect(mock.instances[0].config).toMatchObject({ liveDurationInfinity: false, startPosition: 0 });
    expect(mock.instances[0].loadSource).toHaveBeenCalledWith(descriptor.manifest_url);
  });

  it('opens latest captured footage once and preserves a later paused position across completion', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const instance = mock.instances[0];
    expect(instance.config).toMatchObject({ startPosition: -1, liveSyncDurationCount: 3 });
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 10, end: () => 240 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(228);
    video.currentTime = 85;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(85);
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    act(() => instance.emit('error', { response: { code: 409 } }));
    await settle();
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(85);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
    expect(screen.getByText('Recording finished')).toBeInTheDocument();
  });

  it('waits for a usable latest range rather than pinning startup to zero', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'duration', { configurable: true, value: Infinity });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 0 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 120 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(108);
  });

  it('keeps latest startup during a reconnect before the first range arrives', async () => {
    vi.useFakeTimers();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    act(() => mock.instances[0].emit('error', { fatal: true, type: 'network', response: { code: 409 } }));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mock.instances).toHaveLength(2);
    expect(mock.instances[1].config.startPosition).toBe(-1);
    expect(mock.instances[1].loadSource).toHaveBeenCalledWith(descriptor.manifest_url);
  });

  it('uses the latest position if capture has finished before the initial status check', async () => {
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file });
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 80 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(77);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(screen.getByText('Recording finished')).toBeInTheDocument();
  });

  it.each([
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'],
    ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'],
  ])('opens latest footage with native HLS in %s', async (_browser, userAgent) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    expect(mock.instances).toHaveLength(0);
    const video = screen.getByLabelText('Recording player');
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 48 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(36);
    video.currentTime = 15;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(15);
  });

  it('shows capture progress and retires the pulse once an ended playlist arrives', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(screen.getByText('Now Recording').closest('[role="status"]')).toHaveClass('is-recording');
    expect(screen.queryByText('Pause and rewind available')).not.toBeInTheDocument();
    act(() => mock.instances[0].emit('level', { details: { live: false } }));
    await settle();
    expect(screen.getByText('Recording finished').closest('[role="status"]')).toHaveClass('is-finished');
    expect(screen.queryByText('Pause and rewind available')).not.toBeInTheDocument();
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
  });

  it('shows capture finished while the fresh recording status waits for processing', async () => {
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'waiting', recording: false });
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(screen.getByText('Recording finished').closest('[role="status"]')).toHaveClass('is-finished');
    expect(screen.queryByText('Now Recording')).not.toBeInTheDocument();
  });

  it('keeps a new capture visibly recording while status waits for usable segments', async () => {
    vi.useFakeTimers();
    getDVRActivePlaybackStatus.mockResolvedValueOnce({ mode: 'waiting', recording: true, live_delay_seconds: 12 });
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(mock.instances).toHaveLength(0);
    expect(screen.getByText('Now Recording')).toBeInTheDocument();
    expect(screen.queryByText('Recording finished')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: true, live_delay_seconds: 18 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mock.instances).toHaveLength(1);
    expect(mock.instances[0].config).toMatchObject({ liveSyncDurationCount: 3, initialLiveManifestSize: 3 });
  });

  it('does not finish startup or enable navigation on metadata without a usable seekable range', async () => {
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'duration', { configurable: true, value: Infinity });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 0 } });
    fireEvent.loadedMetadata(video);
    fireEvent.canPlay(video);
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go Live' })).toBeDisabled();
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(12);
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    fireEvent.canPlay(video);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toBeEnabled();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('uses a checked live delay and prefers a safe engine live synchronization position', async () => {
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: true, live_delay_seconds: 18 });
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 5, end: () => 60 } });
    mock.instances[0].liveSyncPosition = 39;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(39);
    video.currentTime = 20;
    fireEvent.timeUpdate(video);
    mock.instances[0].liveSyncPosition = 55;
    fireEvent.click(screen.getByRole('button', { name: 'Go Live' }));
    expect(video.currentTime).toBe(42);
    video.currentTime = 20;
    fireEvent.timeUpdate(video);
    mock.instances[0].liveSyncPosition = 1000;
    fireEvent.click(screen.getByRole('button', { name: 'Go Live' }));
    expect(video.currentTime).toBe(42);
  });

  it('recovers a fresh native decode failure using the same generation and requested latest position', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.pause(video);
    fireEvent.error(video);
    await settle();
    expect(fatal).not.toHaveBeenCalled();
    expect(video).not.toHaveAttribute('src');
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 32 } });
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(20);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBeGreaterThan(plays);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('rebuilds a failed desktop startup engine without making another recording playback generation', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const old = mock.instances[0];
    act(() => old.emit('error', { fatal: true, type: 'media' }));
    await settle();
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mock.instances).toHaveLength(2);
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    act(() => mock.instances[1].emit('buffered'));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(0);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('keeps persistent fresh native decoding failure bounded', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } });
    for (let attempt = 0; attempt < 12 && !fatal.mock.calls.length; attempt++) {
      fireEvent.error(video);
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    }
    expect(fatal).toHaveBeenCalledOnce();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(video).not.toHaveAttribute('src');
  });

  it('retains a deliberate startup pause through native recovery', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    fireEvent.pause(video);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    await settle();
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.canPlay(video);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
    expect(video.paused).toBe(true);
  });

  it('ends native startup recovery immediately when the status rejects permission', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    getDVRActivePlaybackStatus.mockRejectedValueOnce(new APIError('Denied', { status: 403 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fatal).toHaveBeenCalledOnce();
    expect(video).not.toHaveAttribute('src');
    const requests = getDVRActivePlaybackStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(requests);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('cancels native recovery when the viewer leaves', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    const view = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    const requests = getDVRActivePlaybackStatus.mock.calls.length;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(requests);
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('retries only a typed preparing generation response and never overlaps creation', async () => {
    vi.useFakeTimers();
    createDVRActivePlayback.mockRejectedValueOnce(new APIError('Preparing', { status: 409, code: 'recording_preparing' }));
    let resolve;
    createDVRActivePlayback.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    expect(mock.instances).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(createDVRActivePlayback).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(createDVRActivePlayback).toHaveBeenCalledTimes(2);
    await act(async () => resolve(descriptor));
    expect(mock.instances).toHaveLength(1);
    expect(fatal).not.toHaveBeenCalled();
  });

  it.each([403, 409])('does not retry rejected generation creation with status %s absent a preparing code', async status => {
    vi.useFakeTimers();
    createDVRActivePlayback.mockRejectedValueOnce(new APIError('Access or capability rejected', { status }));
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(fatal).toHaveBeenCalledWith('Access or capability rejected');
    expect(mock.instances).toHaveLength(0);
  });

  it('bounds a stalled generation response and stops the eventual late generation', async () => {
    vi.useFakeTimers();
    let resolve;
    createDVRActivePlayback.mockImplementation(() => new Promise(done => { resolve = done; }));
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
    expect(fatal).toHaveBeenCalledOnce();
    await act(async () => resolve(descriptor));
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
    expect(getDVRActivePlaybackStatus).not.toHaveBeenCalled();
  });

  it('keeps the requested latest position when an attached but unready HLS recording finalizes', async () => {
    vi.useFakeTimers();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file, recording: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 80 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(77);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(screen.getByText('Recording finished')).toBeInTheDocument();
  });

  it('keeps paused skips and scrubs stable as capture grows, and explicitly resumes Go Live', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    let end = 90;
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 5, end: () => end } });
    fireEvent.canPlay(video);
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    video.currentTime = 40;
    fireEvent.pause(video);
    fireEvent.timeUpdate(video);
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }));
    expect(video.currentTime).toBe(25);
    fireEvent.change(screen.getByRole('slider', { name: 'Recording timeline' }), { target: { value: 5 } });
    expect(video.currentTime).toBe(5);
    expect(screen.getByRole('button', { name: 'Back 15 seconds' })).toBeDisabled();
    end = 120;
    fireEvent.progress(video);
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toHaveAttribute('max', '108');
    expect(video.currentTime).toBe(5);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
    fireEvent.click(screen.getByRole('button', { name: 'Go Live' }));
    expect(video.currentTime).toBe(108);
    expect(video.paused).toBe(true);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays + 1);
    expect(screen.getByRole('button', { name: 'Go Live' })).toBeDisabled();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('keeps rewind outside a gap in retained media and removes Go Live after capture ends', async () => {
    vi.useFakeTimers();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 2, start: i => i ? 30 : 0, end: i => i ? 90 : 20 } });
    fireEvent.canPlay(video);
    video.currentTime = 40;
    fireEvent.timeUpdate(video);
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }));
    expect(video.currentTime).toBeCloseTo(19.99);
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.queryByRole('button', { name: 'Go Live' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toBeEnabled();
  });

  it('does not treat a buffered fragment as decoded playback or clear the startup deadline', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    act(() => mock.instances[0].emit('buffered'));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
    expect(fatal).toHaveBeenCalledOnce();
  });

  it('does not let an in-flight status reattach native playback during its recovery delay', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    let resolve;
    getDVRActivePlaybackStatus.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    await act(async () => resolve({ mode: 'hls', recording: true }));
    expect(video).not.toHaveAttribute('src');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('lets a polling-ready playlist replace a queued waiting retry before native recovery', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'waiting', recording: true });
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" onFatalError={fatal} />);
    await settle();
    // Waiting retries occur at 2, 6, 12, and 20 seconds. The normal poll at
    // fifteen seconds sees usable media before the queued twenty-second retry.
    await act(async () => { await vi.advanceTimersByTimeAsync(14000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(4);
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const video = screen.getByLabelText('Recording player');
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    expect(video).not.toHaveAttribute('src');
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 32 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(20);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    const calls = getDVRActivePlaybackStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(calls);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('cancels an older reconnect timer when genuine media readiness returns first', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    await settle();
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.canPlay(video);
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loads);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('ignores an asynchronously queued reset pause after load clears the native error', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    await act(async () => { await Promise.resolve(); fireEvent.pause(video); });
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.canPlay(video);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBeGreaterThan(plays);
    // The new source's play event retires suppression. A subsequent user pause
    // remains intentional and survives the next native network reconnect.
    fireEvent.play(video);
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    video.currentTime = 7;
    fireEvent.pause(video);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    await settle();
    const pausedPlays = HTMLMediaElement.prototype.play.mock.calls.length;
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(7);
    expect(video.paused).toBe(true);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(pausedPlays);
  });

  it('ignores the queued source-change pause when finalization follows native startup recovery', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } });
    fireEvent.error(video);
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'file', stream_url: file, recording: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(video).toHaveAttribute('src', file);
    await act(async () => { await Promise.resolve(); fireEvent.pause(video); });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 80 } });
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(77);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBeGreaterThan(plays);
  });

  it('completes native startup when progress exposes a range after the sole canplay event', async () => {
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 0 } });
    fireEvent.canPlay(video);
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 32 } });
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    fireEvent.progress(video);
    expect(video.currentTime).toBe(20);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).toBeEnabled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loads);
  });

  it('rebuilds the same playback generation after an initial fragment returns temporary 409', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" onFatalError={fatal} />);
    await settle();
    const old = mock.instances[0];
    act(() => old.emit('error', { fatal: false, type: 'network', response: { code: 409 }, details: 'fragLoadError' }));
    await settle();
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(old.startLoad).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mock.instances).toHaveLength(2);
    expect(mock.instances[1].loadSource).toHaveBeenCalledWith(descriptor.manifest_url);
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.canPlay(video);
    expect(video.currentTime).toBe(12);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
  });

  it('queues urgent established-playback recovery behind an in-flight status poll without overlapping requests', async () => {
    vi.useFakeTimers();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } });
    fireEvent.canPlay(video);
    video.currentTime = 45;
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    let resolvePoll, resolveRecovery;
    getDVRActivePlaybackStatus.mockImplementationOnce(() => new Promise(done => { resolvePoll = done; }));
    getDVRActivePlaybackStatus.mockImplementationOnce(() => new Promise(done => { resolveRecovery = done; }));
    fireEvent.pause(video);
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(2);
    act(() => mock.instances[0].emit('error', { fatal: true, type: 'network', response: { code: 409 } }));
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(2);
    await act(async () => resolvePoll({ mode: 'hls', recording: true }));
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(3);
    await act(async () => resolveRecovery({ mode: 'hls', recording: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mock.instances[0].startLoad).toHaveBeenCalledWith(45);
    expect(video.paused).toBe(true);
    expect(mock.instances).toHaveLength(1);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('does not run queued recovery after the active status poll revokes authorization', async () => {
    vi.useFakeTimers();
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 90 } });
    fireEvent.canPlay(video);
    let reject;
    getDVRActivePlaybackStatus.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    fireEvent.play(video);
    act(() => mock.instances[0].emit('error', { fatal: true, type: 'network', response: { code: 409 } }));
    await act(async () => reject(new APIError('Access ended', { status: 403 })));
    expect(fatal).toHaveBeenCalledOnce();
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(2);
    expect(stopDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('applies the recovered initial seek once while metadata and progress arrive before decoded readiness', async () => {
    vi.useFakeTimers();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" initialPosition="latest" />);
    await settle();
    act(() => mock.instances[0].emit('error', { fatal: false, type: 'network', response: { code: 409 } }));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const video = screen.getByLabelText('Recording player');
    let position = 0;
    const seek = vi.fn(value => { position = value; });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => position, set: seek });
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.loadedMetadata(video);
    expect(seek).toHaveBeenCalledOnce();
    expect(position).toBe(12);
    fireEvent.progress(video);
    fireEvent.durationChange(video);
    act(() => mock.instances[1].emit('buffered'));
    expect(seek).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    fireEvent.canPlay(video);
    expect(seek).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('does not announce autoplay failure when a retired playback source aborts its play promise', async () => {
    vi.useFakeTimers();
    let rejectPlay;
    HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((_done, reject) => { rejectPlay = reject; }));
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    act(() => mock.instances[0].emit('manifest'));
    act(() => mock.instances[0].emit('error', { fatal: false, type: 'network', response: { code: 409 } }));
    await settle();
    await act(async () => rejectPlay(new DOMException('Source replaced', 'AbortError')));
    expect(screen.queryByText('Autoplay was prevented. Use the controls to start.')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    act(() => mock.instances[1].emit('manifest'));
    await settle();
    expect(screen.queryByText('Autoplay was prevented. Use the controls to start.')).not.toBeInTheDocument();
  });

  it('ignores a retired source play rejection but still reports an actual current-source autoplay restriction', async () => {
    vi.useFakeTimers();
    let rejectOld;
    HTMLMediaElement.prototype.play.mockImplementationOnce(() => new Promise((_done, reject) => { rejectOld = reject; }));
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    act(() => mock.instances[0].emit('manifest'));
    act(() => mock.instances[0].emit('error', { fatal: false, type: 'network', response: { code: 409 } }));
    await settle();
    await act(async () => rejectOld(new DOMException('Old policy result', 'NotAllowedError')));
    expect(screen.queryByText('Autoplay was prevented. Use the controls to start.')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Gesture required', 'NotAllowedError'));
    act(() => mock.instances[1].emit('manifest'));
    await settle();
    expect(screen.getByText('Autoplay was prevented. Use the controls to start.')).toBeInTheDocument();
    fireEvent.play(screen.getByLabelText('Recording player'));
    expect(screen.queryByText('Autoplay was prevented. Use the controls to start.')).not.toBeInTheDocument();
  });

  it('clamps absolute scrubbing and forward skips to retained media and the safe live edge', async () => {
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 2, start: i => i ? 30 : 5, end: i => i ? 90 : 20 } });
    fireEvent.canPlay(video);
    const timeline = screen.getByRole('slider', { name: 'Recording timeline' });
    fireEvent.change(timeline, { target: { value: 25 } });
    expect(video.currentTime).toBeCloseTo(19.99);
    fireEvent.change(timeline, { target: { value: 70 } });
    expect(video.currentTime).toBe(70);
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    expect(video.currentTime).toBe(78);
    expect(screen.getByRole('button', { name: 'Forward 15 seconds' })).toBeDisabled();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
  });

  it('keeps routine startup prose off the picture and shows only a delayed concise hint below it', async () => {
    vi.useFakeTimers();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'waiting', recording: true });
    const { container } = render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" />);
    await settle();
    expect(screen.queryByText('Starting recording…')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for recorded video to become available…')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const hint = screen.getByText('Starting recording…');
    expect(hint.closest('.video-frame')).toBeNull();
    expect(container.querySelector('.playback-loading')).toBeNull();
    getDVRActivePlaybackStatus.mockResolvedValue({ mode: 'hls', recording: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 24 } });
    fireEvent.canPlay(video);
    expect(screen.queryByText('Starting recording…')).not.toBeInTheDocument();
  });

  it.each([
    ['native HLS while playing', false, false],
    ['native HLS while deliberately paused', false, true],
    ['hls.js while playing', true, false],
  ])('keeps a transient status poll and its retry quiet for %s without reloading healthy media', async (_label, mse, paused) => {
    vi.useFakeTimers();
    mock.supported = mse;
    if (!mse) vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    fireEvent.canPlay(video);
    video.currentTime = 120;
    Object.defineProperty(video, 'paused', { configurable: true, value: paused });
    fireEvent(video, new Event(paused ? 'pause' : 'play'));
    fireEvent.timeUpdate(video);
    await settle();
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    const polls = getDVRActivePlaybackStatus.mock.calls.length;
    const engine = mock.instances[0];
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).not.toBeDisabled();
    getDVRActivePlaybackStatus.mockRejectedValueOnce(new APIError('Metadata temporarily unavailable', { status: 503 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(polls + 1);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Recording timeline' })).not.toBeDisabled();
    expect(video.currentTime).toBe(120);
    expect(video.paused).toBe(paused);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(polls + 2);
    // A retry must retain its metadata purpose: treating it as media recovery
    // would schedule a later native load() or hls.js startLoad().
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(HTMLMediaElement.prototype.load.mock.calls.length).toBe(loads);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
    expect(video.currentTime).toBe(120);
    expect(video.paused).toBe(paused);
    if (mse) {
      expect(engine.startLoad).not.toHaveBeenCalled();
      expect(engine.destroy).not.toHaveBeenCalled();
      expect(mock.instances).toHaveLength(1);
    } else {
      expect(video).toHaveAttribute('src', descriptor.manifest_url);
      expect(mock.instances).toHaveLength(0);
    }
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
  });


  it('resets the soft metadata retry budget after each healthy response over nine isolated failures', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    fireEvent.canPlay(video);
    video.currentTime = 120;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);
    await settle();
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    const plays = HTMLMediaElement.prototype.play.mock.calls.length;
    for (let cycle = 0; cycle < 9; cycle += 1) {
      const requests = getDVRActivePlaybackStatus.mock.calls.length;
      getDVRActivePlaybackStatus.mockRejectedValueOnce(new APIError('Temporary status failure', { status: 503 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(cycle ? 13000 : 15000); });
      expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(requests + 1);
      expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(requests + 2);
      expect(fatal).not.toHaveBeenCalled();
      expect(video.currentTime).toBe(120);
      expect(video.paused).toBe(false);
    }
    expect(HTMLMediaElement.prototype.load.mock.calls.length).toBe(loads);
    expect(HTMLMediaElement.prototype.play.mock.calls.length).toBe(plays);
    expect(video).toHaveAttribute('src', descriptor.manifest_url);
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).not.toHaveBeenCalled();
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('prioritizes actual native media recovery over a scheduled background metadata retry', async () => {
    vi.useFakeTimers();
    mock.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const fatal = vi.fn();
    render(<RecordingHLSPlayer recordingID="7" csrfToken="csrf" onFatalError={fatal} />);
    await settle();
    const video = screen.getByLabelText('Recording player');
    Object.defineProperty(video, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } });
    fireEvent.canPlay(video);
    video.currentTime = 120;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    fireEvent.play(video);
    await settle();
    const loads = HTMLMediaElement.prototype.load.mock.calls.length;
    getDVRActivePlaybackStatus.mockRejectedValueOnce(new APIError('Temporary status failure', { status: 503 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    await settle();
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    const requests = getDVRActivePlaybackStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(HTMLMediaElement.prototype.load.mock.calls.length).toBe(loads + 1);
    expect(getDVRActivePlaybackStatus).toHaveBeenCalledTimes(requests);
    Object.defineProperty(video, 'error', { configurable: true, value: null });
    fireEvent.canPlay(video);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(video.currentTime).toBe(120);
    expect(video.paused).toBe(false);
    expect(fatal).not.toHaveBeenCalled();
    expect(createDVRActivePlayback).toHaveBeenCalledOnce();
    expect(stopDVRActivePlayback).not.toHaveBeenCalled();
  });


});
