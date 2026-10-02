const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = process.env.QA_CHROME ? require('playwright') : require('./pw/node_modules/playwright');

async function test(root, label) {
  const dist = path.join(root, 'frontend/dist');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(dist, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.QA_CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      const unexpected = [];
      let signedIn = false;
      page.on('pageerror', err => errors.push(err.message));
      await page.route('**/api/**', async route => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname;
        let data;
        let status = 200;
        if (p === '/api/session') {
          status = signedIn ? 200 : 401;
          data = signedIn ? { user: { username: 'synthetic-viewer' }, csrf_token: 'synthetic-csrf' } : { error: { code: 'session_expired' } };
        } else if (p === '/api/auth/login') {
          assert.equal(req.method(), 'POST'); signedIn = true;
          data = { user: { username: 'synthetic-viewer' }, csrf_token: 'synthetic-csrf' };
        } else if (p === '/api/auth/logout') {
          assert.equal(req.headers()['x-csrf-token'], 'synthetic-csrf'); signedIn = false;
          return route.fulfill({ status: 204 });
        } else if (p === '/api/health/ready') data = { reachable: true, version: '0.31.0' };
        else if (p === '/api/live/search/capabilities') data = { program_search: false };
        else if (p === '/api/live/categories') data = [{ id: '2', name: 'News' }];
        else if (p === '/api/live/channels') data = [{ id: '41', name: 'World News', channel_number: '7', category_id: '2' }];
        else if (p.endsWith('/epg')) data = { current: { title: 'Synthetic News', start: new Date(Date.now() - 600000), end: new Date(Date.now() + 600000) } };
        else if (p === '/api/live/channels/41/stream') return route.fulfill({ status: 200, contentType: 'video/mp2t', body: fs.readFileSync(path.join(__dirname, 'sample.ts')) });
        else if (p === '/api/movies/categories') data = [{ id: '1', name: 'Action' }];
        else if (p === '/api/movies') data = { items: [{ id: '7', name: 'Space Movie' }], total: 1 };
        else if (p === '/api/movies/7') data = { id: '7', name: 'Space Movie', description: 'Synthetic movie', stream_info: { container: 'MP4', video_codec: 'H.264', audio_codec: 'AAC', resolution: '1080p' } };
        else if (p === '/api/movies/7/vlc' || p === '/api/series/4/episodes/9/vlc') {
          assert.equal(req.headers()['x-csrf-token'], 'synthetic-csrf');
          status = 201;
          data = { launch_url: `/api/vlc/launch/${'A'.repeat(43)}/Synthetic-Video.mp4` };
        } else if (p === '/api/series/categories') data = [{ id: '3', name: 'Drama' }];
        else if (p === '/api/series') data = { items: [{ id: '4', name: 'Safe Series' }], total: 1 };
        else if (p === '/api/series/4') data = { id: '4', name: 'Safe Series', seasons: [{ number: 1, episodes: [{ id: '9', episode_number: 1, title: 'Pilot' }] }] };
        else { unexpected.push(p); status = 404; data = { error: { code: 'unmocked' } }; }
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      });
      const login = async () => {
        await page.getByLabel('Username', { exact: true }).fill('synthetic-viewer');
        await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
        await page.getByRole('button', { name: 'Open Watch Now', exact: true }).click();
        await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
      };
      const menu = () => page.getByRole('button', { name: /Open menu, current section/ });
      const vlc = async () => {
        await page.getByRole('button', { name: 'Watch options', exact: true }).click();
        await page.keyboard.press('End');
        await page.getByRole('menuitem', { name: 'Watch in VLC', exact: true }).focus();
        const dl = page.waitForEvent('download');
        await page.keyboard.press('Enter');
        const download = await dl;
        const playlist = fs.readFileSync(await download.path(), 'utf8');
        assert.match(playlist, /^#EXTM3U\n#EXTINF:-1,/);
        assert(playlist.includes(base + '/api/vlc/launch/'));
        assert(!playlist.includes('synthetic-password'));
        await page.getByRole('button', { name: 'Back to details', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'Watch', exact: true }).isEnabled(), true);
      };
      await page.goto(base);
      await login();
      await page.getByRole('heading', { name: 'Synthetic News', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Watch Live', exact: true }).click();
      if (process.env.QA_MEDIA === '1') {
        try {
          await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime > 2 && v.videoWidth > 0 && !v.error; }, null, { timeout: 20000 });
        } catch (err) {
          console.error(await page.evaluate(() => { const v = document.querySelector('video'); return { body: document.body.innerText, media: v && { time: v.currentTime, paused: v.paused, width: v.videoWidth, ready: v.readyState, error: v.error?.message, buffered: Array.from({length:v.buffered.length}, (_,i)=>[v.buffered.start(i),v.buffered.end(i)]) }, codecs: {h264:MediaSource.isTypeSupported('video/mp4;codecs="avc1.42E01E"'),aac:MediaSource.isTypeSupported('audio/mp4;codecs="mp4a.40.2"')} }; }));
          throw err;
        }
      }
      if (process.env.QA_MEDIA === '1') {
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('video'));
        assert.equal(await page.locator('video').count(), 0);
      } else {
        await page.getByText('Live playback is not supported by this browser.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Watch Live', exact: true }).isEnabled(), true);
      }
      await menu().click();
      await page.getByRole('button', { name: 'Movies', exact: true }).click();
      await page.getByRole('button', { name: 'All Titles A–Z', exact: false }).click();
      await page.getByRole('button', { name: /Space Movie/ }).click();
      await vlc();
      await menu().click();
      await page.getByRole('button', { name: 'Series', exact: true }).click();
      await page.getByRole('button', { name: 'All Titles A–Z', exact: false }).click();
      await page.getByRole('button', { name: /Safe Series/ }).click();
      await page.getByRole('button', { name: /Episode 1 · Pilot/ }).click();
      await vlc();
      await menu().click();
      await page.getByRole('button', { name: 'Sign out synthetic-viewer', exact: true }).click();
      await login();
      assert.equal(await page.getByRole('button', { name: 'Watch Live', exact: true }).isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      await page.screenshot({ path: path.join(__dirname, `${label}-${width}.png`) });
      console.log(`${label} ${width}px: login, Live TV start/Stop${process.env.QA_MEDIA === '1' ? ' with MPEG-TS video playback' : ''}, Movie/Series VLC playlists, keyboard menu, logout/login and overflow checks passed`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
test(process.argv[2], process.argv[3]).catch(err => { console.error(err); process.exit(1); });
