/* Integrity of the exported fixtures against PLAN's measured numbers.
 *
 * These read the JSON off disk rather than mocking it, so they fail if the export
 * script drifts from the engine, if the engine's own numbers move, or if someone
 * hand-edits a fixture. That is the point: the display's credibility rests on its
 * figures being the engine's figures, and this is the only automatic check of that
 * on the frontend side.
 *
 * Skipped with a clear message when the fixtures have not been generated, so a
 * fresh clone does not fail for a reason that is not a bug.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Alert, DatasetInfo, FieldReport, FrameDetail, TrackHistory } from '@/domain/types';

const DIR = join(__dirname, '..', '..', 'public', 'fixtures');
const present = existsSync(join(DIR, 'dataset.json'));

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as T;
}

const suite = present ? describe : describe.skip;

if (!present) {
  // eslint-disable-next-line no-console
  console.warn(
    'fixtures not found; run `python web/scripts/export_fixtures.py` from the repo root',
  );
}

suite('dataset.json', () => {
  const dataset = present ? read<DatasetInfo>('dataset.json') : ({} as DatasetInfo);

  it('holds the census PLAN 2.1 measured', () => {
    expect(dataset.counts.images).toBe(40);
    expect(dataset.counts.tracks).toBe(226);
    expect(dataset.counts.reports).toBe(137);
    expect(dataset.counts.zones).toBe(8);
    expect(dataset.counts.raw_boxes).toBe(17394);
  });

  it('places the eight zones on the ring PLAN 2.4 measured', () => {
    // 3 192-3 204 m at exact 45-degree steps. The display labels its spokes from
    // these, so if the ring moved the labels would silently lie.
    expect(dataset.zones).toHaveLength(8);
    for (const zone of dataset.zones) {
      // PLAN's table is rounded to whole metres, so compare at that precision.
      expect(Math.round(zone.range_m)).toBeGreaterThanOrEqual(3192);
      expect(Math.round(zone.range_m)).toBeLessThanOrEqual(3204);
    }
    const bearings = dataset.zones.map((z) => z.bearing_deg).sort((a, b) => a - b);
    const expected = [0, 45, 90, 135, 180, 225, 270, 315];
    bearings.forEach((bearing, i) => {
      expect(Math.abs(bearing - (expected[i] as number))).toBeLessThan(0.2);
    });
  });

  it('names the base as the data spells it', () => {
    // ASCII-folded, per PLAN 2.4: report text is matched against these strings.
    expect(dataset.base.name).toBe('Merkez Us');
    expect(dataset.base.lat).toBeCloseTo(39.92184, 5);
    expect(dataset.base.lon).toBeCloseTo(32.85306, 5);
  });

  it('labels frame times on the exercise clock, not UTC', () => {
    // PLAN 2.1: capture runs 10:10 to 15:50 local. A UTC label would read 07:10.
    const hours = dataset.frames.map((f) => Number(f.capture_hhmm.slice(0, 2)));
    expect(Math.min(...hours)).toBe(10);
    expect(Math.max(...hours)).toBe(15);
    expect(dataset.frames[0]!.capture_hhmm).toBe('10:10');
  });

  it('gives the timeline a window that contains every frame', () => {
    for (const frame of dataset.frames) {
      expect(frame.capture_min).toBeGreaterThanOrEqual(dataset.sim.start_min);
      expect(frame.capture_min).toBeLessThanOrEqual(dataset.sim.end_min);
    }
  });

  it('imports cleanly: no blocking validation errors', () => {
    const errors = dataset.validation_issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('carries the thresholds the score breakdown is read against', () => {
    expect(dataset.thresholds.zone_radius_m).toBeGreaterThan(0);
    expect(dataset.thresholds.zone_buffer_m).toBeGreaterThan(0);
    expect(dataset.thresholds.horizon_min).toBeGreaterThan(0);
    expect(dataset.thresholds.stationary_disp_m).toBeGreaterThan(0);
  });
});

suite('alerts.json', () => {
  const alerts = present ? read<{ alerts: Alert[] }>('alerts.json').alerts : [];

  it('reproduces the baseline mix the agent log recorded', () => {
    const byLevel = alerts.reduce<Record<string, number>>((acc, alert) => {
      acc[alert.level] = (acc[alert.level] ?? 0) + 1;
      return acc;
    }, {});
    expect(byLevel.ALERT).toBe(23);
    expect(byLevel.WATCH).toBe(126);
  });

  it('breaks every score into terms that add up to it', () => {
    // A breakdown whose rows miss the total invites the reader to distrust both.
    for (const alert of alerts) {
      const sum = alert.breakdown.terms.reduce((total, term) => total + term.points, 0);
      expect(sum, `${alert.alert_id} terms do not sum to its score`).toBe(
        alert.breakdown.score,
      );
    }
  });

  it('keeps the score consistent with the engine priority it came from', () => {
    for (const alert of alerts) {
      expect(alert.breakdown.score).toBe(Math.round(alert.priority * 100));
    }
  });

  it('never lets an agent level sit below the rule baseline', () => {
    // The floor from the agent layer must survive serialisation: the level the
    // reviewer sees is the higher of the two, never the agent's alone.
    const rank = { CLEAR: 1, WATCH: 2, ALERT: 3 } as const;
    for (const alert of alerts) {
      expect(rank[alert.level]).toBeGreaterThanOrEqual(rank[alert.baseline_level]);
    }
  });

  it('marks untracked-detection alerts so they are not looked up as tracks', () => {
    const untracked = alerts.filter((a) => a.track_id.includes('#'));
    expect(untracked).toHaveLength(7);
    for (const alert of untracked) {
      // No track means no kinematics; the payload must say so rather than zero it.
      expect(alert.eta_entry_s).toBeNull();
      expect(alert.speed_mps).toBeNull();
      expect(alert.breakdown.note).toBeTruthy();
    }
  });
});

suite('tracks.json', () => {
  const tracks = present ? read<{ tracks: TrackHistory[] }>('tracks.json').tracks : [];

  it('holds 226 tracks of exactly 25 fixes', () => {
    expect(tracks).toHaveLength(226);
    for (const track of tracks) {
      expect(track.t).toHaveLength(25);
      expect(track.e).toHaveLength(25);
      expect(track.n).toHaveLength(25);
    }
  });

  it('keeps the fixes of every track in ascending time order', () => {
    for (const track of tracks) {
      for (let i = 1; i < track.t.length; i += 1) {
        expect(track.t[i]!).toBeGreaterThan(track.t[i - 1]!);
      }
    }
  });

  it('stays inside the 8 km scale the map defaults to', () => {
    let max = 0;
    for (const track of tracks) {
      for (let i = 0; i < track.e.length; i += 1) {
        max = Math.max(max, Math.hypot(track.e[i]!, track.n[i]!));
      }
    }
    expect(max).toBeLessThan(8000);
  });
});

suite('reports.json', () => {
  const reports = present ? read<{ reports: FieldReport[] }>('reports.json').reports : [];

  it('splits by source as PLAN 2.1 measured', () => {
    expect(reports).toHaveLength(137);
    expect(reports.filter((r) => r.source === 'official')).toHaveLength(98);
    expect(reports.filter((r) => r.source === 'third_party')).toHaveLength(39);
  });

  it('assigns the R001..R137 ids the agent layer cites', () => {
    // Finding F5 in the agent log: ids are synthesised from file order, and a
    // citation will not line up if anything renumbers them.
    expect(reports[0]!.report_id).toBe('R001');
    expect(reports[reports.length - 1]!.report_id).toBe('R137');
  });
});

suite('frames/*.json', () => {
  const dataset = present ? read<DatasetInfo>('dataset.json') : ({} as DatasetInfo);

  it('serves a full payload for every frame in the index', () => {
    for (const summary of dataset.frames) {
      expect(
        existsSync(join(DIR, 'frames', `${summary.image_id}.json`)),
        `missing payload for ${summary.image_id}`,
      ).toBe(true);
    }
  });

  it('agrees with its own summary and funnel', () => {
    for (const summary of dataset.frames) {
      const frame = read<FrameDetail>(join('frames', `${summary.image_id}.json`));
      expect(frame.image_id).toBe(summary.image_id);
      expect(frame.capture_hhmm).toBe(summary.capture_hhmm);
      expect(frame.width_px).toBe(summary.width_px);
      expect(frame.track_states).toHaveLength(summary.vehicle_count);
      expect(frame.detections.filter((d) => d.kept)).toHaveLength(summary.kept_boxes);
      if (frame.funnel) {
        expect(frame.funnel.raw).toBe(frame.detections.length);
        expect(frame.funnel.kept).toBe(summary.kept_boxes);
      }
    }
  });

  it('gives every dropped box a reason and every kept box none', () => {
    // The UI shows the reason on hover, so a box dropped for no stated reason
    // would be unexplainable on screen.
    for (const summary of dataset.frames.slice(0, 8)) {
      const frame = read<FrameDetail>(join('frames', `${summary.image_id}.json`));
      for (const det of frame.detections) {
        if (det.kept) expect(det.drop_reason).toBeNull();
        else expect(det.drop_reason).toBeTruthy();
      }
    }
  });

  it('keeps bounding boxes inside the image', () => {
    for (const summary of dataset.frames.slice(0, 8)) {
      const frame = read<FrameDetail>(join('frames', `${summary.image_id}.json`));
      for (const det of frame.detections.filter((d) => d.kept)) {
        const [x1, y1, x2, y2] = det.bbox_px;
        expect(x1).toBeGreaterThanOrEqual(0);
        expect(y1).toBeGreaterThanOrEqual(0);
        expect(x2).toBeLessThanOrEqual(frame.width_px);
        expect(y2).toBeLessThanOrEqual(frame.height_px);
        expect(x2).toBeGreaterThan(x1);
        expect(y2).toBeGreaterThan(y1);
      }
    }
  });

  it('ships a rules-based brief for every frame, labelled as such', () => {
    // No gateway ran during the export, so every brief must be the deterministic
    // template and must say so -- the UI decides what to label from this field.
    for (const summary of dataset.frames) {
      const frame = read<FrameDetail>(join('frames', `${summary.image_id}.json`));
      expect(frame.brief.source).toBe('rules');
    }
  });
});
