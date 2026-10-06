import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NavigationRoot, { cleanNavigation, useSavedState } from './navigation';
import WatchControl from './components/WatchControl';
import App from './App';
const session = {user:{username:'viewer'},csrf_token:'csrf'};
const token = '1'+'A'.repeat(44);
const json = (body,status=200) => Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
afterEach(()=> { cleanup(); sessionStorage.clear(); history.replaceState(null,'','/'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function Harness() {
 const [section,setSection] = useSavedState('section','live');
 return <><p>Section: {section}</p><button onClick={()=>setSection('movies')}>Movies</button><WatchControl shareTarget={{kind:'movie',id:'7'}} onWatch={()=>{}} /></>;
}
it('restores per-tab navigation on refresh, isolates accounts, and restores history', async()=> {
 vi.stubGlobal('fetch',vi.fn(()=>json({enabled:false})));
 const user = userEvent.setup();
 const view = render(<NavigationRoot session={session} onExpired={vi.fn()}><Harness /></NavigationRoot>);
 await user.click(screen.getByText('Movies'));
 await waitFor(()=>expect(JSON.parse(sessionStorage.getItem('watch-now-navigation-v1')).value.section).toBe('movies'));
 view.unmount();
 const next=render(<NavigationRoot session={session} onExpired={vi.fn()}><Harness /></NavigationRoot>);
 expect(screen.getByText('Section: movies')).toBeInTheDocument();
 act(()=> { history.replaceState({watchNow:true,user:'viewer',value:{section:'series'}},'','/'); window.dispatchEvent(new PopStateEvent('popstate')); });
 expect(screen.getByText('Section: series')).toBeInTheDocument();
 next.unmount();
 render(<NavigationRoot session={{...session,user:{username:'friend'}}} onExpired={vi.fn()}><Harness /></NavigationRoot>);
 expect(screen.getByText('Section: live')).toBeInTheDocument();
});
it('validates stored navigation and excludes playback, credentials, and expired Guide dates',()=> {
 expect(cleanNavigation({section:'https://evil.test',movieID:'../7',playing:true,password:'secret',guideDay:0,moviePage:-1})).toEqual({});
});
it('offers Share link and a manual copy fallback without starting playback',async()=> {
 const fetcher=vi.fn((path)=>json(path==='/api/share' ? {enabled:true,token} : {}));
 vi.stubGlobal('fetch',fetcher);
 const user=userEvent.setup();
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error('HTTP'))}});
 render(<NavigationRoot session={session} onExpired={vi.fn()}><Harness /></NavigationRoot>);
 await user.click(screen.getByRole('button',{name:'Watch options'}));
 await user.click(await screen.findByRole('menuitem',{name:'Share link'}));
 const input=await screen.findByRole('textbox',{name:'Link'});
 await waitFor(()=>expect(input.value).toContain('#/s/'+token));
 expect(input.value).not.toContain('movie');
 await user.click(screen.getByRole('button',{name:'Copy link'}));
 expect(await screen.findByText('Automatic copying was blocked. The link is selected; press Ctrl+C (Command+C on Mac), or use your device’s Copy command.')).toBeInTheDocument();
 expect(input).toHaveFocus();
 expect(JSON.parse(fetcher.mock.calls.find(([,o])=>o?.method==='POST')[1].body)).toEqual({kind:'movie',id:'7'});
});
function appFixture(target, authenticated=true, recordings=null) {
 let signed=authenticated;
 const fetcher=vi.fn((input,options={})=> {
  const path=new URL(String(input),'http://localhost').pathname;
  if(path==='/api/health/ready') return json({reachable:true});
  if(path==='/api/auth/login'){signed=true;return json(session);}
  if(!signed)return json({error:{code:'session_expired',message:'Sign in'}},401);
  if(path==='/api/session')return json(session);
  if(path==='/api/share')return json({enabled:true});
  if(path==='/api/share/resolve')return json(target);
  if(path==='/api/live/search/capabilities')return json({program_search:true,guide:true,dvr:Boolean(recordings)});
  if(path==='/api/dvr/connection')return json({connected:true,access:'view',managed:true});
  if(path==='/api/dvr/recordings')return json({access:'view',items:recordings || []});
  if(path==='/api/live/categories')return json([]);
  if(path==='/api/live/channels')return json([{id:'41',name:'Sample channel'}]);
  if(path.endsWith('/epg'))return json({});
  if(path==='/api/movies')return json({items:[{id:'7',name:'Sample movie'}],total:1});
  if(path==='/api/movies/7')return json({id:'7',name:'Sample movie'});
  if(path==='/api/series')return json({items:[{id:'8',name:'Sample series'}],total:1});
  if(path==='/api/series/8')return json({id:'8',name:'Sample series',seasons:[{number:2,episodes:[{id:'9',title:'Shared episode',episode_number:3}]}]});
  if(path.endsWith('/categories'))return json([]);
  return json({error:{message:'Unavailable'}},404);
 });
 vi.stubGlobal('fetch',fetcher);return fetcher;
}
it('keeps a shared movie through authentication and refresh without autoplay',async()=> {
 history.replaceState(null,'','/#/s/'+token);
 const fetcher=appFixture({kind:'movie',id:'7'},false);
 const user=userEvent.setup();
 const view=render(<App />);
 await user.type(await screen.findByLabelText('Username'),'viewer');
 await user.type(screen.getByLabelText('Password'),'secret');
 await user.click(screen.getByRole('button',{name:'Open Watch Now',exact:true}));
 await screen.findByRole('heading',{name:'Sample movie'});
 expect(fetcher.mock.calls.some(([p])=>String(p).endsWith('/stream'))).toBe(false);
 expect(location.hash).toBe('');
 view.unmount();render(<App />);
 expect(await screen.findByRole('heading',{name:'Sample movie'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Watch',exact:true})).toBeInTheDocument();
});
it('opens and refreshes the shared series episode and season',async()=> {
 history.replaceState(null,'','/#/s/'+token);
 appFixture({kind:'episode',id:'8',episode:'9'});
 const view=render(<App />);
 await screen.findByRole('button',{name:'Watch',exact:true});
 expect(screen.getByRole('heading',{name:'Shared episode'})).toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:'Season'})).not.toBeInTheDocument();
 view.unmount();render(<App />);
 expect(await screen.findByRole('button',{name:'Watch',exact:true})).toBeInTheDocument();
 expect(screen.getByRole('heading',{name:'Shared episode'})).toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:'Season'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:/Back to all show details/}));
 expect(screen.getByRole('combobox',{name:'Season'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:/Shared episode/})).toHaveAttribute('aria-pressed','true');
});
it('rejects malformed links without resolving or redirecting outside the app',async()=> {
 history.replaceState(null,'','/#/s/https://evil.test');
 const fetcher=appFixture({kind:'movie',id:'7'});
 render(<App />);
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('invalid'));
 expect(fetcher.mock.calls.some(([p])=>p==='/api/share/resolve')).toBe(false);
});

