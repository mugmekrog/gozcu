/* The radar's coordinate system.
 *
 * One projection, used by every layer. ENU metres from the base go in, SVG
 * user-space points come out. The interface is two functions and a viewport
 * description; everything about ring spacing, the north-up flip and the scale
 * switch is behind them, so no layer does arithmetic on a coordinate.
 *
 * Why a plain SVG projection rather than deck.gl, which PLAN F0.1 names: the
 * wireframes specify a flat vector radar -- dashed rings, 45-degree spokes, a
 * sweep wedge, glyph symbols -- and no basemap, no extrusion and no pitch
 * control. An orthographic WebGL view would add roughly a megabyte of runtime
 * to draw strokes the browser already draws, and the offline requirement
 * (PLAN F4.3) argues the same way. Measured cost of the SVG at the real data's
 * worst frame is in the log.
 */

import type { Enu } from './types';

/** Visible radius in kilometres; continuous zoom is clamped to this range. */
export type ScaleKm = number;
export const MIN_SCALE = 1;
export const MAX_SCALE = 12;
export function zoomScale(current: number, direction: -1 | 1): number {
  const next = direction < 0 ? current / 1.15 : current * 1.15;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 10) / 10));
}

/**
 * The default scale.
 *
 * 8 km, because the furthest track fix in the shipped data sits 7.99 km from
 * the base -- so 8 km is the smallest ring that holds the whole exercise. The
 * wireframe also shows 8 selected, which is the same answer arrived at twice.
 */
export const DEFAULT_SCALE: ScaleKm = 8;

/** SVG user-space extent. Fixed, so the viewBox is stable and text is crisp. */
export const VIEW = { w: 960, h: 680, cx: 480, cy: 340 } as const;

export interface Projection {
  /** Visible radius in kilometres. */
  scaleKm: ScaleKm;
  /** SVG units per kilometre. */
  unitsPerKm: number;
  /** ENU metres to an SVG point. North is up, so north maps to -y. */
  project(enu: Enu): readonly [number, number];
  /** Polar placement: compass bearing and range, for labels and zone rings. */
  polar(bearingDeg: number, rangeKm: number, offsetAlong?: number): readonly [number, number];
  /** SVG radius for a range in metres. */
  radius(metres: number): number;
  /** True when the point falls inside the visible disc, with a small margin. */
  visible(enu: Enu): boolean;
}

/**
 * Build the projection for one scale.
 *
 * The radius that fits is set by the *shorter* half-extent (the height), so the
 * outermost ring is always fully on screen and the horizontal margin carries
 * the range labels.
 */
export function projectionFor(scaleKm: ScaleKm): Projection {
  const usable = VIEW.h / 2 - 20;
  const unitsPerKm = usable / scaleKm;
  const limitM = scaleKm * 1000 * 1.02;

  return {
    scaleKm,
    unitsPerKm,
    project(enu) {
      return [
        VIEW.cx + (enu.e_m / 1000) * unitsPerKm,
        VIEW.cy - (enu.n_m / 1000) * unitsPerKm,
      ] as const;
    },
    polar(bearingDeg, rangeKm, offsetAlong = 0) {
      const a = (bearingDeg * Math.PI) / 180;
      const r = rangeKm * unitsPerKm + offsetAlong;
      return [VIEW.cx + r * Math.sin(a), VIEW.cy - r * Math.cos(a)] as const;
    },
    radius(metres) {
      return (metres / 1000) * unitsPerKm;
    },
    visible(enu) {
      return Math.hypot(enu.e_m, enu.n_m) <= limitM;
    },
  };
}

/** Ring ranges extend past the viewport when the map is panned. */
export function ringsFor(scaleKm: ScaleKm, extentKm = scaleKm): number[] {
  const step = scaleKm <= 2 ? 0.5 : scaleKm <= 8 ? 1 : 2;
  const out: number[] = [];
  for (let k = step; k <= Math.max(scaleKm, extentKm); k += step) out.push(k);
  return out;
}

/** The eight compass spokes the zones sit on, plus the 30-degree minor spokes. */
export const MAJOR_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export function bearingOf(enu: Enu): number {
  const deg = (Math.atan2(enu.e_m, enu.n_m) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function rangeOf(enu: Enu): number {
  return Math.hypot(enu.e_m, enu.n_m);
}

/**
 * Where a label should sit relative to its anchor so it never crosses the
 * centre: on the outward side of the spoke it belongs to.
 */
export function labelSide(bearingDeg: number): 'start' | 'end' {
  const a = (bearingDeg * Math.PI) / 180;
  return Math.sin(a) < -0.1 ? 'end' : 'start';
}

/** ENU point for a compass bearing and a range in metres. Used by tests. */
export function enuAt(bearingDeg: number, rangeM: number): Enu {
  const a = (bearingDeg * Math.PI) / 180;
  return { e_m: rangeM * Math.sin(a), n_m: rangeM * Math.cos(a) };
}
