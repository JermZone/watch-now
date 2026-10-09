// Real Chromium decoding and lifecycle checks using generated, synthetic media.
// Requires a built frontend, Playwright/Chromium, and FFmpeg with libx264/AAC.
// Host FFmpeg is preferred. NOW_TEST_FFMPEG_IMAGE may select a preexisting image;
// Docker is used only as an isolated fixture generator, never in the product.
// Completion uses an MP4 fixture. This does not validate stock Dispatcharr MKV
// playback, actual upstream authorization, Safari/native HLS, or every codec.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const dist = path.resolve(process.env.NOW_LAYOUT_DIST || 'frontend/dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-now-active-hls-'));
const states = new Map();
const SYNTHETIC_DETAILS_TITLE = 'Synthetic extended recording and channel title for testing the Details action beneath the show title';
const failures = [];
let nextSession = 0;
// Fourteen browser scenarios retain a finite fixture traffic budget; production guards are unchanged.
const MAX_SYNTHETIC_REQUESTS = 2000;
let requests = 0;
let base;
let browser;
let server;
const deadline = setTimeout(() => {
  console.error('FAIL synthetic active recording test exceeded its three-minute limit');
  process.exit(1);
}, 180000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function ffmpeg(args) {
  const binary = process.env.NOW_TEST_FFMPEG_BIN || 'ffmpeg';
  const local = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 5000 });
  let command = binary;
  let commandArgs = args.map(arg => arg.replaceAll('/fixtures/', temp + path.sep));
  if (local.error || local.status !== 0) {
    const image = process.env.NOW_TEST_FFMPEG_IMAGE;
    if (!image) throw new Error('FFmpeg with H.264/AAC is required. Set NOW_TEST_FFMPEG_BIN or NOW_TEST_FFMPEG_IMAGE to an already available fixture tool.');
    command = 'docker';
    commandArgs = ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '2',
      '--memory', '256m', '--user', String(process.getuid()) + ':' + String(process.getgid()),
      '--volume', temp + ':/fixtures', '--entrypoint', 'ffmpeg', image, ...args];
  }
  execFileSync(command, commandArgs, { timeout: 45000, maxBuffer: 1 << 20, stdio: ['ignore', 'ignore', 'pipe'] });
}

function fixtures() {
  ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '80', '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-threads', '2', '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments', '-hls_segment_filename', '/fixtures/seg_%05d.ts',
    '/fixtures/index.m3u8']);
  ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', '/fixtures/index.m3u8',
    '-c', 'copy', '-movflags', '+faststart', '/fixtures/completed.mp4']);
  const lines = fs.readFileSync(path.join(temp, 'index.m3u8'), 'utf8').trim().split('\n');
  const headers = [];
  const entries = [];
  let duration = '';
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) duration = line;
    else if (/^seg_[0-9]+\.ts$/.test(line)) {
      assert.ok(duration, 'generated segment requires a duration');
      entries.push({ duration, name: line });
      duration = '';
    } else if (line !== '#EXT-X-ENDLIST') headers.push(line);
  }
  assert.equal(entries.length, 20, '80-second fixture must contain twenty four-second segments');
  assert.ok(headers.includes('#EXT-X-PLAYLIST-TYPE:EVENT'), 'fixture must use EVENT');
  assert.ok(fs.statSync(path.join(temp, 'completed.mp4')).size > 0, 'completion fixture must exist');
  return { headers, entries };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function stateFor(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)synthetic_session=([0-9]+)/);
  return match && states.get(match[1]);
}
function record(state, i = 0) {
  const now = Date.now();
  return {
    id: String(7 + i), channel: { id: '1', name: state.detailsScenario ? SYNTHETIC_DETAILS_TITLE : 'Synthetic test channel', channel_number: '1' },
    title: i ? 'Synthetic recording ' + i : state.catalogTitle,
    description: state.shortDVRDescription ? 'Synthetic captured footage for browser playback checks.' :
      'Synthetic media generated only for this browser test. '.repeat(8),
    start: new Date(now - 3600000 - i * 60000).toISOString(),
    end: new Date(now + 1800000 - i * 60000).toISOString(),
    status: i ? 'recording' : state.catalogStatus, playable: false, can_watch_active: true,
  };
}
function media(res, req, filename, contentType) {
  const size = fs.statSync(filename).size;
  const range = req.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
    if (!match) { res.writeHead(416); return res.end(); }
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416); return res.end(); }
    res.statusCode = 206;
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(filename, { start, end }).pipe(res);
}
async function waitUntil(condition, label, timeout = 15000) {
  const start = Date.now();
  while (!condition()) {
    assert.ok(Date.now() - start < timeout, label);
    await delay(100);
  }
}
async function geometry(page, label) {
  const size = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      width: innerWidth, height: innerHeight,
      pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
      panes: [...document.querySelectorAll('.playback-stage,.playback-stage-card,.native-player')]
        .map(el => el.scrollHeight - el.clientHeight),
      video: video && video.getBoundingClientRect().toJSON(),
    };
  });
  assert.ok(size.pageWidth <= size.width + 1 && size.pageHeight <= size.height + 1,
    label + ': document overflow ' + JSON.stringify(size));
  assert.ok(size.panes.every(value => value <= 1), label + ': nested playback scrollbar');
  assert.ok(size.video && size.video.height > 60 && size.video.top >= 0 &&
    size.video.bottom <= size.height + 1 && size.video.right <= size.width + 1,
    label + ': video does not fit');
}
async function assertPlaybackDetails(page, video, viewport, state, label) {
  const details = page.getByRole('button', { name: 'Details', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Playback details', exact: true });
  assert.equal(await details.count(), 1, label + ': player exposes one small Details action');
  assert.equal(await page.getByRole('button', { name: 'Playback details', exact: true }).count(), 0,
    label + ': old navigation-level details action is retired');
  const layout = await details.evaluate(button => {
    const titleGroup = button.closest('.playback-title-group');
    const header = button.closest('.playback-stage-heading,.channel-identity');
    const title = titleGroup?.querySelector('h2');
    const stop = header?.querySelector('button.is-stop');
    const navigation = document.querySelector('.playback-stage-navigation,.live-focus-navigation');
    return { details: button.getBoundingClientRect().toJSON(),
      title: title?.getBoundingClientRect().toJSON(), stop: stop?.getBoundingClientRect().toJSON(),
      titleText: title?.textContent, detailsFont: parseFloat(getComputedStyle(button).fontSize),
      titleFont: title && parseFloat(getComputedStyle(title).fontSize),
      navigation: navigation && [...navigation.querySelectorAll('button')].map(el => el.textContent.trim()),
      pageWidth: document.documentElement.scrollWidth };
  });
  const intersects = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 &&
    a.top < b.bottom - 1 && a.bottom > b.top + 1;
  assert.ok(layout.title && layout.stop && layout.details.top >= layout.title.bottom - 1 &&
    layout.details.left >= layout.title.left - 1 && !intersects(layout.title, layout.stop) &&
    !intersects(layout.details, layout.stop),
    label + ': Details sits beneath title without competing with Stop: ' + JSON.stringify(layout));
  assert.ok(layout.details.width >= 43 && layout.details.height >= 43 &&
    layout.details.left >= 0 && layout.details.right <= viewport.width + 1 &&
    layout.stop.left >= 0 && layout.stop.right <= viewport.width + 1 &&
    layout.pageWidth <= viewport.width + 1 && layout.detailsFont < layout.titleFont,
    label + ': quiet Details action retains a44px tap target within its viewport: ' + JSON.stringify(layout));
  assert.equal(layout.navigation?.length, 1, label + ': player navigation contains only Back');
  assert.match(layout.navigation[0], /Back to /, label + ': the single navigation action returns to browsing/details');
  if (state.detailsScenario) assert.equal(layout.titleText, SYNTHETIC_DETAILS_TITLE,
    label + ': long title remains in the title group');
  await geometry(page, label + ' Details layout');
  if (process.env.NOW_LAYOUT_SCREENSHOTS) {
    await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
      'synthetic-details-' + label + '-' + viewport.width + 'x' + viewport.height + '.png') });
  }

  const starts = state.startRequests;
  const stops = state.stopRequests;
  await video.evaluate(v => {
    const audit = { video: v, source: v.currentSrc, position: v.currentTime, loads: 0 };
    audit.onLoad = () => audit.loads++;
    window.syntheticDetailsAudit = audit;
    v.addEventListener('loadstart', audit.onLoad);
  });
  try {
    assert.ok(await video.evaluate(v => v.paused), label + ': modal continuity check begins from deliberate pause');
    await details.click();
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, label + ': Details opens one dialog');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      label + ': modal contains initial focus');
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      label + ': modal traps reverse keyboard focus');
    const rect = await dialog.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 &&
      rect.bottom <= viewport.height + 1, label + ': Details dialog fits its viewport');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-details-dialog-' + label + '-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await details.evaluate(el => el === document.activeElement),
      label + ': closing Details restores the title action focus');
    assert.ok(await video.evaluate(v => {
      const audit = window.syntheticDetailsAudit;
      return v === audit.video && v.currentSrc === audit.source && audit.loads === 0 &&
        v.paused && Math.abs(v.currentTime - audit.position) < 0.2;
    }), label + ': inspecting Details preserves paused video, source and position');

    await video.evaluate(v => v.play());
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return !v.paused && !v.seeking && v.readyState >= 2;
    });
    const playing = await video.evaluate(v => ({ time: v.currentTime,
      frames: v.getVideoPlaybackQuality().totalVideoFrames }));
    await details.click();
    await dialog.waitFor();
    await delay(650);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await details.evaluate(el => el === document.activeElement),
      label + ': Escape restores Details focus');
    assert.ok(await video.evaluate((v, previous) => {
      const audit = window.syntheticDetailsAudit;
      return v === audit.video && v.currentSrc === audit.source && audit.loads === 0 &&
        !v.paused && v.currentTime > previous.time + 0.2 && v.currentTime < previous.time + 4 &&
        v.getVideoPlaybackQuality().totalVideoFrames > previous.frames;
    }, playing), label + ': moving video keeps decoding through Details without reload or reset');
    assert.equal(state.startRequests, starts, label + ': Details never starts a new playback generation');
    assert.equal(state.stopRequests, stops, label + ': Details never retires playback');
    await video.evaluate(v => v.pause());
  } finally {
    await video.evaluate(v => {
      v.removeEventListener('loadstart', window.syntheticDetailsAudit?.onLoad);
      delete window.syntheticDetailsAudit;
    });
  }
}

async function exerciseDetails(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500, isMobile: viewport.width < 500,
    reducedMotion: 'reduce', extraHTTPHeaders: { 'X-Synthetic-Details': '1' },
  });
  const page = await context.newPage();
  const errors = [];
  let state;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('Details browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  const decoded = async () => {
    const video = page.getByLabel('Recording player', { exact: true });
    await video.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && !v.seeking && v.videoWidth === 320 &&
        v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
    await video.evaluate(v => v.pause());
    return video;
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state?.detailsScenario, 'Details fixture is isolated from default browser scenarios');
    await page.getByRole('button', { name: /Open menu, current section/ }).click();
    await page.getByRole('navigation', { name: 'Viewer sections' }).getByRole('button', { name: 'DVR', exact: true }).click();
    await page.getByRole('button', { name: /^Recording \(/ }).click();
    await page.locator('.dvr-recording').first().getByRole('button', { name: 'Watch', exact: true }).click();
    await page.getByRole('dialog', { name: 'Watch recording', exact: true })
      .getByRole('button', { name: 'Watch from Beginning', exact: true }).click();
    let video = await decoded();
    await video.evaluate(v => { v.currentTime = 8; });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 8) < 0.2;
    });
    await assertPlaybackDetails(page, video, viewport, state, 'DVR');
    await page.getByRole('button', { name: /Back to DVR/ }).click();
    await waitUntil(() => state.stopRequests === 1, 'leaving DVR should retire its playback once');
    await page.getByRole('button', { name: /Open menu, current section/ }).click();
    await page.getByRole('navigation', { name: 'Viewer sections' }).getByRole('button', { name: 'Live TV', exact: true }).click();
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    await page.getByRole('dialog', { name: 'Watch recording', exact: true })
      .getByRole('button', { name: 'Watch Live', exact: true }).click();
    video = await decoded();
    await assertPlaybackDetails(page, video, viewport, state, 'focused-Live');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === 2, 'focused Live Stop should retire its playback once');
    assert.equal(state.captureStopped, false, 'Details and navigation preserve the synthetic upstream capture');
    assert.deepEqual(errors, [], 'Details flows must not raise uncaught browser errors');
    console.log('PASS Details placement ' + viewport.width + 'x' + viewport.height +
      ': real DVR and focused Live, long title/Stop fit, quiet44px action beneath title, one Back, single modal/focus return, paused and playing media/source/generation preserved');
  } catch (error) {
    console.error('Synthetic Details state', JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector('video');
      return { video: v && { time: v.currentTime, paused: v.paused, ready: v.readyState },
        body: document.body.innerText.slice(-1800) };
    }).catch(() => ({ closed: true }))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}

