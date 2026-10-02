import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Keep the actual App, viewer, controls and media lifecycle components. Only
// network responses and browser media primitives are synthetic. These tests do
// not establish real-browser hit testing, media decoding or upstream access.
const media = vi.hoisted(() => ({ players: [], createPlayer: vi.fn() }));
vi.mock('mpegts.js', () => ({ default: {
  version: '1.8.0',
  Events: { ERROR: 'error', MEDIA_INFO: 'media-info' },
  ErrorTypes: { MEDIA_ERROR: 'MediaError', NETWORK_ERROR: 'NetworkError' },
  ErrorDetails: { MEDIA_MSE_ERROR: 'MediaMSEError' },
  isSupported: () => true,
  createPlayer: (...args) => media.createPlayer(...args),
} }));

import App from './App';

const response = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

function installAPI(programSearch) {
  let authenticated = false;
  let generation = 0;
  const logoutTokens = [];
  const unexpected = [];
  const movie = { id: '101', name: 'Sample Movie', has_artwork: false };
  const series = { id: '201', name: 'Sample Series', has_artwork: false };
  const fixture = { holdGuide: null, logoutTokens, unexpected };
  const session = () => ({ user: { username: 'sample-viewer' }, csrf_token: `synthetic-session-${generation}` });
  const fetchMock = vi.fn((input, options = {}) => {
    const endpoint = String(input).split('?')[0];
    if (endpoint === '/api/health/ready') return response({ reachable: true });
    if (endpoint === '/api/auth/login' && options.method === 'POST') {
      authenticated = true;
      generation += 1;
      return response(session());
    }
    if (!authenticated) return response({ error: { code: 'session_expired', message: 'Sign in' } }, 401);
    if (endpoint === '/api/auth/logout' && options.method === 'POST') {
      logoutTokens.push(new Headers(options.headers).get('X-CSRF-Token'));
      authenticated = false;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (endpoint === '/api/session') return response(session());
    if (endpoint === '/api/live/search/capabilities') return response({ program_search: programSearch });
    if (endpoint === '/api/live/categories') return response([{ id: '2', name: 'Sample channels' }]);
    if (endpoint === '/api/live/channels') return response([{ id: '41', name: 'Sample Channel', category_id: '2', channel_number: '7', has_artwork: false }]);
    if (endpoint === '/api/live/channels/41/epg') {
      if (fixture.holdGuide) return fixture.holdGuide;
      return response({ current: null, upcoming: null });
    }
    if (endpoint === '/api/movies/categories' || endpoint === '/api/series/categories') return response([{ id: '3', name: 'Samples' }]);
    if (endpoint === '/api/movies') return response({ items: [movie], total: 1 });
    if (endpoint === '/api/movies/101') return response(movie);
    if (endpoint === '/api/series') return response({ items: [series], total: 1 });
    if (endpoint === '/api/series/201') return response({ ...series, seasons: [{ number: 1, episodes: [{ id: '301', title: 'Sample Episode', episode_number: 1, season_number: 1 }] }] });
    unexpected.push(endpoint);
    return response({ error: { message: 'Unexpected test request' } }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fixture;
}

beforeEach(() => {
  media.players = [];
  media.createPlayer.mockReset().mockImplementation(() => {
    const handlers = new Map();
    const player = {
      on: vi.fn((event, callback) => handlers.set(event, callback)),
      attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(), unload: vi.fn(), detachMediaElement: vi.fn(), destroy: vi.fn(),
      emit: (event, ...args) => handlers.get(event)?.(...args),
    };
    media.players.push(player);
    return player;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function signIn(user) {
  await user.type(await screen.findByLabelText('Username'), 'sample-viewer');
  await user.type(screen.getByLabelText('Password'), 'synthetic-only');
  await user.click(screen.getByRole('button', { name: 'Open Watch Now', exact: true }));
  await screen.findByRole('button', { name: 'Watch Live', exact: true });
}

async function openMenu(user) {
  await user.click(screen.getByRole('button', { name: /^Open menu, current section/ }));
}

async function section(user, label) {
  await openMenu(user);
  await user.click(within(screen.getByRole('navigation', { name: 'Viewer sections' })).getByRole('button', { name: label, exact: true }));
}

function expectInteractiveRoot(container) {
  expect(container.inert).toBeFalsy();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.querySelector('.dialog-backdrop')).toBeNull();
}

async function watchNative(user, label, source) {
  const button = screen.getByRole('button', { name: 'Watch', exact: true });
  expect(button).toBeEnabled();
  await user.click(button);
  const video = screen.getByLabelText(`${label} player`);
  expect(video).toHaveAttribute('src', source);
  fireEvent.playing(video);
  await user.click(screen.getByRole('button', { name: 'Stop', exact: true }));
  expect(video).not.toHaveAttribute('src');
  expect(video).not.toBeInTheDocument();
  return video;
}

describe('viewer session lifecycle (synthetic integration)', () => {
  it.each([
    { programSearch: false, apple: false },
    { programSearch: true, apple: false },
    { programSearch: false, apple: true },
    { programSearch: true, apple: true },
  ])('keeps Live, Movie and Episode Watch usable after three logins: %j', async ({ programSearch, apple }) => {
    // Apple UA exercises the optional VLC explanation, not device support.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(apple ? 'iPhone' : 'desktop-test');
    const fixture = installAPI(programSearch);
    const user = userEvent.setup();
    const { container } = render(<StrictMode><App /></StrictMode>);
    let retiredLive, retiredVideo;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await signIn(user);
      if (retiredLive) act(() => retiredLive.emit('error', 'NetworkError', 'Exception', {}));
      if (retiredVideo) fireEvent.error(retiredVideo);
      expectInteractiveRoot(container);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
      await waitFor(() => expect(screen.getByLabelText('Live video for Sample Channel')).toBeInTheDocument());
      retiredLive = media.players.at(-1);
      expect(media.createPlayer).toHaveBeenLastCalledWith(
        { type: 'mpegts', isLive: true, url: '/api/live/channels/41/stream' },
        { enableWorker: false, lazyLoad: false },
      );
      await user.click(screen.getByRole('button', { name: 'Stop', exact: true }));
      expect(retiredLive.destroy).toHaveBeenCalledOnce();
      expect(screen.queryByLabelText('Live video for Sample Channel')).not.toBeInTheDocument();
      await openMenu(user);
      await user.click(screen.getByRole('button', { name: 'About', exact: true }));
      expect(container.inert).toBe(true);
      await user.click(within(screen.getByRole('dialog', { name: 'Watch Now' })).getByRole('button', { name: 'Close', exact: true }));
      expectInteractiveRoot(container);
      await section(user, 'Movies');
      await user.click(await screen.findByRole('button', { name: 'All Titles A–Z', exact: true }));
      await user.click(await screen.findByRole('button', { name: /Sample Movie/ }));
      await user.click(screen.getByRole('button', { name: 'Watch options', exact: true }));
      if (apple) {
        await user.click(screen.getByRole('menuitem', { name: 'Open in VLC', exact: true }));
        expect(container.inert).toBe(true);
        await user.click(within(screen.getByRole('dialog', { name: 'Open in VLC' })).getByRole('button', { name: 'Cancel', exact: true }));
      } else await user.keyboard('{Escape}');
      expectInteractiveRoot(container);
      await watchNative(user, 'Movie', '/api/movies/101/stream');
      await section(user, 'Series');
      await user.click(await screen.findByRole('button', { name: 'All Titles A–Z', exact: true }));
      await user.click(await screen.findByRole('button', { name: /Sample Series/ }));
      await user.click(await screen.findByRole('button', { name: 'Episode 1 · Sample Episode', exact: true }));
      retiredVideo = await watchNative(user, 'Episode', '/api/series/201/episodes/301/stream');
      // Leave a real native-player component active when signing out.
      await user.click(screen.getByRole('button', { name: 'Watch', exact: true }));
      const signingOutVideo = screen.getByLabelText('Episode player');
      await openMenu(user);
      await user.click(screen.getByRole('button', { name: 'Sign out sample-viewer', exact: true }));
      await screen.findByLabelText('Username');
      expect(signingOutVideo).not.toHaveAttribute('src');
      expect(container.querySelector('video')).toBeNull();
      expectInteractiveRoot(container);
    }
    expect(fixture.logoutTokens).toEqual(['synthetic-session-1', 'synthetic-session-2', 'synthetic-session-3']);
    expect(fixture.unexpected).toEqual([]);
    for (const player of media.players) {
      expect(player.pause).toHaveBeenCalledOnce();
      expect(player.unload).toHaveBeenCalledOnce();
      expect(player.detachMediaElement).toHaveBeenCalledOnce();
      expect(player.destroy).toHaveBeenCalledOnce();
    }
  }, 20000);

  it('restores background interaction when a session expires with About open', async () => {
    const fixture = installAPI(false);
    let expireGuide;
    fixture.holdGuide = new Promise((resolve) => { expireGuide = resolve; });
    const user = userEvent.setup();
    const { container } = render(<StrictMode><App /></StrictMode>);
    await signIn(user);
    await openMenu(user);
    await user.click(screen.getByRole('button', { name: 'About', exact: true }));
    expect(container.inert).toBe(true);
    await act(async () => {
      fixture.holdGuide = null;
      expireGuide(await response({ error: { code: 'session_expired', message: 'Expired' } }, 401));
    });
    await screen.findByText('Your viewer session expired. Sign in again.');
    expectInteractiveRoot(container);
    await signIn(user);
    await user.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
    expect(screen.getByLabelText('Live video for Sample Channel')).toBeInTheDocument();
    expect(fixture.unexpected).toEqual([]);
  });
});
