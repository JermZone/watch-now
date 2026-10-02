import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopVLCPlaylist, isAppleMobile, openVLC, vlcDeepLink } from './vlc';

afterEach(() => vi.unstubAllGlobals());

describe('VLC handoff', () => {
  it('recognizes iPhone and iPad desktop mode, but not a non-touch Mac', () => {
    vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 });
    expect(isAppleMobile()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isAppleMobile()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isAppleMobile()).toBe(false);
  });

  it('accepts only the exact same-origin opaque launch route', () => {
    const path = `/api/vlc/launch/${'A'.repeat(43)}`;
    expect(vlcDeepLink(path)).toBe(`vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(new URL(path, window.location.href).href)}`);
    expect(() => vlcDeepLink(`https://provider.example${path}`)).toThrow();
    expect(() => vlcDeepLink(`${path}?secret=1`)).toThrow();
    expect(() => vlcDeepLink(`/api/vlc/launch/${'A'.repeat(42)}`)).toThrow();
    const titledPath = `${path}/Film-Name.mkv`;
    expect(vlcDeepLink(titledPath)).toBe(`vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(new URL(titledPath, window.location.href).href)}`);
    expect(() => vlcDeepLink(`${path}/Film-Name.mkv/extra`)).toThrow();
  });

  it('builds a titled desktop playlist without letting a title add playlist directives', () => {
    const path = `/api/vlc/launch/${'A'.repeat(43)}`;
    const playlist = desktopVLCPlaylist(path, 'Movie\n#EXTINF:1,Other');
    expect(playlist.filename).toBe('Movie _EXTINF_1_Other.m3u');
    expect(playlist.content).toBe(`#EXTM3U\n#EXTINF:-1,Movie #EXTINF:1,Other\n${new URL(path, window.location.href).href}\n`);
    expect(() => desktopVLCPlaylist(`https://provider.example${path}`, 'Movie')).toThrow();
  });

  it('downloads a small playlist for desktop VLC', () => {
    vi.stubGlobal('navigator', { userAgent: 'Firefox on Windows', platform: 'Win32', maxTouchPoints: 0 });
    const objectURL = 'blob:test-playlist';
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectURL);
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const timeout = vi.spyOn(window, 'setTimeout').mockImplementation(() => 1);
    const path = `/api/vlc/launch/${'A'.repeat(43)}`;

    expect(openVLC(path, 'A Movie')).toBe('playlist');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.contexts[0].download).toBe('A Movie.m3u');
    expect(click.mock.contexts[0].href).toBe(objectURL);
    expect(click.mock.contexts[0].isConnected).toBe(false);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    timeout.mock.calls[0][0]();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectURL);

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    click.mockRestore();
    timeout.mockRestore();
  });
});