async function exercise(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500, isMobile: viewport.width < 500,
  });
  let state;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  try {
    await page.goto(base);
    await page.getByRole('button', { name: /Open menu, current section/ }).click();
    await page.getByRole('navigation', { name: 'Viewer sections' }).getByRole('button', { name: 'DVR', exact: true }).click();
    await page.getByRole('button', { name: /^Recording \(/ }).click();
    await page.locator('.dvr-recording').first().waitFor();
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state, 'synthetic viewer has a separate test state');
    // The dedicated PlaybackStage hides global navigation. Exercise real menu
    // re-entry while the catalog is visible, then check background catalog
    // refresh separately during paused playback below.
    for (let entry = 1; entry <= 2; entry++) {
      const previousRequests = state.listRequests;
      state.catalogTitle = 'Synthetic active recording after DVR entry ' + entry;
      await page.getByRole('button', { name: /Open menu, current section/ }).click();
      await page.getByRole('navigation', { name: 'Viewer sections' })
        .getByRole('button', { name: 'DVR', exact: true }).click();
      await waitUntil(() => state.listRequests > previousRequests,
        'every DVR menu selection must refresh the catalog');
      await page.locator('.dvr-recording').first().getByRole('heading',
        { name: state.catalogTitle, exact: true }).waitFor();
    }
    const pane = page.locator('.dvr-section');
    const scroll = await pane.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      return { client: el.clientHeight, content: el.scrollHeight, top: el.scrollTop };
    });
    if (viewport.width >= 500) assert.ok(scroll.content > scroll.client && scroll.top > 0, 'desktop DVR list must scroll');
    await page.locator('.dvr-recording').last().scrollIntoViewIfNeeded();
    await pane.evaluate(el => { el.scrollTop = 0; });
    const recordingCard = page.locator('.dvr-recording').first();
    const compact = await recordingCard.evaluate(el => {
      const control = el.querySelector('.watch-control');
      return { buttons: control && [...control.querySelectorAll(':scope > button')]
        .map(button => button.getAttribute('aria-label') || button.textContent.trim()),
        watch: control?.getBoundingClientRect().toJSON(),
        status: el.querySelector('.recording-status')?.getBoundingClientRect().toJSON() };
    });
    assert.deepEqual(compact.buttons, ['Watch', 'Watch options'],
      'DVR recording rows should use the compact shared Watch dropdown');
    assert.ok(compact.status && compact.watch && compact.status.top >= compact.watch.bottom + 5,
      'DVR recording status should occupy its own row below Watch');
    await recordingCard.getByRole('button', { name: 'Watch options', exact: true }).click();
    const recordingMenu = page.getByRole('menu');
    await recordingMenu.getByRole('menuitem', { name: 'Extend 30 minutes', exact: true }).waitFor();
    assert.deepEqual(await recordingMenu.getByRole('menuitem').allTextContents(),
      ['Extend 30 minutes', 'Stop recording'], 'active DVR management should occupy only its dropdown');
    const menuRect = await recordingMenu.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(menuRect.left >= 0 && menuRect.top >= 0 && menuRect.right <= viewport.width + 1 &&
      menuRect.bottom <= viewport.height + 1, 'DVR recording menu must fit the viewport');
    await page.keyboard.press('Escape');
    assert.ok(await recordingCard.getByRole('button', { name: 'Watch options', exact: true })
      .evaluate(el => el === document.activeElement), 'DVR menu Escape should restore dropdown focus');
    assert.equal(state.captureStopped, false, 'inspecting recording options must leave capture running');
    await recordingCard.getByRole('button', { name: 'Watch', exact: true }).click();
    const recordingChoice = page.getByRole('dialog', { name: 'Watch recording', exact: true });
    await recordingChoice.waitFor();
    assert.equal(state.startRequests, 0, 'DVR recording choices must precede playback');
    assert.ok(await recordingChoice.getByRole('button', { name: 'Watch from Beginning', exact: true })
      .evaluate(el => el === document.activeElement), 'DVR choices should focus captured beginning');
    await page.keyboard.press('Escape');
    assert.ok(await recordingCard.getByRole('button', { name: 'Watch', exact: true })
      .evaluate(el => el === document.activeElement), 'DVR choices should restore Watch focus after Escape');
    await recordingCard.getByRole('button', { name: 'Watch', exact: true }).click();
    await recordingChoice.getByRole('button', { name: 'Watch from Beginning', exact: true }).click();
    const video = page.locator('video');
    await video.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 2 && v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
    const initial = await video.evaluate(v => {
      v.pause();
      window.syntheticAuditVideo = v;
      return { position: v.currentTime, width: v.videoWidth, height: v.videoHeight, decoded: v.getVideoPlaybackQuality().totalVideoFrames };
    });
    assert.equal(initial.width, 320, 'real H.264 fixture dimensions must decode');
    assert.equal(initial.height, 180, 'real H.264 fixture dimensions must decode');
    assert.ok(initial.decoded > 0 && initial.position < 3, 'active playback must start near zero rather than the 24-second live edge');
    await page.waitForFunction(() => document.querySelector('video').seekable.length &&
      document.querySelector('video').seekable.end(0) > 20);
    await video.evaluate(v => { v.currentTime = 8; });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 8) < 0.15;
    });
    const paused = await video.evaluate(v => ({ position: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
    await delay(800);
    assert.ok(await video.evaluate(v => v.paused && Math.abs(v.currentTime - 8) < 0.15), 'paused playback must not drift');
    assert.ok(paused.frames > 0, 'seek must retain decoded media');

    state.visibleSegments = 20;
    state.catalogTitle = 'Synthetic catalog refresh observed';
    state.catalogStatus = 'attention';
    await page.waitForFunction(() => { const v=document.querySelector('video'); return Number.isFinite(v.duration) && v.duration <= 81 && v.seekable.length && v.seekable.end(0) > 76; }, null, { timeout: 12000 });
    // Moving beyond the 60-second back buffer makes the beginning genuinely
    // unbuffered, so this verifies archive reload rather than a buffered seek.
    await video.evaluate(v => { v.currentTime = 70; });
    await page.waitForFunction(() => { const v=document.querySelector('video'); return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime-70) < 0.3; });
    await video.evaluate(v => v.play());
    await delay(500);
    await video.evaluate(v => v.pause());
    await page.waitForFunction(() => { const v=document.querySelector('video'); return ![...Array(v.buffered.length)].some((_,i)=>v.buffered.start(i)<=2 && v.buffered.end(i)>2); }, null, { timeout: 5000 });
    const headRequests = state.segmentHits['seg_00000.ts'] || 0;
    await video.evaluate(v => { v.currentTime = 2; });
    await page.waitForFunction(() => { const v=document.querySelector('video'); return !v.seeking && v.readyState >= 2 && v.paused && Math.abs(v.currentTime-2) < 0.2; });
    assert.ok((state.segmentHits['seg_00000.ts'] || 0) > headRequests, 'backward seek must reload an unbuffered retained segment');
    const initialLists = state.listRequests;
    await waitUntil(() => state.listRequests > initialLists, 'real 30-second catalog refresh did not run', 40000);
    assert.ok(await video.evaluate(v => v === window.syntheticAuditVideo && v.paused && Math.abs(v.currentTime - 2) < 0.2),
      'catalog refresh/status change must retain the same paused media element and position');
    await geometry(page, 'Active ' + viewport.width + 'x' + viewport.height);

    state.ended = true;
    await waitUntil(() => state.endedManifestRequests > 0, 'player did not observe the EVENT ENDLIST', 12000);
    assert.ok(await video.evaluate(v => v === window.syntheticAuditVideo && v.paused && !v.error),
      'ENDLIST must preserve paused playback during processing');
    state.fileReady = true;
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.currentSrc.endsWith('/file') && v.readyState >= 2 && !v.seeking &&
        v.paused && Math.abs(v.currentTime - 2) < 0.4;
    }, null, { timeout: 20000 });
    assert.ok(await video.evaluate(v => v === window.syntheticAuditVideo && v.videoWidth === 320 && v.getVideoPlaybackQuality().totalVideoFrames > 0),
      'completion must decode MP4 in the same element while preserving pause and position');
    assert.ok(state.fileRequests > 0 && state.statusRequests > 1 && state.startRequests === 1,
      'completion must reuse one playback generation and obtain status/file media');
    await geometry(page, 'Completed ' + viewport.width + 'x' + viewport.height);
    const completedControls = page.getByRole('group', { name: 'Recording player controls', exact: true });
    await completedControls.getByRole('slider', { name: 'Recording timeline', exact: true }).waitFor();
    assert.equal(await completedControls.getByRole('button', { name: 'Go Live', exact: true }).count(), 0,
      'completed capture retires live navigation while retaining the standard timeline');
    assert.ok(await video.evaluate(v => !v.controls), 'completion must not restore duplicate native controls');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-active-recording-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === 1, 'Stop must retire the playback generation');
    assert.equal(await page.locator('video').count(), 0, 'Stop removes playback');
    assert.equal(state.captureStopped, false, 'viewer Stop must not stop the upstream recording');
    assert.deepEqual(errors, [], 'browser must not raise uncaught errors');
    console.log('PASS real H.264/AAC EVENT ' + viewport.width + 'x' + viewport.height +
      ': compact DVR Watch/choices/focus, decoded frames, zero start, seek/pause, growing finite range, unbuffered backward seek, every DVR selection refreshes current rows, background catalog refresh preserves paused playback, ENDLIST, MP4 transition, layout, Stop');
  } catch (error) {
    console.error("Synthetic browser state", JSON.stringify(await page.evaluate(() => { const v=document.querySelector("video"); return { video:v && {time:v.currentTime, paused:v.paused, ready:v.readyState, duration:v.duration, error:v.error && {code:v.error.code, message:v.error.message}, buffered:[...Array(v.buffered.length)].map((_,i)=>[v.buffered.start(i),v.buffered.end(i)]), seekable:[...Array(v.seekable.length)].map((_,i)=>[v.seekable.start(i),v.seekable.end(i)])}, body:document.body.innerText.slice(-1000) }; }).catch(()=>({closed:true}))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}



async function exerciseLive(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500, isMobile: viewport.width < 500,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  let state;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('Live browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  const waitForFrames = async (label = 'Recording player') => {
    const video = page.getByLabel(label, { exact: true });
    await video.waitFor();
    await page.waitForFunction(label => {
      const v = [...document.querySelectorAll('video')].find(el => el.getAttribute('aria-label') === label);
      return v && v.readyState >= 2 && v.videoWidth === 320 && v.getVideoPlaybackQuality().totalVideoFrames > 0;
    }, label);
    return video;
  };
  const stopRecordingPlayback = async (expected) => {
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === expected, 'Live Stop did not retire the recording playback generation');
    assert.equal(await page.locator('video').count(), 0, 'Live Stop must remove playback');
    assert.equal(state.captureStopped, false, 'Live Stop must leave the upstream recording running');
  };
  const openChoice = async () => {
    const starts = state.startRequests;
    const streams = state.liveStreamRequests;
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Watch recording', exact: true });
    await dialog.waitFor();
    const beginning = dialog.getByRole('button', { name: 'Watch from Beginning', exact: true });
    const latest = dialog.getByRole('button', { name: 'Watch Live', exact: true });
    await beginning.waitFor();
    await latest.waitFor();
    assert.ok(await beginning.evaluate(el => el === document.activeElement),
      'recording popup should focus its beginning choice');
    const rect = await dialog.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
      'recording popup must fit its viewport: ' + JSON.stringify(rect));
    assert.equal(state.startRequests, starts, 'opening the recording popup must not start playback');
    assert.equal(state.liveStreamRequests, streams, 'opening the recording popup must not request the ordinary Live stream');
    assert.equal(await page.locator('video').count(), 0, 'recording popup must precede playback');
    return { dialog, beginning, latest };
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state, 'Live viewer needs a separate synthetic state');
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 1,
      'arriving viewer sees one Now Recording indicator');
    const dot = page.locator('.recording-status-dot');
    const renderedDot = () => dot.evaluate(el => {
      const style = getComputedStyle(el);
      return { color: style.backgroundColor, opacity: style.opacity, transform: style.transform,
        halo: style.boxShadow, animation: style.animationName };
    });
    const reducedStart = await renderedDot();
    assert.equal(reducedStart.animation, 'none', 'recording pulse must respect reduced motion');
    assert.equal(reducedStart.opacity, '1', 'reduced-motion recording dot must remain fully visible');
    assert.equal(reducedStart.transform, 'none', 'reduced-motion recording dot must remain unscaled');
    await delay(120);
    assert.deepEqual(await renderedDot(), reducedStart,
      'reduced-motion recording status must remain visually static');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const animationStart = await dot.evaluate(el => {
      const animation = el.getAnimations()[0];
      return animation && { state: animation.playState, time: animation.currentTime,
        duration: animation.effect.getTiming().duration };
    });
    assert.ok(animationStart && animationStart.state === 'running' && animationStart.duration > 0,
      'recording indicator must have a running animation');
    await delay(120);
    assert.ok(await dot.evaluate((el, previous) => el.getAnimations()[0]?.currentTime > previous + 30,
      animationStart.time), 'recording animation clock must actually advance');
    const pulseFrame = fraction => dot.evaluate(async (el, fraction) => {
      const animation = el.getAnimations()[0];
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration * fraction;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const style = getComputedStyle(el);
      return { color: style.backgroundColor, opacity: style.opacity,
        transform: style.transform, halo: style.boxShadow };
    }, fraction);
    const dim = await pulseFrame(0);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-recording-pulse-dim-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    const bright = await pulseFrame(0.5);
    assert.notEqual(bright.color, dim.color, 'rendered recording pulse must change red color');
    assert.ok(Math.abs(Number(bright.opacity) - Number(dim.opacity)) >= 0.3,
      'rendered recording pulse needs an observable brightness change');
    assert.notEqual(bright.transform, dim.transform, 'rendered recording pulse must change dot size');
    assert.notEqual(bright.halo, dim.halo, 'rendered recording pulse must change its soft halo');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-recording-pulse-bright-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await dot.evaluate(el => el.getAnimations()[0].play());

    const header = await page.locator('.live-recording-control').evaluate(el => {
      const status = el.querySelector('.recording-status');
      const watch = el.querySelector('.watch-control');
      return { status: status?.getBoundingClientRect().toJSON(), watch: watch?.getBoundingClientRect().toJSON(),
        pageWidth: document.documentElement.scrollWidth };
    });
    assert.ok(header.status && header.watch && header.pageWidth <= viewport.width + 1,
      'recording header must fit without horizontal document overflow');
    for (const rect of [header.status, header.watch]) {
      assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
        'recording header action/status must remain visible: ' + JSON.stringify(header));
    }
    assert.ok(header.status.top >= header.watch.bottom + 5,
      'Now Recording must occupy the next row below Watch with visible spacing on every device: ' +
      JSON.stringify(header));
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-recording-header-' + viewport.width + 'x' + viewport.height + '.png') });
    }

    // The dropdown is for external playback/sharing; browser playback has one
    // main action, and only the recording popup offers the two start positions.
    await page.getByRole('button', { name: 'Watch options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Share link', exact: true }).waitFor();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Watch in VLC', 'Share link'],
      'active recording dropdown should contain only VLC and sharing');
    await page.keyboard.press('Escape');

    let choice = await openChoice();
    await page.keyboard.press('Shift+Tab');
    assert.ok(await choice.dialog.evaluate(el => el.contains(document.activeElement)), 'recording popup must trap reverse keyboard focus');
    await page.keyboard.press('Tab');
    assert.ok(await choice.dialog.evaluate(el => el.contains(document.activeElement)), 'recording popup must trap keyboard focus');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-recording-choice-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Escape should close the recording popup');
    assert.ok(await page.getByRole('button', { name: 'Watch', exact: true }).evaluate(el => el === document.activeElement),
      'Escape should restore focus to Watch');
    assert.equal(state.startRequests, 0, 'cancelling the popup must not start recording playback');
    assert.equal(state.createRequests, 0, 'cancelling the popup must not create a capture');

    choice = await openChoice();
    await choice.latest.click();
    let video = await waitForFrames();
    const latest = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(latest >= 11 && latest <= 16, 'popup Watch Live must open near latest captured footage: ' + latest);
    assert.equal(state.startRequests, 1, 'watching an existing recording creates one playback generation');
    assert.equal(state.liveStreamRequests, 0, 'recording Watch Live must use retained recording playback');
    assert.equal(state.createRequests, 0, 'watching an existing recording does not create another capture');
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 1,
      'recording status appears once without a duplicate channel-header indicator');
    assert.equal(await page.locator('.recording-player-status').getByText('Now Recording', { exact: true }).count(), 1,
      'the one recording status belongs to the player outside its picture');
    await assertPlaybackDetails(page, video, viewport, state, 'focused-Live');
    await geometry(page, 'Live recording latest ' + viewport.width + 'x' + viewport.height);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-live-recording-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await stopRecordingPlayback(1);

    choice = await openChoice();
    await choice.beginning.click();
    video = await waitForFrames();
    const beginning = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(beginning < 3, 'arriving viewer beginning choice must open retained capture start: ' + beginning);
    assert.equal(state.startRequests, 2, 'beginning choice must create one fresh playback generation');
    assert.equal(state.liveStreamRequests, 0, 'beginning choice must use the retained capture');
    assert.equal(state.createRequests, 0, 'beginning choice must use the existing capture');
    await stopRecordingPlayback(2);

    // Simulate a channel without an active recording. Ordinary Live has no
    // start-position popup and does not start another recording generation.
    state.captureAvailable = false;
    await page.reload();
    await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 0,
      'channel without a recording must not show the red indicator');
    const recordingStarts = state.startRequests;
    await page.getByRole('button', { name: 'Watch Live', exact: true }).click();
    await waitUntil(() => state.liveStreamRequests > 0, 'ordinary Watch Live did not use the Live stream endpoint');
    await page.getByLabel('Live video for Synthetic test channel', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'ordinary Live must start directly without a popup');
    assert.equal(state.startRequests, recordingStarts, 'ordinary Live must not start recording playback');
    assert.equal(state.createRequests, 0, 'ordinary Live must not create a recording');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(state.captureStopped, false, 'ordinary Live Stop must leave capture running');

    // All capture mutations below are synthetic and local. Managers retain the
    // direct Watch & Record action when no capture exists.
    await page.getByRole('button', { name: 'Watch options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Watch & Record/ }).click();
    video = await waitForFrames();
    const createdLatest = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(createdLatest >= 11 && createdLatest <= 16,
      'Watch & Record must open latest captured footage: ' + createdLatest);
    assert.equal(state.createRequests, 1, 'Watch & Record creates exactly one synthetic capture');
    assert.ok(state.captureAvailable, 'new synthetic capture must be discoverable');
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 1,
      'new capture must show the recording status in its player');
    await stopRecordingPlayback(3);

    // A returning viewer sees the consolidated action instead of another
    // capture action. Completion while the popup is open retires stale choices.
    await page.reload();
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Watch options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Share link', exact: true }).waitFor();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Watch in VLC', 'Share link'],
      'returning viewer should use the existing recording');
    await page.keyboard.press('Escape');
    await openChoice();
    const beforeFinish = state.startRequests;
    state.captureAvailable = false;
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 18000 });
    await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 0,
      'capture completion should retire the recording indicator');
    assert.equal(state.startRequests, beforeFinish, 'capture completion must close the popup without starting stale playback');
    assert.equal(state.createRequests, 1, 'returning viewer must not create a second capture');
    assert.equal(state.captureStopped, false, 'all viewing flows leave the recording running');
    assert.deepEqual(errors, [], 'Live recording flows must not raise uncaught browser errors');
    console.log('PASS Live recording UI ' + viewport.width + 'x' + viewport.height +
      ': recording-only popup, focus/Escape/stale completion, latest/beginning H.264 decode, direct ordinary Live, VLC/share menu, Watch & Record, status below Watch, running visible red/brightness/size/halo pulse, static reduced-motion status, Stop retains capture');
  } catch (error) {
    console.error('Synthetic Live state', JSON.stringify(await page.evaluate(() => {
      const v=document.querySelector('video');
      return { video:v && { time:v.currentTime, paused:v.paused, ready:v.readyState, duration:v.duration,
        error:v.error && { code:v.error.code, message:v.error.message } }, body:document.body.innerText.slice(-1400) };
    }).catch(()=>({ closed:true }))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}


async function exerciseGuide(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500,
    isMobile: viewport.width < 500, reducedMotion: 'no-preference',
    extraHTTPHeaders: { 'X-Synthetic-Guide': '1' },
  });
  await context.addInitScript(() => localStorage.setItem('watch-now-guide-layout', 'agenda'));
  const page = await context.newPage();
  const errors = [];
  let state;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('Guide browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  const inspectButtons = async (dialog, label) => {
    const value = await dialog.evaluate(el => ({
      dialog: el.getBoundingClientRect().toJSON(),
      buttons: [...el.querySelectorAll('.guide-detail-actions button')].map(button => {
        const style = getComputedStyle(button);
        return { label: button.getAttribute('aria-label') || button.textContent.trim(),
          rect: button.getBoundingClientRect().toJSON(), radius: parseFloat(style.borderRadius),
          background: style.backgroundColor, image: style.backgroundImage, weight: style.fontWeight,
          primary: button.classList.contains('primary-button'), quiet: button.classList.contains('quiet-button') };
      }),
    }));
    assert.ok(value.dialog.left >= 0 && value.dialog.top >= 0 &&
      value.dialog.right <= viewport.width + 1 && value.dialog.bottom <= viewport.height + 1,
      label + ': Guide popup must fit the viewport ' + JSON.stringify(value.dialog));
    assert.ok(value.buttons.length >= 2, label + ': Guide popup needs actions and Close');
    for (const button of value.buttons) {
      assert.ok(button.primary || button.quiet, label + ': Guide action must use the shared button styles ' + button.label);
      assert.ok(button.rect.height >= 44 && button.radius >= 10,
        label + ': Guide actions need matching touch size and rounded corners ' + JSON.stringify(button));
      assert.ok(button.rect.left >= 0 && button.rect.right <= viewport.width + 1,
        label + ': Guide action must fit horizontally ' + JSON.stringify(button));
      assert.ok(button.image !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(button.background),
        label + ': Guide button needs a visible filled style ' + button.label);
    }
    return value;
  };
  const inspectDots = async (selector, expected, label) => {
    const colors = [];
    for (const [title, status] of Object.entries(expected)) {
      const button = page.locator(selector).filter({ hasText: title });
      await button.waitFor();
      const dot = button.locator('.tv-guide-recording-dot');
      if (!status) {
        await dot.waitFor({ state: 'detached' });
        assert.equal(await dot.count(), 0, label + ': unrelated or cancelled airing must have no dot ' + title);
        continue;
      }
      await dot.waitFor();
      assert.equal(await dot.count(), 1, label + ': one dot per marked airing ' + title);
      const result = await dot.evaluate(el => {
        const style = getComputedStyle(el);
        const button = el.closest('button');
        return { status: el.dataset.recordingStatus, hidden: el.getAttribute('aria-hidden'),
          animation: style.animationName, opacity: style.opacity, background: style.backgroundColor,
          rect: el.getBoundingClientRect().toJSON(), button: button.getBoundingClientRect().toJSON(),
          text: button.querySelector('strong')?.getBoundingClientRect().toJSON(), title: button.title, label: button.getAttribute('aria-label') || '' };
      });
      const statusLabel = status === 'recording' ? 'Recording now' : 'Scheduled recording';
      assert.equal(result.status, status, label + ': correct recording state ' + title);
      assert.equal(result.hidden, 'true', label + ': decorative dot avoids duplicate screen reader status');
      assert.equal(result.animation, 'none', label + ': guide dots must stay still with normal motion enabled');
      assert.equal(Number(result.opacity), 1, label + ': guide dots must be solid');
      const rgb = result.background.match(/[0-9.]+/g)?.map(Number) || [];
      assert.ok(rgb.length >= 3 && rgb[0] >= 180 && rgb[0] > rgb[1] + 50 && rgb[0] > rgb[2] + 50,
        label + ': guide dot must be visibly red ' + result.background);
      assert.ok(result.rect.width >= 5 && result.rect.height >= 5 &&
        result.rect.left >= result.button.left && result.rect.right <= result.button.right + 1 &&
        result.rect.top >= result.button.top && result.rect.bottom <= result.button.bottom + 1,
        label + ': dot must fit its programme button ' + JSON.stringify(result));
      assert.ok(!result.text || result.text.bottom <= result.rect.top || result.text.top >= result.rect.bottom ||
        result.text.right <= result.rect.left - 1,
        label + ': long wrapped programme title must not overlap its recording dot ' + JSON.stringify(result));
      assert.ok(result.title.includes(statusLabel) && result.label.includes(statusLabel),
        label + ': title and accessible button name expose the status ' + JSON.stringify(result));
      colors.push(result.background);
    }
    assert.ok(new Set(colors).size <= 1, label + ': scheduled and active recordings use the same red dot');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      label + ': guide dots must not add document overflow');
  };
  const inspectGuideDots = (currentStatus, label) => inspectDots('.tv-guide-program', {
    'Synthetic current programme': currentStatus,
    'Synthetic future programme': 'scheduled',
    'Synthetic unscheduled programme': null,
  }, label);
  const layoutButton = name => page.getByRole('group', { name: 'Guide layout', exact: true })
    .getByRole('button', { name, exact: true });
  const screenshot = async name => {
    if (!process.env.NOW_LAYOUT_SCREENSHOTS) return;
    fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
      name + '-' + viewport.width + 'x' + viewport.height + '.png') });
  };
  const currentProgram = () => page.locator('.tv-guide-program').filter({ hasText: 'Synthetic current programme' });
  const openCurrent = async () => {
    await currentProgram().click();
    const dialog = page.getByRole('dialog', { name: 'Synthetic current programme', exact: true });
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Guide details must use exactly one modal');
    return dialog;
  };
  const waitForRecordingFrames = async () => {
    const video = page.getByLabel('Recording player', { exact: true });
    await video.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video[aria-label="Recording player"]');
      return v && v.readyState >= 2 && v.videoWidth === 320 && v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
    return video;
  };
  const stopAndReturn = async (expected) => {
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === expected, 'Guide Stop must retire the recording generation');
    assert.equal(state.captureStopped, false, 'Guide playback Stop must leave the capture running');
    await page.getByRole('button', { name: /Back to Guide/ }).click();
    await currentProgram().waitFor();
    assert.equal(await page.locator('video').count(), 0, 'Back to Guide should leave no player');
  };
  const chooseInSameModal = async (dialog) => {
    await dialog.evaluate(el => { window.syntheticGuideModal = el; });
    const starts = state.startRequests;
    await dialog.getByRole('button', { name: 'Watch', exact: true }).click();
    const group = dialog.getByRole('group', { name: 'Watch recording', exact: true });
    await group.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1,
      'Guide recording choices must stay in the existing modal');
    assert.ok(await dialog.evaluate(el => el === window.syntheticGuideModal),
      'Guide recording choices must retain the same modal element');
    const beginning = group.getByRole('button', { name: 'Watch from Beginning', exact: true });
    const latest = group.getByRole('button', { name: 'Watch Live', exact: true });
    assert.ok(await beginning.evaluate(el => el === document.activeElement),
      'inline Guide recording choices should focus the beginning option');
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      'Guide recording choices must retain reverse focus inside the same modal');
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      'Guide recording choices must retain forward focus inside the same modal');
    assert.equal(state.startRequests, starts, 'opening Guide choices must not start playback');
    await inspectButtons(dialog, 'Guide recording choices');
    return { group, beginning, latest };
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state, 'Guide viewer needs a separate synthetic state');
    state.captureAvailable = false;
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Guide', exact: true }).click();
    await inspectGuideDots(null, 'Initial Guide List');
    await screenshot('synthetic-guide-dots-list-scheduled');
    await layoutButton('Grid').click();
    await inspectGuideDots(null, 'Initial Guide Grid');
    await screenshot('synthetic-guide-dots-grid-scheduled');
    await layoutButton('List').click();
    let dialog = await openCurrent();
    await dialog.getByRole('button', { name: 'Watch & Record', exact: true }).waitFor();
    assert.deepEqual(await dialog.getByRole('button').allTextContents(), ['Watch Live', 'Watch & Record', 'Record', 'Close'],
      'current manager Guide popup must expose direct Watch Live, Watch & Record, Record and Close');
    const currentButtons = await inspectButtons(dialog, 'Current Guide actions');
    assert.ok(currentButtons.buttons.find(button => button.label === 'Watch Live')?.primary,
      'Guide Watch Live should use the shared primary action style');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-guide-current-actions-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await dialog.getByRole('button', { name: 'Watch & Record', exact: true }).click();
    let video = await waitForRecordingFrames();
    const createdPosition = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(createdPosition >= 11 && createdPosition <= 16,
      'Guide Watch & Record must decode latest captured footage: ' + createdPosition);
    assert.equal(state.createRequests, 1, 'Guide Watch & Record must create exactly one capture');
    assert.equal(state.lastCreateCSRF, 'synthetic-token', 'Guide recording creation must include CSRF');
    assert.equal(state.startRequests, 1, 'Guide Watch & Record must start one playback generation');
    assert.equal(state.liveStreamRequests, 0, 'Guide Watch & Record must use recording playback');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Guide playback must close details');
    await geometry(page, 'Guide Watch & Record ' + viewport.width + 'x' + viewport.height);
    await stopAndReturn(1);
    await inspectGuideDots('recording', 'Guide List after capture creation');
    await screenshot('synthetic-guide-dots-list-recording');
    await layoutButton('Grid').click();
    await inspectGuideDots('recording', 'Guide Grid after capture creation');
    await screenshot('synthetic-guide-dots-grid-recording');

    state.guideLongTitle = true;
    const longTitleRequests = state.guideRequests;
    await page.getByRole('group', { name: 'Guide day', exact: true })
      .getByRole('button', { name: 'Now', exact: true }).click();
    await waitUntil(() => state.guideRequests > longTitleRequests, 'long Guide title fixture must refresh');
    await currentProgram().filter({ hasText: 'exceptionally long wrapped title' }).waitFor();
    await inspectGuideDots('recording', 'Long current title in Guide Grid');
    await screenshot('synthetic-guide-dots-grid-long-title');

    // Conflicting EPG listings retain status on the grouped grid button and
    // each matching chooser entry, without marking an adjacent partial overlap.
    state.guideOverlap = true;
    const guideRequests = state.guideRequests;
    await page.getByRole('group', { name: 'Guide day', exact: true })
      .getByRole('button', { name: 'Now', exact: true }).click();
    await waitUntil(() => state.guideRequests > guideRequests, 'Guide overlap fixture must refresh');
    const overlap = page.getByRole('button', { name: /Synthetic test channel, 3 overlapping listings/ });
    await overlap.waitFor();
    await inspectDots('.tv-guide-program', { 'Synthetic current programme': 'recording',
      'Synthetic unscheduled programme': null }, 'Grouped Guide Grid');
    await overlap.click();
    const conflict = page.getByRole('dialog', { name: 'Overlapping listings', exact: true });
    await conflict.waitFor();
    await inspectDots('.guide-conflict-list > button', {
      'Synthetic current programme': 'recording',
      'Synthetic future programme': 'scheduled',
      'Synthetic overlap programme': null,
    }, 'Guide overlap chooser');
    await screenshot('synthetic-guide-dots-overlap');
    await conflict.getByRole('button', { name: 'Close', exact: true }).click();
    state.guideOverlap = false;
    state.guideLongTitle = false;
    await layoutButton('List').click();
    await inspectGuideDots('recording', 'Guide List after overlap inspection');

    // A cancellation on another device is reflected on fresh Guide entry.
    state.guideScheduledAvailable = false;
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Browse', exact: true }).click();
    const listsBeforeCancel = state.listRequests;
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Guide', exact: true }).click();
    await waitUntil(() => state.listRequests > listsBeforeCancel, 'fresh Guide entry must refresh recording markers');
    await inspectDots('.tv-guide-program', {
      'Synthetic current programme': 'recording', 'Synthetic future programme': null,
      'Synthetic unscheduled programme': null,
    }, 'Guide after scheduled cancellation');
    state.guideScheduledAvailable = true;
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Browse', exact: true }).click();
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Guide', exact: true }).click();
    await inspectGuideDots('recording', 'Guide after schedule restoration');

    // A viewer with viewing access can choose either position in the existing
    // programme modal, without capture mutation or a nested modal.
    state.liveAccess = 'view';
    dialog = await openCurrent();
    await dialog.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    assert.equal(await dialog.getByText('Now Recording', { exact: true }).count(), 1,
      'active Guide recording should show Now Recording');
    assert.equal(await dialog.getByRole('button', { name: 'Watch & Record', exact: true }).count(), 0,
      'active Guide recording must not offer another capture');
    const header = await dialog.locator('.guide-watch-actions').evaluate(el => ({
      watch: el.querySelector('button').getBoundingClientRect().toJSON(),
      status: el.querySelector('.recording-status').getBoundingClientRect().toJSON(),
    }));
    assert.ok(header.status.top >= header.watch.bottom + 5, 'Guide recording status must occupy its own row');
    let choice = await chooseInSameModal(dialog);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-guide-recording-choices-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await choice.group.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Cancel choices should retain Guide details');
    assert.ok(await dialog.getByRole('button', { name: 'Watch', exact: true }).evaluate(el => el === document.activeElement),
      'Cancel Guide choices should restore Watch focus');
    assert.equal(state.startRequests, 1, 'Cancel Guide choices must not start playback');
    assert.equal(state.createRequests, 1, 'viewing and cancelling must not create another capture');

    choice = await chooseInSameModal(dialog);
    await choice.latest.click();
    video = await waitForRecordingFrames();
    const latest = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(latest >= 11 && latest <= 16, 'Guide Watch Live choice must decode latest footage: ' + latest);
    assert.equal(state.createRequests, 1, 'view-only Guide Watch Live must reuse the capture');
    assert.equal(state.liveStreamRequests, 0, 'Guide Watch Live choice must use retained recording playback');
    await stopAndReturn(2);

    dialog = await openCurrent();
    await dialog.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    choice = await chooseInSameModal(dialog);
    await choice.beginning.click();
    video = await waitForRecordingFrames();
    const beginning = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(beginning < 3, 'Guide beginning choice must decode from retained recording start: ' + beginning);
    assert.equal(state.createRequests, 1, 'view-only Guide beginning choice must reuse the capture');
    await stopAndReturn(3);

    state.liveAccess = 'manage';
    await page.locator('.tv-guide-program').filter({ hasText: 'Synthetic future programme' }).click();
    dialog = page.getByRole('dialog', { name: 'Synthetic future programme', exact: true });
    await dialog.waitFor();
    assert.deepEqual(await dialog.getByRole('button').allTextContents(), ['Record', 'Close'],
      'future Guide airing must offer Record and Close, without live watching choices');
    await inspectButtons(dialog, 'Future Guide actions');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-guide-future-actions-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    state.captureAvailable = false;
    dialog = await openCurrent();
    await dialog.getByRole('button', { name: 'Watch & Record', exact: true }).waitFor();
    const starts = state.startRequests;
    await dialog.getByRole('button', { name: 'Watch Live', exact: true }).click();
    await waitUntil(() => state.liveStreamRequests > 0, 'ordinary Guide Watch Live must use the Live stream');
    await page.getByLabel('Live video for Synthetic test channel', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'ordinary Guide Watch Live must close details directly');
    assert.equal(state.startRequests, starts, 'ordinary Guide Watch Live must not start recording playback');
    assert.equal(state.createRequests, 1, 'ordinary Guide Watch Live must not create another capture');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(state.captureStopped, false, 'Guide viewing must leave capture lifecycle unchanged');
    assert.deepEqual(errors, [], 'Guide popup/playback must not raise uncaught browser errors');
    console.log('PASS Guide recording UI ' + viewport.width + 'x' + viewport.height +
      ': static red scheduled/recording dots in Grid/List/overlap chooser, precise channel/airing matching and cancelled-marker refresh, styled direct current actions, one CSRF capture/latest H.264 decode, view-only single-modal choices/focus/cancel, latest/beginning decode, future Record-only, direct ordinary Live, Stop retains capture');
  } catch (error) {
    console.error('Synthetic Guide state', JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector('video');
      return { dialogs: document.querySelectorAll('[role="dialog"]').length,
        video: v && { time: v.currentTime, paused: v.paused, ready: v.readyState, duration: v.duration,
          error: v.error && { code: v.error.code, message: v.error.message } }, body: document.body.innerText.slice(-1600) };
    }).catch(() => ({ closed: true }))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}


