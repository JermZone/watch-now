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

const installAPI = (handoff = () => jsonResponse({ launch_url: launchURL }, 201), recording = null) => {
  const fetchMock = vi.fn((input, options) => {
    const path = String(input);
    if (path.endsWith('/vlc')) return handoff(input, options);
    if (path === '/api/live/search/capabilities') return jsonResponse({ program_search: false, dvr: Boolean(recording) });
    if (path === '/api/dvr/connection') return jsonResponse({ connected: true, access: 'view' });
    if (path === '/api/dvr/recordings' || path === '/api/live/channels/41/recordings') return jsonResponse({ items: recording ? [recording] : [], access: 'view' });
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

// Isolated module state: this test exercises the first-time VLC explanation.
describe('Recording VLC first-time help', () => {
  it('opens the recording chooser after first-time Apple VLC help and returns focus on Cancel', async () => {
    vlcMocks.isAppleMobile.mockReturnValue(true);
    const recording = { id: '7', channel_id: '41', title: 'Recorded News', status: 'recording', can_watch_active: true };
    installAPI(undefined, recording);
    const user = userEvent.setup();
    renderViewer();
    await screen.findByText('Now Recording');
    const options = screen.getByRole('button', { name: 'Watch options' });
    await user.click(options);
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Open in VLC' })).getByRole('button', { name: 'Open VLC' }));
    expect(screen.getByRole('dialog', { name: 'Watch recording in VLC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch from Beginning' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(options).toHaveFocus();
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
  });
});
