import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import WatchControl from './WatchControl';
import { VLC_APP_STORE_URL } from './vlc';

const rectangle = ({ height, left, top, width }) => ({
  bottom: top + height,
  height,
  left,
  right: left + width,
  top,
  width,
  x: left,
  y: top,
  toJSON: () => ({}),
});

const installMenuGeometry = ({ triggerTop = 100, viewportHeight = 800 } = {}) => {
  let trigger = rectangle({ height: 44, left: 256, top: triggerTop, width: 44 });
  const menu = rectangle({ height: 100, left: 0, top: 0, width: 190 });
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.stubGlobal('innerHeight', viewportHeight);
  vi.stubGlobal('innerWidth', 1024);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect() {
    if (this.classList.contains('watch-options-button')) return trigger;
    if (this.classList.contains('watch-menu')) return menu;
    return original.call(this);
  });
  return {
    setTriggerTop(top) {
      trigger = rectangle({ height: 44, left: 256, top, width: 44 });
    },
  };
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WatchControl', () => {
  it('shows only Stop during playback and invokes the stop action', async () => {
    const onStop = vi.fn();
    const onWatch = vi.fn();
    const user = userEvent.setup();
    render(<WatchControl onStop={onStop} onWatch={onWatch} playing />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onWatch).not.toHaveBeenCalled();
  });

  it('closes open options when playback starts and restores closed options after stopping', async () => {
    installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const user = userEvent.setup();
    const props = { onStop: vi.fn(), onWatch: vi.fn(), onDownload: vi.fn() };
    const { rerender } = render(<WatchControl {...props} />);
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(<WatchControl {...props} playing />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(<WatchControl {...props} playing={false} />);
    expect(screen.getByRole('button', { name: 'Watch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch options' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download' }));
    expect(props.onDownload).toHaveBeenCalledOnce();
  });

  it('opens below the trigger when the menu fits in the viewport', async () => {
    installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const user = userEvent.setup();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('is-below');
    expect(menu).toHaveStyle({ left: '110px', top: '149px' });
  });

  it('flips above near the viewport bottom and keeps its actions operational', async () => {
    installMenuGeometry({ triggerTop: 700 });
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const download = vi.fn();
    const user = userEvent.setup();
    render(<WatchControl onDownload={download} onStop={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menu')).toHaveClass('is-above');
    expect(screen.getByRole('menu')).toHaveStyle({ top: '595px' });
    await user.click(screen.getByRole('menuitem', { name: 'Download' }));
    expect(download).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('recalculates placement on viewport resize and orientation change', async () => {
    const geometry = installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const user = userEvent.setup();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onWatch={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menu')).toHaveClass('is-below');
    act(() => {
      geometry.setTriggerTop(700);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(screen.getByRole('menu')).toHaveClass('is-above'));
    act(() => {
      geometry.setTriggerTop(100);
      window.dispatchEvent(new Event('orientationchange'));
    });
    await waitFor(() => expect(screen.getByRole('menu')).toHaveClass('is-below'));
  });

  it('keeps the primary action in place while changing Watch to Stop', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const { rerender } = render(<WatchControl onDownload={vi.fn()} onStop={stop} onWatch={vi.fn()} />);
    const primary = screen.getByRole('button', { name: 'Watch' });
    rerender(<WatchControl onDownload={vi.fn()} onStop={stop} onWatch={vi.fn()} playing />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBe(primary);
    await user.click(primary);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('offers browser, desktop VLC, and download actions', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const user = userEvent.setup();
    const onVLC = vi.fn();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onVLC={onVLC} onWatch={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menuitem', { name: 'Watch in Browser' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));
    expect(onVLC).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
  });

  it('offers VLC on iPad desktop mode and restores focus after Escape', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 });
    const user = userEvent.setup();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onVLC={vi.fn()} onWatch={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Watch options' });
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Open in VLC' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not let a delayed animation frame override keyboard navigation', () => {
    installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onWatch={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Watch options' }));
    const download = screen.getByRole('menuitem', { name: 'Download' });
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(download).toHaveFocus();

    act(() => frames.splice(0).forEach((callback) => callback(0)));
    expect(download).toHaveFocus();
  });

  it.each([
    [false, 'Watch in Browser'],
    [true, 'Download'],
  ])('focuses the first enabled item once the menu is positioned (loading=%s)', (playbackLoading, label) => {
    const geometry = installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onWatch={vi.fn()} playbackLoading={playbackLoading} />);
    const trigger = screen.getByRole('button', { name: 'Watch options' });

    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: label })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    act(() => {
      geometry.setTriggerTop(700);
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('menu')).toHaveClass('is-above');
    expect(screen.getByRole('menuitem', { name: 'Download' })).toHaveFocus();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: label })).toHaveFocus();
  });

  it('preserves keyboard navigation and outside-pointer close behavior', async () => {
    installMenuGeometry();
    vi.stubGlobal('navigator', { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 0 });
    const user = userEvent.setup();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onWatch={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Watch options' });

    await user.click(trigger);
    const browser = screen.getByRole('menuitem', { name: 'Watch in Browser' });
    const download = screen.getByRole('menuitem', { name: 'Download' });
    await user.keyboard('{End}');
    expect(download).toHaveFocus();
    await user.keyboard('{Home}');
    expect(browser).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(download).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(browser).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(download).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('explains the Apple VLC handoff once and links to the App Store', async () => {
    vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 });
    const user = userEvent.setup();
    const openVLC = vi.fn();
    render(<WatchControl onDownload={vi.fn()} onStop={vi.fn()} onVLC={openVLC} onWatch={vi.fn()} selectionKey="movie:7" />);

    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    const dialog = screen.getByRole('dialog', { name: 'Open in VLC' });
    expect(openVLC).not.toHaveBeenCalled();
    expect(dialog.querySelector('a')).toHaveAttribute('href', VLC_APP_STORE_URL);
    await user.click(screen.getByRole('button', { name: 'Open VLC' }));
    expect(openVLC).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem('dispatcharr-now-vlc-explained')).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(openVLC).toHaveBeenCalledTimes(2);
  });
});