async function exerciseSearch(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500,
    isMobile: viewport.width < 500, reducedMotion: 'reduce',
    extraHTTPHeaders: { 'X-Synthetic-Search': '1' },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors = [];
  let state;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('Search browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  const queryInput = () => page.getByRole('searchbox', { name: 'Search Live TV', exact: true });
  const scopes = () => page.getByRole('navigation', { name: 'Live TV search scope', exact: true });
  const nowCard = () => page.getByRole('region', { name: 'On now search results', exact: true })
    .locator('.program-search-card').filter({ hasText: 'Synthetic current programme' });
  const inspectActions = async (card, label) => {
    await card.scrollIntoViewIfNeeded();
    const value = await card.evaluate(el => {
      const control = el.querySelector('.watch-control');
      return { card: el.getBoundingClientRect().toJSON(), pageWidth: document.documentElement.scrollWidth,
        control: control?.getBoundingClientRect().toJSON(),
        buttons: [...el.querySelectorAll(control ? '.watch-control > button' : '.primary-button,.quiet-button')]
          .map(button => {
            const style = getComputedStyle(button);
            return { label: button.getAttribute('aria-label') || button.textContent.trim(),
              rect: button.getBoundingClientRect().toJSON(), leftRadius: parseFloat(style.borderTopLeftRadius),
              rightRadius: parseFloat(style.borderTopRightRadius), background: style.backgroundColor,
              image: style.backgroundImage, primary: button.classList.contains('primary-button') };
          }),
      };
    });
    assert.ok(value.card.left >= 0 && value.card.right <= viewport.width + 1 &&
      value.pageWidth <= viewport.width + 1, label + ': Search card must fit without horizontal overflow');
    for (const button of value.buttons) {
      assert.ok(button.rect.height >= 44,
        label + ': Search actions need shared touch-sized styles ' + JSON.stringify(button));
      assert.ok(button.rect.left >= 0 && button.rect.right <= viewport.width + 1,
        label + ': Search action must fit horizontally ' + JSON.stringify(button));
      assert.ok(button.image !== 'none' || !['transparent', 'rgba(0, 0, 0, 0)'].includes(button.background),
        label + ': Search action needs a visible filled style ' + button.label);
    }
    if (value.control) {
      assert.equal(value.buttons.length, 2, label + ': current Search card should show only Watch and its options trigger');
      const [watch, options] = value.buttons;
      assert.equal(options.label, 'Watch options', label + ': Watch options must be a joined dropdown trigger');
      assert.ok(watch.primary && watch.leftRadius >= 10 && options.rightRadius >= 10,
        label + ': joined Search control should retain rounded outer corners');
      assert.ok(Math.abs(watch.rect.top - options.rect.top) <= 1 &&
        Math.abs(watch.rect.right - options.rect.left) <= 1 &&
        Math.abs(watch.rect.height - options.rect.height) <= 1 && options.rect.width >= 44,
        label + ': Watch/options must be one compact split control');
      assert.ok(value.control.width <= 300 && value.control.height <= 46,
        label + ': Search split control must remain compact ' + JSON.stringify(value.control));
    } else {
      assert.ok(value.buttons.every(button => button.leftRadius >= 10 && button.rightRadius >= 10),
        label + ': future Record action should retain rounded shared styling');
    }
    return value;
  };
  const openSearchMenu = async (expected) => {
    await nowCard().getByRole('button', { name: 'Watch options', exact: true }).click();
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: expected[0], exact: true }).waitFor();
    const labels = await menu.getByRole('menuitem').evaluateAll(items =>
      items.map(item => item.getAttribute('aria-label') || item.textContent.trim()));
    assert.deepEqual(labels, expected, 'Search options must match the shared Browse menu');
    const rect = await menu.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
      'Search dropdown must remain inside its viewport ' + JSON.stringify(rect));
    assert.ok(await menu.evaluate(el => el.contains(document.activeElement)),
      'Search dropdown should contain keyboard focus');
    await page.keyboard.press('Home');
    assert.ok(await menu.getByRole('menuitem').first().evaluate(el => el === document.activeElement),
      'Home should focus the first Search menu item');
    await page.keyboard.press('ArrowDown');
    assert.ok(await menu.getByRole('menuitem').nth(1).evaluate(el => el === document.activeElement),
      'ArrowDown should advance Search menu focus');
    await page.keyboard.press('End');
    assert.ok(await menu.getByRole('menuitem').last().evaluate(el => el === document.activeElement),
      'End should focus the last Search menu item');
    await page.keyboard.press('Home');
    return menu;
  };
  const waitForFrames = async () => {
    const video = page.getByLabel('Recording player', { exact: true });
    await video.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video[aria-label="Recording player"]');
      return v && v.readyState >= 2 && v.videoWidth === 320 && v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
    return video;
  };
  const backToResults = async () => {
    await page.getByRole('button', { name: /Back to search results/ }).click();
    assert.equal(await queryInput().inputValue(), 'synthetic', 'Search playback return must retain the query');
    await nowCard().waitFor();
    assert.equal(await page.locator('video').count(), 0, 'returning to Search results must leave no player');
  };
  const stopAndReturn = async (expected) => {
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === expected, 'Search Stop must retire the recording generation');
    assert.equal(state.captureStopped, false, 'Search Stop must leave the upstream recording running');
    await backToResults();
  };
  const openChoice = async () => {
    const starts = state.startRequests;
    await nowCard().getByRole('button', { name: 'Watch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Watch recording', exact: true });
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Search recording choices must use one modal');
    const beginning = dialog.getByRole('button', { name: 'Watch from Beginning', exact: true });
    const latest = dialog.getByRole('button', { name: 'Watch Live', exact: true });
    assert.ok(await beginning.evaluate(el => el === document.activeElement),
      'Search recording popup should focus its beginning choice');
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      'Search recording popup must retain reverse keyboard focus');
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)),
      'Search recording popup must retain forward keyboard focus');
    const rect = await dialog.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
      'Search recording popup must fit its viewport');
    assert.equal(state.startRequests, starts, 'opening Search recording choices must not start playback');
    return { dialog, beginning, latest };
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Program guide for Previous browse channel', exact: true }).count(), 1,
      'Search VLC scenario must start with a different Browse selection');
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state, 'Search viewer needs a separate synthetic state');
    state.captureAvailable = false;
    await page.getByRole('navigation', { name: 'Browse, search or guide' })
      .getByRole('button', { name: 'Search', exact: true }).click();
    await queryInput().fill('synthetic');
    await scopes().getByRole('button', { name: 'On now', exact: true }).click();
    await nowCard().getByRole('button', { name: 'Watch options', exact: true }).waitFor();
    const currentActions = await inspectActions(nowCard(), 'Current Search control');
    assert.deepEqual(currentActions.buttons.map(button => button.label), ['Watch Live', 'Watch options'],
      'current manager Search card must show a compact Watch Live/options control');
    let menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-current-dropdown-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(), 0, 'Escape must close Search options');
    assert.ok(await nowCard().getByRole('button', { name: 'Watch options', exact: true }).evaluate(el => el === document.activeElement),
      'Escape should restore the Search dropdown trigger focus');

    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    await menu.getByRole('menuitem', { name: 'Record', exact: true }).click();
    let recordDialog = page.getByRole('dialog', { name: 'Record this airing?', exact: true });
    await recordDialog.waitFor();
    assert.equal(await recordDialog.getByRole('heading', { name: 'Synthetic current programme', exact: true }).count(), 1,
      'Search Record menu action must target its exact airing');
    await recordDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(state.createRequests, 0, 'cancelling the Record menu action must not create a capture');
    assert.ok(await nowCard().getByRole('button', { name: 'Watch options', exact: true }).evaluate(el => el === document.activeElement),
      'cancelling Search Record must restore the same card dropdown trigger focus');
    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    await menu.getByRole('menuitem', { name: 'Record', exact: true }).click();
    await recordDialog.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Escape must close the Search Record confirmation');
    assert.ok(await nowCard().getByRole('button', { name: 'Watch options', exact: true }).evaluate(el => el === document.activeElement),
      'Escape from Search Record must restore the same card dropdown trigger focus');

    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    await menu.getByRole('menuitem', { name: 'Share link', exact: true }).click();
    const share = page.getByRole('dialog', { name: 'Share link', exact: true });
    await share.getByLabel('Link', { exact: true }).waitFor();
    assert.equal(state.shareRequests, 1, 'Search Share link should create exactly one link');
    assert.equal(state.lastShareCSRF, 'synthetic-token', 'Search sharing must include CSRF');
    assert.deepEqual(state.lastShareBody, { kind: 'live', id: '1' }, 'Search sharing must target the card channel');
    const shareURL = await share.getByLabel('Link', { exact: true }).inputValue();
    assert.equal(shareURL, base + '/#/s/1' + 'S'.repeat(39), 'Search sharing must produce the bounded local share route');
    await share.getByRole('button', { name: 'Copy link', exact: true }).click();
    await share.getByText('Link copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shareURL,
      'Search Share link must copy its displayed URL');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-share-dialog-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await share.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'closing Search sharing should leave no dialog');
    assert.ok(await nowCard().getByRole('button', { name: 'Watch options', exact: true }).evaluate(el => el === document.activeElement),
      'closing Search sharing must restore its dropdown trigger focus');

    if (viewport.width < 500) {
      const cdp = await context.newCDPSession(page);
      const originalUA = await page.evaluate(() => navigator.userAgent);
      try {
        await cdp.send('Network.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        });
        menu = await openSearchMenu(['Watch & Record', 'Record', 'Open in VLC', 'Share link']);
        await menu.getByRole('menuitem', { name: 'Open in VLC', exact: true }).click();
        const explanation = page.getByRole('dialog', { name: 'Open in VLC', exact: true });
        await explanation.waitFor();
        assert.ok(await explanation.getByRole('button', { name: 'Open VLC', exact: true }).evaluate(el => el === document.activeElement),
          'Apple VLC explanation should focus its confirmation');
        await explanation.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(state.vlcRequests.length, 0, 'cancelling Apple VLC explanation must not request a handoff');
        assert.ok(await nowCard().getByRole('button', { name: 'Watch options', exact: true }).evaluate(el => el === document.activeElement),
          'cancelling Apple VLC explanation should restore Search dropdown focus');
      } finally {
        await cdp.send('Network.setUserAgentOverride', { userAgent: originalUA });
        await cdp.detach();
      }
    }

    // A bounded downloadable playlist verifies the exact Search channel.
    // The initial Browse selection is a different channel; no external app is launched.
    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    const downloadReady = page.waitForEvent('download');
    await menu.getByRole('menuitem', { name: 'Watch in VLC', exact: true }).click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), 'Synthetic test channel.m3u', 'Search VLC filename must match the result channel');
    const playlistPath = await download.path();
    assert.ok(playlistPath && fs.statSync(playlistPath).size < 2048, 'Search VLC fixture must be a bounded playlist');
    const playlist = fs.readFileSync(playlistPath, 'utf8');
    assert.equal(playlist, '#EXTM3U\n#EXTINF:-1,Synthetic test channel\n' + base + '/api/vlc/launch/' + 'V'.repeat(43) + '/synthetic.ts\n',
      'Search VLC playlist must contain only the card title and owned local launch route');
    assert.deepEqual(state.vlcRequests, ['1'], 'Search VLC must target its card rather than the previous Browse channel');
    assert.equal(state.lastVLCCSRF, 'synthetic-token', 'Search VLC must include CSRF');
    await page.locator('.vlc-handoff').waitFor();
    await page.getByRole('button', { name: /Back to search results/ }).click();
    assert.equal(await queryInput().inputValue(), 'synthetic', 'VLC handoff return must retain the Search query');

    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    await menu.getByRole('menuitem', { name: 'Watch & Record', exact: true }).click();
    let video = await waitForFrames();
    const created = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(created >= 11 && created <= 16, 'Search Watch & Record must decode latest captured footage: ' + created);
    assert.equal(state.createRequests, 1, 'Search Watch & Record must create exactly one capture');
    assert.equal(state.lastCreateCSRF, 'synthetic-token', 'Search Watch & Record must send CSRF');
    assert.deepEqual(state.lastCreateBody, { channel_id: '1', start: state.airingStart, end: state.airingEnd },
      'Search Watch & Record must use the exact selected airing');
    assert.equal(state.startRequests, 1, 'Search Watch & Record must start one recording generation');
    assert.equal(state.liveStreamRequests, 0, 'Search Watch & Record must use retained recording playback');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Search recording playback must leave no modal');
    await geometry(page, 'Search Watch & Record ' + viewport.width + 'x' + viewport.height);
    await stopAndReturn(1);

    state.liveAccess = 'view';
    // Reload once to make the permission transition visible in fresh card discovery.
    await page.reload();
    await nowCard().getByRole('button', { name: 'Watch', exact: true }).waitFor();
    assert.equal(await nowCard().getByText('Now Recording', { exact: true }).count(), 1,
      'active Search card must expose Now Recording');
    menu = await openSearchMenu(['Watch in VLC', 'Share link']);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-active-dropdown-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await page.keyboard.press('Escape');
    const header = await nowCard().evaluate(el => {
      const watch = [...el.querySelectorAll('button')].find(button => button.textContent.trim() === 'Watch');
      return { watch: watch.getBoundingClientRect().toJSON(),
        status: el.querySelector('.recording-status').getBoundingClientRect().toJSON() };
    });
    assert.ok(header.status.top >= header.watch.bottom + 5, 'Search recording status must occupy its own row');
    await inspectActions(nowCard(), 'Active Search action');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-active-recording-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    let choice = await openChoice();
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-recording-choices-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await choice.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0, 'Cancel must close Search recording choices');
    assert.ok(await nowCard().getByRole('button', { name: 'Watch', exact: true }).evaluate(el => el === document.activeElement),
      'Cancel Search recording choices must restore Watch focus');
    assert.equal(state.startRequests, 1, 'cancelling Search choices must not start playback');
    assert.equal(state.createRequests, 1, 'cancelling Search choices must not mutate the capture');

    choice = await openChoice();
    await choice.latest.click();
    video = await waitForFrames();
    const latest = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(latest >= 11 && latest <= 16, 'Search Watch Live recording choice must decode latest footage: ' + latest);
    assert.equal(state.createRequests, 1, 'view-only Search playback must reuse the recording');
    assert.equal(state.liveStreamRequests, 0, 'Search recording Live choice must use retained media');
    await stopAndReturn(2);

    await nowCard().getByRole('button', { name: 'Watch', exact: true }).waitFor();
    choice = await openChoice();
    await choice.beginning.click();
    video = await waitForFrames();
    const beginning = await video.evaluate(v => { v.pause(); return v.currentTime; });
    assert.ok(beginning < 3, 'Search beginning choice must decode retained recording start: ' + beginning);
    assert.equal(state.createRequests, 1, 'Search beginning choice must reuse the recording');
    await stopAndReturn(3);

    state.liveAccess = 'manage';
    await scopes().getByRole('button', { name: 'Upcoming', exact: true }).click();
    const futureCard = page.getByRole('region', { name: 'Upcoming search results', exact: true })
      .locator('.program-search-card').filter({ hasText: 'Synthetic future programme' });
    await futureCard.waitFor();
    const futureActions = await inspectActions(futureCard, 'Future Search actions');
    assert.deepEqual(futureActions.buttons.map(button => button.label), ['Record'],
      'future Search card must have only Record, without live playback choices');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-search-future-actions-' + viewport.width + 'x' + viewport.height + '.png') });
    }

    await scopes().getByRole('button', { name: 'Channels', exact: true }).click();
    await page.locator('.channel-search-result').first().waitFor();
    const beforeSelection = state.startRequests;
    await page.locator('.channel-search-result').first().click();
    await page.getByRole('button', { name: /Back to search results/ }).waitFor();
    assert.equal(await page.locator('video').count(), 0, 'selecting a Search channel must not autoplay');
    assert.equal(state.startRequests, beforeSelection, 'Search channel selection must not start recording playback');
    assert.equal(state.liveStreamRequests, 0, 'Search channel selection must not request the ordinary stream');
    await page.getByRole('button', { name: /Back to search results/ }).click();
    assert.equal(await queryInput().inputValue(), 'synthetic', 'channel detail return must retain Search query');

    state.captureAvailable = false;
    await scopes().getByRole('button', { name: 'On now', exact: true }).click();
    await nowCard().getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    const ordinaryStarts = state.startRequests;
    await nowCard().getByRole('button', { name: 'Watch Live', exact: true }).click();
    await waitUntil(() => state.liveStreamRequests > 0, 'ordinary Search Watch Live must use the Live stream');
    await page.getByLabel('Live video for Synthetic test channel', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'ordinary Search Watch Live must start without a recording popup');
    assert.equal(state.startRequests, ordinaryStarts, 'ordinary Search Watch Live must not start recording playback');
    assert.equal(state.createRequests, 1, 'ordinary Search Watch Live must not create another capture');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await backToResults();

    // The synthetic server creates the capture before delaying its response.
    // A query change must retire the card, retain the created capture, and stop
    // the late response from opening playback for an obsolete search result.
    await nowCard().getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    state.createResponseDelay = 750;
    const staleStarts = state.startRequests;
    menu = await openSearchMenu(['Watch & Record', 'Record', 'Watch in VLC', 'Share link']);
    await menu.getByRole('menuitem', { name: 'Watch & Record', exact: true }).click();
    await waitUntil(() => state.createRequests === 2, 'delayed synthetic Search creation was not received');
    await queryInput().fill('no matching airings');
    await waitUntil(() => state.delayedCreateResponses === 1, 'synthetic delayed creation response was not released');
    await page.getByText('No matching shows on now.', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0, 'query change must prevent stale recording playback');
    assert.equal(await page.getByRole('dialog').count(), 0, 'query change must prevent stale playback choices');
    assert.equal(state.startRequests, staleStarts, 'late creation response must not start stale playback');
    assert.equal(state.captureAvailable, true, 'query change must retain the already created capture');
    assert.equal(state.captureStopped, false, 'Search viewing/navigation must not stop recording capture');
    assert.deepEqual(errors, [], 'Search recording flows must not raise uncaught browser errors');
    console.log('PASS Search recording UI ' + viewport.width + 'x' + viewport.height +
      ': compact shared dropdown/keyboard/Escape, Record cancel/Escape focus, Share target/CSRF/copied URL, card-channel VLC playlist/CSRF, ' +
      (viewport.width < 500 ? 'Apple explanation cancel, ' : '') + 'exact-airing capture/latest H.264 decode, view-only popup/focus/cancel, latest/beginning decode, future Record-only, channel select without autoplay, retained query/back navigation, direct ordinary Live, stale query response retired');
  } catch (error) {
    console.error('Synthetic Search state', JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector('video');
      return { dialogs: document.querySelectorAll('[role="dialog"]').length,
        video: v && { time: v.currentTime, paused: v.paused, ready: v.readyState, duration: v.duration,
          error: v.error && { code: v.error.code, message: v.error.message } }, body: document.body.innerText.slice(-1700) };
    }).catch(() => ({ closed: true }))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}



