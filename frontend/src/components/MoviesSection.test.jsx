import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

vi.mock('./NativeVideoPlayer', () => ({
  default: ({ label, onFatalError, source }) => (
    <div data-source={source} data-testid="native-player">
      {label} player
      <button onClick={() => onFatalError('Browser format error')} type="button">Fail playback</button>
    </div>
  ),
}));

const vlcMocks = vi.hoisted(() => ({
  VLC_APP_STORE_URL: 'https://apps.apple.com/us/app/vlc-media-player/id650377962',
  isAppleMobile: vi.fn(() => false),
  openVLC: vi.fn(() => 'playlist'),
}));
vi.mock('./vlc', () => vlcMocks);

import MoviesSection from './MoviesSection';

const jsonResponse = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

const Harness = ({ search = '' }) => {
  const [browse, setBrowse] = useState(null);
  return <MoviesSection
    browseSelection={browse}
    categories={[{ id: '1', name: 'Action' }]}
    onBrowseSelectionChange={setBrowse}
    onCategoriesLoaded={vi.fn()}
    onExpired={vi.fn()}
    search={search}
    session={{ csrf_token: 'csrf' }}
  />;
};

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('MoviesSection viewer flow', () => {
  it('shows a centered desktop VLC handoff and downloads a fresh playlist on retry', async () => {
    const fetchMock = vi.fn((input) => {
      const pathname = new URL(String(input), 'https://now.test').pathname;
      if (pathname === '/api/movies') return jsonResponse({ items: [{ id: '7', name: 'Space Movie' }], total: 1 });
      if (pathname === '/api/movies/7') return jsonResponse({ id: '7', name: 'Space Movie' });
      if (pathname === '/api/movies/7/vlc') return jsonResponse({ launch_url: `/api/vlc/launch/${'A'.repeat(43)}/Space-Movie.mkv` }, 201);
      throw new Error(`Unexpected fetch ${pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<Harness search="space" />);
    await user.click(await screen.findByRole('button', { name: /Space Movie/ }));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));

    expect(await screen.findByText('Ready to watch in VLC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Space Movie' })).toBeInTheDocument();
    expect(screen.getByText('Open the downloaded playlist in VLC right away. Its link expires shortly.')).toBeInTheDocument();
    expect(screen.getByText(/If too much time has passed/)).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Selected movie: Space Movie' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch in VLC again' }));
    await waitFor(() => expect(vlcMocks.openVLC).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.filter(([input]) => new URL(String(input), 'https://now.test').pathname === '/api/movies/7/vlc')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Back to details' }));
    expect(screen.getByRole('article', { name: 'Selected movie: Space Movie' })).toBeInTheDocument();
  });
  it('shows placeholders for missing list posters without background detail and keeps known list posters', async () => {
    const fetchMock = vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/movies') return jsonResponse({
        items: [
          { id: '298526', name: '001 Trolling - 2017', has_artwork: false },
          { id: '2', name: 'No poster movie', has_artwork: false },
          { id: '3', name: 'Known poster movie', has_artwork: true },
        ], total: 3,
      });
      if (url.pathname === '/api/movies/298526') return jsonResponse({ id: '298526', name: '001 Trolling - 2017', has_artwork: true });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<Harness search="movie" />);
    expect(await screen.findByLabelText('001 Trolling - 2017 artwork unavailable')).toHaveTextContent('No artwork');
    expect(screen.getByLabelText('No poster movie artwork unavailable')).toHaveTextContent('No artwork');
    expect(screen.getByRole('img', { name: 'Known poster movie poster' })).toHaveAttribute('src', '/api/movies/3/artwork');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url), 'https://now.test').pathname))
      .toEqual(['/api/movies']);
    expect(screen.queryByRole('article', { name: /Selected movie/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /001 Trolling - 2017/ }));
    expect(await screen.findByRole('img', { name: '001 Trolling - 2017 poster' })).toHaveAttribute('src', '/api/movies/298526/artwork');
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url), 'https://now.test').pathname))
      .toEqual(['/api/movies', '/api/movies/298526']);
  });

  it.each(['search', 'page'])('changes %s without requesting missing-poster details', async (change) => {
    const fetchMock = vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/movies') return jsonResponse({
        items: [{ id: `${url.searchParams.get('search') || 'old'}-${url.searchParams.get('page') || '1'}`, name: 'Missing poster', has_artwork: false }], total: 40,
      });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<Harness search="old" />);
    expect(await screen.findByLabelText('Missing poster artwork unavailable')).toHaveTextContent('No artwork');
    if (change === 'search') view.rerender(<Harness search="new" />);
    else await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url), 'https://now.test').pathname === '/api/movies')).toBe(true);
  });

  it('moves from category-first browsing through search, detail, playback failure, and back', async () => {
    const fetchMock = vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/movies/7') return jsonResponse({
        id: '7', name: 'Space Movie', year: 2025, rating: 8, genre: 'Sci-Fi', description: 'A safe detail.',
        stream_info: { container: 'MP4', video_codec: 'H.264', audio_codec: 'AAC', resolution: '1080p' },
      });
      if (url.pathname === '/api/movies') {
        const searched = url.searchParams.get('search') === 'space';
        return jsonResponse({
          items: searched ? [{ id: '7', name: 'Space Movie', year: 2025 }] : [{ id: '6', name: 'Action Movie', year: 2024 }],
          total: 1, page: 1, page_size: 20,
        });
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const view = render(<Harness />);

    expect(screen.getByRole('region', { name: 'Movies categories' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Movies' })).toHaveClass('sr-only');
    expect(screen.queryByRole('button', { name: /Filter/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /All Titles A–Z/ }));
    expect(await screen.findByRole('button', { name: /Action Movie/ })).toBeInTheDocument();
    expect(new URL(String(fetchMock.mock.calls[0][0]), 'https://now.test').searchParams.get('page_size')).toBe('20');

    view.rerender(<Harness search="space" />);
    expect(await screen.findByRole('button', { name: /Space Movie/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Space Movie/ }));
    expect(await screen.findByText('A safe detail.')).toBeInTheDocument();
    const selectedView = screen.getByRole('region', { name: 'Space Movie' });
    const watchArea = screen.getByRole('region', { name: 'Playback controls for Space Movie' });
    const detailCard = screen.getByRole('article', { name: 'Selected movie: Space Movie' });
    expect(selectedView).toHaveFocus();
    expect(screen.getAllByRole('heading', { name: 'Space Movie' })).toHaveLength(1);
    expect(watchArea.nextElementSibling).toBe(detailCard);
    expect(screen.queryByText('Likely plays in browser')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/1080p.*H\.264.*AAC.*MP4/);
    expect(screen.queryByRole('button', { name: 'Check compatibility' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    const player = screen.getByTestId('native-player');
    expect(player).toHaveAttribute('data-source', '/api/movies/7/stream');
    expect(watchArea.nextElementSibling).toBe(player);
    expect(player.nextElementSibling).toBe(detailCard);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    expect(watchArea.nextElementSibling).toBe(detailCard);
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    await user.click(screen.getByRole('button', { name: 'Fail playback' }));
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Browser format error');
    expect(detailCard).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/1080p.*H\.264.*AAC.*MP4/);
    expect(screen.getByRole('button', { name: 'Watch' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '← Back to search results' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Space Movie/ })).toBeInTheDocument());
  });

  it('focuses and immediately reveals the selected detail top without waiting for detail loading', async () => {
    const scrollIntoView = vi.fn();
    let finishDetail;
    const detailSignals = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal('fetch', vi.fn((input, options) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/movies') return jsonResponse({ items: [{ id: '7', name: 'Slow Movie' }], total: 1 });
      if (url.pathname === '/api/movies/7') {
        detailSignals.push(options.signal);
        return new Promise((resolve) => { finishDetail = resolve; });
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();

    try {
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: /All Titles/ }));
      await user.click(await screen.findByRole('button', { name: /Slow Movie/ }));

      const selectedView = screen.getByRole('region', { name: 'Slow Movie' });
      expect(detailSignals).toHaveLength(1);
      expect(detailSignals[0].aborted).toBe(false);
      expect(selectedView).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
      expect(screen.getByText(/Loading details/)).toBeInTheDocument();
      expect(screen.getByText('Request in progress.')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Watch' }));
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(screen.getByTestId('native-player')).toHaveAttribute('data-source', '/api/movies/7/stream');
      await act(async () => finishDetail(await jsonResponse({ id: '7', name: 'Slow Movie', plot: 'Details are ready.' })));
      expect(await screen.findByText('Details are ready.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(screen.queryByText(/Loading details/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Request in progress/)).not.toBeInTheDocument();
    } finally {
      if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      else delete HTMLElement.prototype.scrollIntoView;
    }
  });

  it('ignores a stale non-aborting catalog response after search changes', async () => {
    const pending = [];
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname !== '/api/movies') throw new Error(`Unexpected fetch ${url.pathname}`);
      return new Promise((resolve) => pending.push({ query: url.searchParams.get('search'), resolve }));
    }));
    const user = userEvent.setup();
    const view = render(<Harness />);
	await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await waitFor(() => expect(pending).toHaveLength(1));
    view.rerender(<Harness search="new" />);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve(new Response(JSON.stringify({ items: [{ id: '2', name: 'New result' }], total: 1 }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await screen.findByRole('button', { name: /New result/ })).toBeInTheDocument();
    pending[0].resolve(new Response(JSON.stringify({ items: [{ id: '1', name: 'Stale result' }], total: 1 }), { headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Stale result/ })).not.toBeInTheDocument());
  });

  it('requests deterministic catalog pages through Next and Previous', async () => {
    const requestedPages = [];
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname !== '/api/movies') throw new Error(`Unexpected fetch ${url.pathname}`);
      const page = Number(url.searchParams.get('page'));
      requestedPages.push(page);
      return jsonResponse({
        items: [{ id: String(page), name: page === 1 ? 'First page movie' : 'Second page movie' }],
        total: 21,
        page,
        page_size: 20,
      });
    }));
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    expect(await screen.findByRole('button', { name: /First page movie/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: /Second page movie/ })).toBeInTheDocument();
    expect(requestedPages).toEqual([1, 2]);

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByRole('button', { name: /First page movie/ })).toBeInTheDocument();
    expect(requestedPages).toEqual([1, 2, 1]);
  });

  it('aborts an in-flight detail request when returning to results', async () => {
    let detailSignal;
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/movies') return jsonResponse({ items: [{ id: '7', name: 'Movie', has_artwork: true }], total: 1 });
      if (url.pathname === '/api/movies/7') {
        detailSignal = options.signal;
        return new Promise(() => {});
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await user.click(await screen.findByRole('button', { name: /Movie/ }));
    expect(detailSignal?.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: /Back to Movies/ }));
    expect(detailSignal.aborted).toBe(true);
    expect(screen.queryByText(/Request in progress/)).not.toBeInTheDocument();
  });
});
