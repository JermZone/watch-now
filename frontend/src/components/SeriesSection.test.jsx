import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

const nativePlayerEvents = vi.hoisted(() => []);
vi.mock('./NativeVideoPlayer', async () => {
  const { useEffect } = await import('react');
  return {
    default: ({ label, source }) => {
      useEffect(() => {
        nativePlayerEvents.push(`mount:${source}`);
        return () => nativePlayerEvents.push(`unmount:${source}`);
      }, [source]);
      return <div data-source={source} data-testid="native-player">{label} player</div>;
    },
  };
});

const vlcMocks = vi.hoisted(() => ({
  VLC_APP_STORE_URL: 'https://apps.apple.com/us/app/vlc-media-player/id650377962',
  isAppleMobile: vi.fn(() => true),
  openVLC: vi.fn(),
}));
vi.mock('./vlc', () => vlcMocks);

import SeriesSection, { groupSeriesSeasons } from './SeriesSection';

const jsonResponse = (body) => Promise.resolve(new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
}));
const COMPATIBILITY_STATUS = /^(Likely plays in browser|VLC may work better|Compatibility unknown)$/;

const Harness = ({ search = '' }) => {
  const [browse, setBrowse] = useState(null);
  return <SeriesSection
    browseSelection={browse}
    categories={[{ id: '2', name: 'Drama' }]}
    onBrowseSelectionChange={setBrowse}
    onCategoriesLoaded={vi.fn()}
    onExpired={vi.fn()}
    search={search}
    session={{ csrf_token: 'csrf' }}
  />;
};

afterEach(() => {
  cleanup();
  nativePlayerEvents.length = 0;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vlcMocks.isAppleMobile.mockReturnValue(true);
  vlcMocks.openVLC.mockReset();
  vi.unstubAllGlobals();
});