async function assertRecordingBufferingProgress(page, video, viewport, state) {
  const spinner = page.getByRole('status', { name: 'Buffering recording', exact: true });
  await video.evaluate(v => {
    window.syntheticSpinnerReadyEvents = [];
    window.syntheticSpinnerReadyListener = event => window.syntheticSpinnerReadyEvents.push(event.type);
    v.addEventListener('playing', window.syntheticSpinnerReadyListener);
    v.addEventListener('canplay', window.syntheticSpinnerReadyListener);
  });
  try {
    // Fail a real background metadata request while MSE buffers keep decoding.
    // Its bounded retry must not reload the source or mask the moving picture.
    const statusRequests = state.statusRequests;
    const statusFailures = state.transientStatusFailures;
    state.failNextStatus = 1;
    const recovery = await video.evaluate(async v => {
      const start = v.currentTime;
      const frames = v.getVideoPlaybackQuality().totalVideoFrames;
      const sourceLoads = [];
      const onSourceLoad = () => sourceLoads.push(v.currentTime);
      v.addEventListener('loadstart', onSourceLoad);
      v.dispatchEvent(new Event('play'));
      const samples = [];
      for (let i = 0; i < 32; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        samples.push({ time: v.currentTime, paused: v.paused,
          spinner: Boolean(document.querySelector('.recording-player-buffering')) });
      }
      v.removeEventListener('loadstart', onSourceLoad);
      return { start, end: v.currentTime, frames, decoded: v.getVideoPlaybackQuality().totalVideoFrames,
        samples, sourceLoads, error: v.error?.code || 0 };
    });
    await waitUntil(() => state.transientStatusFailures === statusFailures + 1 &&
      state.statusRequests >= statusRequests + 2 && state.failNextStatus === 0,
      'failed metadata poll must perform one bounded status retry');
    assert.ok(recovery.end > recovery.start + 2.4 && recovery.decoded > recovery.frames &&
      recovery.error === 0 && recovery.sourceLoads.length === 0 &&
      recovery.samples.every(sample => !sample.paused && !sample.spinner),
      'buffered metadata retry must stay quiet without reloading advancing decoded video: ' + JSON.stringify(recovery));
    await video.evaluate(() => { window.syntheticSpinnerReadyEvents = []; });

    // Safari can emit network waiting/stalled notifications while buffered
    // footage is still advancing. No media-ready event should be needed here.
    const advancing = await video.evaluate(async v => {
      const start = v.currentTime;
      const frames = v.getVideoPlaybackQuality().totalVideoFrames;
      const samples = [];
      for (let i = 0; i < 36; i++) {
        v.dispatchEvent(new Event(i % 2 ? 'waiting' : 'stalled'));
        await new Promise(resolve => setTimeout(resolve, 100));
        samples.push({ time: v.currentTime, paused: v.paused,
          spinner: Boolean(document.querySelector('.recording-player-buffering')),
          controls: document.querySelector('media-controller.recording-player-controls')?.dataset.controlsVisible });
      }
      return { start, end: v.currentTime, frames, decoded: v.getVideoPlaybackQuality().totalVideoFrames,
        samples, readyEvents: [...window.syntheticSpinnerReadyEvents] };
    });
    assert.ok(advancing.end > advancing.start + 2.5 && advancing.decoded > advancing.frames &&
      advancing.samples.every(sample => !sample.paused && !sample.spinner),
      'spurious Safari waiting/stalled events must not cover advancing decoded video: ' + JSON.stringify(advancing));
    assert.deepEqual(advancing.readyEvents, [], 'progress-only spinner recovery must not depend on playing/canplay');
    assert.equal(advancing.samples.at(-1).controls, 'false',
      'spurious network events must not pin controls after the playing hide timeout');

    // Hold the real media clock at rate zero while viewing remains unpaused.
    // Unlike a fake currentTime getter, this does not provoke HLS gap healing.
    // It models a stationary picture for the UI; it is not a network-stall test.
    await video.evaluate(v => {
      const rate = v.playbackRate;
      window.syntheticSpinnerClockRestore = () => { v.playbackRate = rate; };
      v.playbackRate = 0;
      v.dispatchEvent(new Event('waiting'));
    });
    try {
      await delay(650);
      assert.equal(await spinner.count(), 0, 'brief nonadvancing waits retain the buffering grace period');
      await spinner.waitFor({ timeout: 4000 });
      assert.ok(await video.evaluate(v => !v.paused), 'confirmed stall retains the active viewing intent');
      assert.equal(await page.locator('media-controller.recording-player-controls')
        .getAttribute('data-controls-visible'), 'true', 'confirmed buffering keeps transport controls available');
      if (process.env.NOW_LAYOUT_SCREENSHOTS) {
        await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
          'synthetic-confirmed-recording-stall-' + viewport.width + 'x' + viewport.height + '.png') });
      }
    } finally {
      await video.evaluate(() => {
        window.syntheticSpinnerClockRestore?.();
        delete window.syntheticSpinnerClockRestore;
      });
    }
    await spinner.waitFor({ state: 'detached', timeout: 1500 });
    assert.deepEqual(await page.evaluate(() => window.syntheticSpinnerReadyEvents), [],
      'advancing timeupdate must clear a confirmed spinner without new playing/canplay events');
    await page.waitForFunction(() => document.querySelector('media-controller.recording-player-controls')
      ?.getAttribute('data-controls-visible') === 'false', null, { timeout: 4500 });
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-progress-recovered-recording-' + viewport.width + 'x' + viewport.height + '.png') });
    }
  } finally {
    await video.evaluate(v => {
      window.syntheticSpinnerClockRestore?.();
      delete window.syntheticSpinnerClockRestore;
      v.removeEventListener('playing', window.syntheticSpinnerReadyListener);
      v.removeEventListener('canplay', window.syntheticSpinnerReadyListener);
      delete window.syntheticSpinnerReadyListener;
    });
  }

  // Pausing intentionally is distinct from active buffering.
  await video.evaluate(v => {
    v.pause();
    v.dispatchEvent(new Event('waiting'));
    v.dispatchEvent(new Event('stalled'));
  });
  await delay(1400);
  assert.equal(await spinner.count(), 0, 'paused media must not display a buffering spinner');
  const pausedPosition = await video.evaluate(v => v.currentTime);
  await video.evaluate(v => v.play());
  await page.waitForFunction(position => {
    const v = document.querySelector('video[aria-label="Recording player"]');
    return !v.paused && v.currentTime > position + 0.25;
  }, pausedPosition);
}

