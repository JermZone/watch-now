import { afterEach, expect, it, vi } from 'vitest';
import mpegts from 'mpegts.js';
import { installLiveTrackGuard } from './liveTrackGuard';

const installMediaSource = (rejectType = 'audio') => {
  class MediaSourceStub {
    readyState = 'open';
    addEventListener() {}
    removeEventListener() {}
    removeSourceBuffer() {}
    endOfStream() {}
    addSourceBuffer(mime) {
      if (mime.startsWith(rejectType)) throw new DOMException('Unsupported track', 'NotSupportedError');
      return {
        updating: false, buffered: { length: 0 },
        addEventListener() {}, removeEventListener() {},
        appendBuffer: vi.fn(),
      };
    }
  }
  vi.stubGlobal('MediaSource', MediaSourceStub);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  class URLStub extends URL {
    static createObjectURL = vi.fn(() => 'blob:test');
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal('URL', URLStub);
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['audio', 'video'])('drops rejected %s chunks while the other track keeps appending in mpegts.js', (rejectedTrack) => {
  installMediaSource(rejectedTrack);
  const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: '/unused' }, { enableWorker: false });
  player.attachMediaElement(document.createElement('video'));
  const guard = installLiveTrackGuard(player, mpegts.version);
  expect(guard).not.toBeNull();
  let rejected;
  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    expect(type).toBe(mpegts.ErrorTypes.MEDIA_ERROR);
    expect(detail).toBe(mpegts.ErrorDetails.MEDIA_MSE_ERROR);
    expect(info.code).toBe(9);
    rejected = guard.rejectInitializingTrack();
  });
  const controller = player._player_engine._mse_controller;
  const supportedTrack = rejectedTrack === 'audio' ? 'video' : 'audio';
  const init = (type) => ({ type, container: `${type}/mp4`, codec: type === 'audio' ? 'ec-3' : 'avc1.640028', data: new ArrayBuffer(4) });
  controller.appendInitSegment(init(supportedTrack));
  controller.appendInitSegment(init(rejectedTrack));
  expect(rejected).toEqual({ track: rejectedTrack, allRejected: false });
  // Sustained unsupported media must never accumulate in an unconsumed queue.
  for (let i = 0; i < 1000; i += 1) controller.appendMediaSegment({ type: rejectedTrack, data: new ArrayBuffer(256) });
  controller.appendInitSegment(init(rejectedTrack));
  expect(controller._pendingSegments[rejectedTrack]).toHaveLength(0);
  controller.appendMediaSegment({ type: supportedTrack, data: new ArrayBuffer(4) });
  expect(controller._sourceBuffers[supportedTrack].appendBuffer).toHaveBeenCalled();
  player.destroy();
});

it('refuses unverified library versions and controller shapes', () => {
  expect(installLiveTrackGuard({}, '1.8.0')).toBeNull();
  expect(installLiveTrackGuard({ _player_engine: { _mse_controller: {} } }, '1.8.0')).toBeNull();
  expect(installLiveTrackGuard({}, '1.8.2')).toBeNull();
});

it('does not attribute errors outside source-buffer initialization to a track', () => {
  installMediaSource();
  const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: '/unused' }, { enableWorker: false });
  player.attachMediaElement(document.createElement('video'));
  const guard = installLiveTrackGuard(player, mpegts.version);
  expect(guard.rejectInitializingTrack()).toBeNull();
  player.destroy();
});
