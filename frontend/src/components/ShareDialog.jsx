import { useContext, useEffect, useId, useRef, useState } from 'react';
import { APIError, createShare } from '../api';
import { Sharing } from '../navigation';
import Modal from './Modal';

export default function ShareDialog({ target, onClose, returnFocusRef }) {
 const sharing = useContext(Sharing);
 const titleID = useId();
 const input = useRef(null);
 const [state, setState] = useState({loading:true,url:'',error:'',copied:false});
 const [retry, setRetry] = useState(0);
 const {kind,id,episode} = target;
 useEffect(() => {
  const controller = new AbortController();
  setState({loading:true,url:'',error:'',copied:false});
  createShare({kind,id,...(episode ? {episode}: {})}, sharing.session.csrf_token, {signal:controller.signal}).then(data => {
   if (controller.signal.aborted) return;
   if (!/^1[A-Za-z0-9_-]{39,399}$/.test(data.token)) throw new Error('Could not create a share link.');
   setState({loading:false,url:`${window.location.origin}${window.location.pathname}#/s/${data.token}`,error:'',copied:false});
  }).catch(error => {
   if (controller.signal.aborted) return;
   if (error instanceof APIError && error.status === 401) sharing.onExpired('Your viewer session expired. Sign in again.');
   else setState({loading:false,url:'',error:error.message || 'Could not create a share link.',copied:false});
  });
  return () => controller.abort();
 }, [kind,id,episode,sharing,retry]);
 const copy = async () => {
  let copied = false;
  try {
   if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(state.url); copied = true; }
  } catch { /* HTTP deployments and browser permissions may require the selection fallback. */ }
  if (!copied) {
   input.current?.focus();
   input.current?.select();
   // Clipboard API requires HTTPS; retain user-initiated copying on LAN HTTP.
   try { copied = document.execCommand?.('copy') === true; } catch { /* Leave the link selected for manual copying. */ }
  }
  setState(s=>({...s,copied,error:copied ? '' : 'Automatic copying was blocked. The link is selected; press Ctrl+C (Command+C on Mac), or use your device’s Copy command.'}));
 };
 return <Modal labelledBy={titleID} onClose={onClose} returnFocusRef={returnFocusRef}>
  <h2 id={titleID}>Share link</h2><p>The recipient must sign in with an account that can access this item.</p>
  <p>{{live:'Live TV channel link',movie:'Movie link',episode:'Episode link',recording:'Recording link'}[kind]}</p>
  {state.loading && <p role="status">Creating link…</p>}
  {state.error && <p role="alert">{state.error}</p>}
  {state.url && <><label>Link<input ref={input} readOnly value={state.url} onFocus={e=>e.target.select()} /></label><button onClick={copy}>Copy link</button>{state.copied && <p role="status">Link copied</p>}</>}
  {!state.loading && !state.url && <button onClick={()=>setRetry(n=>n+1)}>Retry</button>}
  <button onClick={onClose}>Close</button>
 </Modal>;
}