async function assertStandardRecordingControls(page, video, viewport, state) {
  const controls = page.getByRole('group', { name: 'Recording player controls', exact: true });
  const timeline = controls.getByRole('slider', { name: 'Recording timeline', exact: true });
  const play = controls.locator('media-play-button');
  const mute = controls.locator('media-mute-button');
  const fullscreen = controls.locator('media-fullscreen-button');
  const current = async () => video.evaluate(v => v.currentTime);
  const waitSeek = async target => page.waitForFunction(value => {
    const v = document.querySelector('video[aria-label="Recording player"]');
    return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - value) < 0.5;
  }, target);
  const setTimeline = async value => {
    // The native setter and real input event exercise React's controlled range,
    // including engine clamping, instead of writing video.currentTime directly.
    await timeline.evaluate((input, desired) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(desired));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };

  const statusPlacement = await page.evaluate(() => {
    const status = document.querySelector('.recording-player-status');
    const v = document.querySelector('video[aria-label="Recording player"]');
    return { status: status?.getBoundingClientRect().toJSON(), video: v?.getBoundingClientRect().toJSON() };
  });
  assert.ok(statusPlacement.status && statusPlacement.video &&
    statusPlacement.status.bottom <= statusPlacement.video.top + 1,
    'Now Recording stays outside the picture');
  assert.equal(await page.getByRole('status', { name: 'Buffering recording', exact: true }).count(), 0,
    'buffering indicator retires after current media decodes');

  await setTimeline(8);
  await waitSeek(8);
  await play.click();
  await page.waitForFunction(() => {
    const v = document.querySelector('video[aria-label="Recording player"]');
    return !v.paused && v.currentTime > 8.3 && v.currentTime < 11;
  });
  await play.click();
  const resumePosition = await current();
  await delay(350);
  assert.ok(await video.evaluate((v, position) => v.paused && Math.abs(v.currentTime - position) < 0.2, resumePosition),
    'standard Play/Pause resumes the selected position rather than jumping to live');

  const mutedBefore = await video.evaluate(v => v.muted);
  await mute.click();
  assert.equal(await video.evaluate(v => v.muted), !mutedBefore, 'toolkit mute changes real media audio state');
  await mute.click();
  assert.equal(await video.evaluate(v => v.muted), mutedBefore, 'toolkit unmute restores media audio state');

  if (viewport.width >= 500 && await fullscreen.evaluate(el => !el.hasAttribute('disabled'))) {
    await fullscreen.click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.ok(await video.evaluate(v => document.fullscreenElement?.contains(v)),
      'fullscreen includes the same media and integrated controls');
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await page.locator('video').count(), 1, 'fullscreen return keeps one media element');
  }

  // Simulate an upstream retained-footage gap while using the real media fixture.
  // The engine must clamp the slider request into captured media, preserving pause.
  await video.evaluate(v => {
    Object.defineProperty(v, 'seekable', { configurable: true, get: () => ({
      length: 2, start: i => i === 0 ? 0 : 40, end: i => i === 0 ? 20 : 80,
    }) });
    v.dispatchEvent(new Event('progress'));
  });
  await setTimeline(35);
  await page.waitForFunction(() => {
    const v = document.querySelector('video[aria-label="Recording player"]');
    return v.paused && !v.seeking && v.readyState >= 2 && v.currentTime > 19.5 && v.currentTime < 20;
  });
  await video.evaluate(v => {
    delete v.seekable;
    v.dispatchEvent(new Event('progress'));
  });
  await setTimeline(12);
  await waitSeek(12);
  if (process.env.NOW_LAYOUT_SCREENSHOTS) {
    await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
      'synthetic-standard-recording-controls-' + viewport.width + 'x' + viewport.height + '.png') });
  }

  // Paused controls remain available beyond the playing hide timeout.
  await timeline.focus();
  await delay(3200);
  assert.equal(await controls.getAttribute('data-controls-visible'), 'true', 'paused/focused controls remain visible');
  await play.click();
  await page.waitForFunction(() => !document.querySelector('video[aria-label="Recording player"]').paused);
  await timeline.focus();
  await delay(3200);
  assert.equal(await controls.getAttribute('data-controls-visible'), 'true', 'keyboard focus keeps playing controls visible');

  // A real pointer drag shows a draft without repeatedly seeking the source.
  const sliderRect = await timeline.boundingBox();
  const beforeDrag = await current();
  await page.mouse.move(sliderRect.x + sliderRect.width * 0.55, sliderRect.y + sliderRect.height / 2);
  await page.mouse.down();
  await delay(3200);
  assert.equal(await controls.getAttribute('data-controls-visible'), 'true', 'a held scrub keeps controls visible');
  const duringDrag = await current();
  assert.ok(duringDrag < beforeDrag + 6 && duringDrag < 30,
    'pointer scrub does not seek until commit: ' + JSON.stringify({ beforeDrag, duringDrag }));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.ok(await current() < 30, 'Escape cancels the pending scrub without a delayed seek');

  // Mouse/touch button focus must not pin the chrome forever after Play.
  // Keyboard focus remains protected, as verified above.
  await play.click();
  assert.ok(await video.evaluate(v => v.paused), 'pointer Pause applies to current playback');
  await play.click();
  assert.ok(await video.evaluate(v => !v.paused), 'pointer Play resumes current playback');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => {
    const v = document.querySelector('video[aria-label="Recording player"]');
    return !v.paused && !v.seeking && v.readyState >= 3;
  });
  await assertRecordingBufferingProgress(page, video, viewport, state);
  await page.waitForFunction(() => document.querySelector('media-controller.recording-player-controls')
    ?.getAttribute('data-controls-visible') === 'false', null, { timeout: 6500 });
  if (process.env.NOW_LAYOUT_SCREENSHOTS) {
    await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
      'synthetic-standard-recording-hidden-' + viewport.width + 'x' + viewport.height + '.png') });
  }
  const videoRect = await video.boundingBox();
  if (viewport.width < 500) await page.touchscreen.tap(videoRect.x + videoRect.width / 2, videoRect.y + videoRect.height / 3);
  else await page.mouse.move(videoRect.x + videoRect.width / 2, videoRect.y + videoRect.height / 3);
  await page.waitForFunction(() => document.querySelector('media-controller.recording-player-controls')
    ?.getAttribute('data-controls-visible') === 'true');
  if (viewport.width < 500) {
    await page.waitForFunction(() => document.querySelector('media-controller.recording-player-controls')
      ?.getAttribute('data-controls-visible') === 'false', null, { timeout: 6500 });
    await page.touchscreen.tap(videoRect.x + videoRect.width / 2, videoRect.y + videoRect.height / 3);
    await page.waitForFunction(() => document.querySelector('media-controller.recording-player-controls')
      ?.getAttribute('data-controls-visible') === 'true');
  }
  await play.click();
  assert.ok(await video.evaluate(v => v.paused), 'revealed controls can pause the current source');
  await setTimeline(0);
  await waitSeek(0);
  await geometry(page, 'Standard player controls ' + viewport.width + 'x' + viewport.height);
}

