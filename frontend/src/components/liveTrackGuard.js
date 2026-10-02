// mpegts.js 1.8.0 keeps queuing media for a source buffer that failed to initialize.
// Its public API has no track-drop operation. This narrowly scoped adapter uses
// the pinned main-thread controller, with shape/version checks that fail closed
// to normal fatal error handling if a dependency update changes the contract.
export const installLiveTrackGuard = (player, version) => {
  const controller = player?._player_engine?._mse_controller;
  if (version !== '1.8.0' || !controller
    || typeof controller.appendInitSegment !== 'function'
    || typeof controller.appendMediaSegment !== 'function'
    || !Array.isArray(controller._pendingSegments?.audio)
    || !Array.isArray(controller._pendingSegments?.video)) return null;

  const rejected = new Set();
  let initializingTrack = null;
  const appendInit = controller.appendInitSegment;
  const appendMedia = controller.appendMediaSegment;
  controller.appendInitSegment = function guardedInit(segment, ...args) {
    if (rejected.has(segment.type)) return;
    const previousTrack = initializingTrack;
    initializingTrack = segment.type;
    try {
      return appendInit.call(this, segment, ...args);
    } finally {
      // An init segment may have been queued before the source opened.
      if (rejected.has(segment.type)) this._pendingSegments[segment.type].length = 0;
      initializingTrack = previousTrack;
    }
  };
  controller.appendMediaSegment = function guardedMedia(segment, ...args) {
    if (!rejected.has(segment.type)) return appendMedia.call(this, segment, ...args);
  };
  return {
    rejectInitializingTrack: () => {
      if (initializingTrack !== 'audio' && initializingTrack !== 'video') return null;
      rejected.add(initializingTrack);
      controller._pendingSegments[initializingTrack].length = 0;
      return { track: initializingTrack, allRejected: rejected.size === 2 };
    },
  };
};
