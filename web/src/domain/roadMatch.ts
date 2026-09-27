/* The map-matched trace of one track, ready to draw.
 *
 * Half a track's fixes typically match no road (see app/roads/mapmatch.py), so
 * the matched trace is not one line: it is the runs that did match, with the
 * gaps left open. Joining across a gap would draw a road the vehicle was never
 * shown to be on, which is the one thing map matching must not do.
 */

import type { Enu, TrackHistory } from './types';

export interface MatchedRun {
  /** Index of the first fix in this run, for keying and for the clock. */
  from: number;
  points: Enu[];
}

export interface MatchedTrace {
  /**
   * The route driven, from the graph. This is the trace worth looking at: a
   * path along real streets rather than the snapped fixes on their own.
   */
  legs: MatchedRun[];
  runs: MatchedRun[];
  /** Fixes that matched nothing, at their raw position. */
  unmatched: Enu[];
  matchedFraction: number;
  roads: string[];
  medianOffsetM: number;
  /** "graph" or "geometry"; only the graph produces legs. */
  method: string;
  routeLengthM: number;
}

/** Null when the fixtures carry no match for this track. */
export function matchedTrace(track: TrackHistory, toMin?: number): MatchedTrace | null {
  const { me, mn } = track;
  if (!me || !mn) return null;

  const runs: MatchedRun[] = [];
  const unmatched: Enu[] = [];
  let open: MatchedRun | null = null;

  for (let i = 0; i < track.t.length; i += 1) {
    if (toMin !== undefined && track.t[i]! > toMin) break;
    const e = me[i];
    const n = mn[i];
    if (e == null || n == null) {
      open = null;
      unmatched.push({ e_m: track.e[i]!, n_m: track.n[i]! });
      continue;
    }
    if (!open) {
      open = { from: i, points: [] };
      runs.push(open);
    }
    open.points.push({ e_m: e, n_m: n });
  }

  // Legs are clipped by the clock on their first fix, so the drawn route never
  // runs ahead of where the map says the vehicle is.
  const legs: MatchedRun[] = (track.legs ?? [])
    .filter((leg) => toMin === undefined || (track.t[leg.from] ?? Infinity) <= toMin)
    .map((leg) => ({
      from: leg.from,
      points: Array.from({ length: leg.pts.length / 2 }, (_, i) => ({
        e_m: leg.pts[i * 2]!,
        n_m: leg.pts[i * 2 + 1]!,
      })),
    }));

  return {
    legs,
    // A run of one is a snapped point, not a path; it stays in the trace so the
    // tick is drawn, and the caller decides whether to stroke it.
    runs,
    unmatched,
    matchedFraction: track.matched_fraction ?? 0,
    roads: track.roads ?? [],
    medianOffsetM: track.median_offset_m ?? 0,
    method: track.match_method ?? 'geometry',
    routeLengthM: track.route_length_m ?? 0,
  };
}
