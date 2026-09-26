/* SESLE KONTROL — the speech screen.
 *
 * The fourth view, beside Harita, Hareket and Kayıtlar. The wireframes contain no
 * screen for it, which makes this a divergence of the same kind the frontend log
 * records in its §6; it is written up as S3 in the speech log rather than quietly
 * invented.
 *
 * What it is for, given that the microphone itself is in the agent column and works
 * from every view: this is where an operator can see *what the system heard*. That
 * matters more for speech than for anything else on the display, because a
 * misheard command is the failure mode, and the only way to recognise one is to
 * compare what was said with what was understood. So every row shows the model's
 * raw text beside the normalised transcript, names each rewrite the normaliser
 * made, and says what the command actually did.
 *
 * It also lists what speech can do. Not documentation for its own sake -- voice is
 * admin-level here, so the honest thing is to show an operator the full reach of
 * it, including which commands write to the record.
 */

import { memo } from 'react';
import { LevelBars } from '@/components/LevelBars';
import { T } from '@/domain/strings';
import { useAppStore } from '@/store/useAppStore';
import { useVoiceStore, type VoiceEntry } from '@/store/useVoiceStore';
import './voice-view.css';

export interface VoiceViewProps {
  available: boolean;
  unavailableReason: string | null;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}

const EFFECT_LABEL: Record<string, string> = {
  view: T.voice.effectView,
  compute: T.voice.effectCompute,
  audit: T.voice.effectAudit,
};

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export const VoiceView = memo(function VoiceView({
  available,
  unavailableReason,
  onStart,
  onStop,
  onCancel,
}: VoiceViewProps) {
  const status = useVoiceStore((s) => s.status);
  const phase = useVoiceStore((s) => s.phase);
  const open = useVoiceStore((s) => s.open);
  const level = useVoiceStore((s) => s.level);
  const heldS = useVoiceStore((s) => s.heldS);
  const error = useVoiceStore((s) => s.error);
  const history = useVoiceStore((s) => s.history);
  const setView = useAppStore((s) => s.setView);

  const busy = phase === 'transcribing' || phase === 'routing' || phase === 'working';

  return (
    <div className="voice-view">
      <section className="voice-view__stage">
        <div className="voice-view__control">
          <button
            type="button"
            className={
              open
                ? 'btn btn--action voice-view__mic is-open'
                : 'btn btn--action voice-view__mic'
            }
            onClick={open ? onStop : onStart}
            disabled={!available || busy}
            aria-pressed={open}
          >
            {open ? T.voice.stop : T.voice.start}
          </button>

          <div className="voice-view__readout">
            <b className="voice-view__phase" role="status">
              {open || busy
                ? phase === 'calibrating'
                  ? T.voice.calibrating
                  : phase === 'listening'
                    ? T.voice.listening
                    : phase === 'hearing'
                      ? T.voice.hearing
                      : phase === 'trailing'
                        ? T.voice.trailing
                        : phase === 'transcribing'
                          ? T.voice.transcribing
                          : phase === 'routing'
                            ? T.voice.routing
                            : T.voice.working
                : available
                  ? T.voice.hint
                  : T.voice.unavailable}
            </b>
            <LevelBars level={level} active={open} label={T.voice.level} />
            {open && heldS > 0 && (
              <span className="voice-view__held">{T.voice.heldSeconds(heldS.toFixed(1))}</span>
            )}
          </div>

          {open && (
            <button type="button" className="btn" onClick={onCancel}>
              {T.voice.cancel}
            </button>
          )}
        </div>

        {error && (
          <p className="voice-view__error" role="alert">
            {error}
          </p>
        )}
        {!available && unavailableReason && !error && (
          <p className="voice-view__hint">{unavailableReason}</p>
        )}

        {/* The provenance row. Speech gets the same treatment as the detector and
            the LLM in the header: an operator is entitled to know what is
            transcribing them before they act on its output. */}
        {status.stt.ready && (
          <p className="voice-view__provenance">
            <span>{status.stt.model}</span>
            <span>
              {status.stt.device}/{status.stt.compute_type}
            </span>
            <span>{status.stt.language}</span>
            {status.stt.model_load_ms !== null && (
              <span>yükleme {(status.stt.model_load_ms / 1000).toFixed(1)} sn</span>
            )}
            {status.stt.vram_used_mb !== null && (
              <span>{Math.round(status.stt.vram_used_mb)} MiB VRAM</span>
            )}
          </p>
        )}
        {status.voice.admin && <p className="voice-view__admin">{T.voice.adminNote}</p>}
      </section>

      <div className="voice-view__columns">
        <section className="panel voice-view__history">
          <div className="voice-view__head">
            <span className="kicker">{T.voice.history}</span>
            <div className="spacer" />
            {history.length > 0 && (
              <span className="muted voice-view__count">{history.length}</span>
            )}
          </div>

          {history.length === 0 ? (
            <div className="voice-view__empty">
              <b>{T.voice.historyEmpty}</b>
              <p className="muted">{T.voice.historyHint}</p>
            </div>
          ) : (
            <ol className="voice-view__list">
              {history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
        </section>

        <section className="panel voice-view__commands">
          <div className="voice-view__head">
            <span className="kicker">{T.voice.examples}</span>
          </div>
          <p className="voice-view__note">{T.voice.examplesNote}</p>

          {status.voice.commands.length === 0 ? (
            <p className="voice-view__note muted">{T.voice.unavailable}</p>
          ) : (
            <ul className="voice-view__commandlist">
              {status.voice.commands.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="btn btn--small" onClick={() => setView('map')}>
            ← {T.view.mapName}
          </button>
        </section>
      </div>
    </div>
  );
});

const HistoryRow = memo(function HistoryRow({ entry }: { entry: VoiceEntry }) {
  /* The raw text is only shown when it differs from what was routed. Showing both
   * every time would make the list twice as long to say the same thing, and the
   * cases where they differ are exactly the interesting ones. */
  const showRaw = entry.rawText.trim() && entry.rawText.trim() !== entry.text;

  return (
    <li className="voice-row" data-ok={entry.ok}>
      <div className="voice-row__head">
        <span className="voice-row__clock">{clockOf(entry.at)}</span>
        {entry.command && <code className="voice-row__command">{entry.command}</code>}
        {entry.effect && (
          <span className="voice-row__effect" data-effect={entry.effect}>
            {EFFECT_LABEL[entry.effect]}
          </span>
        )}
        <div className="spacer" />
        {entry.fromCache && <span className="voice-row__meta">{T.voice.cached}</span>}
        {entry.sttLatencyMs !== null && (
          <span className="voice-row__meta">{T.voice.latency(entry.sttLatencyMs)}</span>
        )}
      </div>

      <p className="voice-row__text">{entry.text}</p>

      {showRaw && (
        <p className="voice-row__raw">
          <span className="voice-row__tag">{T.voice.modelSaid}</span> {entry.rawText.trim()}
        </p>
      )}

      {entry.normalised.length > 0 && (
        <p className="voice-row__normalised">
          <span className="voice-row__tag">{T.voice.normalised}</span>
          {entry.normalised.join(' · ')}
        </p>
      )}

      {entry.summary && (
        <p className={entry.ok ? 'voice-row__done' : 'voice-row__failed'}>
          {entry.ok ? '✓' : '—'} {entry.summary}
        </p>
      )}

      {entry.answer && <p className="voice-row__answer">{entry.answer}</p>}
    </li>
  );
});
