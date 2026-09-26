/* Reading a track's 2-hour history at an arbitrary clock.
 *
 * The map and the motion chart both need the same four answers about a track --
 * where is it now, has it been sitting still, is it closing on the base, and
 * what does its range-to-base curve look like -- so all four live here and the
 * views ask rather than compute. The history arrays are read in place; nothing
 * in this module allocates per fix, because the map calls `sampleAt` for every
 * live track on every clock tick.
 */

import type { Enu, TrackHistory } from './types';

export interface Sample {
  enu: Enu;
  /** Metres from the base. */
  range_m: number;
  /** Metres per second over the surrounding fixes; 0 while stationary. */
  speed_mps: number;
  /** Negative while closing on the base. */
  closing_mps: number;
  /** Index of the fix at or before the sampled time. */
  index: number;
}

/** A spell during which the vehicle did not meaningfully move. */
export interface Stop {
  fromMin: number;
  toMin: number;
  durationMin: number;
  range_m: number;
}

export type Trend = 'approaching' | 'receding' | 'steady' | 'stopped';

/** True when `tMin` falls inside this track's recorded window. */
export function covers(track: TrackHistory, tMin: number): boolean {
  const first = track.t[0];
  const last = track.t[track.t.length - 1];
  return first !== undefined && last !== undefined && tMin >= first && tMin <= last;
}

export function windowOf(track: TrackHistory): readonly [number, number] {
  return [track.t[0] ?? 0, track.t[track.t.length - 1] ?? 0] as const;
}

/**
 * The track's state at `tMin`, linearly interpolated between fixes.
 *
 * Returns null outside the window rather than clamping: a vehicle whose history
 * has not started is not at its first position, it is simply not yet known, and
 * drawing it early would be exactly the future leakage PLAN forbids.
 */
export function sampleAt(track: TrackHistory, tMin: number): Sample | null {
  const n = track.t.length;
  if (n === 0 || !covers(track, tMin)) return null;

  // Fixes are 5 minutes apart and ascending, so a linear scan from a guessed
  // index beats a binary search in practice and keeps the code obvious.
  let i = n - 1;
  for (let k = 1; k < n; k += 1) {
    if ((track.t[k] as number) > tMin) {
      i = k - 1;
      break;
    }
  }

  const t0 = track.t[i] as number;
  const e0 = track.e[i] as number;
  const n0 = track.n[i] as number;
  const j = Math.min(i + 1, n - 1);
  const t1 = track.t[j] as number;
  const e1 = track.e[j] as number;
  const n1 = track.n[j] as number;

  const span = t1 - t0;
  const f = span > 0 ? (tMin - t0) / span : 0;
  const e = e0 + (e1 - e0) * f;
  const north = n0 + (n1 - n0) * f;

  const dtSec = span * 60;
  const step = Math.hypot(e1 - e0, n1 - n0);
  const speed = dtSec > 0 ? step / dtSec : 0;
  const r0 = Math.hypot(e0, n0);
  const r1 = Math.hypot(e1, n1);
  const closing = dtSec > 0 ? (r1 - r0) / dtSec : 0;

  return {
    enu: { e_m: e, n_m: north },
    range_m: Math.hypot(e, north),
    speed_mps: speed,
    closing_mps: closing,
    index: i,
  };
}

/**
 * The spells this track spent stationary.
 *
 * A spell is a maximal run of consecutive fixes that all stay within
 * `stationaryDispM` of where the run started, and it only counts as a stop once
 * it spans at least two intervals -- a single quiet fix is noise in a
 * constant-velocity fit, not a stop worth telling an operator about.
 *
 * `stationaryDispM` comes from `goru.yaml`'s `kinematics.stationary_disp_m`, so
 * the display's idea of "stopped" is the engine's idea of it.
 */
export function stopsOf(track: TrackHistory, stationaryDispM: number): Stop[] {
  const stops: Stop[] = [];
  const n = track.t.length;
  let start = 0;

  while (start < n - 1) {
    const e0 = track.e[start] as number;
    const n0 = track.n[start] as number;
    let end = start;

    for (let k = start + 1; k < n; k += 1) {
      const dist = Math.hypot((track.e[k] as number) - e0, (track.n[k] as number) - n0);
      if (dist > stationaryDispM) break;
      end = k;
    }

    if (end - start >= 2) {
      const fromMin = track.t[start] as number;
      const toMin = track.t[end] as number;
      stops.push({
        fromMin,
        toMin,
        durationMin: Math.round(toMin - fromMin),
        range_m: Math.hypot(e0, n0),
      });
      start = end;
    } else {
      start += 1;
    }
  }

  return stops;
}

/** Total minutes spent stopped, for the "2 · 85 dk" reading. */
export function stopTotal(stops: readonly Stop[]): number {
  return stops.reduce((sum, s) => sum + s.durationMin, 0);
}

/**
 * Which way the range to base is going.
 *
 * `stopped` wins over direction: a vehicle doing 0.1 m/s is not approaching
 * anything, and labelling it "yaklaşıyor" would put a false urgency on the row.
 */
export function trendOf(sample: Sample, stationarySpeed = 0.5): Trend {
  if (sample.speed_mps < stationarySpeed) return 'stopped';
  if (sample.closing_mps < -0.15) return 'approaching';
  if (sample.closing_mps > 0.15) return 'receding';
  return 'steady';
}

/** The range-to-base curve, for the motion chart. One point per fix. */
export function rangeSeries(track: TrackHistory): { tMin: number; range_m: number }[] {
  const out: { tMin: number; range_m: number }[] = [];
  for (let i = 0; i < track.t.length; i += 1) {
    out.push({
      tMin: track.t[i] as number,
      range_m: Math.hypot(track.e[i] as number, track.n[i] as number),
    });
  }
  return out;
}

/**
 * The tail to draw behind a moving symbol: the fixes over the last
 * `trailMinutes`, newest last, ending at the interpolated present position.
 */
export function trailAt(
  track: TrackHistory,
  tMin: number,
  trailMinutes: number,
): Enu[] {
  const sample = sampleAt(track, tMin);
  if (!sample) return [];
  const cutoff = tMin - trailMinutes;
  const out: Enu[] = [];
  for (let i = 0; i <= sample.index; i += 1) {
    const t = track.t[i] as number;
    if (t >= cutoff) out.push({ e_m: track.e[i] as number, n_m: track.n[i] as number });
  }
  out.push(sample.enu);
  return out;
}
