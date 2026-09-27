/* A vehicle's movement history, read the way a fitness app reads a run.
 *
 * Strava turns a GPS trace into distance, moving time, pace, splits and a map.
 * This is the same reading of a track, so a vehicle's two hours can be looked
 * at -- and printed as a report -- on one page. Every figure comes from the
 * recorded fixes alone: 25 per track, five minutes apart, in ENU metres.
 *
 * Two rules decide the numbers:
 *
 * 1. Nothing after the clock. The history is clipped at `toMin`, its last point
 *    interpolated there exactly as the map samples the vehicle. A report opened
 *    at 11:00 must not describe 11:30 -- the future-leakage rule `tracks.ts`
 *    and `live.ts` enforce for the map applies to a report just the same.
 * 2. Jitter is not distance. A parked vehicle's fixes wander 4-7 m a step
 *    (PLAN 2.6); summed, that credits a stationary truck with a few hundred
 *    metres of driving. A step counts as moving only when it clears the
 *    engine's own stationary threshold (`kinematics.stationary_disp_m`),
 *    scaled to the step's length.
 *
 * Zone geometry is solved, not sampled: the closest approach to a zone centre
 * and the moment a segment first crosses a radius are closed-form on a straight
 * segment, which is what linear interpolation between fixes draws.
 */

import { bearingOf } from './polar';
import { sampleAt, stopsOf, type Stop } from './tracks';
import type { TrackHistory, VehicleClass, Zone } from './types';

export interface RoutePoint {
  tMin: number;
  e: number;
  n: number;
}

export interface ZonePass {
  zoneId: string;
  name: string;
  closestM: number;
  closestAtMin: number;
  /** First moment inside radius + buffer, or null if it never got that close. */
  bufferEnteredAtMin: number | null;
  /** First moment inside the zone itself. */
  zoneEnteredAtMin: number | null;
  insideBufferMin: number;
}

export interface Split {
  index: number;
  fromMin: number;
  toMin: number;
  distanceM: number;
  movingMin: number;
  avgSpeedMps: number;
  /** Change in range to the base across the split. Negative means it closed. */
  rangeDeltaM: number;
}

export type ActivityEvent =
  | { kind: 'start'; tMin: number; rangeM: number }
  | { kind: 'stop'; tMin: number; durationMin: number }
  | { kind: 'buffer'; tMin: number; zoneId: string; name: string }
  | { kind: 'zone'; tMin: number; zoneId: string; name: string }
  | { kind: 'closest'; tMin: number; rangeM: number }
  | { kind: 'end'; tMin: number; rangeM: number; complete: boolean };

export interface Activity {
  trackId: string;
  cls: VehicleClass | null;
  imageId: string | null;
  fromMin: number;
  toMin: number;
  /** True once the clock has passed the track's last fix: the whole record is in. */
  complete: boolean;
  route: RoutePoint[];
  fixCount: number;
  distanceM: number;
  elapsedMin: number;
  movingMin: number;
  avgMovingSpeedMps: number;
  maxSpeedMps: number;
  maxSpeedAtMin: number | null;
  /** Steps faster than any road vehicle; excluded from the maximum. */
  outlierSteps: number;
  stops: Stop[];
  stoppedMin: number;
  startRangeM: number;
  endRangeM: number;
  closestBaseM: number;
  closestBaseAtMin: number;
  /** Start range minus end range: positive means it ended nearer the base. */
  netApproachM: number;
  /** Straight-line start-to-end. */
  displacementM: number;
  /** Bearing of that displacement; null when it barely moved. */
  headingDeg: number | null;
  /** Every zone, nearest pass first. */
  zones: ZonePass[];
  splits: Split[];
  events: ActivityEvent[];
  box: { w: number; s: number; e: number; n: number };
}

export interface ActivityOptions {
  /** The simulation clock. Nothing recorded after it is read. */
  toMin: number;
  zones: readonly Zone[];
  stationaryDispM: number;
}

/** A step faster than this is a GPS outlier, not a speed (PLAN 6.5). */
export const OUTLIER_MPS = 40;
/** Split length, in minutes. */
export const SPLIT_MIN = 30;
/** The recording interval of every track (PLAN 2.6). */
const STEP_MIN = 5;

