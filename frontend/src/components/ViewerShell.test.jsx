import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./LivePlayer', () => ({
  default: ({ channel }) => <div data-testid="live-player">Playing {channel.name}</div>,
}));
vi.mock('./NativeVideoPlayer', () => ({
  default: ({ source }) => <div data-source={source} data-testid="native-player" />,
}));

import ViewerShell, { PHONE_LAYOUT_QUERY } from './ViewerShell';

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
  window.localStorage.removeItem('dispatcharr-now-appearance');
  delete document.documentElement.dataset.theme;
});

describe('ViewerShell header menu', () => {
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
    expect(screen.getByRole('region', { name: 'Program guide for World News' })).toBeInTheDocument();
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
    expect(screen.getByTestId('live-player')).toBe(player);
    await user.click(result);
    expect(result).not.toBeVisible();
    if (mobile) expect(detail).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Clear Live TV search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.queryByLabelText('Live TV search results')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toHaveTextContent('Playing Sports Plus');
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
    expect(screen.getByRole('region', { name: 'Program guide for World News' })).toBeInTheDocument();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
  });
  it('starts playback only when Watch Now is explicitly chosen', async () => {
    installLayoutMedia(false); installViewerAPI(true);
    const user = userEvent.setup(); renderViewer();
    await user.click(await screen.findByRole('button', { name: 'Search', exact: true }));
    await screen.findByRole('navigation', { name: 'Live TV search scope' });
    await user.click(screen.getByRole('button', { name: 'On now' }));
    await user.type(screen.getByRole('searchbox'), 'news');
    await user.click(await screen.findByRole('button', { name: 'Watch Now' }));
    expect(screen.getByRole('searchbox')).toHaveValue('news');
    expect(screen.queryByRole('button', { name: /Morning report/ })).not.toBeInTheDocument();
    const player = screen.getByTestId('live-player');
    await user.click(screen.getByRole('button', { name: /Back to search results/ }));
    expect(screen.getByRole('button', { name: /Morning report/ })).toBeInTheDocument();
    expect(screen.getByTestId('live-player')).toBe(player);
    expect(player).toHaveTextContent('Playing World News');
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
  await userEvent.click(screen.getByRole('button', { name: 'Guide', exact: true }));
  expect(await screen.findByRole('region', { name: 'TV Guide' })).toBeVisible();
  expect(screen.getByTestId('live-player')).toBe(player);
  expect(screen.getByRole('button', { name: 'Guide', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Browse', exact: true }));
  expect(screen.getByTestId('live-player')).toBe(player);
  await userEvent.click(screen.getByRole('button', { name: 'View in Guide' }));
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
  await userEvent.click(await screen.findByRole('button', { name: 'Watch Now', exact: true }));
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
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Watch live', exact: true }));
    expect(guide).not.toBeVisible();
    expect(screen.getByTestId('live-player')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Live playback' })).toHaveFocus();
    expect(screen.getByRole('button', { name: /Back to Guide/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /Back to Guide/ }));
    expect(guide).toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
    expect(grid.scrollLeft).toBe(125); expect(grid.scrollTop).toBe(80);
    expect(guideCalls()).toBe(before);
    expect(scrollWindow).toHaveBeenCalled();
    await userEvent.click(logo);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Watch live', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
    expect(guide).toBeVisible();
    expect(screen.queryByTestId('live-player')).not.toBeInTheDocument();
  } finally {
    if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
    else delete HTMLElement.prototype.scrollIntoView;
    scrollWindow.mockRestore();
  }
});
