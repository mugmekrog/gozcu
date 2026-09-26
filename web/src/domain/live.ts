/* What is on the map at a given clock.
 *
 * The map, the motion chart and the motion table all need the same answer --
 * which vehicles exist right now, where, and at what risk level -- so it is
 * computed once here and the views read it.
 *
 * The rule about *when* a vehicle has a risk level is the important part. A
 * track's assessment exists only from its own frame's capture time: that is when
 * the drone saw it, when the detections were post-processed, and when the rule
 * engine ran. Before that instant the track is being followed but has not been
 * judged, and it renders as unassessed. Showing its eventual level early would
 * be exactly the future leakage `Timeline.as_of` exists to prevent on the
 * backend, and the display must not undo that.
 */

import { riskRank } from './risk';
import { sampleAt, stopsOf, stopTotal, trendOf, type Sample, type Trend } from './tracks';
import type {
  Alert,
  FrameSummary,
  Level,
  TrackHistory,
  VehicleClass,
  ZoneAssessmentRow,
} from './types';

export interface LiveVehicle {
  trackId: string;
  cls: VehicleClass | null;
  sample: Sample;
  trend: Trend;
  /** null until this vehicle's own frame has been captured. */
  level: Level | null;
  score: number;
  alert: Alert | null;
  /** The frame whose capture time gave this vehicle its level. */
  imageId: string | null;
  stops: { count: number; totalMin: number };
}

export interface LiveOptions {
  tMin: number;
  tracks: readonly TrackHistory[];
  frames: readonly FrameSummary[];
  alertsByFrame: ReadonlyMap<string, readonly Alert[]>;
  stationaryDispM: number;
  classFilter: VehicleClass | 'all';
  /** Restrict to vehicles whose alert names this zone. */
  zoneFilter: string | 'all';
}

/**
 * Build the live set.
 *
 * Linear in the number of tracks and allocation-light per track: one `Sample`
 * and one stops array each. At the shipped data's busiest clock this is a few
 * dozen vehicles, and the whole pass is well under a millisecond.
 */
export function liveVehiclesAt(opts: LiveOptions): LiveVehicle[] {
  const { tMin, tracks, frames, alertsByFrame, stationaryDispM } = opts;

  const captureOf = new Map(frames.map((f) => [f.image_id, f.capture_min]));
  const out: LiveVehicle[] = [];

  for (const track of tracks) {
    if (opts.classFilter !== 'all' && track.cls !== opts.classFilter) continue;

    const sample = sampleAt(track, tMin);
    if (!sample) continue;

    const imageId = track.image_id;
    const captured = imageId != null ? captureOf.get(imageId) : undefined;
    const assessed = captured !== undefined && captured <= tMin;

    let alert: Alert | null = null;
    if (assessed && imageId) {
      const frameAlerts = alertsByFrame.get(imageId);
      if (frameAlerts) {
        // A track can carry one alert per zone; the worst one is its level.
        for (const candidate of frameAlerts) {
          if (candidate.track_id !== track.track_id) continue;
          if (
            alert === null ||
            riskRank(candidate.level) > riskRank(alert.level) ||
            (riskRank(candidate.level) === riskRank(alert.level) &&
              candidate.priority > alert.priority)
          ) {
            alert = candidate;
          }
        }
      }
    }

    if (opts.zoneFilter !== 'all' && alert?.zone_id !== opts.zoneFilter) continue;

    // Assessed with no alert means the rules looked and found nothing: CLEAR.
    const level: Level | null = assessed ? (alert?.level ?? 'CLEAR') : null;
    const stops = stopsOf(track, stationaryDispM);

    out.push({
      trackId: track.track_id,
      cls: track.cls,
      sample,
      trend: trendOf(sample),
      level,
      score: alert?.breakdown.score ?? 0,
      alert,
      imageId,
      stops: { count: stops.length, totalMin: stopTotal(stops) },
    });
  }

  // Draw order: quiet first, loud last, so a triangle is never hidden under a
  // square. The map relies on this ordering rather than on z-index.
  out.sort((a, b) => riskRank(a.level) - riskRank(b.level) || a.score - b.score);
  return out;
}

/** The frames captured at or before the clock. The rest have not happened yet. */
export function framesUpTo(frames: readonly FrameSummary[], tMin: number): FrameSummary[] {
  return frames.filter((f) => f.capture_min <= tMin);
}

/** The zone this vehicle is heading for, if its alert names one. */
export function zoneAssessmentFor(
  assessments: Record<string, ZoneAssessmentRow[]> | undefined,
  trackId: string,
  zoneId: string | null,
): ZoneAssessmentRow | null {
  const rows = assessments?.[trackId];
  if (!rows || rows.length === 0) return null;
  if (!zoneId) return rows[0] ?? null;
  return rows.find((r) => r.zone_id === zoneId) ?? rows[0] ?? null;
}
