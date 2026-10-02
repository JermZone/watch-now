export const VLC_APP_STORE_URL = 'https://apps.apple.com/us/app/vlc-media-player/id650377962';

export const isAppleMobile = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const validatedLaunchURL = (launchURL) => {
  const url = new URL(launchURL, window.location.href);
  if (
    url.origin !== window.location.origin ||
    !/^\/api\/vlc\/launch\/[A-Za-z0-9_-]{43}(?:\/[A-Za-z0-9._-]{1,180})?$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid VLC launch URL');
  }
  return url;
};

export const vlcDeepLink = (launchURL) => {
  const url = validatedLaunchURL(launchURL);
  return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url.href)}`;
};

const playlistTitle = (title) => String(title || 'Video').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Video';
const playlistFilename = (title) => playlistTitle(title).replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[ .]+|[ .]+$/g, '') || 'Video';

export const desktopVLCPlaylist = (launchURL, title) => {
  const url = validatedLaunchURL(launchURL);
  const name = playlistTitle(title);
  return {
    filename: `${playlistFilename(name)}.m3u`,
    content: `#EXTM3U\n#EXTINF:-1,${name}\n${url.href}\n`,
  };
};

export const openVLC = (launchURL, title) => {
  if (isAppleMobile()) {
    window.location.assign(vlcDeepLink(launchURL));
    return 'app';
  }
  const playlist = desktopVLCPlaylist(launchURL, title);
  const objectURL = URL.createObjectURL(new Blob([playlist.content], { type: 'audio/x-mpegurl;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectURL;
  link.download = playlist.filename;
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectURL), 60_000);
  }
  return 'playlist';
};
