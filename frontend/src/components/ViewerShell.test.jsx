import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./LivePlayer', () => ({
  default: ({ channel }) => <div data-testid="live-player">Playing {channel.name}</div>,
}));
vi.mock('./NativeVideoPlayer', () => ({
  default: ({ source }) => <div data-source={source} data-testid="native-player" />,
}));

vi.mock('./vlc', async (original) => ({ ...(await original()), openVLC: vi.fn() }));

import { openVLC } from './vlc';
import { airingTime } from './DVR';
import ViewerShell, { PHONE_LAYOUT_QUERY } from './ViewerShell';
import { Sharing } from '../navigation';

const jsonResponse = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));

const installLayoutMedia = (initialMatches) => {
  let matches = initialMatches;
  const listeners = new Set();
  const mediaQuery = {
    get matches() { return matches; },
    media: PHONE_LAYOUT_QUERY,
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mediaQuery));
  return {
    setMatches(nextMatches) {
      matches = nextMatches;
      listeners.forEach((listener) => listener({ matches, media: PHONE_LAYOUT_QUERY }));
    },
  };
};

const installViewerAPI = (programSearch = false, guide = false) => {
  const now = Date.now();
  const fetchMock = vi.fn((input) => {
    const path = String(input);
    if (path === '/api/auth/logout') return jsonResponse({});
    if (path === '/api/live/search/capabilities') return jsonResponse({ program_search: programSearch, guide });
    if (path.startsWith('/api/live/guide?')) return jsonResponse({ items: [{ channel: { id: '41', name: 'World News' }, programs: [] }], page: 1, has_more: false, snapshot: 's1' });
    if (path.startsWith('/api/live/programs/search?')) return jsonResponse({ items: [{ id: 'search1', title: 'Morning report', start: new Date(now - 60000), end: new Date(now + 60000), channel: { id: '41', name: 'World News', channel_number: '7' } }], total: 1, page: 1, page_size: 20 });
    if (path === '/api/live/categories') {
      return jsonResponse([{ id: '2', name: 'News' }, { id: '3', name: 'Sports' }]);
    }
    if (path.startsWith('/api/live/channels') && !path.includes('/epg')) {
      return jsonResponse([
        { id: '41', name: 'World News', channel_number: '7', category_id: '2', has_artwork: true },
        { id: '42', name: 'Sports Plus', channel_number: '8', category_id: '3' },
      ]);
    }
    if (path.startsWith('/api/live/channels/41/epg')) {
      return jsonResponse({
        current: { title: 'News Now', start: new Date(now - 600_000), end: new Date(now + 600_000) },
        upcoming: { title: 'Evening Report', start: new Date(now + 600_000), end: new Date(now + 1_200_000) },
      });
    }
    if (path.startsWith('/api/live/channels/42/epg')) {
      return jsonResponse({
        current: { title: 'Live Match', start: new Date(now - 300_000), end: new Date(now + 900_000) },
        upcoming: { title: 'Postgame', start: new Date(now + 900_000), end: new Date(now + 1_500_000) },
      });
    }
	if (path === '/api/movies/categories') return jsonResponse([{ id: '9', name: 'Films' }]);
	if (path.startsWith('/api/movies?')) return jsonResponse({ items: [{ id: '7', name: 'Movie' }], total: 1, page: 1, page_size: 20 });
	if (path === '/api/movies/7') return jsonResponse({ id: '7', name: 'Movie', plot: 'Movie detail' });
	if (path === '/api/series/categories') return jsonResponse([{ id: '8', name: 'Shows' }]);
    if (path.startsWith('/api/series?')) return jsonResponse({ items: [{ id: '6', name: 'Series' }], total: 1, page: 1, page_size: 20 });
    throw new Error(`Unexpected fetch: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const catalogSearches = (fetchMock, pathname) => fetchMock.mock.calls
  .map(([input]) => new URL(String(input), 'https://now.test'))
  .filter((url) => url.pathname === pathname)
  .map((url) => url.searchParams.get('search'));

const renderViewer = () => render(
  <ViewerShell
    onExpired={vi.fn()}
    session={{ user: { username: 'viewer' }, csrf_token: 'csrf-token' }}
  />,
);

const chooseSection = async (user, label) => {
  await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
  await user.click(within(screen.getByRole('navigation', { name: 'Viewer sections' })).getByRole('button', { name: label }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  openVLC.mockReset();
  window.localStorage.removeItem('dispatcharr-now-appearance');
  delete document.documentElement.dataset.theme;
});

describe('ViewerShell header menu', () => {
  it.each([
    [{ enabled: true }, 'Sharing is ready.'],
    [{ enabled: false, message: 'Sharing is unavailable. Ask the server administrator to check sharing storage.' }, 'Sharing is unavailable. Ask the server administrator to check sharing storage.'],
  ])('shows sharing availability in About', async (sharing, message) => {
    installLayoutMedia(false);
    installViewerAPI(true);
    const user = userEvent.setup();
    render(<Sharing.Provider value={sharing}><ViewerShell onExpired={vi.fn()} session={{ user: { username: 'viewer' }, csrf_token: 'csrf-token' }} /></Sharing.Provider>);
    await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(within(screen.getByRole('dialog', { name: 'Watch Now' })).getByText(message)).toBeInTheDocument();
  });
  it('offers a blue default and remembers a green appearance choice on this device', async () => {
    installLayoutMedia(false);
    installViewerAPI(true);
    const user = userEvent.setup();
    renderViewer();

    await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
    const appearance = screen.getByRole('group', { name: 'Appearance' });
    expect(within(appearance).getByRole('combobox', { name: 'Color' })).toHaveValue('blue');
    await user.selectOptions(within(appearance).getByRole('combobox', { name: 'Color' }), 'green');
    expect(document.documentElement.dataset.theme).toBe('green');
    expect(window.localStorage.getItem('dispatcharr-now-appearance')).toBe('green');
    expect(within(appearance).getByRole('combobox', { name: 'Color' })).toHaveValue('green');
    cleanup();
    renderViewer();
    await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
    expect(within(screen.getByRole('group', { name: 'Appearance' })).getByRole('combobox', { name: 'Color' })).toHaveValue('green');
  });

  it('shows the built version and source in About and returns focus to the menu', async () => {
    installLayoutMedia(false);
    installViewerAPI(true);
    const user = userEvent.setup();
    renderViewer();
    const trigger = screen.getByRole('button', { name: /Open menu, current section/ });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'About' }));
    const dialog = screen.getByRole('dialog', { name: 'Watch Now' });
    expect(within(dialog).getByText('A web player for Dispatcharr.')).toBeInTheDocument();
    expect(within(dialog).getByText('An independent, open-source project. Not affiliated with or endorsed by Dispatcharr or VideoLAN.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'AGPLv3 license' })).toHaveAttribute('href', 'https://github.com/JermZone/watch-now/blob/main/LICENSE');
    expect(within(dialog).getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Source code and support' })).toHaveAttribute('href', __APP_SOURCE__);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('groups section choices above Sign out and closes with Escape and outside clicks', async () => {
    installLayoutMedia(false);
    installViewerAPI(true);
    const user = userEvent.setup();
    renderViewer();

    const trigger = screen.getByRole('button', { name: /Open menu, current section/ });
    expect(trigger).toHaveTextContent('Live TV');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Viewer sections' })).not.toBeInTheDocument();
    await user.click(trigger);
    const menu = screen.getByRole('navigation', { name: 'Viewer sections' });
    expect(within(menu).getAllByRole('button').map((button) => button.textContent)).toEqual(['Live TV', 'Movies', 'Series']);
    expect(within(menu).getByRole('button', { name: 'Live TV' })).toHaveAttribute('aria-current', 'page');
    expect(menu.parentElement.lastElementChild).toHaveTextContent('Sign out');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('navigation', { name: 'Viewer sections' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open menu, current section/ })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
    await user.click(screen.getByRole('navigation', { name: 'Browse or search' }));
    expect(screen.queryByRole('navigation', { name: 'Viewer sections' })).not.toBeInTheDocument();
  });

  it('keeps Sign out at the bottom and submits the existing logout action', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI(true);
    const onExpired = vi.fn();
    const user = userEvent.setup();
    render(<ViewerShell onExpired={onExpired} session={{ user: { username: 'viewer' }, csrf_token: 'csrf-token' }} />);
    await user.click(screen.getByRole('button', { name: /Open menu, current section/ }));
    await user.click(screen.getByRole('button', { name: 'Sign out viewer' }));
    await waitFor(() => expect(onExpired).toHaveBeenCalledWith('You signed out.'));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/auth/logout');
    expect(call?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  });

  it('keeps Browse and Search available after choosing a section', async () => {
    installLayoutMedia(false);
    installViewerAPI(true);
    const user = userEvent.setup();
    renderViewer();
    await chooseSection(user, 'Movies');
    expect(screen.getByRole('button', { name: 'Open menu, current section Movies' })).toHaveTextContent('Movies');
    expect(screen.getByRole('navigation', { name: 'Browse or search' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Viewer sections' })).not.toBeInTheDocument();
    await chooseSection(user, 'Series');
    expect(screen.getByRole('button', { name: 'Open menu, current section Series' })).toHaveTextContent('Series');
    expect(screen.getByRole('navigation', { name: 'Browse or search' })).toBeInTheDocument();
  });
});

describe('ViewerShell responsive channel selector', () => {
	it('navigates Live TV, Movies, and Series while tearing down section playback', async () => {
	  installLayoutMedia(false);
	  installViewerAPI();
	  const user = userEvent.setup();
	  renderViewer();

	  const selected = await screen.findByRole('region', { name: 'Selected channel: World News' });
	  await user.click(within(selected).getByRole('button', { name: 'Watch Live' }));
	  expect(screen.getByTestId('live-player')).toBeInTheDocument();
	  await chooseSection(user, 'Movies');
	  expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
	  expect(screen.getByRole('searchbox', { name: 'Search Movies' })).toBeInTheDocument();
	  expect(screen.getByRole('heading', { name: 'Movies' })).toHaveClass('sr-only');
	  expect(screen.queryByRole('button', { name: /Filter/i })).not.toBeInTheDocument();
	  expect(screen.queryByRole('combobox', { name: 'Sort movies' })).not.toBeInTheDocument();
	  await user.click(await screen.findByRole('button', { name: /All Titles/ }));
	  await user.click(await screen.findByRole('button', { name: /artwork unavailable.*Movie/ }));
	  await screen.findByText('Movie detail');
	  await user.click(screen.getByRole('button', { name: 'Watch' }));
	  expect(screen.getByTestId('native-player')).toHaveAttribute('data-source', '/api/movies/7/stream');

	  await chooseSection(user, 'Series');
	  expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
	  expect(screen.getByRole('searchbox', { name: 'Search Series' })).toBeInTheDocument();
	  expect(await screen.findByRole('region', { name: 'Series categories' })).toBeInTheDocument();
	  await chooseSection(user, 'Live TV');
	  expect(screen.getByRole('searchbox', { name: 'Search Live TV' })).toBeInTheDocument();
	  expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
	});

  it('keeps one Watch Live/Stop action in the selected identity and reserves no player space', async () => {
    installLayoutMedia(false);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    const selected = await screen.findByRole('region', { name: 'Selected channel: World News' });
    const watch = within(selected).getByRole('button', { name: 'Watch Live' });
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    await user.click(watch);
    expect(within(selected).getByRole('button', { name: 'Stop' })).toBe(watch);
    expect(screen.getByTestId('live-player')).toHaveTextContent('World News');
    await user.click(watch);
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(within(selected).getByRole('button', { name: 'Watch Live' })).toBe(watch);
  });

  it('keeps the Live TV heading semantic-only while preserving count and category controls', async () => {
    installLayoutMedia(false);
    installViewerAPI();
    renderViewer();

    expect(await screen.findByText('2 channels')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live TV' })).toHaveClass('sr-only');
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
  });
  it('keeps a compact virtualized channel list persistently visible on tablet and desktop', async () => {
    installLayoutMedia(false);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    expect(await screen.findByRole('listbox', { name: 'Live channels' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Choose channel/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Viewer companion')).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Live channels' })).toHaveClass('is-compact');
    await user.click(screen.getByRole('option', { name: /Sports Plus/ }));
    expect(screen.getByRole('listbox', { name: 'Live channels' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sports Plus' })).toBeInTheDocument();
    expect(screen.getByText('Channel 8')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Program guide for Sports Plus' }).querySelector('.channel-artwork-compact')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Live Match' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Postgame' })).toBeInTheDocument();
  });

  it('collapses the mobile selector after selection and focuses usable guide details', async () => {
    installLayoutMedia(true);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    const trigger = await screen.findByRole('button', { name: 'Choose channel, current channel World News' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('title', 'World News');
    expect(screen.queryByRole('listbox', { name: 'Live channels' })).not.toBeInTheDocument();
    expect(screen.queryByText('Viewer companion')).not.toBeInTheDocument();
    expect(screen.queryByText('Channel 7')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox', { name: 'Live channels' });
    expect(list).toBeVisible();
    expect(list).not.toHaveClass('is-compact');
    list.scrollTop = 48;
    fireEvent.scroll(list);

    await user.click(screen.getByRole('option', { name: /Sports Plus/ }));
    const selectedTrigger = await screen.findByRole('button', { name: 'Choose channel, current channel Sports Plus' });
    expect(selectedTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', { name: 'Live channels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sports Plus' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Live Match' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Postgame' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    const guide = screen.getByRole('region', { name: 'Program guide for Sports Plus' });
    await waitFor(() => expect(guide).toHaveFocus());

    await user.click(selectedTrigger);
    expect(screen.getByRole('listbox', { name: 'Live channels' }).scrollTop).toBe(48);
  });

  it('keeps the phone selector collapsed and preserves browsing state through rotation', async () => {
    const layout = installLayoutMedia(true);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    expect(window.matchMedia).toHaveBeenCalledWith(PHONE_LAYOUT_QUERY);
    expect(PHONE_LAYOUT_QUERY).toContain('(max-height: 500px)');
    expect(PHONE_LAYOUT_QUERY).toContain('(pointer: coarse)');

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Category' }), '2');
    const trigger = await screen.findByRole('button', { name: 'Choose channel, current channel World News' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: /Sports Plus/ }));
    expect(screen.getByRole('button', { name: 'Choose channel, current channel Sports Plus' })).toHaveAttribute('aria-expanded', 'false');

    act(() => layout.setMatches(true));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'Choose channel, current channel Sports Plus' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', { name: 'Live channels' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Live Match' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Postgame' })).toBeInTheDocument();

    act(() => layout.setMatches(false));
    expect(screen.queryByRole('button', { name: /Choose channel/ })).not.toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Live channels' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Sports Plus' })).toBeInTheDocument();

    act(() => layout.setMatches(true));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'Choose channel, current channel Sports Plus' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', { name: 'Live channels' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Program guide for Sports Plus' })).toBeInTheDocument();
  });
});

describe('ViewerShell search', () => {
  it('keeps Browse group/channel separate from Search query and selected result', async () => {
    installLayoutMedia(true); const fetchMock = installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await screen.findByRole('navigation', { name: 'Browse or search' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), '3');
    await screen.findByRole('button', { name: 'Choose channel, current channel Sports Plus' });
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(screen.queryByRole('combobox', { name: 'Category' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Program guide for Sports Plus' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'On now', exact: true }));
    await user.type(screen.getByRole('searchbox'), 'news');
    await user.click(await screen.findByRole('button', { name: /Morning report/ }));
    expect(screen.getByRole('region', { name: 'Program guide for World News' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'sports');
    await user.click(screen.getByRole('button', { name: 'Browse', exact: true }));
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('3');
    expect(screen.getByRole('button', { name: 'Choose channel, current channel Sports Plus' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(screen.getByRole('searchbox')).toHaveValue('sports');
    expect(screen.getByLabelText('Program guide for World News')).not.toBeVisible();
    const requests = fetchMock.mock.calls.map(([input]) => String(input)).filter((path) => path.startsWith('/api/live/programs/search?'));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((path) => !new URL(path, 'https://now.test').searchParams.has('category_id'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/live/channels/41/epg?category_id=3'))).toBe(false);
  });
  it('keeps current playback mounted when switching discovery modes', async () => {
    installLayoutMedia(false); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await screen.findByRole('navigation', { name: 'Browse or search' });
    await user.click(screen.getByRole('button', { name: 'Watch Live' }));
    const player = screen.getByTestId('live-player');
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(screen.getByTestId('live-player')).toBe(player);
    await user.click(screen.getByRole('button', { name: 'Browse', exact: true }));
    expect(screen.getByTestId('live-player')).toBe(player);
    await user.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
  });
  it.each([['Movies', 'Films', '9', '/api/movies'], ['Series', 'Shows', '8', '/api/series']])('keeps %s Browse category independent from retained Search text', async (label, category, id, path) => {
    installLayoutMedia(false); const fetchMock = installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await screen.findByRole('navigation', { name: 'Browse or search' });
    await chooseSection(user, label);
    await user.click(await screen.findByRole('button', { name: new RegExp(category) }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith(path + '?') && new URL(String(input), 'https://now.test').searchParams.get('category_id') === id)).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    await user.type(screen.getByRole('searchbox'), 'something');
    await waitFor(() => expect(catalogSearches(fetchMock, path)).toContain('something'));
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Browse', exact: true }));
    await waitFor(() => expect(fetchMock.mock.calls.slice(before).some(([input]) => String(input).startsWith(path + '?') && new URL(String(input), 'https://now.test').searchParams.get('category_id') === id && !new URL(String(input), 'https://now.test').searchParams.has('search'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(screen.getByRole('searchbox')).toHaveValue('something');
  });
  it('switches movie discovery independently from Live TV', async () => {
    installLayoutMedia(false); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await screen.findByRole('navigation', { name: 'Browse or search' });
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    await chooseSection(user, 'Movies');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Movies categories' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(screen.getByRole('searchbox', { name: 'Search Movies' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Movies categories' })).not.toBeInTheDocument();
    expect(screen.getByText('Search for a movie by title.')).toBeInTheDocument();
    await chooseSection(user, 'Live TV');
    expect(screen.getByRole('searchbox', { name: 'Search Live TV' })).toBeInTheDocument();
  });
  it.each([false, true])('retains channel-search text and results after selection (mobile: %s)', async (mobile) => {
    installLayoutMedia(mobile); const fetchMock = installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Channels', exact: true }));
    const search = screen.getByRole('searchbox');
    await user.type(search, 'sports');
    const results = screen.getByRole('region', { name: 'Channels search results' });
    const result = await within(results).findByRole('button', { name: /Sports Plus/ });
    await user.click(result);
    expect(search).toHaveValue('sports');
    expect(result).not.toBeVisible();
    expect(screen.getByRole('button', { name: /Back to search results/ })).toBeInTheDocument();
    const detail = screen.getByRole('region', { name: 'Program guide for Sports Plus' });
    if (mobile) expect(detail).toHaveFocus();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: 'Watch Live' }));
    expect(search).toHaveValue('sports');
    const player = screen.getByTestId('live-player');
    expect(player).toHaveTextContent('Playing Sports Plus');
    await user.click(screen.getByRole('button', { name: /Back to search results/ }));
    expect(within(results).getByRole('button', { name: /Sports Plus/ })).toBe(result);
    expect(search).toHaveValue('sports');
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(detail).not.toBeVisible();
    await user.click(result);
    expect(result).not.toBeVisible();
    if (mobile) expect(detail).toHaveFocus();
    await user.click(within(detail).getByRole('button', { name: 'Watch Live' }));
    await user.click(screen.getByRole('button', { name: 'Clear Live TV search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.queryByLabelText('Live TV search results')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toHaveTextContent('Playing Sports Plus');
    expect(screen.getByTestId('live-player')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Return to player' }));
    expect(screen.getByTestId('live-player')).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/live/programs/search?'))).toBe(false);
  });
  it('opens a program-search channel without autoplaying and retains the search results', async () => {
    installLayoutMedia(false); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await screen.findByRole('navigation', { name: 'Live TV search scope' });
    await user.click(screen.getByRole('button', { name: 'On now' }));
    await user.type(screen.getByRole('searchbox'), 'news');
    const result = await screen.findByRole('button', { name: /Morning report/ });
    await user.click(result);
    expect(screen.getByRole('searchbox')).toHaveValue('news');
    expect(result).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: /Back to search results/ }));
    expect(screen.getByRole('button', { name: /Morning report/ })).toBe(result);
    expect(screen.getByLabelText('Program guide for World News')).not.toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
  });
  it.each([false, true])('opens Search playback and restores results without a trailing player (mobile: %s)', async (mobile) => {
    installLayoutMedia(mobile);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await screen.findByRole('navigation', { name: 'Live TV search scope' });
    await user.click(screen.getByRole('button', { name: 'On now' }));
    await user.type(screen.getByRole('searchbox'), 'news');
    await user.click(await screen.findByRole('button', { name: 'Watch Live', exact: true }));
    expect(screen.getByRole('searchbox')).toHaveValue('news');
    expect(screen.queryByRole('button', { name: /Morning report/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Live playback', exact: true })).toHaveFocus();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Morning report/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
    expect(screen.getByTestId('live-player')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Back to search results/ }));
    expect(screen.getByRole('button', { name: /Morning report/ })).toBeInTheDocument();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('news');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: window.scrollY, behavior: 'instant' });
    expect(screen.getByRole('button', { name: /Morning report/ }).closest('[tabindex="-1"]')).toHaveFocus();
  });

  it('reopens retained results from Search, scope changes, or query edits', async () => {
    installLayoutMedia(false); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Channels', exact: true }));
    const search = screen.getByRole('searchbox');
    await user.type(search, 'sports');
    const result = await screen.findByRole('button', { name: /Sports Plus.*Channel 8/ });
    await user.click(result);
    await user.click(screen.getByRole('button', { name: 'Search', exact: true }));
    expect(result).toBeVisible();
    expect(search).toHaveValue('sports');
    await user.click(result);
    await user.click(screen.getByRole('button', { name: 'All', exact: true }));
    expect(result).toBeVisible();
    await user.click(result);
    await user.type(search, ' plus');
    expect(screen.queryByRole('button', { name: /Back to search results/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Sports Plus.*Channel 8/ })).toBeVisible();
    expect(search).toHaveValue('sports plus');
  });

  it('clears Live search immediately, restores all channels, and returns focus without fetching', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI();
    const user = userEvent.setup();
    renderViewer();
    await screen.findByRole('option', { name: /World News/ });
    expect(screen.queryByRole('button', { name: 'Clear Live TV search' })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search Live TV' });
    await user.type(search, 'sports');
    await waitFor(() => expect(screen.queryByRole('option', { name: /World News/ })).not.toBeInTheDocument());
    const requests = fetchMock.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Clear Live TV search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear Live TV search' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /World News/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(requests);
  });

  it.each([['Movies', '/api/movies'], ['Series', '/api/series']])('clears %s search and preserves the Live query', async (section, endpoint) => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI();
    const user = userEvent.setup();
    renderViewer();
    await screen.findByRole('option', { name: /World News/ });
    await user.type(screen.getByRole('searchbox'), 'news');
    await chooseSection(user, section);
    await user.click(await screen.findByRole('button', { name: /All Titles A–Z/ }));
    const search = screen.getByRole('searchbox', { name: `Search ${section}` });
    await user.type(search, 'space');
    await waitFor(() => expect(catalogSearches(fetchMock, endpoint)).toContain('space'));
    const count = catalogSearches(fetchMock, endpoint).length;
    await user.click(screen.getByRole('button', { name: `Clear ${section} search` }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await waitFor(() => expect(catalogSearches(fetchMock, endpoint).length).toBeGreaterThan(count));
    expect(catalogSearches(fetchMock, endpoint).at(-1)).toBeNull();
    await chooseSection(user, 'Live TV');
    expect(screen.getByRole('searchbox')).toHaveValue('news');
  });

  it('types into Live TV search without retaining the change event', async () => {
    installLayoutMedia(false);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    await screen.findByRole('option', { name: /World News/ });
    const search = screen.getByRole('searchbox', { name: 'Search Live TV' });
    await user.type(search, 'sports');

    expect(search).toHaveValue('sports');
    expect(screen.getByRole('option', { name: /Sports Plus/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('option', { name: /World News/ })).not.toBeInTheDocument());
  });

  it('debounces Movies search and requests the typed catalog query', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    await chooseSection(user, 'Movies');
    const search = screen.getByRole('searchbox', { name: 'Search Movies' });
    await user.type(search, 'space');

    expect(search).toHaveValue('space');
    expect(catalogSearches(fetchMock, '/api/movies')).not.toContain('space');
    await waitFor(() => expect(catalogSearches(fetchMock, '/api/movies')).toContain('space'));
  });

  it('debounces Series search and requests the typed catalog query', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI();
    const user = userEvent.setup();
    renderViewer();

    await chooseSection(user, 'Series');
    const search = screen.getByRole('searchbox', { name: 'Search Series' });
    await user.type(search, 'drama');

    expect(search).toHaveValue('drama');
    expect(catalogSearches(fetchMock, '/api/series')).not.toContain('drama');
    await waitFor(() => expect(catalogSearches(fetchMock, '/api/series')).toContain('drama'));
  });
});


describe('Live search and guide lifecycle', () => {
  it('searches numbers, trims spaces, retains the Live query, and makes no query requests', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI();
    const user = userEvent.setup();
    renderViewer();
    await screen.findByRole('option', { name: /World News/ });
    await screen.findByRole('heading', { name: 'News Now' });
    const before = fetchMock.mock.calls.length;
    await user.type(screen.getByRole('searchbox'), '  8  ');
    await waitFor(() => expect(screen.queryByRole('option', { name: /World News/ })).not.toBeInTheDocument());
    expect(screen.getByRole('option', { name: /Sports Plus/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
    await chooseSection(user, 'Movies');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    await chooseSection(user, 'Live TV');
    expect(screen.getByRole('searchbox')).toHaveValue('  8  ');
    await user.clear(screen.getByRole('searchbox'));
    await screen.findByRole('option', { name: /World News/ });
  });

  it('browses a different channel without interrupting playback or autoplaying', async () => {
    installLayoutMedia(false);
    installViewerAPI();
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Watch Live' }));
    const player = screen.getByTestId('live-player');
    await user.click(screen.getByRole('option', { name: /Sports Plus/ }));
    expect(screen.getByTestId('live-player')).toBe(player);
    expect(player).toHaveTextContent('Playing World News');
    await screen.findByText('Live Match');
    await user.click(screen.getByRole('button', { name: 'Watch Live' }));
    expect(player).toHaveTextContent('Playing Sports Plus');
  });

  it('refreshes only the selected guide at its boundary and fences old selections', async () => {
    vi.useFakeTimers();
    try {
      installLayoutMedia(false);
      let oldResolve;
      let count = 0;
      const base = Date.now();
      const fetchMock = vi.fn((input) => {
        const path = String(input);
        if (path.includes('/categories')) return jsonResponse([]);
        if (!path.includes('/epg')) return jsonResponse([{ id: '1', name: 'First' }, { id: '2', name: 'Second' }]);
        if (path.includes('/1/')) return new Promise((resolve) => { oldResolve = resolve; });
        count += 1;
        return jsonResponse({ current: { title: count === 1 ? 'Before boundary' : 'After boundary', start: new Date(base - 1000), end: new Date(base + (count === 1 ? 2000 : 600000)) } });
      });
      vi.stubGlobal('fetch', fetchMock);
      renderViewer();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('option', { name: 'Second' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Before boundary')).toBeInTheDocument();
      await act(async () => { oldResolve(await jsonResponse({ current: { title: 'Wrong channel' } })); });
      expect(screen.queryByText('Wrong channel')).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(screen.getByText('After boundary')).toBeInTheDocument();
      expect(count).toBe(2);
      expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('/1/epg'))).toHaveLength(1);
    } finally { cleanup(); vi.useRealTimers(); }
  });
});

it('places Guide next to Browse/Search and preserves playback and browse selection', async () => {
  installLayoutMedia(false);
  const fetchMock = installViewerAPI(true, true);
  renderViewer();
  await screen.findByRole('button', { name: 'Guide', exact: true });
  await userEvent.click(await screen.findByRole('button', { name: 'Watch Live', exact: true }));
  const player = await screen.findByTestId('live-player');
  const details = screen.getByRole('button', { name: 'Details', exact: true });
  expect(details.previousElementSibling).toBe(screen.getByRole('heading', { name: 'World News', exact: true }));
  expect(details.closest('.live-focus-navigation')).toBeNull();
  expect(document.querySelector('.live-focus-navigation').querySelectorAll('button')).toHaveLength(1);
  await userEvent.click(details);
  expect(screen.getByRole('dialog', { name: 'Playback details' })).toHaveTextContent('News Now');
  expect(screen.getByTestId('live-player')).toBe(player);
  await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  expect(details).toHaveFocus();
  expect(screen.getByTestId('live-player')).toBe(player);
  await userEvent.click(screen.getByRole('button', { name: 'Guide', exact: true }));
  expect(await screen.findByRole('region', { name: 'TV Guide' })).toBeVisible();
  expect(screen.getByTestId('live-player')).toBe(player);
  expect(screen.getByRole('button', { name: 'Guide', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Browse', exact: true }));
  expect(screen.getByTestId('live-player')).toBe(player);
  await userEvent.click(screen.getByRole('button', { name: /Back to browsing/ }));
  expect(screen.getByTestId('live-player')).toBe(player);
  await userEvent.click(within(screen.getByRole('region', { name: 'Selected channel: World News' })).getByRole('button', { name: 'View in Guide' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/api/live/guide?') && String(path).includes('channel_id=41'))).toBe(true));
});

it('preserves Search playback entering Guide with an empty Browse group', async () => {
  installLayoutMedia(false);
  const fetchMock = installViewerAPI(true, true);
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input, ...args) => String(input) === '/api/live/categories'
    ? jsonResponse([{ id: '2', name: 'News' }, { id: 'empty', name: 'Empty group' }])
    : original(input, ...args));
  renderViewer();
  await screen.findByRole('button', { name: 'Guide', exact: true });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'empty');
  await userEvent.click(screen.getByRole('button', { name: 'Search', exact: true }));
  await userEvent.type(screen.getByRole('searchbox'), 'World');
  await userEvent.click(await screen.findByRole('button', { name: 'Watch Live', exact: true }));
  const player = await screen.findByTestId('live-player');
  await userEvent.click(screen.getByRole('button', { name: 'Guide', exact: true }));
  expect(screen.queryByTestId('live-player')).toBe(player);
});

it.each([false, true])('opens dedicated Guide playback and restores the schedule (mobile: %s)', async (mobile) => {
  installLayoutMedia(mobile);
  const fetchMock = installViewerAPI(true, true);
  const scroll = vi.fn();
  const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const scrollWindow = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  try {
    renderViewer();
    await userEvent.click(await screen.findByRole('button', { name: 'Guide', exact: true }));
    const guide = await screen.findByRole('region', { name: 'TV Guide' });
    const logo = await within(guide).findByRole('button', { name: 'Options for World News', exact: true });
    const grid = within(guide).getByRole('region', { name: /Schedule grid/ });
    grid.scrollLeft = 125; grid.scrollTop = 80;
    const guideCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/live/guide?')).length;
    const before = guideCalls();
    await userEvent.click(logo);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Watch Live', exact: true }));
    expect(guide).not.toBeVisible();
    expect(screen.getByTestId('live-player')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Live playback' })).toHaveFocus();
    const player = screen.getByTestId('live-player');
    const details = screen.getByRole('button', { name: 'Details', exact: true });
    expect(details.previousElementSibling).toBe(screen.getByRole('heading', { name: 'World News', exact: true }));
    expect(details.closest('.channel-identity')).toBe(screen.getByRole('region', { name: 'Selected channel: World News' }));
    await userEvent.click(details);
    expect(screen.getByRole('dialog', { name: 'Playback details' })).toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toBe(player);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(details).toHaveFocus();
    expect(screen.getByTestId('live-player')).toBe(player);
    expect(screen.getByRole('button', { name: /Back to Guide/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Back to Guide/ }));
    expect(guide).toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(grid.scrollLeft).toBe(125); expect(grid.scrollTop).toBe(80);
    expect(guideCalls()).toBe(before);
    expect(scrollWindow).toHaveBeenCalled();
    await userEvent.click(logo);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Watch Live', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    expect(guide).not.toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to Guide/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
    expect(screen.getByTestId('live-player')).toBeVisible();
    expect(guide).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Back to Guide/ }));
    expect(guide).toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
  } finally {
    if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
    else delete HTMLElement.prototype.scrollIntoView;
    scrollWindow.mockRestore();
  }
});

describe('ViewerShell selected airing details', () => {
  it.each([false, true])('merges the selected current airing into Now (mobile: %s)', async (mobile) => {
    installLayoutMedia(mobile);
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    const start = new Date(Date.now() - 60000).toISOString();
    const end = new Date(Date.now() + 60000).toISOString();
    const program = { title: 'Morning report', start, end };
    fetchMock.mockImplementation((input) => {
      const path = String(input);
      if (path.startsWith('/api/live/programs/search?')) return jsonResponse({ items: [{ ...program, id: 'search1', subtitle: 'Special report', description: 'The selected programme description.', channel: { id: '41', name: 'World News' } }], total: 1, page: 1, page_size: 20 });
      if (path.startsWith('/api/live/channels/41/epg')) return jsonResponse({ current: program });
      return original(input);
    });
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await screen.findByRole('navigation', { name: 'Live TV search scope' });
    await user.click(screen.getByRole('button', { name: 'On now' }));
    await user.type(screen.getByRole('searchbox'), 'news');
    await user.click(await screen.findByRole('button', { name: /Morning report/ }));
    const detail = screen.getByRole('region', { name: 'Program guide for World News' });
    await waitFor(() => expect(within(detail).getAllByRole('heading', { name: 'Morning report' })).toHaveLength(1));
    expect(within(detail).queryByText('Selected airing')).not.toBeInTheDocument();
    expect(within(detail).getByText('Now')).toBeInTheDocument();
    expect(within(detail).getByText('Special report')).toBeInTheDocument();
    expect(within(detail).getByText('The selected programme description.')).toBeInTheDocument();
  });
  it('keeps a future selection distinct from what is on now', async () => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input) => String(input).startsWith('/api/live/programs/search?')
      ? jsonResponse({ items: [{ id: 'future1', title: 'Morning report', start: new Date(Date.now() + 3600000), end: new Date(Date.now() + 7200000), channel: { id: '41', name: 'World News' } }], total: 1, page: 1, page_size: 20 }) : original(input));
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await screen.findByRole('navigation', { name: 'Live TV search scope' });
    await user.click(screen.getByRole('button', { name: 'Upcoming' }));
    await user.type(screen.getByRole('searchbox'), 'news');
    await user.click(await screen.findByRole('button', { name: /Morning report/ }));
    const detail = screen.getByRole('region', { name: 'Program guide for World News' });
    expect(await within(detail).findByText('Upcoming selection')).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'Morning report' })).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'News Now' })).toBeInTheDocument();
  });
});


describe('Search VLC dropdown integration', () => {
  const launchURL = '/api/vlc/launch/' + 'a'.repeat(43);
  const enterCurrentSearch = async (user) => {
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await user.click(screen.getByRole('button', { name: 'On now', exact: true }));
    await user.type(screen.getByRole('searchbox', { name: 'Search Live TV' }), 'news');
    await within(screen.getByRole('region', { name: 'On now search results' })).findByRole('button', { name: /Morning report/ });
  };
  const chooseSearchVLC = async (user) => {
    const current = screen.getByRole('region', { name: 'On now search results' });
    await user.click(within(current).getByRole('button', { name: 'Watch options' }));
    await user.click(within(current).getByRole('menuitem', { name: 'Watch in VLC' }));
  };

  it.each([false, true])('opens VLC for the search result after changing from another Browse channel (mobile: %s)', async (mobile) => {
    installLayoutMedia(mobile);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, ...args) => String(input) === '/api/live/channels/41/vlc'
      ? jsonResponse({ launch_url: launchURL }) : original(input, ...args));
    openVLC.mockImplementation(() => {
      expect(screen.getByRole('button', { name: /Back to search results/ })).toBeVisible();
      expect(screen.getByRole('region', { name: 'Program guide for World News' })).toBeVisible();
      expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
      return 'playlist';
    });
    const user = userEvent.setup();
    try {
      renderViewer();
      await screen.findByRole('navigation', { name: 'Browse or search' });
      await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), '3');
      await screen.findByRole('heading', { name: 'Live Match' });
      await user.click(screen.getByRole('button', { name: 'Watch Live', exact: true }));
      const oldPlayer = screen.getByTestId('live-player');
      expect(oldPlayer).toHaveTextContent('Playing Sports Plus');
      await enterCurrentSearch(user);
      expect(screen.getByTestId('live-player')).toBe(oldPlayer);

      await chooseSearchVLC(user);
      await waitFor(() => expect(openVLC).toHaveBeenCalledWith(launchURL, 'World News'));
      const requests = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/vlc'));
      expect(requests).toHaveLength(1);
      expect(requests[0][0]).toBe('/api/live/channels/41/vlc');
      expect(requests[0][1].method).toBe('POST');
      expect(requests[0][1].headers.get('X-CSRF-Token')).toBe('csrf-token');
      expect(requests[0][1].signal.aborted).toBe(false);
      expect(screen.getByText('Ready to watch in VLC')).toBeVisible();
      expect(screen.getByRole('searchbox', { name: 'Search Live TV' })).toHaveValue('news');
      expect(oldPlayer).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Back to search results/ }));
      expect(screen.queryByText('Ready to watch in VLC')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Morning report/ })).toBeVisible();
      expect(screen.getByRole('searchbox', { name: 'Search Live TV' })).toHaveValue('news');
      expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    } finally { scrollTo.mockRestore(); }
  });

  it.each(['Back to results', 'query edit', 'section change'])('aborts a pending Search VLC request on %s and ignores its late response', async (exit) => {
    installLayoutMedia(false);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    let resolveVLC;
    let requestOptions;
    fetchMock.mockImplementation((input, options, ...args) => {
      if (String(input) === '/api/live/channels/41/vlc') {
        requestOptions = options;
        return new Promise(resolve => { resolveVLC = resolve; });
      }
      return original(input, options, ...args);
    });
    openVLC.mockReturnValue('playlist');
    const user = userEvent.setup();
    try {
      renderViewer();
      await enterCurrentSearch(user);
      await chooseSearchVLC(user);
      expect(requestOptions.signal.aborted).toBe(false);
      expect(screen.getByRole('button', { name: /Back to search results/ })).toBeVisible();
      if (exit === 'Back to results') await user.click(screen.getByRole('button', { name: /Back to search results/ }));
      else if (exit === 'query edit') await user.type(screen.getByRole('searchbox', { name: 'Search Live TV' }), ' sports');
      else await chooseSection(user, 'Movies');

      expect(requestOptions.signal.aborted).toBe(true);
      await act(async () => resolveVLC(await jsonResponse({ launch_url: launchURL })));
      expect(openVLC).not.toHaveBeenCalled();
      expect(screen.queryByText('Ready to watch in VLC')).not.toBeInTheDocument();
      if (exit === 'Back to results') {
        expect(screen.getByRole('button', { name: /Morning report/ })).toBeVisible();
        expect(screen.getByRole('searchbox', { name: 'Search Live TV' })).toHaveValue('news');
      }
    } finally { scrollTo.mockRestore(); }
  });
});


describe('Search Record menu focus', () => {
  it.each(['Cancel', 'Escape'])('returns keyboard focus to the same card after %s without creating a recording', async (dismissal) => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    const airing = {
      id: 'search-focus-airing', title: 'Specific search airing',
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() + 3600000).toISOString(),
      channel: { id: '41', name: 'World News', channel_number: '7' },
    };
    fetchMock.mockImplementation((input, ...args) => {
      const path = String(input);
      if (path === '/api/live/search/capabilities') return jsonResponse({ program_search: true, dvr: true, guide: false });
      if (path === '/api/dvr/connection') return jsonResponse({ connected: true, access: 'manage', managed: true });
      if (path === '/api/dvr/recordings' || /^\/api\/live\/channels\/[0-9]+\/recordings$/.test(path)) {
        return jsonResponse({ items: [], access: 'manage' });
      }
      if (path.startsWith('/api/live/programs/search?')) return jsonResponse({ items: [airing], total: 1 });
      return original(input, ...args);
    });
    const user = userEvent.setup();
    renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await user.click(screen.getByRole('button', { name: 'On now', exact: true }));
    await user.type(screen.getByRole('searchbox', { name: 'Search Live TV' }), 'specific');
    const current = screen.getByRole('region', { name: 'On now search results' });
    const result = await within(current).findByRole('button', { name: /Specific search airing/ });
    const trigger = within(result.closest('article')).getByRole('button', { name: 'Watch options' });
    act(() => trigger.focus());
    await user.keyboard('{Enter}');
    await within(current).findByRole('menuitem', { name: 'Watch & Record' });
    expect(screen.getByRole('menuitem', { name: 'Watch & Record' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Record', exact: true })).toHaveFocus();
    await user.keyboard('{Enter}');

    const dialog = screen.getByRole('dialog', { name: 'Record this airing?' });
    expect(within(dialog).getByRole('heading', { name: airing.title })).toBeInTheDocument();
    expect(within(dialog).getByText(airing.channel.name)).toBeInTheDocument();
    expect(within(dialog).getByText(airingTime(airing))).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Confirm recording' })).toHaveFocus();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    if (dismissal === 'Escape') await user.keyboard('{Escape}');
    else {
      await user.keyboard('{Tab}');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await user.keyboard('{Enter}');
    }

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(result).toBeVisible();
    expect(fetchMock.mock.calls.filter(([input, options]) => String(input).endsWith('/recordings') && options?.method === 'POST')).toHaveLength(0);
    expect(openVLC).not.toHaveBeenCalled();
  });
});

describe('DVR navigation refresh', () => {
  const recorded = (id, title) => ({
    id, title, status: 'recorded', playable: true,
    start: new Date(Date.now() - 3600000).toISOString(),
    end: new Date(Date.now() - 60000).toISOString(),
    channel: { id: '41', name: 'World News' },
  });
  const installDVR = (recordings) => {
    installLayoutMedia(false);
    const fetchMock = installViewerAPI(true);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, options, ...args) => {
      const path = String(input);
      if (path === '/api/live/search/capabilities') return jsonResponse({ program_search: true, dvr: true, guide: false });
      if (path === '/api/dvr/connection') return jsonResponse({ connected: true, access: 'manage', managed: true });
      if (path === '/api/dvr/recordings') return recordings(options);
      if (/^\/api\/live\/channels\/[0-9]+\/recordings$/.test(path)) return jsonResponse({ items: [], access: 'manage' });
      return original(input, options, ...args);
    });
    return fetchMock;
  };
  const listCalls = (fetchMock) => fetchMock.mock.calls.filter(([input]) => String(input) === '/api/dvr/recordings');

  it('refreshes externally changed recordings on entry, repeated DVR selection, and return from Live TV', async () => {
    let items = [recorded('1', 'Original recording')];
    const fetchMock = installDVR(() => jsonResponse({ items, access: 'manage' }));
    const user = userEvent.setup(); renderViewer();
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(1));
    items = [recorded('2', 'Recorded elsewhere')];
    await chooseSection(user, 'DVR');
    await screen.findByRole('heading', { name: 'Recorded elsewhere' });
    expect(listCalls(fetchMock)).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Original recording' })).not.toBeInTheDocument();

    items = [recorded('3', 'Updated again')];
    await chooseSection(user, 'DVR');
    await screen.findByRole('heading', { name: 'Updated again' });
    expect(listCalls(fetchMock)).toHaveLength(3);
    await chooseSection(user, 'Live TV');
    items = [recorded('4', 'Fresh after returning')];
    await chooseSection(user, 'DVR');
    await screen.findByRole('heading', { name: 'Fresh after returning' });
    expect(listCalls(fetchMock)).toHaveLength(4);
  });

  it('aborts an older refresh and ignores its late response after navigating back to DVR', async () => {
    let resolveStale, staleSignal;
    let requests = 0;
    const fetchMock = installDVR((options) => {
      requests += 1;
      if (requests === 2) {
        staleSignal = options.signal;
        return new Promise(resolve => { resolveStale = resolve; });
      }
      return jsonResponse({ items: [recorded(String(requests), requests === 1 ? 'Initial recording' : 'Current recording')], access: 'manage' });
    });
    const user = userEvent.setup(); renderViewer();
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(1));
    await chooseSection(user, 'DVR');
    await waitFor(() => expect(staleSignal).toBeDefined());
    await chooseSection(user, 'Live TV');
    await chooseSection(user, 'DVR');
    await screen.findByRole('heading', { name: 'Current recording' });
    expect(staleSignal.aborted).toBe(true);
    await act(async () => resolveStale(await jsonResponse({ items: [recorded('99', 'Stale recording')], access: 'manage' })));
    expect(screen.queryByRole('heading', { name: 'Stale recording' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Current recording' })).toBeInTheDocument();
  });

  it('refreshes on return from playback without resetting the player while it is open', async () => {
    let items = [recorded('1', 'Playing recording')];
    const fetchMock = installDVR(() => jsonResponse({ items, access: 'manage' }));
    const user = userEvent.setup(); renderViewer();
    await waitFor(() => expect(listCalls(fetchMock)).toHaveLength(1));
    await chooseSection(user, 'DVR');
    await screen.findByRole('heading', { name: 'Playing recording' });
    await user.click(screen.getByRole('button', { name: 'Watch', exact: true }));
    const player = screen.getByTestId('native-player');
    items = [...items, recorded('2', 'New during playback')];
    expect(screen.getByTestId('native-player')).toBe(player);
    expect(listCalls(fetchMock)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    await screen.findByRole('heading', { name: 'New during playback' });
    expect(listCalls(fetchMock)).toHaveLength(3);
  });
});
