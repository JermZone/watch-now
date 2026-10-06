// Synthetic real-browser coverage. Uses an existing Playwright/Chromium install;
// no Dispatcharr credentials, real media, or recording mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const browsers = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserName = process.env.NOW_TEST_BROWSER || 'chromium';
const host = process.env.NOW_TEST_HOST || '127.0.0.1';
const screenshotDir = process.env.NOW_SHARE_SCREENSHOTS;
if(screenshotDir) fs.mkdirSync(screenshotDir,{recursive:true});
const dist = path.resolve(process.env.NOW_LAYOUT_DIST || 'frontend/dist');
const targets = new Map();
let number = 0;
let mediaRequests = 0;
let playbackFixture = false;
const channels = [{id:'1',name:'First channel'}, {id:'41',name:'Shared channel',has_artwork:true}];
const titles = Array.from({length:20},(_,i)=>({id:String(i+1),name:`Movie ${i+1}`}));
const server = http.createServer(async(req,res)=> {
 const url = new URL(req.url,'http://localhost');
 const send = (body,status=200,headers={}) => {res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
 const session = {user:{username:'synthetic'},csrf_token:'test-csrf'};
 if(url.pathname==='/api/auth/login') return send(session,200,{'Set-Cookie':'synthetic=1; HttpOnly; SameSite=Strict; Path=/'});
 if(url.pathname==='/api/health/ready')return send({reachable:true});
 if(url.pathname.startsWith('/api/')) {
  if(!req.headers.cookie?.includes('synthetic=1'))return send({error:{code:'session_expired',message:'Sign in'}},401);
  const p=url.pathname;
  if(p==='/api/session')return send(session);
  if(p==='/api/share' && req.method==='GET')return send({enabled:true});
  if(req.method==='POST' && p.startsWith('/api/share')) {
   let body='';for await(const chunk of req)body+=chunk;
   const data=JSON.parse(body);
   if(p==='/api/share/resolve')return targets.has(data.token)?send(targets.get(data.token)):send({error:{message:'This item is unavailable to your account.'}},404);
   const token='1'+String(++number).padStart(44,'A');targets.set(token,data);return send({token},201);
  }
  if(p==='/api/live/search/capabilities')return send({program_search:true,guide:true,dvr:true});
  if(p==='/api/live/categories')return send([]);
  if(p==='/api/live/channels')return send(channels);
  if(p==='/api/live/channels/41/artwork') {res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="steelblue"/><text x="12" y="40" fill="white" font-size="24">TV</text></svg>');}
  if(p.endsWith('/epg'))return send({});
  if(p==='/api/movies/categories'||p==='/api/series/categories')return send([]);
  if(p==='/api/movies')return send({items:titles,total:20});
  if(/^\/api\/movies\/\d+$/.test(p))return send({id:p.split('/').at(-1),name:`Movie ${p.split('/').at(-1)}`,plot:'Sample details. '.repeat(400)});
  if(p==='/api/series')return send({items:[{id:'8',name:'Sample series'}],total:1});
  if(p==='/api/series/8')return send({id:'8',name:'Sample series',seasons:[{number:2,episodes:[{id:'10',title:'Other episode',episode_number:2},{id:'9',title:'Shared episode',episode_number:3}]}]});
  if(p==='/api/dvr/connection')return send({connected:true,access:'view',managed:true});
  if(p==='/api/dvr/recordings')return send({access:'view',items:Array.from({length:30},(_,i)=>({id:String(i+1),title:playbackFixture ? `Recording ${i+1} with an unusually long title and extra episode information to exercise constrained playback` : `Recording ${i+1}`,description:playbackFixture ? 'Long recording details remain accessible in the details dialog. '.repeat(100) : '',channel:channels[1],status:'recorded',playable:true,start:new Date(Date.now()-i*3600000).toISOString(),end:new Date().toISOString()}))});
  if(playbackFixture && p.endsWith('/stream')) {res.writeHead(200,{'Content-Type':'video/mp4'});res.flushHeaders();return;}
  if(p.endsWith('/stream')){mediaRequests++;return send({},404);}
  return send({},404);
 }
 const relative=url.pathname.startsWith('/assets/')?url.pathname.slice(1):'index.html';
 const file=path.resolve(dist,relative);
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(file));
});
async function login(page) {await page.getByLabel('Username').fill('synthetic');await page.getByLabel('Password',{exact:true}).fill('test-only');await page.getByRole('button',{name:'Open Watch Now',exact:true}).click();}
async function section(page,name) {await page.getByRole('button',{name:/Open menu, current section/}).click();await page.getByRole('navigation',{name:'Viewer sections'}).getByRole('button',{name,exact:true}).click();}
async function share(page,control) {
 await control.getByRole('button',{name:'Watch options'}).click();await control.getByRole('menuitem',{name:'Share link'}).click();
 const dialog=page.getByRole('dialog',{name:'Share link'});
 await dialog.getByRole('textbox',{name:'Link'}).waitFor();
 const link=await dialog.getByRole('textbox',{name:'Link'}).inputValue();
 assert.match(link,/#\/s\/1[A-Za-z0-9_-]+$/);
 assert.ok(!link.includes('Movie')&&!link.includes('Recording')&&!link.includes('Shared'));
 await page.evaluate(()=>{ window.copiedSelection = null; document.addEventListener('copy',()=>{ const el=document.activeElement; window.copiedSelection=el.value?.slice(el.selectionStart,el.selectionEnd); },{once:true}); });
 await dialog.getByRole('button',{name:'Copy link'}).click();
 await dialog.getByText('Link copied',{exact:true}).waitFor();
 if(await page.evaluate(()=>!navigator.clipboard)) assert.equal(await page.evaluate(()=>window.copiedSelection),link,'HTTP fallback copies the current link');
 await dialog.getByRole('button',{name:'Close',exact:true}).click();return link;
}
(async()=>{
 await new Promise(resolve=>server.listen(0,host,resolve));
 const base=`http://${host}:${server.address().port}`;
 let browser;
 try {
  browser=await browsers[browserName].launch({headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await login(page);
  await page.getByRole('button',{name:'Watch Live',exact:true}).waitFor();
  // Live link opens an authorized channel without starting it.
  await page.getByRole('option',{name:/Shared channel/}).click();
  const liveLink=await share(page,page.locator('.watch-control'));
  await page.reload();await page.getByRole('region',{name:'Selected channel: Shared channel'}).waitFor();
  await section(page,'Movies');await page.getByRole('button',{name:/All Titles/}).click();
  await page.locator('.poster-card').filter({has:page.getByText('Movie 7',{exact:true})}).click();
  const movieLink=await share(page,page.locator('.watch-control'));
  await page.locator('.media-section').evaluate(el=>{el.scrollTop=500;});
  await page.waitForTimeout(350);
  await page.reload();await page.getByRole('heading',{name:'Movie 7',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.media-section')?.scrollTop>=450);
  assert.equal(await page.locator('video').count(),0);
  await page.waitForTimeout(300);
  await section(page,'Series');await page.getByRole('button',{name:/All Titles/}).click();
  await page.locator('.poster-card').filter({has:page.getByText('Sample series',{exact:true})}).click();
  await page.getByRole('button',{name:/Shared episode/}).click();
  const episodeLink=await share(page,page.locator('.watch-control'));
  await page.reload();await page.getByRole('button',{name:'Watch',exact:true}).waitFor();
  await section(page,'DVR');
  await page.getByRole('button',{name:'Next',exact:true}).click();
  const recording=page.locator('[data-recording-id="25"]');
  const recordingLink=await share(page,recording.locator('.watch-control'));
  await page.reload();await page.locator('[data-recording-id="25"]').waitFor();
  // Independent browser context simulates a recipient, with no sender session/storage.
  for(const [link,kind] of [[liveLink,'live'],[movieLink,'movie'],[episodeLink,'episode'],[recordingLink,'recording']]) {
   const recipient=await browser.newPage({viewport:{width:1366,height:768}});
   await recipient.goto(link);await login(recipient);
   if(kind==='live') {
    await recipient.getByRole('region',{name:'Selected channel: Shared channel'}).waitFor();
    assert.equal(await recipient.getByRole('region',{name:'Channel list'}).count(),0);
    if(screenshotDir) await recipient.screenshot({path:path.join(screenshotDir,`${browserName}-channel.png`)});
    await recipient.reload();await recipient.getByRole('button',{name:/Back to Live TV/}).click();
    await recipient.getByRole('region',{name:'Channel list'}).waitFor();
   }
   if(kind==='movie')await recipient.getByRole('heading',{name:'Movie 7',exact:true}).waitFor();
   if(kind==='episode') {
    await recipient.getByRole('heading',{name:'Shared episode',exact:true}).waitFor();
    assert.equal(await recipient.getByRole('combobox',{name:'Season'}).count(),0);
    assert.equal(await recipient.getByText('Other episode',{exact:false}).count(),0);
    if(screenshotDir) await recipient.screenshot({path:path.join(screenshotDir,`${browserName}-episode.png`)});
    await recipient.reload();await recipient.getByRole('heading',{name:'Shared episode',exact:true}).waitFor();
    await recipient.getByRole('button',{name:/Back to all show details/}).click();
    await recipient.getByRole('combobox',{name:'Season'}).waitFor();
    assert.equal(await recipient.getByRole('button',{name:/Shared episode/}).getAttribute('aria-pressed'),'true');
    await recipient.goto(link);await recipient.getByRole('heading',{name:'Shared episode',exact:true}).waitFor();
    await recipient.getByRole('button',{name:'Search',exact:true}).click();
    await recipient.getByRole('searchbox',{name:'Search Series'}).fill('Sample');
    await recipient.locator('.poster-card').filter({has:recipient.getByText('Sample series',{exact:true})}).click();
    await recipient.getByRole('combobox',{name:'Season'}).waitFor();
   }
   if(kind==='recording') {
    await recipient.getByRole('heading',{name:'Recording 25',exact:true}).waitFor();
    assert.equal(await recipient.locator('[data-recording-id]').count(),1);
    await recipient.getByRole('img',{name:'Shared channel logo'}).waitFor();
    assert.equal(await recipient.getByRole('navigation',{name:'DVR status'}).count(),0);
    if(screenshotDir) await recipient.screenshot({path:path.join(screenshotDir,`${browserName}-recording.png`)});
    await recipient.reload();await recipient.getByRole('heading',{name:'Recording 25',exact:true}).waitFor();
    assert.equal(await recipient.locator('[data-recording-id]').count(),1);
    await recipient.getByRole('button',{name:/Back to DVR/}).click();
    await recipient.getByRole('navigation',{name:'DVR status'}).waitFor();
    assert.ok(await recipient.locator('[data-recording-id]').count()>1);
   }
   assert.equal(await recipient.locator('video').count(),0);await recipient.close();
  }
  // Desktop keeps the document and outer container free of redundant scrollbars.
  for(const [width,height] of [[1280,720],[1366,768],[1920,1080]]) {
   await page.setViewportSize({width,height});
   for(const [link,kind] of [[liveLink,'live'],[movieLink,'movie'],[episodeLink,'episode'],[recordingLink,'recording']]) {
    await page.goto(link);
    await page.getByRole('button',{name:kind==='live'?'Watch Live':'Watch',exact:true}).waitFor();
    const overflow=await page.evaluate(()=>({page:document.documentElement.scrollHeight-innerHeight,outer:document.querySelector('.viewer-content').scrollHeight-document.querySelector('.viewer-content').clientHeight}));
    assert.ok(overflow.page<=1 && overflow.outer<=1,`${kind} ${width}x${height} redundant scroll: ${JSON.stringify(overflow)}`);
    if(kind==='episode'||kind==='recording') {
     const pane=page.locator(kind==='episode'?'.media-section':'.dvr-section');
     assert.ok(await pane.evaluate(el=>el.scrollHeight<=el.clientHeight+1),`${kind} compact details should fit ${width}x${height}`);
    }
   }
  }
  await page.setViewportSize({width:1366,height:768});
  playbackFixture = true;
  const probe=await browser.newPage();const supportsLive=await probe.evaluate(()=>Boolean(window.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')));await probe.close();
  // Keep real players mounted against a pending synthetic media response.
  for(const [width,height] of [[1920,1080],[1366,768],[1024,600],[800,400],[390,844],[844,390]]) {
   for(const [playbackLink,kind] of [[movieLink,'movie'],[episodeLink,'episode'],[recordingLink,'recording'],...(supportsLive?[[liveLink,'live']]:[])]) {
   const phoneSize=width===390 || (width===844 && height===390);
   const playbackPage=await browser.newPage({viewport:{width,height},hasTouch:phoneSize,...(browserName==='chromium'?{isMobile:phoneSize}:{})});
   await playbackPage.goto(playbackLink);await login(playbackPage);
   await playbackPage.getByRole('button',{name:kind==='live'?'Watch Live':'Watch',exact:true}).click();
   await playbackPage.locator('video').waitFor();
   await playbackPage.waitForTimeout(100);
   const geometry=await playbackPage.evaluate(()=>{
    const selectors=['.playback-stage','.playback-stage-card','.native-player','.is-live-focused .detail-panel','.is-live-focused .live-player'].filter(s=>document.querySelector(s));
    return {page:document.documentElement.scrollHeight-innerHeight,panes:selectors.map(s=>({selector:s,overflow:document.querySelector(s).scrollHeight-document.querySelector(s).clientHeight})),video:document.querySelector('video').getBoundingClientRect().toJSON()};
   });
   assert.ok(geometry.page<=1 && geometry.panes.every(p=>p.overflow<=1),`${kind} shared playback overflow ${width}x${height}: ${JSON.stringify(geometry)}`);
   assert.ok(geometry.video.height>60 && geometry.video.bottom<=height,`${kind} shared video fits ${width}x${height}`);
   await playbackPage.getByRole('button',{name:'Playback details',exact:true}).click();
   await playbackPage.getByRole('dialog').waitFor();await playbackPage.getByRole('button',{name:'Close',exact:true}).click();
   if(screenshotDir) await playbackPage.screenshot({path:path.join(screenshotDir,`${browserName}-${kind}-playing-${width}x${height}.png`)});
   await playbackPage.getByRole('button',{name:'Stop',exact:true}).click();
   await playbackPage.getByRole('button',{name:kind==='live'?'Watch Live':'Watch',exact:true}).waitFor();
   assert.equal(await playbackPage.locator('.playback-stage').count(),0);
   await playbackPage.close();
   }
  }
  await page.setViewportSize({width:1366,height:768});
  playbackFixture = false;
  // Already authenticated recipients and history restoration.
  await page.goto(movieLink);await page.getByRole('heading',{name:'Movie 7',exact:true}).waitFor();
  await page.waitForTimeout(350);await section(page,'Series');await page.waitForTimeout(350);
  await page.goBack();await page.getByRole('heading',{name:'Movie 7',exact:true}).waitFor();
  const phone=await browser.newPage({viewport:{width:390,height:844},...(browserName==='chromium'?{isMobile:true}:{}),hasTouch:true});
  await phone.goto(movieLink);await login(phone);await phone.getByRole('heading',{name:'Movie 7',exact:true}).waitFor();
  await share(phone,phone.locator('.watch-control'));
  assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile sharing must not overflow');
  for(const [link,label] of [[liveLink,'channel'],[episodeLink,'episode'],[recordingLink,'recording']]) {
   await phone.goto(link);
   await phone.getByRole('button',{name:label==='channel'?'Watch Live':'Watch',exact:true}).waitFor();
   assert.ok(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'focused mobile view must not overflow');
   if(screenshotDir) await phone.screenshot({path:path.join(screenshotDir,`${browserName}-${label}-phone.png`)});
  }
  await phone.close();
  assert.equal(mediaRequests,0,'navigation must not start media');assert.deepEqual(errors,[]);
  console.log('PASS share/navigation: all four content kinds, recipient login, refresh, pane scroll, Back, no autoplay, no page errors');
 } finally {await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
