// Synthetic local CPU/heap measurement; no network or live provider data.
import { performance } from 'node:perf_hooks';
import { filterLiveChannels } from '../frontend/src/components/liveSearch.js';
const channels = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), name: `Station ${i} News`, channel_number: String(i + 1) }));
global.gc?.();
const before = process.memoryUsage().heapUsed;
const coldStart = performance.now();
filterLiveChannels(channels, '  nEwS  ');
const coldMS = performance.now() - coldStart;
const warmStart = performance.now();
for (let i = 0; i < 1000; i++) filterLiveChannels(channels, String(i % 100));
const warmMS = (performance.now() - warmStart) / 1000;
console.log(JSON.stringify({ synthetic: true, channels: channels.length, query_requests: 0, cold_ms: coldMS, warm_mean_ms: warmMS, heap_delta_bytes: process.memoryUsage().heapUsed - before }, null, 2));
