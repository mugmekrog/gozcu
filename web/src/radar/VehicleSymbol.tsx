/* One vehicle on the map, drawn the way APP-6 draws one.
 *
 * The frame carries the warning level and the icon inside carries the vehicle
 * type. That split is the whole point: an operator reads threat from the
 * outline at a glance, across the map, without resolving what is inside it --
 * and it fixes a real gap, because until now level was carried by colour alone
 * here while risk.ts requires it to be redundantly encoded (PLAN 7.3.1). Now
 * level is shape *and* colour, and a colour-blind reviewer or a washed-out
 * projector loses nothing.
 *
 * Frames follow APP-6 affiliation, read as threat rather than allegiance:
 *
 *   ALERT   diamond     the hostile frame
 *   WATCH   quatrefoil  the unknown frame -- something is off, it is not resolved
 *   CLEAR   square      the neutral frame
 *   pending dashed ring not yet judged; the drone has not reached it
 *
 * Icons are four strokes at most. At this size anything more is mud.
 */

import { memo } from 'react';
import type { Level, VehicleClass } from '@/domain/types';

export interface VehicleSymbolProps {
  x: number;
  y: number;
  cls: VehicleClass | null;
  level: Level | null;
  /** Half-width of the frame in SVG units. The icon is sized from it. */
  size: number;
  opacity?: number;
}

interface LevelStyle {
  fill: string;
  stroke: string;
  /** A hue the icon stays legible in against `fill`. */
  ink: string;
  frame: 'diamond' | 'quatrefoil' | 'square' | 'pending';
}

export const LEVEL_STYLES: Record<'ALERT' | 'WATCH' | 'CLEAR' | 'pending', LevelStyle> = {
  ALERT: { fill: 'var(--risk-threat)', stroke: 'var(--surface)', ink: 'var(--surface)', frame: 'diamond' },
  // Amber: white would grey out, so the icon goes dark on this one.
  WATCH: { fill: 'var(--risk-review)', stroke: 'var(--risk-review-deep)', ink: 'var(--risk-review-ink)', frame: 'quatrefoil' },
  CLEAR: { fill: 'var(--risk-safe)', stroke: 'var(--surface)', ink: 'var(--surface)', frame: 'square' },
  pending: { fill: 'var(--surface)', stroke: 'var(--ink-faint)', ink: 'var(--ink-faint)', frame: 'pending' },
};

/** The APP-6 frame, centred on the origin. */
export function framePath(kind: LevelStyle['frame'], s: number): string {
  switch (kind) {
    case 'diamond': {
      const d = s * 1.25;
      return `M0 ${-d} L${d} 0 L0 ${d} L${-d} 0 Z`;
    }
    case 'quatrefoil': {
      // Four outward semicircles on the sides of a square: the APP-6 unknown
      // frame. Traversal is clockwise, so sweep 0 bulges away from the centre.
      const a = s * 0.62;
      return (
        `M${-a} ${-a} A${a} ${a} 0 0 0 ${a} ${-a}` +
        `A${a} ${a} 0 0 0 ${a} ${a}` +
        `A${a} ${a} 0 0 0 ${-a} ${a}` +
        `A${a} ${a} 0 0 0 ${-a} ${-a} Z`
      );
    }
    default:
      return `M${-s} ${-s} H${s} V${s} H${-s} Z`;
  }
}

/**
 * The vehicle icon, in a box one unit each way from the origin. Side views:
 * length and roofline are what separate these four at a glance.
 */
export const VEHICLE_ICONS: Record<VehicleClass | 'unknown', string> = {
  // Low bonnet, short cabin.
  car: 'M-0.9 0.25 L-0.62 -0.1 L-0.2 -0.34 L0.34 -0.34 L0.62 -0.1 L0.9 0.05 L0.9 0.3 L-0.9 0.3 Z',
  // One box, taller than the car and square at the back.
  van: 'M-0.85 0.3 L-0.85 -0.12 L-0.42 -0.44 L0.85 -0.44 L0.85 0.3 Z',
  // Cab plus a separate load bed: the two-part silhouette.
  truck: 'M-0.95 0.3 L-0.95 -0.42 L-0.1 -0.42 L-0.1 0.3 Z M0.08 0.3 L0.08 -0.1 L0.42 -0.48 L0.95 -0.48 L0.95 0.3 Z',
  // Long, flat roof, window band.
  bus: 'M-0.95 0.34 L-0.95 -0.46 L0.95 -0.46 L0.95 0.34 Z',
  unknown: 'M-0.12 0.34 L-0.12 0.1 L0.12 0.1 L0.12 0.34 Z M-0.55 -0.2 A0.55 0.55 0 1 1 0.05 -0.1 L0 0 L0 0.02',
};

export const VehicleSymbol = memo(function VehicleSymbol({
  x, y, cls, level, size, opacity = 1,
}: VehicleSymbolProps) {
  const style = LEVEL_STYLES[level ?? 'pending'];
  // The icon lives inside the frame, so it is sized from the frame's inscribed
  // box rather than from its widest point: a diamond has much less room than a
  // square of the same reach.
  const inner = size * (style.frame === 'diamond' ? 0.62 : style.frame === 'quatrefoil' ? 0.56 : 0.72);

  return (
    <g
      transform={`translate(${x} ${y})`}
      opacity={opacity}
      data-vehicle-class={cls ?? 'unknown'}
      data-risk-level={level ?? 'unknown'}
      data-frame={style.frame}
    >
      {style.frame === 'pending' ? (
        <circle
          className="vehicle-symbol__frame"
          r={size}
          fill="none"
          stroke={style.stroke}
          strokeWidth={1.2}
          strokeDasharray="2.2 2"
        />
      ) : (
        <path
          className="vehicle-symbol__frame"
          d={framePath(style.frame, size)}
          fill={style.fill}
          stroke={style.stroke}
          strokeWidth={1.3}
        />
      )}
      <path
        className="vehicle-symbol__icon"
        d={VEHICLE_ICONS[cls ?? 'unknown']}
        transform={`scale(${inner})`}
        fill={cls ? style.ink : 'none'}
        stroke={cls ? 'none' : style.ink}
        strokeWidth={cls ? 0 : 0.18}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
});
