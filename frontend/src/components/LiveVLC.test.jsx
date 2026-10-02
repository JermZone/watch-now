import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./LivePlayer', () => ({
  default: ({ channel }) => <div data-testid="live-player">Playing {channel.name}</div>,
}));
const vlcMocks = vi.hoisted(() => ({
  VLC_APP_STORE_URL: 'https://apps.apple.com/us/app/vlc-media-player/id650377962',
  isAppleMobile: vi.fn(),
  openVLC: vi.fn(),
}));
vi.mock('./vlc', () => vlcMocks);

import ViewerShell from './ViewerShell';

const launchURL = `/api/vlc/launch/${'A'.repeat(43)}/World-News.ts`;
const jsonResponse = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

const installAPI = (handoff = () => jsonResponse({ launch_url: launchURL }, 201)) => {
  const fetchMock = vi.fn((input, options) => {
    const path = String(input);
    if (path.endsWith('/vlc')) return handoff(input, options);
    if (path === '/api/live/search/capabilities') return jsonResponse({ program_search: false });
    if (path === '/api/live/categories') return jsonResponse([{ id: '2', name: 'News' }]);
    if (path.includes('/epg')) return jsonResponse({});
    if (path.startsWith('/api/live/channels')) return jsonResponse([
      { id: '41', name: 'World News' }, { id: '42', name: 'Sports Plus' },
    ]);
    if (path === '/api/auth/logout') return Promise.resolve(new Response(null, { status: 204 }));
    if (path === '/api/movies/categories') return jsonResponse([]);
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const renderViewer = (onExpired = vi.fn()) => render(<ViewerShell
  onExpired={onExpired} session={{ user: { username: 'viewer' }, csrf_token: 'csrf-live' }}
/>);

const requestVLC = async (user, apple = false) => {
  await screen.findByRole('button', { name: 'Watch Live' });
  await user.click(screen.getByRole('button', { name: 'Watch options' }));
  expect(screen.queryByRole('menuitem', { name: 'Download' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: apple ? 'Open in VLC' : 'Watch in VLC' }));
};

beforeEach(() => {
  vlcMocks.isAppleMobile.mockReturnValue(false);
  vlcMocks.openVLC.mockReset().mockReturnValue('playlist');
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Live TV VLC handoff', () => {
  it('downloads a titled desktop playlist, retries with a fresh handoff, and returns to browser playback', async () => {
    const fetchMock = installAPI();
    const user = userEvent.setup();
    renderViewer();
    await requestVLC(user);
    expect(await screen.findByText('Ready to watch in VLC')).toBeInTheDocument();
    expect(vlcMocks.openVLC).toHaveBeenCalledWith(launchURL, 'World News');
    await user.click(screen.getByRole('button', { name: 'Watch in VLC again' }));
    await waitFor(() => expect(vlcMocks.openVLC).toHaveBeenCalledTimes(2));
    const requests = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/vlc'));
    expect(requests).toHaveLength(2);
    expect(requests[0][0]).toBe('/api/live/channels/41/vlc');
    expect(requests[0][1].headers.get('X-CSRF-Token')).toBe('csrf-live');
    await user.click(screen.getByRole('button', { name: 'Back to details' }));
    await user.click(screen.getByRole('button', { name: 'Watch Live' }));
    expect(screen.getByTestId('live-player')).toHaveTextContent('Playing World News');
  });

  it('offers the Apple handoff and explanation during active browser playback, stopping the player before opening VLC', async () => {
    vlcMocks.isAppleMobile.mockReturnValue(true);
    vlcMocks.openVLC.mockImplementation(() => {
      expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
      return 'app';
    });
    installAPI();
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Watch Live' }));
    expect(screen.getByTestId('live-player')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    const dialog = screen.getByRole('dialog', { name: 'Open in VLC' });
    expect(within(dialog).getByRole('link')).toHaveAttribute('href', vlcMocks.VLC_APP_STORE_URL);
    await user.click(within(dialog).getByRole('button', { name: 'Open VLC' }));
    await waitFor(() => expect(vlcMocks.openVLC).toHaveBeenCalledWith(launchURL, 'World News'));
    expect(screen.getByRole('button', { name: 'Watch Live' })).toBeInTheDocument();
  });

  it('stops a different playing channel before opening the selected channel in VLC', async () => {
    vlcMocks.openVLC.mockImplementation(() => {
      expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
      return 'playlist';
    });
    const fetchMock = installAPI();
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Watch Live' }));
    await user.click(screen.getByRole('option', { name: 'Sports Plus' }));
    await requestVLC(user);
    await waitFor(() => expect(vlcMocks.openVLC).toHaveBeenCalledWith(launchURL, 'Sports Plus'));
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/live/channels/42/vlc')).toBe(true);
  });

  it('preserves browser playback if handoff creation fails', async () => {
    installAPI(() => jsonResponse({ error: { code: 'dispatcharr_unavailable' } }, 502));
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Watch Live' }));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));
    expect(await screen.findByText('VLC handoff could not be completed. Please try again.')).toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toBeInTheDocument();
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
  });

  it('reports an expired viewer session without opening VLC', async () => {
    installAPI(() => jsonResponse({ error: { code: 'session_expired' } }, 401));
    const onExpired = vi.fn();
    const user = userEvent.setup();
    renderViewer(onExpired);
    await requestVLC(user);
    await waitFor(() => expect(onExpired).toHaveBeenCalledWith('Your viewer session expired. Sign in again.'));
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
  });

  it('keeps Stop available while preparing VLC and cancels that pending handoff', async () => {
    let resolveHandoff;
    let signal;
    installAPI((_input, options) => {
      signal = options.signal;
      return new Promise((resolve) => { resolveHandoff = resolve; });
    });
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Watch Live' }));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    await user.click(stop);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    await act(async () => { resolveHandoff(await jsonResponse({ launch_url: launchURL }, 201)); });
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
  });

  it.each(['channel', 'category', 'section', 'sign out', 'unmount'])('ignores a pending handoff after changing %s', async (change) => {
    let resolveHandoff;
    let signal;
    installAPI((_input, options) => {
      signal = options.signal;
      return new Promise((resolve) => { resolveHandoff = resolve; });
    });
    const user = userEvent.setup();
    const view = renderViewer();
    await requestVLC(user);
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    if (change === 'channel') await user.click(screen.getByRole('option', { name: 'Sports Plus' }));
    if (change === 'category') await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), '2');
    if (change === 'section' || change === 'sign out') {
      await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
      await user.click(screen.getByRole('button', { name: change === 'section' ? 'Movies' : 'Sign out viewer', exact: true }));
    }
    if (change === 'unmount') view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveHandoff(await jsonResponse({ launch_url: launchURL }, 201)); });
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
    expect(screen.queryByText('Ready to watch in VLC')).not.toBeInTheDocument();
  });
});