async function exerciseColdStartup(viewport) {
  const context = await browser.newContext({
    viewport, timezoneId: 'America/Denver', hasTouch: viewport.width < 500,
    isMobile: viewport.width < 500, reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    window.syntheticMediaEvents = [];
    for (const name of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing',
      'pause', 'waiting', 'error', 'emptied', 'seeking', 'seeked', 'progress', 'durationchange']) {
      document.addEventListener(name, event => {
        const v = event.target;
        if (!(v instanceof HTMLVideoElement)) return;
        window.syntheticMediaEvents.push({ event: name, time: v.currentTime, paused: v.paused,
          ready: v.readyState, error: v.error?.code || 0,
          buffered: [...Array(v.buffered.length)].map((_, i) => [v.buffered.start(i), v.buffered.end(i)]) });
        if (window.syntheticMediaEvents.length > 40) window.syntheticMediaEvents.shift();
      }, true);
    }
  });
  const page = await context.newPage();
  const errors = [];
  let state;
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      failures.push('Cold recording browser attempted an external request');
      return route.abort();
    }
    return route.continue();
  });
  const waitForFrames = async () => {
    const video = page.getByLabel('Recording player', { exact: true });
    await video.waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector('video[aria-label="Recording player"]');
      return v && v.readyState >= 2 && v.videoWidth === 320 &&
        v.getVideoPlaybackQuality().totalVideoFrames > 0;
    });
    return video;
  };
  const startExisting = async (position) => {
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Watch recording', exact: true });
    await dialog.getByRole('button', { name: position, exact: true }).click();
  };
  const assertPreparing = async (phase) => {
    await waitUntil(() => state.statusHistory.some(item => item.phase === phase && item.mode === 'waiting'),
      'cold startup did not check the ' + phase + ' captured-media phase');
    const video = page.getByLabel('Recording player', { exact: true });
    await video.waitFor();
    await page.getByRole('status', { name: 'Buffering recording', exact: true }).waitFor();
    assert.equal(await page.getByText('Now Recording', { exact: true }).count(), 1,
      phase + ': the recording status must remain visible while waiting');
    assert.ok(await video.evaluate(v => !v.currentSrc && !v.getAttribute('src') && v.readyState === 0),
      phase + ': no browser HLS attachment is allowed before usable captured footage');
    assert.equal(state.manifestRequests, 0, phase + ': player must not fetch a premature manifest');
    assert.equal(Object.keys(state.segmentHits).length, 0, phase + ': player must not fetch premature segments');
    assert.equal(state.createRequests, 1, phase + ': waiting must not create a second recording');
    assert.equal(state.startRequests, 1, phase + ': waiting must reuse one playback generation');
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    const cookies = await context.cookies();
    state = states.get(cookies.find(cookie => cookie.name === 'synthetic_session').value);
    assert.ok(state, 'cold recording viewer needs its own synthetic state');
    state.captureAvailable = false;
    state.coldStartup = true;
    state.coldPhase = 'missing';
    state.visibleSegments = 0;
    await page.reload();
    await page.getByRole('button', { name: 'Watch Live', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Watch options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Watch & Record/ }).click();
    await assertPreparing('missing');
    state.coldPhase = 'empty';
    await assertPreparing('empty');
    state.coldPhase = 'one';
    state.visibleSegments = 1;
    await assertPreparing('one');
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      fs.mkdirSync(process.env.NOW_LAYOUT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-cold-recording-preparing-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    state.coldPhase = 'ready';
    state.visibleSegments = 3;
    state.segmentPreparationFailuresRemaining = 1;
    const video = await waitForFrames();
    const first = await video.evaluate(v => {
      v.pause();
      window.syntheticColdVideo = v;
      return { position: v.currentTime, width: v.videoWidth,
        decoded: v.getVideoPlaybackQuality().totalVideoFrames };
    });
    assert.ok(first.width === 320 && first.decoded > 0 && first.position < 3,
      'three fresh four-second segments must decode from a safe captured position: ' + JSON.stringify(first));
    assert.equal(state.prematureManifestRequests, 0, 'cold startup must never attach unusable recording HLS');
    assert.equal(state.transientSegmentFailures, 1, 'a temporary segment preparation failure must recover on the first entry');
    assert.equal(state.createRequests, 1, 'first Watch & Record must create only one capture');
    assert.equal(state.startRequests, 1, 'first Watch & Record must play without re-entering or restarting a generation');
    assert.equal(state.liveStreamRequests, 0, 'cold Watch & Record must use retained footage');
    assert.equal(await page.getByRole('dialog').count(), 0, 'cold first playback must leave no error or choice popup');

    state.visibleSegments = 20;
    await page.waitForFunction(() => {
      const v = document.querySelector('video[aria-label="Recording player"]');
      return v.seekable.length && v.seekable.end(v.seekable.length - 1) > 76;
    }, null, { timeout: 12000 });
    await assertPlaybackDetails(page, video, viewport, state, 'cold-focused-Live');
    await video.evaluate(v => { v.currentTime = 30; });
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 30) < 0.3;
    });
    const controls = page.getByRole('group', { name: 'Recording player controls', exact: true });
    const rewind = controls.getByRole('button', { name: 'Back 15 seconds', exact: true });
    const forward = controls.getByRole('button', { name: 'Forward 15 seconds', exact: true });
    const timeline = controls.getByRole('slider', { name: 'Recording timeline', exact: true });
    const goLive = controls.getByRole('button', { name: 'Go Live', exact: true });
    await controls.waitFor();
    assert.ok(await video.evaluate(v => !v.controls && v.getAttribute('slot') === 'media'),
      'active recording uses one integrated controls bar without duplicate native controls');
    assert.equal(await page.locator('.playback-loading, .recording-navigation').count(), 0,
      'standard player removes routine picture messages and external navigation buttons');
    const timelineBounds = await timeline.evaluate(el => ({ min: Number(el.min), max: Number(el.max), label: el.getAttribute('aria-valuetext') }));
    assert.ok(timelineBounds.min < 1 && timelineBounds.max >= 67 && timelineBounds.max <= 69,
      'timeline spans retained beginning to safe captured edge: ' + JSON.stringify(timelineBounds));
    assert.ok(timelineBounds.label, 'timeline exposes an accessible time description');
    const controlLayout = await controls.evaluate(el => ({
      rect: el.getBoundingClientRect().toJSON(),
      buttons: [...el.querySelectorAll('button,media-play-button,media-mute-button,media-fullscreen-button')]
        .filter(button => getComputedStyle(button).display !== 'none')
        .map(button => ({ label: button.getAttribute('aria-label') || button.tagName, rect: button.getBoundingClientRect().toJSON() })),
    }));
    assert.ok(controlLayout.rect.left >= 0 && controlLayout.rect.right <= viewport.width + 1 &&
      controlLayout.buttons.every(button => button.rect.width >= 43 && button.rect.height >= 43 &&
        button.rect.left >= 0 && button.rect.right <= viewport.width + 1),
      'integrated icon controls retain 44-pixel targets within the viewport: ' + JSON.stringify(controlLayout));
    await rewind.click();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 15) < 0.4;
    });
    await forward.click();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 30) < 0.4;
    });
    await timeline.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && v.currentTime < 1;
    });
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 68) < 0.4;
    });
    await timeline.focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v.paused && !v.seeking && v.readyState >= 2 && v.currentTime < 1;
    });
    await assertStandardRecordingControls(page, video, viewport, state);
    await goLive.click();
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      const end = v.seekable.length && v.seekable.end(v.seekable.length - 1);
      return !v.seeking && v.readyState >= 2 && end > 76 &&
        v.currentTime >= end - 13 && v.currentTime <= end - 10;
    });
    const liveStatus = page.getByRole('group', { name: 'Recording player controls', exact: true })
      .getByRole('button', { name: 'LIVE', exact: true });
    await liveStatus.waitFor();
    assert.ok(await liveStatus.isDisabled(), 'Go Live resumes playback and becomes a non-actionable LIVE status');
    assert.ok(await video.evaluate(v => !v.paused), 'paused Go Live intentionally resumes captured playback');
    const live = await video.evaluate(v => {
      v.pause();
      return { position: v.currentTime, end: v.seekable.end(v.seekable.length - 1) };
    });
    await delay(400);
    assert.ok(await video.evaluate(v => v === window.syntheticColdVideo && v.paused &&
      Math.abs(v.currentTime - (v.seekable.end(v.seekable.length - 1) - 12)) < 2),
      'recording navigation must preserve its media element and a safe live delay');
    await geometry(page, 'Cold recording navigation ' + viewport.width + 'x' + viewport.height);
    if (process.env.NOW_LAYOUT_SCREENSHOTS) {
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        'synthetic-cold-recording-playing-' + viewport.width + 'x' + viewport.height + '.png') });
    }
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === 1, 'cold first playback Stop must retire its generation');

    // Preparing the active generation is a transient, typed response; retry
    // it without creating a second capture or asking the viewer to re-enter.
    state.startPreparationFailuresRemaining = 1;
    await startExisting('Watch from Beginning');
    const retriedVideo = await waitForFrames();
    assert.ok(await retriedVideo.evaluate(v => v.currentTime < 3),
      'a generation-preparing retry must preserve the beginning start choice');
    assert.equal(state.startRequests, 3, 'one preparing response should require exactly one bounded start retry');
    assert.equal(state.createRequests, 1, 'generation start recovery must not create another recording');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests === 2, 'recovered generation Stop must retire playback');

    // Authorization failures must remain immediate, unlike capture readiness.
    state.denyActiveStatus = true;
    await startExisting('Watch Live');
    await page.getByText('This recording is no longer available to your account. Return to DVR.', { exact: true }).waitFor();
    const deniedRequests = state.statusRequests;
    await delay(600);
    assert.equal(state.statusRequests, deniedRequests, 'revoked recording access must not enter a readiness retry loop');
    assert.equal(await page.locator('video').count(), 0, 'revoked recording access must remove its media element');
    assert.equal(state.createRequests, 1, 'authorization failure must not restart capture');
    state.denyActiveStatus = false;

    // Leaving during preparation cancels pending retries and preserves capture.
    state.coldPhase = 'cancelled';
    state.visibleSegments = 0;
    await page.reload();
    await page.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    await startExisting('Watch Live');
    await waitUntil(() => state.statusHistory.some(item => item.phase === 'cancelled' && item.mode === 'waiting'),
      'cancelled startup must first reach the preparing state');
    const beforeCancel = state.statusRequests;
    const retired = state.stopRequests;
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitUntil(() => state.stopRequests > retired, 'Stop during preparation must retire its generation');
    await delay(2500);
    assert.equal(state.statusRequests, beforeCancel, 'leaving preparation must cancel scheduled status retries');
    assert.equal(await page.locator('video').count(), 0, 'leaving preparation must leave no hidden media');
    assert.equal(state.captureStopped, false, 'all synthetic viewing flows must keep capture running');

    // Inspect the same compact DVR controls at both phone widths after leaving
    // playback; opening menus/choices must not start or mutate another capture.
    state.shortDVRDescription = true;
    await page.getByRole('button', { name: /Open menu, current section/ }).click();
    await page.getByRole('navigation', { name: 'Viewer sections' })
      .getByRole('button', { name: 'DVR', exact: true }).click();
    await page.getByRole('button', { name: /^Recording \(/ }).click();
    const card = page.locator('.dvr-recording').first();
    await card.getByRole('button', { name: 'Watch', exact: true }).waitFor();
    const statusTabs = page.getByRole('navigation', { name: 'DVR status', exact: true });
    assert.ok(await statusTabs.getByRole('button', { name: /^Recording \(/ })
      .evaluate(el => el.classList.contains('is-active')), 'DVR should visibly mark the selected Recording filter');
    const tabLayout = await statusTabs.getByRole('button').evaluateAll(buttons => buttons.map(el => ({
      text: el.textContent, rect: el.getBoundingClientRect().toJSON(),
      clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
    })));
    assert.ok(tabLayout.every(tab => tab.rect.left >= 0 && tab.rect.right <= viewport.width + 1 &&
      tab.scrollWidth <= tab.clientWidth + 1), 'DVR status labels should fit without overlapping or clipping');
    if (viewport.width <= 380) {
      assert.ok(Math.abs(tabLayout[0].rect.top - tabLayout[1].rect.top) <= 1 &&
        Math.abs(tabLayout[2].rect.top - tabLayout[3].rect.top) <= 1 &&
        tabLayout[2].rect.top >= tabLayout[0].rect.bottom + 3,
        'narrow DVR status filters should use two readable columns');
    }
    const header = await card.evaluate(el => {
      const control = el.querySelector('.watch-control');
      return { control: control.getBoundingClientRect().toJSON(),
        status: el.querySelector('.recording-status').getBoundingClientRect().toJSON(),
        pageWidth: document.documentElement.scrollWidth };
    });
    assert.ok(header.control.width <= 180 && header.status.top >= header.control.bottom + 5 &&
      header.pageWidth <= viewport.width + 1, 'active DVR Watch and status must remain compact and fit');
    const screenshot = async name => {
      if (!process.env.NOW_LAYOUT_SCREENSHOTS) return;
      await page.screenshot({ path: path.join(process.env.NOW_LAYOUT_SCREENSHOTS,
        name + '-' + viewport.width + 'x' + viewport.height + '.png') });
    };
    await screenshot('synthetic-dvr-active-catalog');
    await card.getByRole('button', { name: 'Watch options', exact: true }).click();
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Extend 30 minutes', exact: true }).waitFor();
    const menuRect = await menu.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(menuRect.left >= 0 && menuRect.right <= viewport.width + 1 &&
      menuRect.top >= 0 && menuRect.bottom <= viewport.height + 1, 'active DVR options should fit narrow phones');
    await screenshot('synthetic-dvr-active-menu');
    await page.keyboard.press('Escape');
    const startsBeforeChoice = state.startRequests;
    await card.getByRole('button', { name: 'Watch', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: 'Watch recording', exact: true });
    await chooser.getByRole('button', { name: 'Watch from Beginning', exact: true }).waitFor();
    const choiceRect = await chooser.evaluate(el => el.getBoundingClientRect().toJSON());
    assert.ok(choiceRect.left >= 0 && choiceRect.right <= viewport.width + 1 &&
      choiceRect.top >= 0 && choiceRect.bottom <= viewport.height + 1, 'DVR recording chooser should fit narrow phones');
    await screenshot('synthetic-dvr-recording-choices');
    await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(state.startRequests, startsBeforeChoice, 'inspecting DVR choices must not start another playback');
    assert.equal(state.createRequests, 1, 'inspecting DVR controls must not create another recording');
    assert.deepEqual(errors, [], 'cold recording startup must not raise uncaught browser errors');
    console.log('PASS cold Watch & Record ' + viewport.width + 'x' + viewport.height +
      ': missing/empty/one captured segment waits with recording status, three segments decode on first entry, one capture/generation, ' +
      'temporary segment 409 recovers, integrated timeline/15-second skips/play-pause/mute/fullscreen/visibility/gap clamps, quiet buffered retries and spurious waiting/stalled progress ignored; confirmed buffering clears without media-ready events, safe Go Live ' + live.position.toFixed(1) + '/' + live.end.toFixed(1) +
      ', typed generation-preparing retry, authorization failure stops, preparation cancellation retains capture, compact DVR catalog/menu/chooser');
  } catch (error) {
    console.error('Synthetic cold recording state', JSON.stringify(await page.evaluate(() => {
      const v = document.querySelector('video');
      return { video: v && { time: v.currentTime, paused: v.paused, ready: v.readyState,
        duration: v.duration, error: v.error && { code: v.error.code, message: v.error.message },
        buffered: [...Array(v.buffered.length)].map((_, i) => [v.buffered.start(i), v.buffered.end(i)]),
        seekable: [...Array(v.seekable.length)].map((_, i) => [v.seekable.start(i), v.seekable.end(i)]) },
        mediaEvents: window.syntheticMediaEvents, body: document.body.innerText.slice(-1700) };
    }).catch(() => ({ closed: true }))), JSON.stringify(state));
    throw error;
  } finally {
    await context.close();
  }
}

