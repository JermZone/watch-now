import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import VideoFrame from './VideoFrame';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup({ mobile = false, top = 200, height = 800 } = {}) {
  let observerCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const media = { matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('innerHeight', height);
  vi.stubGlobal('scrollY', 0);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top }));
  const view = render(<section><VideoFrame><video aria-label="Test video" /></VideoFrame></section>);
  return { ...view, frame: screen.getByLabelText('Test video').parentElement, media, disconnect, resize: () => observerCallback() };
}

it('fits desktop video below the controls and recalculates after a window resize', () => {
  const { frame } = setup();
  expect(parseFloat(frame.style.maxWidth)).toBeCloseTo((800 - 200 - 24) * 16 / 9);
  vi.stubGlobal('innerHeight', 600);
  fireEvent(window, new Event('resize'));
  expect(parseFloat(frame.style.maxWidth)).toBeCloseTo((600 - 200 - 24) * 16 / 9);
});

it('keeps long-page video usable and does not change size just because the page scrolled', () => {
  const { frame, resize } = setup({ top: 1000 });
  const width = frame.style.maxWidth;
  expect(parseFloat(width)).toBeCloseTo((400 - 24) * 16 / 9);
  vi.stubGlobal('scrollY', 900);
  HTMLElement.prototype.getBoundingClientRect.mockReturnValue({ top: 100 });
  resize();
  expect(frame.style.maxWidth).toBe(width);
});

it('preserves phone sizing including after switching from desktop and cleans up observers', () => {
  const { frame, media, resize, unmount, disconnect } = setup({ mobile: true });
  expect(frame.style.maxWidth).toBe('');
  media.matches = false;
  resize();
  expect(frame.style.maxWidth).not.toBe('');
  media.matches = true;
  resize();
  expect(frame.style.maxWidth).toBe('');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});

it('lets the dedicated player use its available pane without remounting the video', () => {
  const { frame, rerender } = setup();
  const video = screen.getByLabelText('Test video');
  expect(frame.style.maxWidth).not.toBe('');
  rerender(<section><VideoFrame contained><video aria-label="Test video" /></VideoFrame></section>);
  expect(frame.style.maxWidth).toBe('');
  expect(screen.getByLabelText('Test video')).toBe(video);
  rerender(<section><VideoFrame><video aria-label="Test video" /></VideoFrame></section>);
  expect(frame.style.maxWidth).not.toBe('');
  expect(screen.getByLabelText('Test video')).toBe(video);
});