/** Closest point of segment a->b to point z, as distance and fraction along. */
function closestOnSegment(
  ae: number, an: number, be: number, bn: number, ze: number, zn: number,
): { d: number; f: number } {
  const de = be - ae;
  const dn = bn - an;
  const len2 = de * de + dn * dn;
  const f = len2 > 0 ? Math.min(1, Math.max(0, ((ze - ae) * de + (zn - an) * dn) / len2)) : 0;
  return { d: Math.hypot(ae + de * f - ze, an + dn * f - zn), f };
}

/**
 * The span of segment a->b that lies inside a circle, as fractions [f0, f1],
 * or null if it never enters. Roots of |a + f(b - a) - z|^2 = r^2.
 */
function insideSpan(
  ae: number, an: number, be: number, bn: number, ze: number, zn: number, r: number,
): [number, number] | null {
  const de = be - ae;
  const dn = bn - an;
  const re = ae - ze;
  const rn = an - zn;
  const A = de * de + dn * dn;
  const C = re * re + rn * rn - r * r;
  if (A === 0) return C <= 0 ? [0, 1] : null;
  const B = 2 * (re * de + rn * dn);
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const f0 = Math.max(0, (-B - root) / (2 * A));
  const f1 = Math.min(1, (-B + root) / (2 * A));
  return f1 >= f0 ? [f0, f1] : null;
}

/** Position on the route at a time inside it, linearly interpolated. */
export function positionAt(route: readonly RoutePoint[], tMin: number): RoutePoint {
  const first = route[0] as RoutePoint;
  if (tMin <= first.tMin) return first;
  for (let i = 1; i < route.length; i += 1) {
    const b = route[i] as RoutePoint;
    if (b.tMin >= tMin) {
      const a = route[i - 1] as RoutePoint;
      const f = b.tMin > a.tMin ? (tMin - a.tMin) / (b.tMin - a.tMin) : 0;
      return { tMin, e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f };
    }
  }
  return route[route.length - 1] as RoutePoint;
}

const rangeOf = (p: RoutePoint) => Math.hypot(p.e, p.n);

/**
 * The activity for one track, as of `opts.toMin`.
 *
 * Null before the track's first fix: a vehicle not yet being followed has no
 * history to report, and reporting its eventual one would leak the future.
 */
