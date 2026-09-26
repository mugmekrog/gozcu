/* The confirmation before speech records a decision.
 *
 * Voice is admin-level by team decision: it reaches every command in the registry,
 * including the one that writes an operator decision into the record. The argument
 * against that is in the step log (S6) and was overruled; this dialog is what
 * survives of it, and `voice.confirm_audit_commands: false` removes it entirely.
 *
 * It is a real modal with a focus trap, not a toast, for one reason: an operator
 * decision is the only irreversible thing in this system, and the step it guards
 * has to be one the operator cannot walk past. It shows what was heard as well as
 * what will be recorded, because the failure it exists to catch is a misheard
 * sentence, and the transcript is the evidence for that.
 *
 * `Vazgeç` is the default focus. If the operator is not sure what is on screen, the
 * key they reach for should not be the one that writes to the record.
 */

import { memo, useEffect, useRef } from 'react';
import { T } from '@/domain/strings';
import type { PendingConfirm } from '@/store/useVoiceStore';
import './voice-confirm.css';

export interface VoiceConfirmProps {
  pending: PendingConfirm;
  onConfirm(): void;
  onReject(): void;
}

export const VoiceConfirm = memo(function VoiceConfirm({
  pending,
  onConfirm,
  onReject,
}: VoiceConfirmProps) {
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restore.current = document.activeElement as HTMLElement | null;
    cancel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onReject();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = panel.current?.querySelectorAll<HTMLElement>('button');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      restore.current?.focus();
    };
  }, [onReject]);

  return (
    <>
      <div className="voice-confirm__scrim" />
      <div
        className="voice-confirm"
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="voice-confirm-title"
        aria-describedby="voice-confirm-body"
      >
        <h2 className="voice-confirm__title" id="voice-confirm-title">
          {T.voice.confirmTitle}
        </h2>

        <p className="voice-confirm__body" id="voice-confirm-body">
          {T.voice.confirmBody(pending.what)}
        </p>

        <p className="voice-confirm__heard">
          <span className="voice-confirm__tag">{T.voice.confirmHeard}</span>
          <q>{pending.heard}</q>
        </p>

        <div className="voice-confirm__actions">
          <button type="button" className="btn" ref={cancel} onClick={onReject}>
            {T.voice.confirmNo}
          </button>
          <button type="button" className="btn btn--action" onClick={onConfirm}>
            {T.voice.confirmYes}
          </button>
        </div>
      </div>
    </>
  );
});
