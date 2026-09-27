/* The timeline: frame markers, manual scrubber and clock.
 * Each frame marker sits at its capture time and is coloured by the frame's
 * risk level, in the same colours the map uses, so the day's shape is readable
 * before anything is clicked.
 *
 * The scrubber is a real range input. A div with pointer handlers would look the
 * same and would lose keyboard stepping, Home/End, and the screen-reader value
 * announcement -- and this is the control an operator uses most.
 */

import { memo, useMemo } from 'react';
import * as fmt from '@/domain/format';
import { bandOf, riskStyle } from '@/domain/risk';
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

/** The frame nearest a minute: what a drag on the scrubber lands on. */
function nearestFrame(frames: readonly FrameSummary[], minute: number): FrameSummary | null {
  let best: FrameSummary | null = null;
  let bestGap = Infinity;
  for (const frame of frames) {
    const gap = Math.abs(frame.capture_min - minute);
    if (gap < bestGap) {
      best = frame;
      bestGap = gap;
    }
  }
  return best;
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
  const ordered = useMemo(
    () => [...frames].sort((a, b) => a.capture_min - b.capture_min),
    [frames],
  );

  /* Which frame the stepper is standing on. The selected one only while the
   * clock is still on it: scrubbing away and leaving the readout behind would
   * have it naming a frame the map is no longer showing. */
  const here = useMemo(() => {
    const picked = ordered.findIndex((frame) => frame.image_id === selectedFrameId);
    if (picked >= 0 && Math.round(ordered[picked]!.capture_min) === Math.round(tMin)) return picked;
    let last = -1;
    ordered.forEach((frame, i) => {
      if (frame.capture_min <= tMin) last = i;
    });
    return last;
  }, [ordered, selectedFrameId, tMin]);

  const current = here >= 0 ? ordered[here] ?? null : null;
  const previous = here > 0 ? ordered[here - 1] ?? null : null;
  const next = here < ordered.length - 1 ? ordered[here + 1] ?? null : ordered[0] ?? null;

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
      {/* Stepping frame to frame is what an operator actually does: between
          two captures nothing has been judged, so a minute-by-minute scrub is
          mostly dead ground. The buttons are the primary control and the strip
          behind them is the overview. */}
      <div className="timeline__stepper">
        <button
          type="button"
          className="timeline__step"
          disabled={!previous}
          aria-label={T.transport.prevFrame}
          onClick={() => previous && onSelectFrame(previous.image_id)}
        >
          <span aria-hidden="true">◀</span>
        </button>
        <span className="timeline__here">
          {current ? (
            <>
              <b>{fmt.clockOf(originIso, current.capture_min)}</b>
              <span className="timeline__here-meta">
                {T.transport.frameCount(current.vehicle_count)}
              </span>
            </>
          ) : (
            <span className="timeline__here-meta">{T.transport.noFrame}</span>
          )}
        </span>
        <button
          type="button"
          className="timeline__step"
          disabled={!next || next === current}
          aria-label={T.transport.nextFrame}
          onClick={() => next && onSelectFrame(next.image_id)}
        >
          <span aria-hidden="true">▶</span>
        </button>
      </div>

      <div className="timeline__axis">
        <div className="timeline__markers">
          {frames.map((frame) => (
            <button
              key={frame.image_id}
              type="button"
              className={frame.image_id === selectedFrameId
                ? 'timeline__frame timeline__frame--selected' : 'timeline__frame'}
              style={{
                left: pct(frame.capture_min),
                background: riskStyle(bandOf(frame.level, frame.score)).color,
              }}
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
          /* Snaps to the nearest capture time: a drag always lands on a frame
             rather than on a minute where nothing has been assessed. */
          onChange={(event) => {
            const minute = Number(event.target.value);
            onSeek(nearestFrame(ordered, minute)?.capture_min ?? minute);
          }}
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
