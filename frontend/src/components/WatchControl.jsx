import { Sharing } from '../navigation';
import ShareDialog from './ShareDialog';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import Modal from './Modal';

import { isAppleMobile, VLC_APP_STORE_URL } from './vlc';

const VLC_HELP_KEY = 'dispatcharr-now-vlc-explained';
const MENU_EDGE_MARGIN = 8;
const MENU_GAP = 5;
let acknowledgedInMemory = false;

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

const wasVLCExplained = () => {
  if (acknowledgedInMemory) return true;
  try { return window.localStorage.getItem(VLC_HELP_KEY) === '1'; } catch { return false; }
};

const acknowledgeVLC = () => {
  acknowledgedInMemory = true;
  try { window.localStorage.setItem(VLC_HELP_KEY, '1'); } catch { /* private browsing may block storage */ }
};

const WatchControl = ({
  downloadLoading = false, onDownload, onStop, onVLC, onWatch,
  onDelete, deleteLoading = false,
  playbackLoading = false, playing = false, selectionKey = '', vlcLoading = false,
  watchLabel = 'Watch', shareTarget, onMenuWatch, menuWatchLabel = 'Watch in Browser', extraActions = [],
  showMenuWatch = true, showVLC = true, watchHasPopup,
}) => {
  const sharing = useContext(Sharing);
  const hasMenu = Boolean(showMenuWatch || showVLC || extraActions.length > 0 || onDownload || onDelete || (sharing?.enabled && shareTarget));
  const [sharingOpen, setSharingOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const [showVLCExplanation, setShowVLCExplanation] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const confirmRef = useRef(null);
  const pendingSelectionRef = useRef(null);

  useEffect(() => {
    pendingSelectionRef.current = null;
    setOpen(false); setMenuPosition(null);
    setSharingOpen(false);
    setShowVLCExplanation(false);
  }, [selectionKey]);

  useEffect(() => {
    if (hasMenu) return;
    if (open) rootRef.current?.querySelector('.watch-primary')?.focus();
    setOpen(false); setMenuPosition(null);
  }, [hasMenu]);

  useEffect(() => {
    if (!playing) return;
    setOpen(false);
    setShowVLCExplanation(false);
    pendingSelectionRef.current = null;
  }, [playing]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const placeMenu = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportHeight = viewport?.height || window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = viewport?.width || window.innerWidth || document.documentElement.clientWidth;
      const viewportBottom = viewportTop + viewportHeight;
      const viewportRight = viewportLeft + viewportWidth;
      const menuHeight = Math.max(menuRect.height, menu.scrollHeight);
      const menuWidth = menuRect.width;
      const spaceBelow = viewportBottom - MENU_EDGE_MARGIN - triggerRect.bottom - MENU_GAP;
      const placement = spaceBelow >= menuHeight ? 'below' : 'above';
      const intendedTop = placement === 'below'
        ? triggerRect.bottom + MENU_GAP
        : triggerRect.top - MENU_GAP - menuHeight;
      const minimumTop = viewportTop + MENU_EDGE_MARGIN;
      const maximumTop = Math.max(minimumTop, viewportBottom - MENU_EDGE_MARGIN - menuHeight);
      const minimumLeft = viewportLeft + MENU_EDGE_MARGIN;
      const maximumLeft = Math.max(minimumLeft, viewportRight - MENU_EDGE_MARGIN - menuWidth);
      const next = {
        placement,
        top: Math.round(clamp(intendedTop, minimumTop, maximumTop)),
        left: Math.round(clamp(triggerRect.right - menuWidth, minimumLeft, maximumLeft)),
        maxHeight: Math.max(0, Math.floor(viewportHeight - MENU_EDGE_MARGIN * 2)),
      };
      setMenuPosition((current) => current
        && current.placement === next.placement
        && current.top === next.top
        && current.left === next.left
        && current.maxHeight === next.maxHeight ? current : next);
    };

    placeMenu();
    window.addEventListener('resize', placeMenu);
    window.addEventListener('orientationchange', placeMenu);
    window.addEventListener('scroll', placeMenu, true);
    window.visualViewport?.addEventListener?.('resize', placeMenu);
    window.visualViewport?.addEventListener?.('scroll', placeMenu);
    return () => {
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('orientationchange', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
      window.visualViewport?.removeEventListener?.('resize', placeMenu);
      window.visualViewport?.removeEventListener?.('scroll', placeMenu);
    };
  }, [open]);

  const menuReady = open && menuPosition !== null;
  useLayoutEffect(() => {
    // Focus the visible menu before input can race with a deferred callback.
    // Repositioning an already open menu must preserve keyboard navigation.
    if (menuReady) menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuReady]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' && event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
	  } else if (event.type === 'keydown' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
		event.preventDefault();
		const items = [...(rootRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];
		if (!items.length) return;
		const current = items.indexOf(document.activeElement);
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
		  : event.key === 'ArrowUp' ? (current <= 0 ? items.length - 1 : current - 1)
		    : (current + 1) % items.length;
		items[next]?.focus();
      } else if (event.type === 'pointerdown' && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  const choose = (action) => {
    setOpen(false);
    // Preserve the opener when a menu action replaces its focused item with a dialog.
    triggerRef.current?.focus();
    action?.();
  };

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setMenuPosition(null);
    setOpen(true);
  };

  const requestVLC = () => {
    if (wasVLCExplained()) {
      onVLC?.();
      return;
    }
    pendingSelectionRef.current = selectionKey;
    setShowVLCExplanation(true);
  };

  const confirmVLC = () => {
    if (pendingSelectionRef.current !== selectionKey) {
      setShowVLCExplanation(false);
      return;
    }
    acknowledgeVLC();
    setShowVLCExplanation(false);
    onVLC?.();
  };

  return (
    <div className={`watch-control ${playing ? 'is-playing' : !hasMenu ? 'is-single-action' : ''}`} ref={rootRef}>
      <button
        className={`primary-button watch-primary ${playing ? 'is-stop' : ''}`}
        disabled={playbackLoading}
        aria-haspopup={!playing ? watchHasPopup : undefined}
        onClick={playing ? onStop : onWatch}
        type="button"
      >
        {playbackLoading ? 'Preparing…' : playing ? 'Stop' : watchLabel}
      </button>
      {!playing && hasMenu && (<button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Watch options"
        className="watch-options-button"
        onClick={toggleMenu}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true" className="selector-chevron" />
      </button>)}
      {open && !playing && hasMenu && (
		<div
          className={`watch-menu is-${menuPosition?.placement || 'below'}`}
          ref={menuRef}
          role="menu"
          style={menuPosition
            ? { left: menuPosition.left, maxHeight: menuPosition.maxHeight, top: menuPosition.top }
            : { left: 0, top: 0, visibility: 'hidden' }}
        >
		  {showMenuWatch && <button disabled={playbackLoading || playing} onClick={() => choose(onMenuWatch || onWatch)} role="menuitem" type="button">{menuWatchLabel}</button>}
          {extraActions.map(action => <button key={action.label} aria-label={action.label} aria-description={action.description} disabled={playbackLoading || action.disabled} onClick={() => choose(action.onSelect)} role="menuitem" type="button">{action.label}{action.description && <span className="watch-menu-description">{action.description}</span>}</button>)}
          {showVLC && <button disabled={vlcLoading || !onVLC} onClick={() => choose(isAppleMobile() ? requestVLC : onVLC)} role="menuitem" type="button">
            {vlcLoading ? 'Preparing VLC…' : isAppleMobile() ? 'Open in VLC' : 'Watch in VLC'}
          </button>}
          {onDownload && <button disabled={downloadLoading} onClick={() => choose(onDownload)} role="menuitem" type="button">
            {downloadLoading ? 'Preparing download…' : 'Download'}
          </button>}
          {sharing?.enabled && shareTarget && <button onClick={() => choose(() => setSharingOpen(true))} role="menuitem" type="button">Share link</button>}
          {onDelete && <button disabled={deleteLoading} onClick={() => choose(onDelete)} role="menuitem" type="button">Delete</button>}
        </div>
      )}
      {sharingOpen && <ShareDialog target={shareTarget} returnFocusRef={triggerRef} onClose={() => setSharingOpen(false)} />}
      {showVLCExplanation && !playing && (
        <Modal labelledBy="vlc-dialog-title" initialFocusRef={confirmRef} returnFocusRef={triggerRef} onClose={() => setShowVLCExplanation(false)}>
            <h3 id="vlc-dialog-title">Open in VLC</h3>
            <p>VLC opens outside your browser and may play formats your browser cannot.</p>
            <p>Don’t have VLC? <a href={VLC_APP_STORE_URL} rel="noopener noreferrer" target="_blank">Get it from the App Store.</a></p>
            <div className="dialog-actions">
              <button className="quiet-button" onClick={() => setShowVLCExplanation(false)} type="button">Cancel</button>
              <button className="primary-button" onClick={confirmVLC} ref={confirmRef} type="button">Open VLC</button>
            </div>
        </Modal>
      )}
    </div>
  );
};

export default WatchControl;
