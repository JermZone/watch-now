import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App';

const jsonResponse = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('authenticates and renders viewer-authorized categories and channels', async () => {
    const now = Date.now();
    const fetchMock = vi.fn((input, options = {}) => {
      const path = String(input);
      if (path === '/api/session') {
        return jsonResponse({ error: { code: 'session_expired', message: 'Sign in' } }, 401);
      }
      if (path === '/api/health/ready') {
        return jsonResponse({ reachable: true, version: '0.44.0' });
      }
      if (path === '/api/auth/login' && options.method === 'POST') {
        return jsonResponse({ user: { username: 'viewer' }, csrf_token: 'csrf-token' });
      }
      if (path === '/api/live/categories') {
        return jsonResponse([{ id: '2', name: 'News' }]);
      }
      if (path === '/api/live/channels') {
        return jsonResponse([{ id: '41', name: 'World News', channel_number: '7', category_id: '2', has_artwork: true }]);
      }
      if (path === '/api/live/channels/41/epg') {
        return jsonResponse({
          current: { title: 'News at Noon', start: new Date(now - 600_000), end: new Date(now + 600_000) },
          upcoming: { title: 'Market Close', start: new Date(now + 600_000), end: new Date(now + 1_200_000) },
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Watch Now' })).toBeInTheDocument();
    expect(screen.getByText('A web player for Dispatcharr.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Username'), 'viewer');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Open Watch Now' }));

    expect(await screen.findByRole('heading', { name: 'Live TV' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /World News/ })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'News at Noon' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Market Close' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Category/ })).toHaveTextContent('News');
    expect(JSON.parse(fetchMock.mock.calls.find(([path]) => path === '/api/auth/login')[1].body)).toEqual({
      username: 'viewer',
      password: 'secret',
    });
  });

  it('shows an expired-session state when a catalog call is unauthorized', async () => {
    const fetchMock = vi.fn((input) => {
      const path = String(input);
      if (path === '/api/session') {
        return jsonResponse({ user: { username: 'viewer' }, csrf_token: 'csrf-token' });
      }
      if (path === '/api/live/categories' || path === '/api/live/channels') {
        return jsonResponse({ error: { code: 'session_expired', message: 'Expired' } }, 401);
      }
      if (path === '/api/health/ready') {
        return jsonResponse({ reachable: true, version: '0.31.0' });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('Your viewer session expired. Sign in again.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeInTheDocument());
  });
});