export function activityOf(track: TrackHistory, opts: ActivityOptions): Activity | null {
  const count = track.t.length;
  const firstT = track.t[0];
  const lastT = track.t[count - 1];
  if (firstT === undefined || lastT === undefined || opts.toMin < firstT) return null;

  const route: RoutePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = track.t[i] as number;
    if (t > opts.toMin) break;
    route.push({ tMin: t, e: track.e[i] as number, n: track.n[i] as number });
  }
  const complete = opts.toMin >= lastT;
  const fixCount = route.length;
  const tail = route[route.length - 1] as RoutePoint;
  if (!complete && opts.toMin > tail.tMin) {
    const sample = sampleAt(track, opts.toMin);
    if (sample) route.push({ tMin: opts.toMin, e: sample.enu.e_m, n: sample.enu.n_m });
  }

  const start = route[0] as RoutePoint;
  const end = route[route.length - 1] as RoutePoint;
  const fromMin = start.tMin;
  const toMin = end.tMin;

  // --- steps --------------------------------------------------------------- //
  interface Step { a: RoutePoint; b: RoutePoint; d: number; dt: number; moving: boolean }
  const steps: Step[] = [];
  let distanceM = 0;
  let movingMin = 0;
  let maxSpeedMps = 0;
  let maxSpeedAtMin: number | null = null;
  let outlierSteps = 0;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1] as RoutePoint;
    const b = route[i] as RoutePoint;
    const dt = b.tMin - a.tMin;
    if (dt <= 0) continue;
    const d = Math.hypot(b.e - a.e, b.n - a.n);
    const moving = d > (opts.stationaryDispM * dt) / STEP_MIN;
    steps.push({ a, b, d, dt, moving });
    const speed = d / (dt * 60);
    if (speed > OUTLIER_MPS) {
      outlierSteps += 1;
      continue;
    }
    if (moving) {
      distanceM += d;
      movingMin += dt;
    }
    // Only whole recording intervals set the maximum: a partial step to the
    // clock is an interpolation, not a measurement.
    if (dt >= STEP_MIN - 1e-9 && speed > maxSpeedMps) {
      maxSpeedMps = speed;
      maxSpeedAtMin = b.tMin;
    }
  }

  // --- stops ---------------------------------------------------------------- //
  const clipped: TrackHistory = {
    track_id: track.track_id,
    cls: track.cls,
    image_id: track.image_id,
    t: route.map((p) => p.tMin),
    e: route.map((p) => p.e),
    n: route.map((p) => p.n),
  };
  const stops = stopsOf(clipped, opts.stationaryDispM);
  const stoppedMin = stops.reduce((sum, s) => sum + (s.toMin - s.fromMin), 0);

  // --- range to the base ---------------------------------------------------- //
  let closestBaseM = rangeOf(start);
  let closestBaseAtMin = start.tMin;
  for (const step of steps) {
    const { d, f } = closestOnSegment(step.a.e, step.a.n, step.b.e, step.b.n, 0, 0);
    if (d < closestBaseM) {
      closestBaseM = d;
      closestBaseAtMin = step.a.tMin + f * step.dt;
    }
  }

  // --- zones ---------------------------------------------------------------- //
  const zones: ZonePass[] = opts.zones.map((zone) => {
    const ze = zone.enu.e_m;
    const zn = zone.enu.n_m;
    const pass: ZonePass = {
      zoneId: zone.zone_id,
      name: zone.name,
      closestM: Math.hypot(start.e - ze, start.n - zn),
      closestAtMin: start.tMin,
      bufferEnteredAtMin: null,
      zoneEnteredAtMin: null,
      insideBufferMin: 0,
    };
    const outer = zone.radius_m + zone.buffer_m;
    if (pass.closestM <= outer) pass.bufferEnteredAtMin = start.tMin;
    if (pass.closestM <= zone.radius_m) pass.zoneEnteredAtMin = start.tMin;
    for (const step of steps) {
      const { a, b, dt } = step;
      const { d, f } = closestOnSegment(a.e, a.n, b.e, b.n, ze, zn);
      if (d < pass.closestM) {
        pass.closestM = d;
        pass.closestAtMin = a.tMin + f * dt;
      }
      const buffer = insideSpan(a.e, a.n, b.e, b.n, ze, zn, outer);
      if (buffer) {
        pass.insideBufferMin += (buffer[1] - buffer[0]) * dt;
        pass.bufferEnteredAtMin ??= a.tMin + buffer[0] * dt;
      }
      const core = insideSpan(a.e, a.n, b.e, b.n, ze, zn, zone.radius_m);
      if (core) pass.zoneEnteredAtMin ??= a.tMin + core[0] * dt;
    }
    return pass;
  }).sort((x, y) => x.closestM - y.closestM);

  // --- splits --------------------------------------------------------------- //
  const splits: Split[] = [];
  for (let s0 = fromMin, index = 1; s0 < toMin - 1e-9; s0 += SPLIT_MIN, index += 1) {
    const s1 = Math.min(s0 + SPLIT_MIN, toMin);
    let d = 0;
    let moving = 0;
    for (const step of steps) {
      if (!step.moving || step.d / (step.dt * 60) > OUTLIER_MPS) continue;
      const overlap = Math.min(step.b.tMin, s1) - Math.max(step.a.tMin, s0);
      if (overlap <= 0) continue;
      d += step.d * (overlap / step.dt);
      moving += overlap;
    }
    splits.push({
      index,
      fromMin: s0,
      toMin: s1,
      distanceM: d,
      movingMin: moving,
      avgSpeedMps: moving > 0 ? d / (moving * 60) : 0,
      rangeDeltaM: rangeOf(positionAt(route, s1)) - rangeOf(positionAt(route, s0)),
    });
  }

  // --- events --------------------------------------------------------------- //
  const events: ActivityEvent[] = [{ kind: 'start', tMin: fromMin, rangeM: rangeOf(start) }];
  for (const stop of stops) {
    events.push({ kind: 'stop', tMin: stop.fromMin, durationMin: stop.toMin - stop.fromMin });
  }
  for (const pass of zones) {
    if (pass.bufferEnteredAtMin !== null) {
      events.push({ kind: 'buffer', tMin: pass.bufferEnteredAtMin, zoneId: pass.zoneId, name: pass.name });
    }
    if (pass.zoneEnteredAtMin !== null) {
      events.push({ kind: 'zone', tMin: pass.zoneEnteredAtMin, zoneId: pass.zoneId, name: pass.name });
    }
  }
  // The closest approach is news only when it was neither the start nor the end.
  if (closestBaseAtMin - fromMin > STEP_MIN && toMin - closestBaseAtMin > STEP_MIN) {
    events.push({ kind: 'closest', tMin: closestBaseAtMin, rangeM: closestBaseM });
  }
  events.push({ kind: 'end', tMin: toMin, rangeM: rangeOf(end), complete });
  // Stable: at equal times, the order pushed above is the reading order.
  events.sort((x, y) => x.tMin - y.tMin);

  // --- shape ---------------------------------------------------------------- //
  const box = { w: start.e, s: start.n, e: start.e, n: start.n };
  for (const p of route) {
    box.w = Math.min(box.w, p.e);
    box.e = Math.max(box.e, p.e);
    box.s = Math.min(box.s, p.n);
    box.n = Math.max(box.n, p.n);
  }
  const displacementM = Math.hypot(end.e - start.e, end.n - start.n);

  return {
    trackId: track.track_id,
    cls: track.cls,
    imageId: track.image_id,
    fromMin,
    toMin,
    complete,
    route,
    fixCount,
    distanceM,
    elapsedMin: toMin - fromMin,
    movingMin,
    avgMovingSpeedMps: movingMin > 0 ? distanceM / (movingMin * 60) : 0,
    maxSpeedMps,
    maxSpeedAtMin,
    outlierSteps,
    stops,
    stoppedMin,
    startRangeM: rangeOf(start),
    endRangeM: rangeOf(end),
    closestBaseM,
    closestBaseAtMin,
    netApproachM: rangeOf(start) - rangeOf(end),
    displacementM,
    headingDeg: displacementM > opts.stationaryDispM
      ? bearingOf({ e_m: end.e - start.e, n_m: end.n - start.n })
      : null,
    zones,
    splits,
    events,
    box,
  };
}

