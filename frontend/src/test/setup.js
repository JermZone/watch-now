import '@testing-library/jest-dom/vitest';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

// Media controls inspect platform capabilities when their custom elements load.
// Individual layout tests override this inert default with their own queries.
window.matchMedia = globalThis.matchMedia = (query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
});

// jsdom exposes track lists as arrays without the browser event interface.
for (const property of ['textTracks', 'audioTracks', 'videoTracks']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property);
  if (!descriptor?.get) continue;
  const lists = new WeakMap();
  Object.defineProperty(HTMLMediaElement.prototype, property, {
    configurable: true,
    get() {
      if (!lists.has(this)) {
        const tracks = descriptor.get.call(this);
        if (tracks && typeof tracks.addEventListener !== 'function') {
          const events = new window.EventTarget();
          Object.assign(tracks, {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events),
          });
        }
        lists.set(this, tracks);
      }
      return lists.get(this);
    },
  });
}
