import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export default function RecordingOptions({ disabled, onSelect }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const button = trigger.current.getBoundingClientRect();
      const panel = menu.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const panelHeight = Math.min(menu.current.scrollHeight || panel.height, height - 16);
      const below = button.bottom + 5;
      setPosition({
        left: Math.max(left + 8, Math.min(button.right - panel.width, left + width - panel.width - 8)),
        top: Math.max(top + 8, Math.min(below + panelHeight <= top + height - 8 ? below : button.top - panelHeight - 5, top + height - panelHeight - 8)),
        maxHeight: Math.max(0, height - 16),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    viewportListen('addEventListener');
    function viewportListen(method) {
      window.visualViewport?.[method]('resize', place);
      window.visualViewport?.[method]('scroll', place);
    }
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewportListen('removeEventListener');
    };
  }, [open]);
  const ready = open && position !== null;
  useLayoutEffect(() => { if (ready) menu.current?.querySelector('[role="menuitem"]')?.focus(); }, [ready]);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    // Touch browsers can move focus away before dispatching the menu item's click.
    // Dismiss pointer interactions by their target; keyboard users leave with Tab.
    return () => {
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [open]);
  const keyDown = event => {
    if (!open) return;
    if (event.key === 'Tab') {
      setOpen(false);
      trigger.current.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.current.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  const choose = action => {
    setOpen(false);
    trigger.current.focus();
    onSelect(action, { currentTarget: trigger.current });
  };
  return <div className="recording-options" ref={root} onKeyDown={keyDown}>
    <button className="quiet-button" type="button" ref={trigger} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setPosition(null); setOpen(!open); }}>Recording options</button>
    {open && <div className="watch-menu" role="menu" aria-label="Recording options" ref={menu}
      style={position || { left: 0, top: 0, visibility: 'hidden' }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => choose('extend')}>Extend 30 minutes</button>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => choose('stop')}>Stop recording</button>
    </div>}
  </div>;
}