describe('series episode ordering', () => {
  it('shows the selected series and episode in the desktop VLC handoff', async () => {
    vlcMocks.isAppleMobile.mockReturnValue(false);
    vlcMocks.openVLC.mockReturnValue('playlist');
    vi.stubGlobal('fetch', vi.fn((input) => {
      const pathname = new URL(String(input), 'https://now.test').pathname;
      if (pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Safe Series' }], total: 1 });
      if (pathname === '/api/series/4') return jsonResponse({ id: '4', name: 'Safe Series', seasons: [{ number: 1, episodes: [{ id: '9', episode_number: 1, title: 'Pilot' }] }] });
      if (pathname === '/api/series/4/episodes/9/vlc') return jsonResponse({ launch_url: `/api/vlc/launch/${'A'.repeat(43)}/Safe-Series-Pilot.mp4` });
      throw new Error(`Unexpected fetch ${pathname}`);
    }));
    const user = userEvent.setup();
    render(<Harness search="safe" />);
    await user.click(await screen.findByRole('button', { name: /Safe Series/ }));
    await user.click(await screen.findByRole('button', { name: /Episode 1 · Pilot/ }));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Watch in VLC' }));

    expect(await screen.findByRole('heading', { name: 'Safe Series - Pilot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch in VLC again' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Selected series: Safe Series' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to details' }));
    expect(screen.getByRole('article', { name: 'Selected series: Safe Series' })).toBeInTheDocument();
    expect(screen.getByLabelText('Selected episode: Pilot')).toBeInTheDocument();
  });
  it('puts Specials first, numbered seasons in order, and incomplete seasons last', () => {
    const groups = groupSeriesSeasons({ seasons: [
      { number: 2, episodes: [{ id: 'b', episode_number: 2, title: 'Second' }, { id: 'a', episode_number: 1, title: 'First' }] },
      { name: 'Extras', episodes: [{ id: 'x', title: 'Mystery' }] },
      { number: 0, episodes: [{ id: 's', episode_number: 1, title: 'Special' }] },
      { number: 1, episodes: [] },
    ] });
    expect(groups.map((group) => group.label)).toEqual(['Specials', 'Season 1', 'Season 2', 'Extras']);
    expect(groups[2].episodes.map((episode) => episode.title)).toEqual(['First', 'Second']);
  });

  it('returns from searched series details to the retained search results', async () => {
    const fetchMock = vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Safe Series' }], total: 1 });
      if (url.pathname === '/api/series/4') return jsonResponse({ id: '4', name: 'Safe Series', description: 'Series detail', seasons: [] });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<Harness search="safe" />);
    await user.click(await screen.findByRole('button', { name: /Safe Series/ }));
    expect(await screen.findByText('Series detail')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Back to Series/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Back to search results' }));
    expect(await screen.findByRole('button', { name: /Safe Series/ })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Selected series: Safe Series' })).not.toBeInTheDocument();
    const queries = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'https://now.test')).filter((url) => url.pathname === '/api/series');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((url) => url.searchParams.get('search') === 'safe')).toBe(true);
  });

  it('loads details, selects an episode, watches it, and downloads from the same action menu', async () => {
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Safe Series', year: 2024 }], total: 1, page: 1, page_size: 20 });
      if (url.pathname === '/api/series/4') return jsonResponse({
        id: '4', name: 'Safe Series', description: 'Series detail', seasons: [
          { number: 0, episodes: [{ id: '8', season_number: 0, episode_number: 1, title: 'Holiday' }] },
          { number: 1, episodes: [{
            id: '9', season_number: 1, episode_number: 1, title: 'Pilot', description: 'Episode detail',
            stream_info: { container: 'mp4', video_codec: 'h264', audio_codec: 'aac', height: 1080 },
          }] },
        ],
      });
      if (url.pathname === '/api/series/4/episodes/9/vlc') return jsonResponse({ launch_url: `/api/vlc/launch/${'A'.repeat(43)}` });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.getByRole('heading', { level: 2, name: 'Series' })).toHaveClass('sr-only');
    await user.click(screen.getByRole('button', { name: /All Titles A–Z/ }));
    await user.click(await screen.findByRole('button', { name: /Safe Series/ }));
    expect(await screen.findByText('Series detail')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Selected series: Safe Series' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Season' })).toHaveValue('season:0');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Season' }), 'season:1');
    await user.click(screen.getByRole('button', { name: /Episode 1 · Pilot/ }));
    const selectedEpisode = screen.getByLabelText('Selected episode: Pilot');
    expect(selectedEpisode).toHaveTextContent('Episode detail');
    expect(screen.queryByText(COMPATIBILITY_STATUS)).not.toBeInTheDocument();
    const videoDetails = screen.getByRole('list', { name: 'Stream details' });
    expect(videoDetails).toHaveTextContent(/1080 px high.*H\.264.*AAC.*MP4/);
    expect(screen.queryByRole('button', { name: 'Check compatibility' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    const player = screen.getByTestId('native-player');
    const watchControl = screen.getByRole('button', { name: 'Stop' }).closest('.watch-control');
    expect(player).toHaveAttribute('data-source', '/api/series/4/episodes/9/stream');
    expect(selectedEpisode).toContainElement(player);
    expect(watchControl.compareDocumentPosition(videoDetails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(videoDetails.compareDocumentPosition(player) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(player.compareDocumentPosition(screen.getByText('Episode detail')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Watch options' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download' }));
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(anchorClick.mock.contexts[0].getAttribute('href')).toBe('/api/series/4/episodes/9/download');
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    await user.click(screen.getByRole('button', { name: 'Open VLC' }));
    expect(vlcMocks.openVLC).toHaveBeenCalledWith(`/api/vlc/launch/${'A'.repeat(43)}`, 'Safe Series - Pilot');
  });

  it('tears down the active episode player before episode, season, and series ownership changes', async () => {
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Playback Series' }], total: 1 });
      if (url.pathname === '/api/series/4') return jsonResponse({
        id: '4', name: 'Playback Series', seasons: [
          { number: 1, episodes: [
            { id: '9', episode_number: 1, title: 'First', stream_info: { container: 'mp4', video_codec: 'h264', audio_codec: 'aac' } },
            { id: '10', episode_number: 2, title: 'Next', stream_info: { container: 'mkv', video_codec: 'hevc', audio_codec: 'ac3' } },
          ] },
          { number: 2, episodes: [{ id: '11', episode_number: 1, title: 'Other' }] },
        ],
      });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await user.click(await screen.findByRole('button', { name: /Playback Series/ }));
    await user.click(await screen.findByRole('button', { name: /Episode 1 · First/ }));
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/H\.264.*AAC.*MP4/);
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    expect(nativePlayerEvents).toEqual(['mount:/api/series/4/episodes/9/stream']);

    await user.click(screen.getByRole('button', { name: /Episode 2 · Next/ }));
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    expect(screen.queryByText(COMPATIBILITY_STATUS)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Stream details' })).toHaveTextContent(/HEVC.*AC3.*MKV/);
    expect(nativePlayerEvents).toEqual([
      'mount:/api/series/4/episodes/9/stream',
      'unmount:/api/series/4/episodes/9/stream',
    ]);

    await user.click(screen.getByRole('button', { name: 'Watch' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Season' }), 'season:2');
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    expect(nativePlayerEvents).toEqual([
      'mount:/api/series/4/episodes/9/stream',
      'unmount:/api/series/4/episodes/9/stream',
      'mount:/api/series/4/episodes/10/stream',
      'unmount:/api/series/4/episodes/10/stream',
    ]);

    await user.click(screen.getByRole('button', { name: /Episode 1 · Other/ }));
    await user.click(screen.getByRole('button', { name: 'Watch' }));
    await user.click(screen.getByRole('button', { name: /Back to Series/ }));
    expect(screen.queryByTestId('native-player')).not.toBeInTheDocument();
    expect(nativePlayerEvents).toEqual([
      'mount:/api/series/4/episodes/9/stream',
      'unmount:/api/series/4/episodes/9/stream',
      'mount:/api/series/4/episodes/10/stream',
      'unmount:/api/series/4/episodes/10/stream',
      'mount:/api/series/4/episodes/11/stream',
      'unmount:/api/series/4/episodes/11/stream',
    ]);
  });

  it('selects the first season with episodes and shows a clean all-empty state', async () => {
    let empty = false;
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Sparse Series' }], total: 1 });
      if (url.pathname === '/api/series/4') return jsonResponse({
        id: '4', name: 'Sparse Series', seasons: empty
          ? [{ number: 0, episodes: [] }, { number: 1, episodes: [] }]
          : [{ number: 0, episodes: [] }, { number: 1, episodes: [{ id: '9', episode_number: 1, title: 'Pilot' }] }],
      });
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await user.click(await screen.findByRole('button', { name: /Sparse Series/ }));
    expect(await screen.findByRole('combobox', { name: 'Season' })).toHaveValue('season:1');
    await user.click(screen.getByRole('button', { name: /Back to Series/ }));
    empty = true;
    await user.click(await screen.findByRole('button', { name: /Sparse Series/ }));
    expect(await screen.findByText('No episodes are currently available for this series.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry episodes' })).toBeInTheDocument();
    view.unmount();
  });

  it('does not launch a stale VLC handoff after the season changes', async () => {
    let resolveHandoff;
    window.localStorage.setItem('dispatcharr-now-vlc-explained', '1');
    vi.stubGlobal('fetch', vi.fn((input) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Two Seasons' }], total: 1 });
      if (url.pathname === '/api/series/4') return jsonResponse({
        id: '4', name: 'Two Seasons', seasons: [
          { number: 1, episodes: [{ id: '9', episode_number: 1, title: 'First' }] },
          { number: 2, episodes: [{ id: '10', episode_number: 1, title: 'Second' }] },
        ],
      });
      if (url.pathname === '/api/series/4/episodes/9/vlc') {
        return new Promise((resolve) => { resolveHandoff = resolve; });
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await user.click(await screen.findByRole('button', { name: /Two Seasons/ }));
    await user.click(await screen.findByRole('button', { name: /Episode 1 · First/ }));
    await user.click(screen.getByRole('button', { name: 'Watch options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open in VLC' }));
    await waitFor(() => expect(resolveHandoff).toBeTypeOf('function'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Season' }), 'season:2');
    await act(async () => {
      resolveHandoff(new Response(JSON.stringify({ launch_url: `/api/vlc/launch/${'B'.repeat(43)}` }), { headers: { 'Content-Type': 'application/json' } }));
      await Promise.resolve();
    });
    expect(screen.getByRole('combobox', { name: 'Season' })).toHaveValue('season:2');
    expect(vlcMocks.openVLC).not.toHaveBeenCalled();
  });

  it('aborts an in-flight detail request when returning to results', async () => {
    let detailSignal;
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
      const url = new URL(String(input), 'https://now.test');
      if (url.pathname === '/api/series') return jsonResponse({ items: [{ id: '4', name: 'Series' }], total: 1 });
      if (url.pathname === '/api/series/4') {
        detailSignal = options.signal;
        return new Promise(() => {});
      }
      throw new Error(`Unexpected fetch ${url.pathname}`);
    }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /All Titles/ }));
    await user.click(await screen.findByRole('button', { name: /Series/ }));
    expect(detailSignal?.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: /Back to Series/ }));
    expect(detailSignal.aborted).toBe(true);
  });
});
