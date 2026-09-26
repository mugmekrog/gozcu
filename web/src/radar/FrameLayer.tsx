/* Drone frames on the map.
 *
 * Each captured frame gets a small camera plate at its footprint centre, with a
 * coloured underline carrying the frame's risk level and the capture time
 * beneath. Clicking one selects the frame and moves the clock to it -- the
 * critical interaction from wireframe 1a.
 *
 * Only frames at or before the clock are drawn, because a frame that has not
 * been captured yet is not evidence. The footprint quad is drawn for the selected
 * frame alone; all forty at once would fill the display, and they vary in size
 * because the data has three resolutions and a GSD range of 0.109-0.199 m/px.
 */

import { memo } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import type { Projection } from '@/domain/polar';
import type { Enu, FrameSummary } from '@/domain/types';

export interface FrameLayerProps {
  frames: readonly FrameSummary[];
  projection: Projection;
  selectedId: string | null;
  /** Footprint corners of the selected frame, when its detail has loaded. */
  footprint: readonly Enu[] | null;
  onSelect: (imageId: string) => void;
}

export const FrameLayer = memo(function FrameLayer({
  frames,
  projection,
  selectedId,
  footprint,
  onSelect,
}: FrameLayerProps) {
  return (
    <g>
      {footprint && footprint.length >= 4 && (
        <polygon
          points={footprint.map((c) => projection.project(c).join(',')).join(' ')}
          fill="var(--ink)"
          fillOpacity={0.05}
          stroke="var(--ink)"
          strokeOpacity={0.45}
          strokeDasharray="4 3"
        />
      )}

      {frames.map((frame) => {
        const [x, y] = projection.project(frame.centre_enu);
        const style = riskStyle(bandOf(frame.level, frame.score));
        const selected = frame.image_id === selectedId;

        return (
          <g
            key={frame.image_id}
            className="radar-frame"
            role="button"
            tabIndex={0}
            aria-label={`${frame.image_id}, ${frame.capture_hhmm}, ${frame.vehicle_count} araç`}
            onClick={() => onSelect(frame.image_id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(frame.image_id);
              }
            }}
          >
            <rect
              x={x - 13}
              y={y - 10}
              width={26}
              height={18}
              fill="var(--surface)"
              stroke="var(--ink)"
              strokeWidth={selected ? 2 : 1}
            />
            <rect x={x - 13} y={y + 5} width={26} height={3} fill={style.color} />
            <circle cx={x} cy={y - 2} r={3.5} fill="none" stroke="var(--ink-muted)" />
            <text x={x} y={y + 19} fontSize={9} textAnchor="middle" fill="var(--ink)">
              {frame.capture_hhmm}
            </text>
          </g>
        );
      })}
    </g>
  );
});
