/* The fake data seam used by the shell tests.
 *
 * Extracted from `App.test.tsx` so the speech tests can drive the same app
 * through the same adapter instead of maintaining a second copy of 226 tracks'
 * worth of shapes. It satisfies `GoruApi` exactly, so anything that type-checks
 * against it type-checks against the real adapters.
 */

import type { AgentEvent, GoruApi } from '@/api/port';
import type { Alert, DatasetInfo, Decision, FrameDetail, TrackHistory } from '@/domain/types';
import type { BasemapFile } from '@/domain/basemap';

export const ORIGIN = '2026-09-26T05:10:00+00:00';

export const zone = {
  zone_id: 'Z03',
  name: 'Dogu Yolu',
  enu: { e_m: 3204, n_m: 0 },
  lat: 39.92184,
  lon: 32.89,
  range_m: 3204,
  bearing_deg: 90,
  radius_m: 250,
  buffer_m: 750,
};

export const alert: Alert = {
  alert_id: 'A-img_0001-T0001',
  track_id: 'T0001',
  zone_id: 'Z03',
  zone_name: 'Dogu Yolu',
  cls: 'truck',
  dist_now_m: 1570,
  cpa_m: 240,
  eta_entry_s: 360,
  closing_speed_mps: 6.6,
  approach_conf: 0.94,
  speed_mps: 6.6,
  stationary: false,
  baseline_level: 'ALERT',
  agent_level: null,
  level: 'ALERT',
  source: 'rules',
  priority: 0.78,
  reasons: ['ETA 6.0 min to Dogu Yolu at 6.6 m/s, approach 0.94'],
  agent_rationale: null,
  agent_dissent: null,
  evidence: ['T0001', 'img_0001#003'],
  status: 'open',
  first_raised_hhmm: '14:10',
  breakdown: {
    score: 78,
    base_score: 73,
    heavy_multiplier: 1.25,
    terms: [
      { label: 'Bölgeye giriş süresi · 6,0 dk', points: 40, detail: '30 dk ufka göre' },
      { label: 'En yakın yaklaşma · 240 m', points: 23, detail: '1000 m içinde' },
      { label: 'Yaklaşma güveni · 0,94', points: 15, detail: 'Dogu Yolu yönünde' },
    ],
    note: null,
  },
  image_id: 'img_0001',
};

export const dataset: DatasetInfo = {
  generated_at: '2026-09-26T21:00:00',
  exercise_date: '2026-09-26',
  origin_ts: ORIGIN,
  base: { name: 'Merkez Us', lat: 39.92184, lon: 32.85306 },
  sim: {
    start_hhmm: '08:10',
    end_hhmm: '15:50',
    start_min: 0,
    end_min: 460,
    default_speed: 120,
    tick_sim_s: 60,
  },
  zones: [zone],
  frames: [
    {
      image_id: 'img_0001',
      capture_hhmm: '14:10',
      capture_min: 360,
      width_px: 1360,
      height_px: 765,
      zone_id: 'Z03',
      zone_name: 'Dogu Yolu',
      vehicle_count: 1,
      kept_boxes: 1,
      raw_boxes: 425,
      level: 'ALERT',
      score: 78,
      alert_count: 1,
      report_count: 1,
      centre_enu: { e_m: 1600, n_m: 0 },
    },
    {
      image_id: 'img_0002',
      capture_hhmm: '15:00',
      capture_min: 410,
      width_px: 960,
      height_px: 540,
      zone_id: null,
      zone_name: null,
      vehicle_count: 0,
      kept_boxes: 0,
      raw_boxes: 300,
      level: 'CLEAR',
      score: 0,
      alert_count: 0,
      report_count: 0,
      centre_enu: { e_m: -2000, n_m: 1000 },
    },
  ],
  thresholds: {
    score_threshold: 0.35,
    nms_iou: 0.5,
    min_area_m2: 2.5,
    gate_m: 30,
    duplicate_radius_m: 12,
    zone_radius_m: 250,
    zone_buffer_m: 750,
    horizon_min: 30,
    alert_eta_min: 10,
    alert_conf: 0.6,
    watch_conf: 0.4,
    heavy_vehicle_multiplier: 1.25,
    stationary_disp_m: 25,
  },
  counts: { images: 2, tracks: 1, reports: 1, zones: 1, raw_boxes: 725, alerts: 1 },
  match_quality: {},
  validation_issues: [],
  agents: { mode: 'rules', budget_cap_usd: 15 },
};

export const track: TrackHistory = {
  track_id: 'T0001',
  cls: 'truck',
  image_id: 'img_0001',
  t: [340, 345, 350, 355, 360],
  e: [7000, 5500, 5500, 3000, 1570],
  n: [0, 0, 0, 0, 0],
};

/**
 * A few blocks of city: one named boulevard along the fake track's own road,
 * a cross street, a park, and two place names. Enough to put every basemap
 * layer on screen without shipping the 1.4 MB real file into the shell tests.
 */
export const basemapFile: BasemapFile = {
  version: 1,
  attribution: '© OpenStreetMap katkıda bulunanlar',
  license: 'ODbL 1.0',
  baked_at: '2026-09-27T00:00:00+00:00',
  osm_timestamp: '2026-09-27T00:00:00Z',
  origin: { lat: 39.92184, lon: 32.85306 },
  crop_enu: { w: -9000, s: -9000, e: 9000, n: 9000 },
  roads: [
    ['primary', 'Dogu Bulvari', 0, [-8000, 0, 16000, 0]],
    ['minor', null, 0, [2000, -1500, 0, 3000]],
    ['secondary', null, 1, [-500, -500, 1000, 1000]],
  ],
  lines: [['rail', 'Baskentray', [-8000, 3000, 16000, 200]]],
  areas: [['park', 'Test Parki', [1000, 1000, 800, 0, 0, 600, -800, 0]]],
  places: [
    ['district', 'Cankaya', 0, -3000],
    ['semt', 'Kizilay', -400, 300],
  ],
  stations: [['subway', 'Kizilay', -200, -150]],
  pois: [['park', 'Test Parki', 1400, 1300, 480_000]],
};