(async () => {
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'build frontend before running this test');
  const fixture = fixtures();
  server = http.createServer((req, res) => {
    if (++requests > MAX_SYNTHETIC_REQUESTS) {
      failures.push('synthetic request limit exceeded');
      if (requests === MAX_SYNTHETIC_REQUESTS + 1) console.error('Synthetic fixture request cap reached', JSON.stringify({ requests, limit: MAX_SYNTHETIC_REQUESTS }));
      res.writeHead(429); return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/api/session') {
      let state = stateFor(req);
      if (!state) {
        const id = String(++nextSession);
        const now = Date.now();
        state = { id, visibleSegments: 6, ended: false, fileReady: false,
          catalogTitle: req.headers['x-synthetic-details'] === '1' ? SYNTHETIC_DETAILS_TITLE : 'Synthetic active recording',
          detailsScenario: req.headers['x-synthetic-details'] === '1',
          catalogStatus: 'recording', listRequests: 0, startRequests: 0, statusRequests: 0, stopRequests: 0,
          endedManifestRequests: 0, manifestRequests: 0, prematureManifestRequests: 0, fileRequests: 0, captureStopped: false, segmentHits: {},
          coldStartup: false, coldPhase: 'ready', statusHistory: [], startPreparationFailuresRemaining: 0, denyActiveStatus: false,
          failNextStatus: 0, transientStatusFailures: 0,
          segmentPreparationFailuresRemaining: 0, transientSegmentFailures: 0,
          captureAvailable: true, createRequests: 0, liveStreamRequests: 0, lookupRequests: 0, liveAccess: 'manage', lastCreateCSRF: '', lastCreateBody: null, createResponseDelay: 0, delayedCreateResponses: 0,
          guideScenario: req.headers['x-synthetic-guide'] === '1', guideScheduledAvailable: true, guideOverlap: false, guideLongTitle: false, guideRequests: 0,
          searchScenario: req.headers['x-synthetic-search'] === '1', shareRequests: 0, lastShareBody: null, lastShareCSRF: '', vlcRequests: [], lastVLCCSRF: '',
          airingStart: new Date(now - 300000).toISOString(), airingEnd: new Date(now + 1800000).toISOString(),
          futureEnd: new Date(now + 3600000).toISOString() };
        states.set(id, state);
        res.setHeader('Set-Cookie', 'synthetic_session=' + id + '; HttpOnly; SameSite=Strict; Path=/');
      }
      return json(res, 200, { user: { username: 'synthetic-viewer' }, csrf_token: 'synthetic-token' });
    }
    const state = stateFor(req);
    if (p.startsWith('/api/')) {
      if (!state) return json(res, 401, { error: { message: 'Synthetic session required' } });
      if (req.headers.authorization || req.headers['x-api-key']) failures.push('unexpected credential in synthetic browser request');
      if (req.method === 'POST' && req.headers['x-csrf-token'] !== 'synthetic-token')
        return json(res, 403, { error: { message: 'Synthetic CSRF failed' } });
      if (p === '/api/share' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 65536) { failures.push('synthetic share request exceeded its body bound'); req.destroy(); }
        });
        req.on('end', () => {
          try { state.lastShareBody = JSON.parse(body); } catch {
            failures.push('synthetic share request had invalid JSON');
            return json(res, 400, { error: { message: 'Synthetic JSON required' } });
          }
          state.shareRequests++; state.lastShareCSRF = req.headers['x-csrf-token'];
          return json(res, 201, { token: '1' + 'S'.repeat(39) });
        });
        return;
      }
      if (p === '/api/share') return json(res, 200, { enabled: true });
      const vlc = /^\/api\/live\/channels\/([12])\/vlc$/.exec(p);
      if (vlc && req.method === 'POST') {
        state.vlcRequests.push(vlc[1]); state.lastVLCCSRF = req.headers['x-csrf-token'];
        return json(res, 201, { launch_url: '/api/vlc/launch/' + 'V'.repeat(43) + '/synthetic.ts' });
      }
      if (p === '/api/live/channels/2/recordings') return json(res, 200, { access: state.liveAccess, items: [] });
      if (p === '/api/dvr/connection') return json(res, 200, { connected: true, managed: true, access: 'manage' });
      if (p === '/api/live/channels/1/recordings') {
        state.lookupRequests++;
        return json(res, 200, { access: state.liveAccess, items: state.captureAvailable ? [{ ...record(state), channel_id: '1' }] : [] });
      }
      if (p === '/api/dvr/recordings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 65536) { failures.push('synthetic recording request exceeded its body bound'); req.destroy(); }
        });
        req.on('end', () => {
          try { state.lastCreateBody = JSON.parse(body); } catch {
            failures.push('synthetic recording creation had invalid JSON');
            return json(res, 400, { error: { message: 'Synthetic JSON required' } });
          }
          state.createRequests++; state.captureAvailable = true; state.lastCreateCSRF = req.headers['x-csrf-token'];
          const reply = () => json(res, 201, { recording: { ...record(state), channel_id: '1' }, already_scheduled: false });
          if (state.createResponseDelay) setTimeout(() => { state.delayedCreateResponses++; reply(); }, state.createResponseDelay);
          else reply();
        });
        return;
      }
      if (p === '/api/live/channels/1/stream') {
        state.liveStreamRequests++;
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        return res.end(Buffer.concat(fixture.entries.map(entry => fs.readFileSync(path.join(temp, entry.name)))));
      }
      if (p === '/api/dvr/recordings') {
        state.listRequests++;
        if (state.guideScenario) {
          const futureStart = Date.parse(state.airingEnd), futureEnd = Date.parse(state.futureEnd);
          const channel = { id: '1', name: 'Synthetic test channel', channel_number: '1' };
          const entry = (id, title, start, end, status, channelValue = channel) => ({
            id, title, channel: channelValue, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
            status, playable: status === 'recorded', can_watch_active: status === 'recording',
            ...(id === '7' ? { airing_id: 'a'.repeat(32) } : id === '90' ? { airing_id: 'b'.repeat(32) } : {}),
          });
          const items = [
            ...(state.captureAvailable ? [entry('7', 'Synthetic current programme',
              Date.parse(state.airingStart), futureStart, 'recording')] : []),
            ...(state.guideScheduledAvailable ? [entry('90', 'Synthetic future programme', futureStart, futureEnd, 'scheduled')] : []),
            entry('91', 'Synthetic unscheduled programme', futureEnd, futureEnd + 1800000, 'recording',
              { id: '2', name: 'Other synthetic channel', channel_number: '2' }),
            entry('92', 'Synthetic unscheduled programme', futureEnd, futureEnd + 1800000, 'recorded'),
            entry('93', 'Unrelated boundary capture', futureEnd - 60000, futureEnd, 'recording'),
          ];
          return json(res, 200, { access: state.liveAccess, items });
        }
        return json(res, 200, { access: 'manage', items: Array.from({ length: 30 }, (_, i) => record(state, i)) });
      }
      if (p === '/api/dvr/recordings/7/active-playback' && req.method === 'POST') {
        state.startRequests++;
        if (state.startPreparationFailuresRemaining > 0) {
          state.startPreparationFailuresRemaining--;
          return json(res, 409, { error: { code: 'recording_preparing', message: 'Synthetic recording is preparing' } });
        }
        return json(res, 201, { generation: '1', manifest_url: '/api/dvr/recordings/7/active/1/index.m3u8',
          status_url: '/api/dvr/recordings/7/active/1/status', stop_url: '/api/dvr/recordings/7/active/1/stop' });
      }
      const active = /^\/api\/dvr\/recordings\/7\/active\/1\/(.+)$/.exec(p);
      if (active) {
        const asset = active[1];
        if (asset === 'status') {
          state.statusRequests++;
          if (state.denyActiveStatus)
            return json(res, 403, { error: { code: 'dvr_permission_denied', message: 'Synthetic recording access ended' } });
          if (state.failNextStatus > 0) {
            state.failNextStatus--; state.transientStatusFailures++;
            return json(res, 503, { error: { code: 'upstream_unavailable', message: 'Synthetic metadata interruption' } });
          }
          const mode = state.fileReady ? 'file' :
            state.coldStartup && !state.ended && state.visibleSegments < 3 ? 'waiting' : 'hls';
          state.statusHistory.push({ phase: state.coldPhase, mode, segments: state.visibleSegments });
          return json(res, 200, mode === 'file' ?
            { mode: 'file', stream_url: '/api/dvr/recordings/7/active/1/file' } :
            { mode, recording: !state.ended, live_delay_seconds: 12 });
        }
        if (asset === 'stop' && req.method === 'POST') { state.stopRequests++; res.writeHead(204); return res.end(); }
        if (asset === 'file') {
          if (!state.fileReady) return json(res, 409, { error: { code: 'recording_preparing', message: 'Synthetic file not ready' } });
          state.fileRequests++;
          return media(res, req, path.join(temp, 'completed.mp4'), 'video/mp4');
        }
        if (asset === 'index.m3u8') {
          state.manifestRequests++;
          if (state.coldStartup && !state.ended && state.visibleSegments < 3) state.prematureManifestRequests++;
          if (state.coldStartup && state.coldPhase === 'missing') {
            res.setHeader('Retry-After', '3');
            return json(res, 409, { error: { code: 'recording_preparing', message: 'Synthetic manifest not ready' } });
          }
          if (state.ended) state.endedManifestRequests++;
          const lines = [...fixture.headers];
          for (const entry of fixture.entries.slice(0, state.visibleSegments))
            lines.push(entry.duration, '/api/dvr/recordings/7/active/1/' + entry.name);
          if (state.ended) lines.push('#EXT-X-ENDLIST');
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
          return res.end(lines.join('\n') + '\n');
        }
        if (/^seg_[0-9]+\.ts$/.test(asset) && fixture.entries.slice(0, state.visibleSegments).some(entry => entry.name === asset)) {
          if (state.segmentPreparationFailuresRemaining > 0) {
            state.segmentPreparationFailuresRemaining--;
            state.transientSegmentFailures++;
            return json(res, 409, { error: { code: 'recording_preparing', message: 'Synthetic segment not ready' } });
          }
          state.segmentHits[asset] = (state.segmentHits[asset] || 0) + 1;
          return media(res, req, path.join(temp, asset), 'video/mp2t');
        }
      }
      if (p === '/api/dvr/recordings/7/stop') state.captureStopped = true;
      if (p === '/api/live/guide') {
        state.guideRequests++;
        const now = Date.now();
        const channel = { id: '1', name: 'Synthetic test channel', channel_number: '1', category_id: '1' };
        const program = (id, title, start, end) => ({ id, channel, title,
          start: new Date(start).toISOString(), end: new Date(end).toISOString(),
          description: 'Synthetic programme details for testing Guide actions.' });
        return json(res, 200, { items: [{ channel, programs: [
          program('a'.repeat(32), state.guideLongTitle ? 'Synthetic current programme with an exceptionally long wrapped title for phone layout checks'
            : 'Synthetic current programme', Date.parse(state.airingStart), Date.parse(state.airingEnd)),
          program('b'.repeat(32), 'Synthetic future programme', Date.parse(state.airingEnd), Date.parse(state.futureEnd)),
          ...(state.guideScenario ? [
            ...(state.guideOverlap ? [program('c'.repeat(32), 'Synthetic overlap programme',
              Date.parse(state.airingEnd) - 300000, Date.parse(state.futureEnd))] : []),
            program('d'.repeat(32), 'Synthetic unscheduled programme', Date.parse(state.futureEnd), Date.parse(state.futureEnd) + 1800000),
          ] : []),
        ] }], has_more: false, page: 1, snapshot: 'synthetic-guide',
          fetched_at: new Date(now).toISOString() });
      }
      if (p === '/api/live/programs/search') {
        const upcoming = url.searchParams.get('status') === 'upcoming';
        const query = (url.searchParams.get('search') || '').toLowerCase();
        const channel = { id: '1', name: 'Synthetic test channel', channel_number: '1', category_id: '1' };
        const items = query.includes('synthetic') ? [{
          id: upcoming ? 'search-future' : 'search-current', channel,
          title: upcoming ? 'Synthetic future programme' : 'Synthetic current programme',
          start: upcoming ? state.airingEnd : state.airingStart,
          end: upcoming ? state.futureEnd : state.airingEnd,
          description: 'Synthetic programme details for testing Search actions.',
        }] : [];
        return json(res, 200, { items, total: items.length, page: 1, page_size: 20 });
      }
      if (p === '/api/live/search/capabilities') return json(res, 200, { program_search: true, guide: true, dvr: true });
      if (p === '/api/live/channels') return json(res, 200, [
        ...(state.searchScenario ? [{ id: '2', name: 'Previous browse channel', channel_number: '2', category_id: '1' }] : []),
        { id: '1', name: state.detailsScenario ? SYNTHETIC_DETAILS_TITLE : 'Synthetic test channel', channel_number: '1', category_id: '1' },
      ]);
      if (p.endsWith('/categories')) return json(res, 200, [{ id: '1', name: 'Synthetic' }]);
      if (p.endsWith('/epg')) return json(res, 200, { current: {
        title: 'Synthetic current programme', start: state.airingStart,
        end: state.airingEnd, description: 'Synthetic current programme for local browser testing.',
      }, upcoming: null });
      return json(res, 404, { error: { message: 'Synthetic endpoint unavailable' } });
    }
    const filename = path.resolve(dist, '.' + (p === '/' ? '/index.html' : p));
    if (!filename.startsWith(dist + path.sep) || !fs.existsSync(filename)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' :
      filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    fs.createReadStream(filename).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const probe = await browser.newPage();
  const supported = await probe.evaluate(() => Boolean(window.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')));
  await probe.close();
  assert.ok(supported, 'this Chromium runtime needs H.264/AAC MediaSource support');
  const viewports = [{ width: 1366, height: 768 }, { width: 390, height: 844 }];
  const scenario = process.env.NOW_ACTIVE_RECORDING_SCENARIOS || 'all';
  assert.ok(['all', 'cold', 'baseline', 'guide', 'details'].includes(scenario), 'unsupported recording scenario selection');
  if (scenario === 'details') await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseDetails));
  if (scenario === 'guide') await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseGuide));
  if (scenario !== 'baseline' && scenario !== 'guide' && scenario !== 'details') await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseColdStartup));
  if (scenario !== 'cold' && scenario !== 'guide' && scenario !== 'details') {
    await Promise.all(viewports.map(exercise));
    await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseLive));
    await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseGuide));
    await Promise.all([...viewports, { width: 320, height: 740 }].map(exerciseSearch));
  }
  console.log('Synthetic request audit', JSON.stringify({ requests, failures }));
  assert.deepEqual(failures, [], 'synthetic test must stay local and bounded');
  console.log('Synthetic Chromium fixture only: phone-width checks are not Safari; final MP4 behavior does not establish stock Dispatcharr MKV or native Live Broadcast controls.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
});
