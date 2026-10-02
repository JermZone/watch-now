import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEpisodeVLC, createMovieVLC, episodeStreamURL, getMovies,
  movieDownloadURL, movieStreamURL,
} from './api';

afterEach(() => vi.unstubAllGlobals());

describe('VOD API contract', () => {
  it('builds bounded movie queries and never accepts an upstream extension or URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 2, page_size: 20 }), { headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    await getMovies({ categoryID: 'news & film', search: 'space opera', page: 2 });
    const called = new URL(String(fetchMock.mock.calls[0][0]), 'https://now.test');
    expect(called.pathname).toBe('/api/movies');
    expect(Object.fromEntries(called.searchParams)).toEqual({ category_id: 'news & film', search: 'space opera', page: '2', page_size: '20' });
    expect(called.searchParams.has('year_from')).toBe(false);
    expect(called.searchParams.has('year_to')).toBe(false);
    expect(called.searchParams.has('min_rating')).toBe(false);
    expect(called.searchParams.has('sort')).toBe(false);
    expect(movieStreamURL('a/b')).toBe('/api/movies/a%2Fb/stream');
    expect(movieDownloadURL('7')).toBe('/api/movies/7/download');
    expect(episodeStreamURL('4', '9')).toBe('/api/series/4/episodes/9/stream');
  });

  it('sends CSRF only to Now-owned VLC creation routes', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ launch_url: `/api/vlc/launch/${'A'.repeat(43)}` }), { headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    await createMovieVLC('7', 'csrf-movie');
    await createEpisodeVLC('4', '9', 'csrf-episode');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/movies/7/vlc');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(fetchMock.mock.calls[0][1].headers.get('X-CSRF-Token')).toBe('csrf-movie');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/series/4/episodes/9/vlc');
    expect(fetchMock.mock.calls[1][1].headers.get('X-CSRF-Token')).toBe('csrf-episode');
  });
});
