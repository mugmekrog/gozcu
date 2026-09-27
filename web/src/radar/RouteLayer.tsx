/* A vehicle's route: where it has been, and when. The map's Strava line.
 *
 * Drawn for the selected vehicle on the radar, and again in the activity
 * report's map. Ink on a white casing, fading from faint at the first fix to
 * full at the present, so the direction of time reads without a legend; small
 * chevrons along it say which way it was driving; a badge marks every stop with
 * its length; a tick marks each half hour with the clock.
 *
 * It takes no risk colour. A route answers "where and when", and the vehicle
 * symbol at its head already answers "how dangerous".
 */

import { memo } from 'react';
import type { Projection } from '@/domain/polar';
import { positionAt, type RoutePoint } from '@/domain/activity';
import type { Stop } from '@/domain/tracks';
import * as fmt from '@/domain/format';

export interface RouteLayerProps {
  route: readonly RoutePoint[];
  projection: Projection;
  stops?: readonly Stop[];
  /** Label half-hour ticks with this origin's wall clock; omit for no ticks. */
  originIso?: string;
  /** Heavier line and larger marks, for the report's own map. */
  emphasis?: boolean;
}

/** Faintest opacity, at the first fix. */
const FADE_FROM = 0.3;
/** One chevron per this many SVG units of route on screen. */
const CHEVRON_EVERY = 64;

export const RouteLayer = memo(function RouteLayer({
  route,
  projection,
  stops = [],
  originIso,
  emphasis = false,
}: RouteLayerProps) {
  if (route.length < 2) return null;
  const pts = route.map((p) => projection.project({ e_m: p.e, n_m: p.n }));
  const first = route[0] as RoutePoint;
  const last = route[route.length - 1] as RoutePoint;
  const span = Math.max(last.tMin - first.tMin, 1);
  const width = emphasis ? 4 : 3.2;
  const all = pts.map((p) => p.join(',')).join(' ');

  const segments: React.ReactNode[] = [];
  const chevrons: React.ReactNode[] = [];
  /** Distance into the next segment at which the next chevron falls. */
  let next = CHEVRON_EVERY / 2;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1] as readonly [number, number];
    const [x1, y1] = pts[i] as readonly [number, number];
    const t = ((route[i] as RoutePoint).tMin - first.tMin) / span;
    segments.push(
      <line
        key={`seg-${i}`}
        x1={x0}
        y1={y0}
        x2={x1}
        y2={y1}
        stroke="var(--route)"
        strokeOpacity={FADE_FROM + (1 - FADE_FROM) * t}
        strokeWidth={width}
        strokeLinecap="round"
      />,
    );

    const len = Math.hypot(x1 - x0, y1 - y0);
    const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    let at = next;
    for (; at < len; at += CHEVRON_EVERY) {
      const f = at / len;
      chevrons.push(
        <path
          key={`chev-${i}-${Math.round(at)}`}
          d="M-2.4 -2.6 L1.4 0 L-2.4 2.6"
          transform={`translate(${x0 + (x1 - x0) * f} ${y0 + (y1 - y0) * f}) rotate(${angle})`}
          fill="none"
          stroke="var(--route-casing)"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />,
      );
    }
    next = at - len;
  }

  const ticks: React.ReactNode[] = [];
  if (originIso) {
    for (let m = Math.ceil((first.tMin + 1) / 30) * 30; m < last.tMin - 2; m += 30) {
      // Inside a stop the vehicle is where the stop's badge already is.
      if (stops.some((stop) => m >= stop.fromMin && m <= stop.toMin)) continue;
      const p = positionAt(route, m);
      const [x, y] = projection.project({ e_m: p.e, n_m: p.n });
      ticks.push(
        <g key={`tick-${m}`} className="route__tick">
          <circle cx={x} cy={y} r={2.6} fill="var(--route-casing)" stroke="var(--route)" strokeWidth={1.4} />
          <text className="map-label" x={x + 6} y={y + 11} fontSize={8.5} fontWeight={700}>
            {fmt.clockOf(originIso, m)}
          </text>
        </g>,
      );
    }
  }

  const [sx, sy] = pts[0] as readonly [number, number];

  return (
    <g className="route" aria-hidden="true">
      <polyline
        points={all}
        fill="none"
        stroke="var(--route-casing)"
        strokeWidth={width + 3.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {segments}
      {chevrons}
      {ticks}
      {stops.map((stop) => {
        const p = positionAt(route, stop.fromMin);
        const [x, y] = projection.project({ e_m: p.e, n_m: p.n });
        const text = `❚❚ ${fmt.minutes(stop.durationMin)}`;
        const w = text.length * 5.1 + 8;
        return (
          <g key={`stop-${stop.fromMin}`} className="route__stop">
            <rect x={x - w / 2} y={y - 22} width={w} height={13} rx={6.5} strokeWidth={1.2} />
            <text x={x} y={y - 12.5} fontSize={8} fontWeight={700} textAnchor="middle">
              {text}
            </text>
          </g>
        );
      })}
      {/* The start: a hollow ring, the one mark on the route that is not ink-filled. */}
      <circle
        cx={sx}
        cy={sy}
        r={emphasis ? 5.5 : 4.5}
        fill="var(--route-casing)"
        stroke="var(--route)"
        strokeWidth={2.2}
      />
    </g>
  );
});
