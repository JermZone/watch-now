import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordingPlayerControls from './RecordingPlayerControls';

const capturedRange = { available: true, start: 60, end: 360, seekEnd: 348, position: 120, atLive: false };
function Fixture({ range = capturedRange, loading = false, recording = true, ...props }) {
  const videoRef = useRef(null);
  return <RecordingPlayerControls videoRef={videoRef} range={range} loading={loading} recording={recording} {...props}>
    <video slot="media" ref={videoRef} aria-label="Test recording video" />
  </RecordingPlayerControls>;
}
const video = () => screen.getByLabelText('Test recording video');
const controller = () => screen.getByRole('group', { name: 'Recording player controls' });
const timeline = () => screen.getByRole('slider', { name: 'Recording timeline' });
const playing = () => {
  Object.defineProperty(video(), 'paused', { configurable: true, value: false });
  fireEvent.play(video());
};
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RecordingPlayerControls', () => {
  it('uses the existing video with Media Chrome while disabling native jumping and persisted audio preferences', () => {
    render(<Fixture />);
    expect(video().parentElement).toBe(controller());
    expect(video()).toHaveAttribute('slot', 'media');
    expect(controller()).toHaveAttribute('noautoseektolive');
    expect(controller()).toHaveAttribute('nohotkeys');
    expect(controller()).toHaveAttribute('novolumepref');
    expect(controller()).toHaveAttribute('nomutedpref');
    expect(controller()).toHaveAttribute('gesturesdisabled');
    expect(controller().querySelector('media-control-bar')).toHaveAttribute('noautohide');
    expect(controller().querySelector('media-play-button')).not.toBeNull();
    expect(controller().querySelector('media-mute-button')).not.toBeNull();
    expect(controller().querySelector('media-fullscreen-button')).not.toBeNull();
  });

  it('shows the available captured timeline through the safe seek end', () => {
    render(<Fixture />);
    expect(timeline()).toHaveAttribute('min', '60');
    expect(timeline()).toHaveAttribute('max', '348');
    expect(timeline()).toHaveValue('120');
    expect(timeline()).toHaveAttribute('aria-valuetext', '1:00 of 4:48 captured');
    expect(screen.getByText('−3:48')).toBeInTheDocument();
  });

  it('uses the captured end if a safe edge is not supplied', () => {
    render(<Fixture range={{ ...capturedRange, seekEnd: undefined }} />);
    expect(timeline()).toHaveAttribute('max', '360');
  });

  it('disables navigation until recorded media is ready', () => {
    render(<Fixture range={{ available: false, start: 0, end: 0, position: 0 }} loading />);
    expect(timeline()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back 15 seconds' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward 15 seconds' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Go Live' })).toBeDisabled();
  });

  it('delegates skip and Go Live actions without issuing extra media play or pause calls', () => {
    const navigate = vi.fn();
    render(<Fixture onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back 15 seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go Live' }));
    expect(navigate.mock.calls).toEqual([['back'], ['forward'], ['live']]);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it('disables the back and forward buttons at the appropriate available boundaries', () => {
    const view = render(<Fixture range={{ ...capturedRange, position: 60 }} />);
    expect(screen.getByRole('button', { name: 'Back 15 seconds' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward 15 seconds' })).not.toBeDisabled();
    view.rerender(<Fixture range={{ ...capturedRange, position: 348 }} />);
    expect(screen.getByRole('button', { name: 'Forward 15 seconds' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back 15 seconds' })).not.toBeDisabled();
  });

  it('shows LIVE only while playing at the live edge and lets paused viewers Go Live', () => {
    render(<Fixture range={{ ...capturedRange, position: 348, atLive: true }} />);
    expect(screen.getByRole('button', { name: 'Go Live' })).not.toBeDisabled();
    playing();
    expect(screen.getByRole('button', { name: 'LIVE' })).toBeDisabled();
    fireEvent.pause(video());
    expect(screen.getByRole('button', { name: 'Go Live' })).not.toBeDisabled();
  });

  it('removes the live action when the recording finishes', () => {
    const view = render(<Fixture />);
    view.rerender(<Fixture recording={false} />);
    expect(screen.queryByRole('button', { name: 'Go Live' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'LIVE' })).not.toBeInTheDocument();
    expect(timeline()).not.toBeDisabled();
    expect(controller()).toHaveAttribute('data-recording', 'false');
  });

  it('delegates keyboard timeline changes immediately without changing pause state', () => {
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    fireEvent.change(timeline(), { target: { value: '195.5' } });
    expect(seek).toHaveBeenCalledWith(195.5);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it('previews a drag and commits once on release', () => {
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '200' } });
    fireEvent.change(timeline(), { target: { value: '230' } });
    expect(seek).not.toHaveBeenCalled();
    expect(timeline()).toHaveValue('230');
    expect(timeline()).toHaveAttribute('aria-valuetext', '2:50 of 4:48 captured');
    fireEvent.pointerUp(timeline());
    expect(seek).toHaveBeenCalledExactlyOnceWith(230);
  });

  it('commits a drag released outside the player', () => {
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '210' } });
    fireEvent.pointerUp(window);
    expect(seek).toHaveBeenCalledExactlyOnceWith(210);
  });

  it('cancels a drag on pointer cancellation without seeking', () => {
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '220' } });
    fireEvent.pointerCancel(timeline());
    fireEvent.pointerUp(window);
    expect(seek).not.toHaveBeenCalled();
    expect(timeline()).toHaveValue('120');
  });

  it('cancels a drag with Escape without seeking', () => {
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '220' } });
    fireEvent.keyDown(timeline(), { key: 'Escape' });
    fireEvent.pointerUp(window);
    expect(seek).not.toHaveBeenCalled();
    expect(timeline()).toHaveValue('120');
  });

  it('clamps a pending drag to the latest retained bounds when media changes', () => {
    const seek = vi.fn();
    const view = render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '80' } });
    view.rerender(<Fixture range={{ ...capturedRange, start: 100 }} onSeek={seek} />);
    fireEvent.pointerUp(window);
    expect(seek).toHaveBeenCalledExactlyOnceWith(100);
  });

  it('keeps controls visible while paused and hides them after three seconds playing', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    act(() => vi.advanceTimersByTime(5000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    playing();
    act(() => vi.advanceTimersByTime(2999));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    act(() => vi.advanceTimersByTime(1));
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
    fireEvent.pause(video());
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
  });

  it('reveals hidden controls on touch without playing or seeking', () => {
    vi.useFakeTimers();
    const seek = vi.fn();
    render(<Fixture onSeek={seek} />);
    playing();
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.pointerDown(video(), { pointerType: 'touch' });
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it('keeps focused controls visible, then resumes auto-hide after focus leaves', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    const back = screen.getByRole('button', { name: 'Back 15 seconds' });
    act(() => back.focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    act(() => back.blur());
    act(() => vi.advanceTimersByTime(3000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
  });

  it('keeps controls visible while scrubbing', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    fireEvent.pointerDown(timeline());
    act(() => vi.advanceTimersByTime(5000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    fireEvent.pointerCancel(timeline());
    act(() => vi.advanceTimersByTime(3000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
  });

  it('delays the quiet buffering spinner and removes it as soon as playback is ready', () => {
    vi.useFakeTimers();
    const view = render(<Fixture loading />);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toHaveTextContent('');
    view.rerender(<Fixture loading={false} />);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('shows a spinner for a playing media wait and never for a deliberate paused wait', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    fireEvent.waiting(video());
    act(() => vi.advanceTimersByTime(799));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    fireEvent.playing(video());
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    fireEvent.pause(video());
    Object.defineProperty(video(), 'paused', { configurable: true, value: true });
    fireEvent.waiting(video());
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it.each(['waiting', 'stalled'])('does not reveal controls or a spinner for repeated %s events while recorded frames advance', (eventName) => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    act(() => vi.advanceTimersByTime(3000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
    for (let frame = 1; frame <= 12; frame += 1) {
      fireEvent(video(), new Event(eventName));
      act(() => vi.advanceTimersByTime(250));
      video().currentTime = 120 + frame * 0.25;
      fireEvent.timeUpdate(video());
      expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
      expect(controller()).toHaveAttribute('data-controls-visible', 'false');
    }
  });

  it('checks currentTime advancement at the grace timer even when native media readiness and timeupdate events are absent', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.stalled(video());
    for (let frame = 1; frame <= 8; frame += 1) {
      act(() => vi.advanceTimersByTime(400));
      video().currentTime = 120 + frame;
      expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
      expect(controller()).toHaveAttribute('data-controls-visible', 'false');
    }
  });

  it('still confirms a real playback halt when repeated waiting events continue during the grace period', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    act(() => vi.advanceTimersByTime(3000));
    for (let tick = 0; tick < 4; tick += 1) {
      fireEvent.waiting(video());
      act(() => vi.advanceTimersByTime(200));
    }
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
  });

  it('clears a confirmed buffering spinner as soon as frames resume without playing or canplay events', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    fireEvent.waiting(video());
    act(() => vi.advanceTimersByTime(800));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    video().currentTime = 120.5;
    fireEvent.timeUpdate(video());
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('does not mistake a backward time update for resumed playback', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    fireEvent.waiting(video());
    act(() => vi.advanceTimersByTime(800));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    video().currentTime = 100;
    fireEvent.timeUpdate(video());
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    fireEvent.seeking(video());
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it.each(['pause', 'seeking', 'seeked', 'emptied'])('cancels a pending buffering candidate on %s before its grace expires', (eventName) => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    video().currentTime = 120;
    fireEvent.waiting(video());
    act(() => vi.advanceTimersByTime(500));
    if (eventName === 'pause') Object.defineProperty(video(), 'paused', { configurable: true, value: true });
    fireEvent(video(), new Event(eventName));
    act(() => vi.advanceTimersByTime(800));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('clears a stale network buffering candidate across an engine loading reset', () => {
    vi.useFakeTimers();
    const view = render(<Fixture />);
    playing();
    video().currentTime = 120;
    fireEvent.stalled(video());
    act(() => vi.advanceTimersByTime(500));
    view.rerender(<Fixture loading />);
    fireEvent.emptied(video());
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('status', { name: 'Buffering recording' })).toBeInTheDocument();
    view.rerender(<Fixture loading={false} />);
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
  });

  it('retires buffering timers and old video listeners when a recording player unmounts', () => {
    vi.useFakeTimers();
    const view = render(<Fixture />);
    playing();
    const oldVideo = video();
    oldVideo.currentTime = 120;
    fireEvent.waiting(oldVideo);
    act(() => vi.advanceTimersByTime(500));
    view.unmount();
    render(<Fixture />);
    playing();
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.stalled(oldVideo);
    act(() => vi.advanceTimersByTime(800));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('status', { name: 'Buffering recording' })).not.toBeInTheDocument();
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
  });

  it('routes player keyboard skips and boundaries through engine callbacks', () => {
    const seek = vi.fn(), navigate = vi.fn();
    render(<Fixture onSeek={seek} onNavigate={navigate} />);
    fireEvent.keyDown(controller(), { key: 'ArrowLeft' });
    fireEvent.keyDown(controller(), { key: 'ArrowRight' });
    fireEvent.keyDown(controller(), { key: 'Home' });
    fireEvent.keyDown(controller(), { key: 'End' });
    expect(navigate.mock.calls).toEqual([['back'], ['forward'], ['live']]);
    expect(seek).toHaveBeenCalledExactlyOnceWith(60);
  });

  it('lets a finished recording keyboard End seek to its safe end', () => {
    const seek = vi.fn();
    render(<Fixture recording={false} onSeek={seek} />);
    fireEvent.keyDown(controller(), { key: 'End' });
    expect(seek).toHaveBeenCalledExactlyOnceWith(348);
  });

  it('does not steal range or button keyboard shortcuts', () => {
    const seek = vi.fn(), navigate = vi.fn();
    render(<Fixture onSeek={seek} onNavigate={navigate} />);
    fireEvent.keyDown(timeline(), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back 15 seconds' }), { key: 'ArrowLeft' });
    expect(navigate).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it('handles rejected keyboard play without losing usable controls', async () => {
    HTMLMediaElement.prototype.play.mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
    render(<Fixture />);
    fireEvent.keyDown(controller(), { key: ' ' });
    await act(async () => { await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
  });

  it('cancels a held drag across a loading reset even if media is ready again before release', () => {
    const seek = vi.fn();
    const view = render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '200' } });
    view.rerender(<Fixture loading onSeek={seek} />);
    view.rerender(<Fixture loading={false} onSeek={seek} />);
    fireEvent.pointerUp(window);
    expect(seek).not.toHaveBeenCalled();
    expect(timeline()).toHaveValue('120');
  });

  it('allows pointer-focused controls to hide without forcing keyboard focus away', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    const back = screen.getByRole('button', { name: 'Back 15 seconds' });
    fireEvent.pointerDown(back, { pointerType: 'touch' });
    act(() => back.focus());
    act(() => vi.advanceTimersByTime(3000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'false');
    expect(back).toHaveFocus();
    fireEvent.keyDown(back, { key: 'Tab' });
    act(() => vi.advanceTimersByTime(5000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
  });

  it('recognizes keyboard Tab re-entry after an earlier pointer interaction', () => {
    vi.useFakeTimers();
    render(<Fixture />);
    playing();
    const back = screen.getByRole('button', { name: 'Back 15 seconds' });
    fireEvent.pointerDown(back, { pointerType: 'touch' });
    act(() => back.focus());
    act(() => back.blur());
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => back.focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(controller()).toHaveAttribute('data-controls-visible', 'true');
  });

  it('ignores releases after unmount instead of seeking an old recording', () => {
    const seek = vi.fn();
    const view = render(<Fixture onSeek={seek} />);
    fireEvent.pointerDown(timeline());
    fireEvent.change(timeline(), { target: { value: '200' } });
    view.unmount();
    fireEvent.pointerUp(window);
    expect(seek).not.toHaveBeenCalled();
  });
});
