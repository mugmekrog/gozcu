/* The timeline: transport, scrubber, frame markers, clock.
 *
 * The frame diamonds and the scrubber share one axis, which is the point of the
 * component -- a diamond's horizontal position *is* the time it was captured, so
 * clicking one and dragging to it are the same gesture. Each diamond is coloured
 * by its frame's risk level, so the day's shape is readable before anything is
 * clicked.
 *
 * The scrubber is a real range input. A div with pointer handlers would look the
 * same and would lose keyboard stepping, Home/End, and the screen-reader value
 * announcement -- and this is the control an operator uses most.
 */

import { memo, useMemo } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import * as fmt from '@/domain/format';
import { T } from '@/domain/strings';
import { SPEED_OPTIONS, type SimSpeed } from '@/store/useAppStore';
import type { FrameSummary } from '@/domain/types';
import './timeline.css';

export interface TimelineProps {
  originIso: string;
  startMin: number;
  endMin: number;
  tMin: number;
  playing: boolean;
  speed: SimSpeed;
  frames: readonly FrameSummary[];
  selectedFrameId: string | null;
  /** Highlighted spans: the selected vehicle's window, then each pin's. */
  bands: { fromMin: number; toMin: number; colour: string }[];
  onSeek: (tMin: number) => void;
  onTogglePlay: () => void;
  onSpeed: (speed: SimSpeed) => void;
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
  playing,
  speed,
  frames,
  selectedFrameId,
  bands,
  onSeek,
  onTogglePlay,
  onSpeed,
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
      <button
        type="button"
        className={playing ? 'btn btn--primary timeline__transport' : 'btn timeline__transport'}
        onClick={onTogglePlay}
        aria-label={playing ? T.transport.pause : T.transport.play}
      >
        {playing ? `⏸ ${T.transport.pause}` : `▶ ${T.transport.play}`}
      </button>

      <div className="timeline__axis">
        <div className="timeline__markers">
          {frames.map((frame) => {
            const style = riskStyle(bandOf(frame.level, frame.score));
            return (
              <button
                key={frame.image_id}
                type="button"
                className={
                  frame.image_id === selectedFrameId
                    ? 'timeline__frame timeline__frame--selected'
                    : 'timeline__frame'
                }
                style={{ left: pct(frame.capture_min), background: style.color }}
                title={`${frame.image_id} · ${frame.capture_hhmm} · ${frame.vehicle_count} araç`}
                aria-label={`${T.transport.frameMarker} ${frame.image_id}, ${frame.capture_hhmm}`}
                onClick={() => onSelectFrame(frame.image_id)}
              />
            );
          })}
        </div>

        {bands.map((band, i) => (
          <span
            key={`band-${i}`}
            className="timeline__band"
            style={{
              left: pct(band.fromMin),
              width: `${((band.toMin - band.fromMin) / span) * 100}%`,
              background: band.colour,
              top: `${13 + i * (bands.length > 1 ? 2.5 : 5)}px`,
              height: bands.length > 1 ? 2 : 5,
            }}
            aria-hidden="true"
          />
        ))}

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

      <div className="timeline__speed" role="group" aria-label={T.transport.speed}>
        <span className="label">{T.transport.speed}</span>
        <div className="seg">
          {SPEED_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="seg__opt"
              aria-pressed={option === speed}
              onClick={() => onSpeed(option)}
            >
              ×{option}
            </button>
          ))}
        </div>
      </div>

      <p className="timeline__clock">
        <span className="label">{T.transport.clock}</span>
        <output className="timeline__clock-value">{fmt.clockOf(originIso, tMin)}</output>
      </p>
    </div>
  );
});
