const normalize = (value) => String(value ?? '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

export const filterLiveChannels = (channels, search) => {
  const query = normalize(search);
  return query ? channels.filter((channel) => normalize(channel.name).includes(query)
    || normalize(channel.channel_number).includes(query)) : channels;
};