it('copies the current movie link on HTTP when the async Clipboard API is absent',async()=> {
 vi.stubGlobal('fetch',vi.fn(()=>json({enabled:true,token})));
 const user=userEvent.setup();
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
 const copy=vi.fn(()=>true);
 Object.defineProperty(document,'execCommand',{configurable:true,value:copy});
 try {
  render(<NavigationRoot session={session} onExpired={vi.fn()}><Harness /></NavigationRoot>);
  await user.click(screen.getByRole('button',{name:'Watch options'}));
  await user.click(await screen.findByRole('menuitem',{name:'Share link'}));
  const input=await screen.findByRole('textbox',{name:'Link'});
  await user.click(screen.getByRole('button',{name:'Copy link'}));
  expect(await screen.findByText('Link copied')).toBeInTheDocument();
  expect(copy).toHaveBeenCalledWith('copy');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
 } finally { delete document.execCommand; }
});

it('opens shared channels alone and restores the channel browser on request',async()=> {
 history.replaceState(null,'','/#/s/'+token);
 appFixture({kind:'live',id:'41'});
 const view=render(<App />);
 await screen.findByRole('region',{name:'Selected channel: Sample channel'});
 expect(screen.queryByRole('region',{name:'Channel list'})).not.toBeInTheDocument();
 view.unmount(); render(<App />);
 await screen.findByRole('region',{name:'Selected channel: Sample channel'});
 expect(screen.queryByRole('region',{name:'Channel list'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:/Back to Live TV/}));
 expect(screen.getByRole('region',{name:'Channel list'})).toBeInTheDocument();
});

it('opens only the shared recording with its channel logo and restores DVR browsing',async()=> {
 history.replaceState(null,'','/#/s/'+token);
 const row={id:'25',title:'Shared recording title',status:'recorded',playable:true,channel:{id:'41',name:'Sports Channel',has_artwork:true},start:'2026-10-05T12:00:00Z',end:'2026-10-05T13:00:00Z'};
 const rows=[row,{...row,id:'26',title:'Another recording'}];
 const fetcher=appFixture({kind:'recording',id:'25'},true,rows);
 const view=render(<App />);
 await screen.findByRole('heading',{name:row.title});
 expect(screen.queryByRole('heading',{name:'Another recording'})).not.toBeInTheDocument();
 expect(screen.queryByRole('navigation',{name:'DVR status'})).not.toBeInTheDocument();
 const logo=screen.getByRole('img',{name:'Sports Channel logo'});
 expect(logo.getAttribute('src')).toContain('/api/live/channels/41/artwork');
 fireEvent.error(logo);
 expect(screen.getByText('SC')).toBeInTheDocument();
 expect(fetcher.mock.calls.some(([p])=>String(p).includes('/file'))).toBe(false);
 view.unmount();const refreshed=render(<App />);
 await screen.findByRole('heading',{name:row.title});
 expect(screen.queryByRole('heading',{name:'Another recording'})).not.toBeInTheDocument();
 await userEvent.click(screen.getByRole('button',{name:/Back to DVR/}));
 expect(screen.getByRole('heading',{name:'Another recording'})).toBeInTheDocument();
 expect(screen.getByRole('navigation',{name:'DVR status'})).toBeInTheDocument();
 refreshed.unmount();
 history.replaceState(null,'','/#/s/'+token);
 rows.splice(0,1);
 render(<App />);
 await screen.findByText('This recording is no longer available to your account.');
 expect(screen.queryByRole('heading',{name:'Another recording'})).not.toBeInTheDocument();
});
