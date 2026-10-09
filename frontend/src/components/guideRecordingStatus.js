const recordingID = /^[0-9]{1,64}$/;
const airingID = /^[a-f0-9]{32}$/;
const normalized = (value) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';

// Index the bounded, viewer-authorized DVR catalog once, rather than per cell.
export function buildGuideRecordingIndex(recordings) {
  const index = new Map();
  for (const row of (Array.isArray(recordings) ? recordings.slice(0, 5000) : [])) {
    const channelID = row?.channel_id || row?.channel?.id;
    if (!recordingID.test(row?.id || '') || typeof channelID !== 'string' || !recordingID.test(channelID)
      || !['recording', 'scheduled'].includes(row.status)) continue;
    const start = Date.parse(row.start), end = Date.parse(row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const entry = { status: row.status, start, end, title: normalized(row.title), subtitle: normalized(row.subtitle),
      airingID: airingID.test(row.airing_id || '') ? row.airing_id : '' };
    if (!index.has(channelID)) index.set(channelID, []);
    index.get(channelID).push(entry);
  }
  return index;
}

export function guideRecordingStatus(program, index, now = Date.now()) {
  const start = Date.parse(program?.start), end = Date.parse(program?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const title = normalized(program.title), subtitle = normalized(program.subtitle);
  let status = '';
  for (const row of index.get(program.channel?.id) || []) {
    if (row.end <= now || row.start >= end || row.end <= start) continue;
    let matches;
    if (row.airingID) {
      // The owning airing is authoritative, even when padding reaches a repeat.
      matches = row.airingID === program.id;
    } else {
      const sameTitle = title && row.title === title && (!subtitle || !row.subtitle || subtitle === row.subtitle);
      const generic = !row.title || row.title === 'recording';
      matches = row.start <= start && row.end >= end && (sameTitle || generic)
        || sameTitle && row.start >= start && row.start < end && row.end >= end;
    }
    if (!matches) continue;
    if (row.status === 'recording') return 'recording';
    status = 'scheduled';
  }
  return status;
}

export const guideRecordingLabel = (status) => status === 'recording' ? 'Recording now' : status === 'scheduled' ? 'Scheduled recording' : '';
