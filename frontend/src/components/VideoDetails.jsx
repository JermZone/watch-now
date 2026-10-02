const compactToken = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const containerKind = (value) => {
  const token = compactToken(value);
  if (['mp4', 'm4v', 'mov', 'quicktime', 'isom'].includes(token)) return 'mp4';
  if (['mkv', 'matroska'].includes(token)) return 'mkv';
  if (['webm'].includes(token)) return 'webm';
  if (['3g2', '3gp', 'avi', 'mpeg', 'mpg', 'mpegps', 'mpegts', 'mpegtransportstream', 'ts', 'm2ts', 'flv', 'wmv', 'asf', 'ogg', 'ogv'].includes(token)) return 'other';
  return '';
};

const videoKind = (value) => {
  const token = compactToken(value);
  if (['h264', 'avc', 'avc1', 'x264'].includes(token)) return 'h264';
  if (['h265', 'hevc', 'hev1', 'hvc1', 'x265'].includes(token)) return 'hevc';
  if (['av1', 'av01', 'vp8', 'vp9', 'mpeg2', 'mpeg2video', 'mpeg4', 'mpeg4video', 'mp4v', 'vc1', 'xvid', 'divx', 'theora', 'wmv', 'wmv3'].includes(token)) return 'other';
  return '';
};

const audioKind = (value, channels) => {
  const token = compactToken(value);
  if (['aac', 'aaclc', 'heaac', 'mp4a'].includes(token) || token.startsWith('aac')) return 'aac';
  if (['none', 'noaudio', 'silent', 'withoutaudio'].includes(token) || (channels === 0 || channels === '0')) return 'none';
  if (['ac3', 'eac3', 'ec3', 'dts', 'dtshd', 'truehd', 'opus', 'vorbis', 'flac', 'alac', 'mp2', 'mp3', 'wma', 'pcm'].includes(token)) return 'other';
  return '';
};

const safeText = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  if (!text || text.length > 40 || /(?:[a-z]+:\/\/|[\\/]{2}|[?&=])/i.test(text)) return '';
  return text;
};

const canonicalContainer = (value) => {
  const kind = containerKind(value);
  if (kind === 'mp4') {
    const token = compactToken(value);
    if (token === 'm4v') return 'M4V';
    if (['mov', 'quicktime'].includes(token)) return 'MOV';
    return 'MP4';
  }
  if (kind === 'mkv') return 'MKV';
  if (kind === 'webm') return 'WebM';
  return safeText(value).toUpperCase();
};

const canonicalVideo = (value) => {
  const kind = videoKind(value);
  if (kind === 'h264') return 'H.264';
  if (kind === 'hevc') return 'HEVC';
  const token = compactToken(value);
  if (token === 'av1' || token === 'av01') return 'AV1';
  if (token === 'vp8') return 'VP8';
  if (token === 'vp9') return 'VP9';
  if (['mpeg2', 'mpeg2video'].includes(token)) return 'MPEG-2';
  return safeText(value).toUpperCase();
};

const canonicalAudio = (value, channels) => {
  const kind = audioKind(value, channels);
  if (kind === 'aac') return 'AAC';
  if (kind === 'none') return 'No audio';
  const token = compactToken(value);
  const labels = {
    ac3: 'AC3', dts: 'DTS', dtshd: 'DTS-HD', eac3: 'EAC3', ec3: 'EAC3',
    flac: 'FLAC', mp2: 'MP2', mp3: 'MP3', opus: 'Opus', pcm: 'PCM',
    truehd: 'TrueHD', vorbis: 'Vorbis', wma: 'WMA',
  };
  return labels[token] || safeText(value).toUpperCase();
};

const resolutionText = (streamInfo) => {
  const dimension = (value) => (Number.isInteger(value) && value > 0 && value <= 16384 ? value : 0);
  const width = dimension(streamInfo?.width);
  const height = dimension(streamInfo?.height);
  const supplied = safeText(streamInfo?.resolution).toLowerCase();
  const pair = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(supplied);
  const vertical = /^(\d{2,5})([pi])$/.exec(supplied);
  if (pair) {
    const suppliedWidth = dimension(Number(pair[1]));
    const suppliedHeight = dimension(Number(pair[2]));
    if (suppliedWidth && suppliedHeight && (!width || width === suppliedWidth) && (!height || height === suppliedHeight)) {
      return `${suppliedWidth}x${suppliedHeight}`;
    }
  }
  if (vertical && dimension(Number(vertical[1])) && (!height || height === Number(vertical[1]))) return supplied;
  if (width && height) return `${width}x${height}`;
  if (height) return `${height} px high`;
  if (width) return `${width} px wide`;
  return '';
};

export const videoDetailsMetadata = (streamInfo) => {
  const values = [
    resolutionText(streamInfo),
    canonicalVideo(streamInfo?.video_codec),
    canonicalAudio(streamInfo?.audio_codec, streamInfo?.audio_channels),
    canonicalContainer(streamInfo?.container),
  ];
  return values.filter(Boolean);
};

const VideoDetails = ({ streamInfo }) => {
  const metadata = videoDetailsMetadata(streamInfo);
  if (metadata.length === 0) return null;
  return (
    <ul aria-label="Stream details" className="video-details">
      {metadata.map((value, index) => <li className="video-detail-badge" key={`${index}:${value}`}>{value}</li>)}
    </ul>
  );
};

export default VideoDetails;
