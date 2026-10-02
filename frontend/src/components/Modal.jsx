import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Portalling makes background isolation independent of the caller's nesting.
const Modal = ({ children, labelledBy, onClose, initialFocusRef, returnFocusRef }) => {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = dialog.parentElement;
    const previousFocus = returnFocusRef?.current || document.activeElement;
    const background = [...document.body.children].filter((element) => element !== backdrop);
    const previous = background.map((element) => [element, element.inert]);
    background.forEach((element) => { element.inert = true; });
    const focusable = () => [...dialog.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    (initialFocusRef?.current || focusable()[0] || dialog).focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const elements = focusable();
        const index = elements.indexOf(document.activeElement);
        const next = event.shiftKey ? index - 1 : index + 1;
        event.preventDefault();
        (elements[(next + elements.length) % elements.length] || dialog).focus();
      }
    };
    const containFocus = (event) => {
      if (!dialog.contains(event.target)) (focusable()[0] || dialog).focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      previous.forEach(([element, inert]) => { element.inert = inert; });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<div className="dialog-backdrop"><div aria-labelledby={labelledBy} aria-modal="true" className="confirmation-dialog" ref={dialogRef} role="dialog" tabIndex="-1">{children}</div></div>, document.body);
};

export default Modal;
