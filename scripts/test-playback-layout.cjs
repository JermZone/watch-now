// Real-browser geometry checks. Requires a built frontend and Playwright/Chromium.
// All API responses are synthetic; no Dispatcharr connection or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = path.resolve(process.env.NOW_LAYOUT_DIST || 'frontend/dist');
// Fixed daytime coverage keeps the horizontal-scroll check meaningful at night.
const now = Date.parse('2026-10-05T18:00:00Z');
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
  const content = await page.locator('.viewer-content, .viewer-shell > .playback-stage').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }));
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
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browserName=process.env.NOW_TEST_BROWSER || 'chromium';
 const browser=await (browserName==='firefox'?firefox:chromium).launch({headless:true});
 const probe=await browser.newPage();const supportsLive=await probe.evaluate(()=>Boolean(window.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')));await probe.close();
 if(!supportsLive) console.log('SKIP Live TV geometry: this browser runtime lacks H.264 MediaSource support');
 try {
 for(const [width,height,phone] of [[1920,1080,false],[1366,768,false],[1024,600,false],[800,400,false],[390,844,true],[844,390,true]]) {
  for(const kind of (!supportsLive ? ['movie','episode','recording'] : ['live','search','guide','movie','episode','recording'])) {
   const page=await browser.newPage({viewport:{width,height},hasTouch:phone,...(browserName==='chromium'?{isMobile:phone}:{})});
   page.setDefaultTimeout(10000);await page.clock.install({time:now});await page.goto(base);
   await page.getByRole('button',{name:'Watch Live',exact:true}).waitFor();
   if(kind==='live')await page.getByRole('button',{name:'Watch Live',exact:true}).click();
   if(kind==='search') {await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('searchbox').fill('Sample');await page.locator('.channel-search-result').first().click();await page.getByRole('button',{name:'Watch Live',exact:true}).click();}
   if(kind==='guide') {await page.getByRole('button',{name:'Guide',exact:true}).click();await page.getByRole('button',{name:'Options for Sample channel 1',exact:true}).first().click();await page.getByRole('dialog').getByRole('button',{name:'Watch live',exact:true}).click();}
   if(kind==='movie'||kind==='episode') {await section(page,kind==='movie'?'Movies':'Series');await page.getByRole('button',{name:'All Titles A–Z'}).click();await page.locator('.poster-card').first().click();if(kind==='episode')await page.getByRole('button',{name:/Episode 1 ·/}).click();await page.getByRole('button',{name:'Watch',exact:true}).click();}
   if(kind==='recording') {await section(page,'DVR');await page.locator('.dvr-recording').first().getByRole('button',{name:'Watch',exact:true}).click();}
   await page.locator('video').waitFor();await frame(page);
   const size=await page.evaluate(()=>({page:document.documentElement.scrollHeight-innerHeight,width:document.documentElement.scrollWidth-innerWidth,panes:[...document.querySelectorAll('.playback-stage,.playback-stage-card,.native-player,.live-player,.is-live-focused .detail-panel')].map(el=>el.scrollHeight-el.clientHeight),video:document.querySelector('video').getBoundingClientRect().toJSON()}));
   assert.ok(size.page<=1 && size.width<=1 && size.panes.every(v=>v<=1),`${kind} ${width}x${height} overflow ${JSON.stringify(size)}`);
   assert.ok(size.video.height>60 && size.video.bottom<=height && size.video.top>=0,`${kind} video fits`);
   await page.getByRole('button',{name:'Playback details',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
   assert.equal(await page.locator('video').count(),1,'Details must retain one player');
   if(process.env.NOW_LAYOUT_SCREENSHOTS) {fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.NOW_LAYOUT_SCREENSHOTS,`${browserName}-${kind}-${width}x${height}.png`)});}
   if(['live','search','guide'].includes(kind)) {
    await page.locator('video').evaluate(el=>{window.playbackAuditVideo=el;});
    await page.getByRole('button',{name:/Back to browsing/}).click();
    await page.getByRole('button',{name:'Focus player',exact:true}).click();
    assert.equal(await page.locator('video').evaluate(el=>el===window.playbackAuditVideo),true,'Live browsing must retain the player');
   }
   await page.getByRole('button',{name:'Stop',exact:true}).click();assert.equal(await page.locator('video').count(),0,'Stop removes playback');
   console.log(`PASS ${browserName} ${kind} ${width}x${height}: player fits, details, Stop`);
   await page.close();
  }
 }
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
