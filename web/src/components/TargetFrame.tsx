/* The frame picker and its status.
 *
 * The state marker on the right is the
 * frame's current standing: not yet evaluated, running with its step count, the
 * finished level and score, or that the frame holds no vehicles at all.
 */

import { memo } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import { T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { LevelBadge } from './LevelBadge';
import type { AssessPhase } from '@/store/useAppStore';
import type { FrameSummary, Level } from '@/domain/types';
import './target-frame.css';

export interface TargetFrameProps {
  frames: readonly FrameSummary[];
  selectedId: string | null;
  phase: AssessPhase;
  stepsDone: number;
  stepsTotal: number;
  /** Set once an evaluation has finished for the selected frame. */
  result: { level: Level; score: number; vehicleCount: number } | null;
  onSelect: (imageId: string) => void;
  onCamera: () => void;
}

export const TargetFrame = memo(function TargetFrame({
  frames,
  selectedId,
  phase,
  stepsDone,
  stepsTotal,
  result,
  onSelect,
  onCamera,
}: TargetFrameProps) {
  const selected = frames.find((f) => f.image_id === selectedId) ?? null;
  const running = phase === 'running';

  return (
    <section className="panel target-frame">
      <h2 className="panel__head">
        {T.agent.targetFrame}
        <div className="spacer" />
        <span className="panel__head-note">{T.agent.frameCount(frames.length)}</span>
      </h2>

      <div className="panel__body target-frame__body">
        <label className="target-frame__select">
          {selected && (
            <span
              className="target-frame__diamond"
              style={{ background: riskStyle(bandOf(selected.level, selected.score)).color }}
              aria-hidden="true"
            />
          )}
          <span className="sr-only">Hedef kare</span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => onSelect(event.target.value)}
            aria-label="Hedef kare"
          >
            {frames.map((frame) => (
              <option key={frame.image_id} value={frame.image_id}>
                {frame.image_id} · {frame.zone_name ?? '—'} · {frame.capture_hhmm} ·{' '}
                {frame.vehicle_count} araç
              </option>
            ))}
          </select>
        </label>

        <div className="target-frame__actions">
          <button type="button" className="btn" onClick={onCamera} disabled={!selectedId}>
            {T.agent.camera}
          </button>

          <div className="spacer" />

          {phase === 'idle' && <LevelBadge band="unassessed" size="small" />}
          {running && (
            <span className="pill" role="status">
              ◐ {T.step.running.toLocaleUpperCase('tr-TR')} · {stepsDone}/{stepsTotal}
            </span>
          )}
          {phase === 'done' && result && (
            <LevelBadge
              band={result.vehicleCount === 0 ? 'empty' : bandOf(result.level, result.score)}
              score={result.vehicleCount === 0 ? null : result.score}
            />
          )}
          {phase === 'error' && (
            <span className="pill pill--strong" role="status">
              ✕ hata
            </span>
          )}
        </div>

        {selected && (
          <p className="target-frame__meta muted">
            {selected.width_px}×{selected.height_px} · {fmt.count(selected.raw_boxes)} kutu →{' '}
            {fmt.count(selected.kept_boxes)} tespit · {fmt.count(selected.report_count)} rapor
          </p>
        )}
      </div>
    </section>
  );
});
