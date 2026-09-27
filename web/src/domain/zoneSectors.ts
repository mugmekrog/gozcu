/* The angular share of the map each zone owns.
 *
 * Drawn as circles the zones leave wedges of ground belonging to nobody: a
 * vehicle two thirds of the way from the base to Dogu Yolu is plainly heading
 * for Dogu Yolu and sits inside no ring at all. So each zone also claims the
 * sector from the base out to its own buffer edge, bounded by the bisectors to
 * the zones either side of it. The eight shipped zones sit at exact 45-degree
 * steps, so their sectors tile the full circle with no seam -- but the
 * bisectors are computed, not assumed, so an unevenly placed zone still gets
 * the ground nearest its own bearing and nothing more.
 *
 * This is direction, not the alert geometry: what fires a WATCH or an ALERT is
 * still the range to the zone centre against its radius (see ZoneLayer, which
 * keeps drawing that circle on top).
 */

import type { Zone } from './types';

export interface ZoneSector {
  zone_id: string;
  /** Sector edges as compass bearings; `toDeg` may exceed 360 after a wrap. */
  fromDeg: number;
  toDeg: number;
  /** How far the wedge reaches from the base, in metres: the buffer edge. */
  outerM: number;
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Halfway from `a` clockwise to `b`. */
const bisector = (a: number, b: number) => a + wrap(b - a) / 2;

export function zoneSectors(zones: readonly Zone[]): ZoneSector[] {
  if (zones.length === 0) return [];
  const ordered = [...zones].sort((a, b) => wrap(a.bearing_deg) - wrap(b.bearing_deg));
  const outerOf = (zone: Zone) => zone.range_m + zone.radius_m + zone.buffer_m;

  // A lone zone owns every bearing; there is nothing to bisect against.
  if (ordered.length === 1) {
    const only = ordered[0]!;
    return [{ zone_id: only.zone_id, fromDeg: 0, toDeg: 360, outerM: outerOf(only) }];
  }

  return ordered.map((zone, i) => {
    const previous = ordered[(i - 1 + ordered.length) % ordered.length]!;
    const next = ordered[(i + 1) % ordered.length]!;
    const from = bisector(wrap(previous.bearing_deg), wrap(zone.bearing_deg));
    const to = bisector(wrap(zone.bearing_deg), wrap(next.bearing_deg));
    return {
      zone_id: zone.zone_id,
      fromDeg: from,
      toDeg: to > from ? to : to + 360,
      outerM: outerOf(zone),
    };
  });
}
