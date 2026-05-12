import { useEffect } from "react";

// Ref-count so multiple modals stacking each toggle the lock cleanly.
let _activeLocks = 0;
let _originalOverflow: string | null = null;
let _originalPaddingRight: string | null = null;

function _acquire() {
  if (_activeLocks === 0) {
    const body = document.body;
    _originalOverflow = body.style.overflow;
    _originalPaddingRight = body.style.paddingRight;
    // Compensate for the disappearing scrollbar on desktop to avoid the
    // page jumping when a modal opens.
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    if (sbw > 0) body.style.paddingRight = `${sbw}px`;
    body.style.overflow = "hidden";
  }
  _activeLocks += 1;
}

function _release() {
  _activeLocks = Math.max(0, _activeLocks - 1);
  if (_activeLocks === 0) {
    const body = document.body;
    body.style.overflow = _originalOverflow ?? "";
    body.style.paddingRight = _originalPaddingRight ?? "";
    _originalOverflow = null;
    _originalPaddingRight = null;
  }
}

/**
 * Lock <body> scrolling while the calling component is mounted. Multiple
 * concurrent users (stacked modals) are ref-counted, so the lock is only
 * released when the last consumer unmounts.
 *
 * Usage:
 *   function Modal() {
 *     useBodyScrollLock();
 *     return <div ... />;
 *   }
 */
export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    _acquire();
    return () => {
      _release();
    };
  }, [active]);
}
