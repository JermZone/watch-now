export class APIError extends Error {
  constructor(message, { code = 'request_failed', status = 0 } = {}) {
    super(message);
    this.name = 'APIError';
    this.code = code;
    this.status = status;
  }
}

const request = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
  });
  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new APIError(
      payload?.error?.message || 'Watch Now could not complete the request.',
      { code: payload?.error?.code, status: response.status },
    );
  }
  return payload;
};

const queryString = (values) => {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
};

const itemPath = (kind, id, resource = '') =>
  `/api/${kind}/${encodeURIComponent(id)}${resource ? `/${resource}` : ''}`;

export const getSession = ({ signal } = {}) => request('/api/session', { signal });

export const login = (username, password) =>
  request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

export const logout = (csrfToken) =>
  request('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  });

export const getDiagnostics = ({ signal } = {}) =>
  request('/api/health/ready', { signal });

export const getCategories = ({ signal } = {}) =>
  request('/api/live/categories', { signal });

export const getChannels = (categoryID, { signal } = {}) => {
  const query = categoryID ? `?category_id=${encodeURIComponent(categoryID)}` : '';
  return request(`/api/live/channels${query}`, { signal });
};

const channelPath = (channelID, resource, categoryID = '') => {
  const query = categoryID ? `?category_id=${encodeURIComponent(categoryID)}` : '';
  return `/api/live/channels/${encodeURIComponent(channelID)}/${resource}${query}`;
};

export const getEPG = (channelID, categoryID, { signal } = {}) =>
  request(channelPath(channelID, 'epg', categoryID), { signal });

export const artworkURL = (channelID, categoryID) =>
  channelPath(channelID, 'artwork', categoryID);

export const liveStreamURL = (channelID) =>
  channelPath(channelID, 'stream');

export const createLiveVLC = (channelID, csrfToken, { signal } = {}) =>
  request(channelPath(channelID, 'vlc'), {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
    signal,
  });

export const getMovieCategories = ({ signal } = {}) =>
  request('/api/movies/categories', { signal });

export const getMovies = ({
  categoryID = '', search = '', page = 1, pageSize = 20, signal,
} = {}) => request(`/api/movies${queryString({
  category_id: categoryID,
  search: search.trim(),
  page,
  page_size: pageSize,
})}`, { signal });

export const getMovie = (movieID, { signal } = {}) =>
  request(itemPath('movies', movieID), { signal });

export const movieArtworkURL = (movieID) => itemPath('movies', movieID, 'artwork');
export const movieStreamURL = (movieID) => itemPath('movies', movieID, 'stream');
export const movieDownloadURL = (movieID) => itemPath('movies', movieID, 'download');

export const createMovieVLC = (movieID, csrfToken) =>
  request(itemPath('movies', movieID, 'vlc'), {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  });

export const getSeriesCategories = ({ signal } = {}) =>
  request('/api/series/categories', { signal });

export const getSeries = ({
  categoryID = '', search = '', page = 1, pageSize = 20, signal,
} = {}) => request(`/api/series${queryString({
  category_id: categoryID,
  search: search.trim(),
  page,
  page_size: pageSize,
})}`, { signal });

export const getSeriesDetail = (seriesID, { signal } = {}) =>
  request(itemPath('series', seriesID), { signal });

export const seriesArtworkURL = (seriesID) => itemPath('series', seriesID, 'artwork');

const episodePath = (seriesID, episodeID, resource) =>
  `/api/series/${encodeURIComponent(seriesID)}/episodes/${encodeURIComponent(episodeID)}/${resource}`;

export const episodeStreamURL = (seriesID, episodeID) =>
  episodePath(seriesID, episodeID, 'stream');
export const episodeDownloadURL = (seriesID, episodeID) =>
  episodePath(seriesID, episodeID, 'download');

export const createEpisodeVLC = (seriesID, episodeID, csrfToken) =>
  request(episodePath(seriesID, episodeID, 'vlc'), {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfToken },
  });

export const getLiveSearchCapabilities = ({ signal } = {}) => request('/api/live/search/capabilities', { signal });
export const getProgramSearch = ({ categoryID = '', search, status = 'now', page = 1, pageSize = 20, signal } = {}) => request(`/api/live/programs/search${queryString({ category_id: categoryID, search: search.trim(), status, page, page_size: pageSize })}`, { signal });

export const getDVRConnection = ({ signal } = {}) => request('/api/dvr/connection', { signal });
export const getDVRRecordings = ({ signal } = {}) => request('/api/dvr/recordings', { signal });
export const changeDVR = (path, method, csrfToken, body, { signal } = {}) => request(`/api/dvr/${path}`, {
  method, signal, headers: { 'X-CSRF-Token': csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}),
});
export const dvrFileURL = (id, download = false) => `/api/dvr/recordings/${encodeURIComponent(id)}/${download ? 'download' : 'stream'}`;

export const getTVGuide = ({ start, end, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, categoryID = '', channelID = '', page = 1, snapshot = '', signal } = {}) =>
  request(`/api/live/guide${queryString({ start, end, timezone, category_id: categoryID, channel_id: channelID, page, snapshot })}`, { signal });

export const getShareCapabilities = ({ signal } = {}) => request('/api/share', { signal });
export const createShare = (target, csrfToken, { signal } = {}) => request('/api/share', {
  method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: JSON.stringify(target), signal,
});
export const resolveShare = (token, csrfToken, { signal } = {}) => request('/api/share/resolve', {
  method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ token }), signal,
});