/** The one-line story of an activity, most significant reading first. */
export type Headline =
  | { kind: 'zone'; name: string; atMin: number }
  | { kind: 'buffer'; name: string; atMin: number }
  | { kind: 'parked'; minutes: number }
  | { kind: 'approaching'; metres: number }
  | { kind: 'receding'; metres: number }
  | { kind: 'roaming'; metres: number };

/** Net range change below this reads as neither approach nor retreat. */
const NET_MOVE_M = 500;

export function headlineOf(activity: Activity): Headline {
  const entered = activity.zones
    .filter((z) => z.zoneEnteredAtMin !== null)
    .sort((a, b) => (a.zoneEnteredAtMin as number) - (b.zoneEnteredAtMin as number))[0];
  if (entered) return { kind: 'zone', name: entered.name, atMin: entered.zoneEnteredAtMin as number };
  const buffered = activity.zones
    .filter((z) => z.bufferEnteredAtMin !== null)
    .sort((a, b) => (a.bufferEnteredAtMin as number) - (b.bufferEnteredAtMin as number))[0];
  if (buffered) return { kind: 'buffer', name: buffered.name, atMin: buffered.bufferEnteredAtMin as number };
  if (activity.elapsedMin >= 30 && activity.stoppedMin >= activity.elapsedMin * 0.7) {
    return { kind: 'parked', minutes: activity.stoppedMin };
  }
  if (activity.netApproachM >= NET_MOVE_M) return { kind: 'approaching', metres: activity.netApproachM };
  if (activity.netApproachM <= -NET_MOVE_M) return { kind: 'receding', metres: -activity.netApproachM };
  return { kind: 'roaming', metres: activity.distanceM };
}
