// Real-browser geometry checks. Requires a built frontend and Playwright/Chromium.
// All API responses are synthetic; no Dispatcharr connection or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = path.resolve(process.env.NOW_LAYOUT_DIST || 'frontend/dist');
const now = Date.now();
const description = 'A long sample description that must remain reachable inside its panel. '.repeat(100);
const channels = Array.from({ length: 100 }, (_, i) => ({ id: `${i + 1}`, name: `Sample channel ${i + 1}`, channel_number: `${i + 1}`, category_id: '1' }));
const categories = Array.from({ length: 40 }, (_, i) => ({ id: `${i + 1}`, name: `Category ${i + 1}` }));
const airing = (channel, i = 0) => ({ id: `${channel.id}-${i}`, channel, title: `Sample show ${i + 1}`, start: new Date(now - 600000 + i * 3600000).toISOString(), end: new Date(now + 3000000 + i * 3600000).toISOString(), description });
const availableDates = Array.from({ length: 8 }, (_, i) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now + i * 86400000)));
const titles = Array.from({ length: 36 }, (_, i) => ({ id: `${i + 1}`, name: `Sample title ${i + 1}` }));
function api(url) {
  const p = url.pathname;
  if (p === '/api/session') return { user: { username: 'synthetic-viewer' }, csrf_token: 'synthetic-token' };
  if (p === '/api/live/search/capabilities') return { program_search: true, guide: true, dvr: true };
  if (p.endsWith('/categories')) return categories;
  if (p === '/api/live/channels') return channels;
  if (p.endsWith('/epg')) return { current: airing(channels[0]), upcoming: airing(channels[0], 1) };
  if (p === '/api/live/programs/search') return { items: channels.slice(0, 20).map(c => airing(c)), total: 100, page: 1, page_size: 20 };
  if (p === '/api/live/guide') {
    const page = Number(url.searchParams.get('page') || 1);
    return { items: channels.slice((page - 1) * 5, page * 5).map(channel => ({ channel, programs: [airing(channel), airing(channel, 1)] })), page, has_more: page < 20, snapshot: 'synthetic', available_dates: availableDates, window_start: new Date(now).toISOString(), window_end: new Date(now + 3 * 3600000).toISOString() };
  }
  if (p === '/api/movies' || p === '/api/series') return { items: titles, total: 72, page: 1, page_size: 36 };
  if (/^\/api\/movies\/\d+$/.test(p)) return { ...titles[0], plot: description, director: 'Sample director', cast: 'Sample cast' };
  if (/^\/api\/series\/\d+$/.test(p)) return { ...titles[0], plot: description, seasons: [{ number: 1, episodes: titles.map((t, i) => ({ ...t, title: `Episode ${i + 1}`, episode_number: i + 1 })) }] };
  if (p === '/api/dvr/connection') return { connected: true, managed: true, access: 'manage' };
  if (p === '/api/dvr/recordings') return { access: 'manage', items: channels.slice(0, 30).map(c => ({ ...airing(c), id: c.id, status: 'recorded', playable: true })) };
  return null;
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/stream')) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.flushHeaders(); // Keep a synthetic player mounted without sending any media.
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const data = api(url);
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data || { error: { message: 'Synthetic media unavailable' } }));
  }
  const filename = path.resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!filename.startsWith(dist + path.sep) || !fs.existsSync(filename)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(fs.readFileSync(filename));
});
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function contained(page, label) {
  await frame(page);
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, x: scrollX, y: scrollY }));
  assert.ok(size.scrollHeight <= size.height + 1 && size.scrollWidth <= size.width + 1 && size.x === 0 && size.y === 0, `${label}: document overflow ${JSON.stringify(size)}`);
  const content = await page.locator('.viewer-content').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(content.scroll <= content.height + 1, `${label}: an extra outer content scrollbar ${JSON.stringify(content)}`);
}
async function scrollPane(page, selector) {
  const pane = page.locator(selector);
  const before = await pane.evaluate(el => { el.scrollTop = el.scrollHeight; return { height: el.clientHeight, scroll: el.scrollHeight }; });
  await frame(page);
  const top = await pane.evaluate(el => el.scrollTop);
  assert.ok(before.height > 0 && before.scroll > before.height && top > 0, `${selector}: content must be scrollable and reachable ${JSON.stringify({ ...before, top })}`);
}
async function section(page, name) {
  await page.getByRole('button', { name: /Open menu, current section/ }).click();
  await page.getByRole('navigation', { name: 'Viewer sections' }).getByRole('button', { name, exact: true }).click();
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [width, height] of [[1920, 1080], [1366, 768], [1024, 600], [960, 540], [800, 400]]) {
      const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'America/Denver' });
      page.setDefaultTimeout(10000);
      await page.goto(base);
      await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
      await contained(page, 'Browse');
      await page.getByRole('listbox', { name: 'Live channels' }).focus();
      await page.keyboard.press('End');
      await page.getByRole('option', { name: '100 · Sample channel 100' }).waitFor();
      await contained(page, 'Browse keyboard End');
      await scrollPane(page, '.detail-panel');
      await contained(page, 'Browse details');
      await page.getByRole('button', { name: 'Guide', exact: true }).click();
      await page.getByRole('button', { name: 'Options for Sample channel 1', exact: true }).waitFor();
      await contained(page, 'Guide grid');
      assert.equal(await page.getByRole('button', { name: 'Load more channels', exact: true }).count(), 0, 'Grid uses automatic loading without a redundant button');
      await scrollPane(page, '.tv-guide-grid');
      await page.locator('.tv-guide-scrollbar').evaluate(el => { el.scrollLeft = 350; });
      await frame(page);
      assert.ok(await page.locator('.tv-guide-grid').evaluate(el => el.scrollLeft > 0), 'Guide horizontal control works');
      await contained(page, 'Guide scrolled');
      await page.locator('.tv-guide-grid').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
      await page.getByRole('button', { name: 'Options for Sample channel 1', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Watch live', exact: true }).click();
      await page.locator('.video-frame').waitFor();
      await page.locator('.guide-playing-title').waitFor();
      await contained(page, 'Dedicated Guide player');
      const playerPane = await page.locator('.detail-panel').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
      assert.ok(playerPane.scroll <= playerPane.height + 1, `Dedicated player has a vertical scrollbar: ${JSON.stringify(playerPane)}`);
      const video = await page.locator('.video-frame').boundingBox();
      assert.ok(video.height > 0 && video.y + video.height <= height, 'Desktop video fits vertically');
      await page.locator('.guide-playing-title strong').evaluate(el => { el.textContent = 'A longer current program title with episode information and a descriptive subtitle. '.repeat(3); });
      await frame(page);
      const wrappedPane = await page.locator('.detail-panel').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
      assert.ok(wrappedPane.scroll <= wrappedPane.height + 1, 'Wrapped Now playing title must not create a player scrollbar');
      if (process.env.NOW_LAYOUT_SCREENSHOTS) {
        fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS, `player-${width}x${height}.png`) });
      }
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await contained(page, 'Stopped Guide player');
      await page.getByRole('button', { name: /Back to Guide/ }).click();
      await page.getByRole('button', { name: 'List', exact: true }).click();
      await page.locator('.tv-guide-agenda .tv-guide-program').first().waitFor();
      await contained(page, 'Guide list');
      await scrollPane(page, '.tv-guide-agenda');
      await page.locator('.tv-guide-agenda .tv-guide-program').first().click();
      await page.getByRole('dialog').waitFor();
      await scrollPane(page, '.confirmation-dialog');
      await contained(page, 'Long airing dialog');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('searchbox').fill('Sample');
      await page.locator('.channel-search-result').first().waitFor();
      await contained(page, 'Search');
      await page.locator('.channel-search-result').nth(10).scrollIntoViewIfNeeded();
      const saved = await page.locator('.live-search-view').evaluate(el => el.scrollTop);
      assert.ok(saved > 0, 'Search scroll fixture');
      await page.locator('.channel-search-result').nth(10).click();
      await contained(page, 'Search details');
      await page.getByRole('button', { name: /Back to search results/ }).click();
      await frame(page);
      assert.equal(await page.locator('.live-search-view').evaluate(el => el.scrollTop), saved, 'Returning from details restores inner search scroll');
      await contained(page, 'Search restored');
      for (const name of ['Movies', 'Series']) {
        await section(page, name);
        await page.getByRole('button', { name: 'Category 40', exact: true }).waitFor();
        await scrollPane(page, '.media-section');
        await contained(page, `${name} categories`);
        await page.getByRole('button', { name: 'All Titles A–Z' }).click();
        await page.locator('.poster-card').first().waitFor();
        await scrollPane(page, '.media-section');
        await contained(page, `${name} catalog`);
        await page.locator('.poster-card').first().click();
        await page.locator('.media-description').waitFor();
        await scrollPane(page, '.media-section');
        await contained(page, `${name} details`);
      }
      await section(page, 'DVR');
      await page.locator('.dvr-recording').first().waitFor();
      await scrollPane(page, '.dvr-section');
      await contained(page, 'DVR');
      await page.getByRole('button', { name: /Open menu, current section/ }).click();
      await page.getByRole('button', { name: 'About', exact: true }).click();
      await contained(page, 'About');
      await page.keyboard.press('Escape');
      await section(page, 'Live TV');
      await page.getByRole('button', { name: 'Browse', exact: true }).click();
      await page.locator('.program-card').first().waitFor();
      if (process.env.NOW_LAYOUT_SCREENSHOTS) {
        fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS, `desktop-${width}x${height}.png`) });
        await page.getByRole('button', { name: 'Guide', exact: true }).click();
        await page.getByRole('button', { name: 'Grid', exact: true }).click();
        await page.getByRole('button', { name: 'Options for Sample channel 1', exact: true }).waitFor();
        await frame(page);
        await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS, `guide-${width}x${height}.png`) });
      }
      console.log(`PASS desktop ${width}x${height}: Browse, Search/return, Guide Grid/List, long modal, Movies, Series, DVR, About`);
      await page.close();
    }
    for (const [width, height] of [[390, 844], [844, 390]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
      await page.goto(base);
      await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
      assert.equal(await page.locator('.viewer-shell.is-desktop').count(), 0, 'Phone layout remains natural page flow');
      await frame(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), 'Phone long descriptions remain reachable by page scrolling');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No phone horizontal page overflow');
      console.log(`PASS mobile ${width}x${height}: portrait/landscape page scrolling preserved`);
      await page.close();
    }
  } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
