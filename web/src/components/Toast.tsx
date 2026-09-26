/* The confirmation toast.
 *
 * It appears after a decision is recorded and says what was recorded, on which
 * frame, with a link to the row in the log. It does not auto-dismiss while it
 * carries an action -- snatching away the only route to the record would be worse
 * than leaving it on screen.
 */

import { memo, useEffect } from 'react';
import type { Toast as ToastData } from '@/store/useAppStore';
import './toast.css';

export interface ToastProps {
  toast: ToastData;
  onDismiss: () => void;
}

/** Plain notices clear themselves; ones with an action wait for the operator. */
const AUTO_DISMISS_MS = 6000;

export const Toast = memo(function Toast({ toast, onDismiss }: ToastProps) {
  useEffect(() => {
    if (toast.action) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast__message">✓ {toast.message}</span>
      {toast.detail && <span className="toast__detail">{toast.detail}</span>}
      {toast.action && toast.actionLabel && (
        <button type="button" className="toast__action" onClick={toast.action}>
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="toast__close" onClick={onDismiss} aria-label="Bildirimi kapat">
        ✕
      </button>
    </div>
  );
});
