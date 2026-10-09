export function sameAiring(selected, current, channelID) {
  if (!selected || !current || selected.channel?.id !== channelID) return false;
  const values = [selected.start, selected.end, current.start, current.end].map(Date.parse);
  if (!values.every(Number.isFinite) || values[1] <= values[0] || values[3] <= values[2]) return false;
  const title = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
  return values[0] === values[2] && values[1] === values[3] && Boolean(title(selected.title)) && title(selected.title) === title(current.title);
}

export function mergeSelectedAiring(guide, selected, channelID) {
  if (!sameAiring(selected, guide?.current, channelID)) return guide;
  return { ...guide, current: { ...guide.current,
    subtitle: selected.subtitle || guide.current.subtitle,
    description: selected.description?.length > (guide.current.description?.length || 0) ? selected.description : guide.current.description,
  } };
}