export function frameDetail(imageId: string, withVehicles: boolean): FrameDetail {
  return {
    image_id: imageId,
    capture_hhmm: withVehicles ? '14:10' : '15:00',
    width_px: 1360,
    height_px: 765,
    gsd_x_m: 0.12,
    gsd_y_m: 0.12,
    footprint_enu: [
      { e_m: 1400, n_m: 200 },
      { e_m: 1800, n_m: 200 },
      { e_m: 1800, n_m: -200 },
      { e_m: 1400, n_m: -200 },
    ],
    funnel: {
      image_id: imageId,
      raw: 425,
      after_score: 10,
      after_nms: 2,
      kept: withVehicles ? 1 : 0,
      dropped: { 'score<thr': 415, nms_suppressed: 8, 'area<min_m2': 1 },
      legacy_px_would_drop: 0,
      class_mix: { truck: 1 },
    },
    detections: withVehicles
      ? [
          {
            det_id: 'img_0001#003',
            cls: 'truck',
            score: 0.91,
            bbox_px: [400, 300, 508, 356],
            area_m2: 18,
            center_px: [454, 328],
            enu: { e_m: 1570, n_m: 0 },
            kept: true,
            drop_reason: null,
            suppressed_by: null,
          },
          {
            det_id: 'img_0001#004',
            cls: 'car',
            score: 0.04,
            bbox_px: [10, 10, 40, 30],
            area_m2: 4,
            center_px: [25, 20],
            enu: { e_m: 1500, n_m: 100 },
            kept: false,
            drop_reason: 'score<thr',
            suppressed_by: null,
          },
        ]
      : [],
    track_states: withVehicles
      ? [
          {
            track_id: 'T0001',
            enu: { e_m: 1570, n_m: 0 },
            speed_mps: 6.6,
            heading_deg: 270,
            stationary: false,
            cls: 'truck',
            class_conf: 0.91,
            dist_to_base_m: { 't-60': 7000, 't-30': 5500, now: 1570 },
            last_fix_hhmm: '14:10',
            destination_zone_id: 'Z03',
            outlier_steps: 0,
          },
        ]
      : [],
    track_positions: withVehicles
      ? [
          {
            track_id: 'T0001',
            lat: 39.92184,
            lon: 32.87,
            pixel: [454, 328] as [number, number],
            in_frame: true,
          },
        ]
      : [],
    zone_assessments: withVehicles
      ? {
          T0001: [
            {
              zone_id: 'Z03',
              dist_now_m: 1570,
              cpa_m: 240,
              t_cpa_s: 300,
              eta_entry_s: 360,
              closing_speed_mps: 6.6,
              approach_conf: 0.94,
              inside_zone: false,
              inside_buffer: false,
            },
          ],
        }
      : {},
    matches: withVehicles
      ? [{ track_id: 'T0001', det_id: 'img_0001#003', distance_m: 0.2, confidence: 'high' }]
      : [],
    untracked: [],
    expected_not_seen: [],
    alerts: withVehicles ? [alert] : [],
    reports: withVehicles
      ? [
          {
            report_id: 'R006',
            hhmm: '14:10',
            t_min: 360,
            source: 'official',
            text: 'Civarda 1 ağır araç bulunuyor, hareketleri olağan.',
            kind: 'sighting',
            zone_ref: 'Z03',
            geo: null,
            vehicle_type: 'truck',
            count: 1,
            area_wide: false,
            parser: 'regex',
            parse_conf: 0.9,
            consistency: 'contradicts',
            consistency_note: 'ton çelişkisi: "olağan" ≠ hız verisi',
            matched_track_ids: ['T0001'],
          },
        ]
      : [],
    brief: {
      source: 'rules',
      image_summary: '',
      assessments: withVehicles
        ? [
            {
              track_id: 'T0001',
              level: 'ALERT',
              needs_attention: true,
              rationale: ['Dogu Yolu bölgesine 6 dk'],
              cited_ids: ['T0001', 'Z03'],
              report_conflicts: [{ report_id: 'R006', why: 'ton çelişkisi' }],
            },
          ]
        : [],
    },
    bundle: {},
  };
}

export class FakeApi implements GoruApi {
  readonly mode = 'fixture' as const;
  readonly recorded: Decision[] = [];

  async dataset() {
    return dataset;
  }
  async tracks() {
    return [track];
  }
  async reports() {
    return frameDetail('img_0001', true).reports;
  }
  async alerts() {
    return [alert];
  }
  async frame(imageId: string) {
    return frameDetail(imageId, imageId === 'img_0001');
  }
  imageUrl() {
    return null;
  }
  async basemap() {
    return basemapFile;
  }
  async *assess(imageId: string): AsyncIterable<AgentEvent> {
    yield {
      type: 'step',
      step: { id: 'open', index: 1, title: 'Görüntüyü aç', detail: imageId, state: 'done', ms: 4 },
    };
    yield { type: 'brief', brief: frameDetail(imageId, imageId === 'img_0001').brief };
    yield { type: 'done', elapsedMs: 12, toolCalls: 1 };
  }
  async ask(_question: string): Promise<import('@/api/port').AgentReply> {
    throw new Error('offline');
  }
  async budget() {
    return null;
  }
  async record(decision: Decision) {
    this.recorded.push(decision);
    return decision;
  }
  async decisions() {
    return [...this.recorded];
  }
}
