/* A neutral timeline: frame markers, manual scrubber and clock.
 * Frame markers carry capture time only; risk is shown on the map and in the
 * selected vehicle panel.
 *
 * The scrubber is a real range input. A div with pointer handlers would look the
 * same and would lose keyboard stepping, Home/End, and the screen-reader value
 * announcement -- and this is the control an operator uses most.
 */

import { memo, useMemo } from 'react';
import * as fmt from '@/domain/format';
import { T } from '@/domain/strings';
import type { FrameSummary } from '@/domain/types';
import './timeline.css';

export interface TimelineProps {
  originIso: string;
  startMin: number;
  endMin: number;
  tMin: number;
  frames: readonly FrameSummary[];
  selectedFrameId: string | null;
  onSeek: (tMin: number) => void;
  onSelectFrame: (imageId: string) => void;
}

/** Tick every 30 sim minutes, labelled every two hours. */
const TICK_MIN = 30;
const LABEL_EVERY = 4;

export const Timeline = memo(function Timeline({
  originIso,
  startMin,
  endMin,
  tMin,
  frames,
  selectedFrameId,
  onSeek,
  onSelectFrame,
}: TimelineProps) {
  const span = Math.max(endMin - startMin, 1);
  const pct = (minute: number) => `${((minute - startMin) / span) * 100}%`;

  const ticks = useMemo(() => {
    const out: { minute: number; labelled: boolean }[] = [];
    const first = Math.ceil(startMin / TICK_MIN) * TICK_MIN;
    let i = 0;
    for (let m = first; m <= endMin; m += TICK_MIN, i += 1) {
      out.push({ minute: m, labelled: i % LABEL_EVERY === 0 });
    }
    return out;
  }, [startMin, endMin]);

  return (
    <div className="timeline">
      <span className="timeline__heading">ZAMAN ÇİZELGESİ</span>

      <div className="timeline__axis">
        <div className="timeline__markers">
          {frames.map((frame) => (
            <button
              key={frame.image_id}
              type="button"
              className={frame.image_id === selectedFrameId
                ? 'timeline__frame timeline__frame--selected' : 'timeline__frame'}
              style={{ left: pct(frame.capture_min) }}
              title={`${frame.image_id} · ${frame.capture_hhmm} · ${frame.vehicle_count} araç`}
              aria-label={`${T.transport.frameMarker} ${frame.image_id}, ${frame.capture_hhmm}`}
              onClick={() => onSelectFrame(frame.image_id)}
            />
          ))}
        </div>

        <span className="timeline__rail" aria-hidden="true" />
        <span className="timeline__progress" style={{ width: pct(tMin) }} aria-hidden="true" />

        <div className="timeline__ticks" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.minute}
              className={tick.labelled ? 'timeline__tick timeline__tick--major' : 'timeline__tick'}
              style={{ left: pct(tick.minute) }}
            >
              {tick.labelled && (
                <span className="timeline__tick-label">{fmt.clockOf(originIso, tick.minute)}</span>
              )}
            </span>
          ))}
        </div>

        <input
          className="timeline__scrub"
          type="range"
          min={startMin}
          max={endMin}
          step={1}
          value={Math.round(tMin)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label={T.transport.scrub}
          aria-valuetext={fmt.clockOf(originIso, tMin)}
        />
      </div>

      <p className="timeline__clock">
        <span className="label">{T.transport.clock}</span>
        <output className="timeline__clock-value">{fmt.clockOf(originIso, tMin)}</output>
      </p>
    </div>
  );
});
