/* The microphone control, in the agent column.
 *
 * It sits beside AJANA SOR because that is where the operator already goes to talk
 * to the agent, and it stays mounted in every view so a command that changes the
 * view does not take the microphone with it.
 *
 * The button is the whole control: press to listen, and the utterance ends itself
 * when the operator stops talking. There is no second press to hunt for, which is
 * the point of endpointing -- the frontend log's own standard is that a demo should
 * not require mouse hunting on stage.
 *
 * What it always shows, in order of how much the operator needs it: whether the
 * microphone is open, whether it is hearing anything, and what happened to the last
 * thing they said. When speech is unavailable the button is disabled and says why,
 * which is the pattern AskAgent already set for a missing gateway.
 */

import { memo } from 'react';
import { T } from '@/domain/strings';
import { LevelBars } from './LevelBars';
import type { VoiceEntry, VoicePhase } from '@/store/useVoiceStore';
import './voice-dock.css';

export interface VoiceDockProps {
  available: boolean;
  unavailableReason: string | null;
  phase: VoicePhase;
  open: boolean;
  level: number;
  heldS: number;
  maxUtteranceS: number;
  quiet: boolean;
  clipping: boolean;
  error: string | null;
  /** The newest history line, so the dock can show the outcome without the view. */
  last: VoiceEntry | null;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
  onOpenView(): void;
}

const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: T.voice.idle,
  calibrating: T.voice.calibrating,
  listening: T.voice.listening,
  hearing: T.voice.hearing,
  trailing: T.voice.trailing,
  transcribing: T.voice.transcribing,
  routing: T.voice.routing,
  working: T.voice.working,
  confirming: T.voice.confirmTitle,
};

/** The phases where work is happening off-screen and the operator is waiting. */
const BUSY: readonly VoicePhase[] = ['transcribing', 'routing', 'working'];

export const VoiceDock = memo(function VoiceDock({
  available,
  unavailableReason,
  phase,
  open,
  level,
  heldS,
  maxUtteranceS,
  quiet,
  clipping,
  error,
  last,
  onStart,
  onStop,
  onCancel,
  onOpenView,
}: VoiceDockProps) {
  const busy = BUSY.includes(phase);
  const remaining = Math.max(0, maxUtteranceS - heldS);

  return (
    <section className="panel voice-dock">
      <div className="voice-dock__head">
        <span className="kicker">{T.voice.panel}</span>
        <div className="spacer" />
        <button type="button" className="voice-dock__link" onClick={onOpenView}>
          {T.view.voiceName} →
        </button>
      </div>

      <div className="voice-dock__row">
        <button
          type="button"
          className={open ? 'btn btn--action voice-dock__mic is-open' : 'btn btn--action voice-dock__mic'}
          onClick={open ? onStop : onStart}
          disabled={!available || busy}
          aria-pressed={open}
          title={available ? `${T.voice.hint} (${T.voice.hintKey})` : (unavailableReason ?? '')}
        >
          {open ? T.voice.stop : T.voice.start}
        </button>

        {open ? (
          <LevelBars level={level} active={open} />
        ) : (
          <span className="voice-dock__phase" role="status">
            {busy ? PHASE_LABEL[phase] : available ? T.voice.hint : T.voice.unavailable}
          </span>
        )}

        {open && (
          <button type="button" className="btn btn--small" onClick={onCancel}>
            {T.voice.cancel}
          </button>
        )}
      </div>

      {open && (
        <p className="voice-dock__meta" role="status">
          <b>{PHASE_LABEL[phase]}</b>
          {heldS > 0 && <span> · {T.voice.heldSeconds(heldS.toFixed(1))}</span>}
          {heldS > 0 && remaining < 5 && (
            <span className="voice-dock__warn"> · {T.voice.remaining(remaining.toFixed(0))}</span>
          )}
        </p>
      )}

      {busy && (
        <p className="voice-dock__meta" role="status">
          {PHASE_LABEL[phase]}
        </p>
      )}

      {clipping && <p className="voice-dock__warn">{T.voice.clipping}</p>}
      {quiet && !error && <p className="voice-dock__warn">{T.voice.levelQuiet}</p>}

      {error && (
        <p className="voice-dock__error" role="alert">
          {error}
        </p>
      )}

      {!available && unavailableReason && !error && (
        <p className="voice-dock__hint">{unavailableReason}</p>
      )}

      {last && !open && !busy && (
        <div className="voice-dock__last">
          <p className="voice-dock__heard">
            <span className="voice-dock__tag">{T.voice.heard}</span> {last.text}
          </p>
          {last.summary && (
            <p
              className={last.ok ? 'voice-dock__done' : 'voice-dock__failed'}
              role="status"
            >
              {last.ok ? '✓' : '—'} {last.summary}
            </p>
          )}
          {last.answer && <p className="voice-dock__answer">{last.answer}</p>}
        </div>
      )}
    </section>
  );
});
