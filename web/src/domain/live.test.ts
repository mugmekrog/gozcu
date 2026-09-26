import { describe, expect, it } from 'vitest';
import { liveVehiclesAt } from './live';
import type { Alert, FrameSummary, TrackHistory } from './types';

const track: TrackHistory = {
  track_id: 'T0001',
  cls: 'truck',
  image_id: 'img_0001',
  t: [100, 105, 110, 115, 120],
  e: [5000, 4000, 3000, 2000, 1000],
  n: [0, 0, 0, 0, 0],
};

const frame: FrameSummary = {
  image_id: 'img_0001',
  capture_hhmm: '12:00',
  capture_min: 120,
  width_px: 1360,
  height_px: 765,
  zone_id: 'Z03',
  zone_name: 'Dogu Yolu',
  vehicle_count: 1,
  kept_boxes: 1,
  raw_boxes: 400,
  level: 'ALERT',
  score: 90,
  alert_count: 1,
  report_count: 2,
  centre_enu: { e_m: 1000, n_m: 0 },
};

const alert: Alert = {
  alert_id: 'A-img_0001-T0001',
  track_id: 'T0001',
  zone_id: 'Z03',
  zone_name: 'Dogu Yolu',
  cls: 'truck',
  dist_now_m: 900,
  cpa_m: 200,
  eta_entry_s: 180,
  closing_speed_mps: 3.3,
  approach_conf: 0.9,
  speed_mps: 3.3,
  stationary: false,
  baseline_level: 'ALERT',
  agent_level: null,
  level: 'ALERT',
  source: 'rules',
  priority: 0.9,
  reasons: ['ETA 3.0 min to Dogu Yolu'],
  agent_rationale: null,
  agent_dissent: null,
  evidence: ['T0001'],
  status: 'open',
  first_raised_hhmm: '12:00',
  breakdown: { score: 90, base_score: 90, heavy_multiplier: null, terms: [], note: null },
  image_id: 'img_0001',
};

const base = {
  tracks: [track],
  frames: [frame],
  alertsByFrame: new Map([['img_0001', [alert]]]),
  stationaryDispM: 25,
  classFilter: 'all' as const,
  zoneFilter: 'all' as const,
};

describe('liveVehiclesAt', () => {
  it('leaves a vehicle unassessed until its own frame has been captured', () => {
    // This is the display half of the no-future-leakage rule. At 11:55 the drone
    // has not taken the picture yet, so the ALERT that picture will produce must
    // not be on screen -- otherwise the demo shows the system knowing the future.
    const before = liveVehiclesAt({ ...base, tMin: 115 });
    expect(before).toHaveLength(1);
    expect(before[0]!.level).toBeNull();
    expect(before[0]!.alert).toBeNull();
    expect(before[0]!.score).toBe(0);
  });

  it('applies the level from the capture instant onwards', () => {
    const after = liveVehiclesAt({ ...base, tMin: 120 });
    expect(after[0]!.level).toBe('ALERT');
    expect(after[0]!.score).toBe(90);
    expect(after[0]!.alert?.alert_id).toBe(alert.alert_id);
  });

  it('treats an assessed vehicle with no alert as CLEAR, not unassessed', () => {
    const quiet = liveVehiclesAt({ ...base, tMin: 120, alertsByFrame: new Map() });
    expect(quiet[0]!.level).toBe('CLEAR');
  });

  it('omits a track whose history has not started', () => {
    expect(liveVehiclesAt({ ...base, tMin: 50 })).toHaveLength(0);
  });

  it('filters by class', () => {
    expect(liveVehiclesAt({ ...base, tMin: 120, classFilter: 'car' })).toHaveLength(0);
    expect(liveVehiclesAt({ ...base, tMin: 120, classFilter: 'truck' })).toHaveLength(1);
  });

  it('filters by the zone the alert names', () => {
    expect(liveVehiclesAt({ ...base, tMin: 120, zoneFilter: 'Z03' })).toHaveLength(1);
    expect(liveVehiclesAt({ ...base, tMin: 120, zoneFilter: 'Z05' })).toHaveLength(0);
  });

  it('draws the worst vehicles last so their symbols are never hidden', () => {
    const quietTrack: TrackHistory = { ...track, track_id: 'T0002', image_id: null };
    const mixed = liveVehiclesAt({
      ...base,
      tMin: 120,
      tracks: [track, quietTrack],
    });
    expect(mixed.map((v) => v.trackId)).toEqual(['T0002', 'T0001']);
  });

  it('keeps the worst of several alerts on one track', () => {
    const watch: Alert = { ...alert, alert_id: 'A2', zone_id: 'Z04', level: 'WATCH', priority: 0.4 };
    const vehicles = liveVehiclesAt({
      ...base,
      tMin: 120,
      alertsByFrame: new Map([['img_0001', [watch, alert]]]),
    });
    expect(vehicles[0]!.level).toBe('ALERT');
  });
});
