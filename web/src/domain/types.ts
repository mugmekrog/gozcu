/* The shapes the data seam serves.
 *
 * These mirror PLAN 5.1's frozen contracts, narrowed to what the screens read
 * and with timestamps already reduced to exercise wall-clock (`hhmm`) or to
 * minutes-from-origin (`*_min`), because every wireframe labels time one of
 * those two ways and no screen needs a date.
 *
 * `contracts/` will eventually hold generated types from the OpenAPI export
 * (PLAN F0.2). Until `rest.py` exists there is nothing to generate from, so
 * these are hand-written against the same contract and the fixture export
 * writes exactly this shape.
 */

export type Level = 'ALERT' | 'WATCH' | 'CLEAR';
export type VehicleClass = 'car' | 'van' | 'truck' | 'bus';
export type ReportSource = 'official' | 'third_party';
export type ReportConsistency = 'agrees' | 'contradicts' | 'unrelated';
export type AlertSource = 'rules' | 'agent' | 'rules_fallback';
export type DropReason = 'score<thr' | 'nms_suppressed' | 'area<min_m2';

/** East/north metres from the base. The whole UI works in this frame. */
export interface Enu {
  e_m: number;
  n_m: number;
}

export interface Zone {
  zone_id: string;
  name: string;
  enu: Enu;
  lat: number;
  lon: number;
  range_m: number;
  bearing_deg: number;
  radius_m: number;
  buffer_m: number;
}

/** One row of the frame picker and one diamond on the timeline. */
export interface FrameSummary {
  image_id: string;
  capture_hhmm: string;
  capture_min: number;
  width_px: number;
  height_px: number;
  zone_id: string | null;
  zone_name: string | null;
  vehicle_count: number;
  kept_boxes: number;
  raw_boxes: number;
  level: Level;
  score: number;
  alert_count: number;
  report_count: number;
  centre_enu: Enu;
}

export interface Thresholds {
  score_threshold: number;
  nms_iou: number;
  min_area_m2: number;
  gate_m: number;
  duplicate_radius_m: number;
  zone_radius_m: number;
  zone_buffer_m: number;
  horizon_min: number;
  alert_eta_min: number;
  alert_conf: number;
  watch_conf: number;
  heavy_vehicle_multiplier: number;
  stationary_disp_m: number;
}

export interface ValidationIssue {
  file: string;
  pointer: string;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface DatasetInfo {
  generated_at: string;
  exercise_date: string;
  origin_ts: string;
  base: { name: string; lat: number; lon: number };
  sim: {
    start_hhmm: string;
    end_hhmm: string;
    start_min: number;
    end_min: number;
    default_speed: number;
    tick_sim_s: number;
  };
  zones: Zone[];
  frames: FrameSummary[];
  thresholds: Thresholds;
  counts: Record<string, number>;
  match_quality: unknown;
  validation_issues: ValidationIssue[];
  agents: { mode: 'rules' | 'llm' | 'cache'; budget_cap_usd: number };
}

/**
 * One track's whole 2-hour history, as parallel arrays.
 *
 * Parallel arrays rather than an array of points: 226 tracks x 25 fixes is
 * 5 650 objects if modelled the obvious way, and the map re-reads all of them
 * on every clock tick. Three number arrays keep that allocation-free.
 */
export interface TrackHistory {
  track_id: string;
  cls: VehicleClass | null;
  /** The frame this track's last fix belongs to, if any caught it. */
  image_id: string | null;
  /** Minutes from `origin_ts`, ascending. */
  t: number[];
  e: number[];
  n: number[];
}

export interface Detection {
  det_id: string;
  cls: VehicleClass;
  score: number;
  /** x1,y1,x2,y2 in source-image pixels. */
  bbox_px: [number, number, number, number];
  area_m2: number;
  center_px: [number, number];
  enu: Enu;
  kept: boolean;
  drop_reason: DropReason | null;
  suppressed_by: string | null;
}

export interface TrackStateRow {
  track_id: string;
  enu: Enu;
  speed_mps: number;
  heading_deg: number;
  stationary: boolean;
  cls: VehicleClass | null;
  class_conf: number | null;
  /** Range to base at t-60, t-30 and now, keyed exactly so. */
  dist_to_base_m: Record<string, number | null>;
  last_fix_hhmm: string;
  destination_zone_id: string | null;
  outlier_steps: number;
}

export interface ZoneAssessmentRow {
  zone_id: string;
  dist_now_m: number;
  cpa_m: number;
  t_cpa_s: number;
  eta_entry_s: number | null;
  closing_speed_mps: number;
  approach_conf: number;
  inside_zone: boolean;
  inside_buffer: boolean;
}

/** One row of the score breakdown the brief shows. */
export interface ScoreTerm {
  label: string;
  points: number;
  detail: string;
}

export interface ScoreBreakdown {
  score: number;
  base_score: number;
  heavy_multiplier: number | null;
  terms: ScoreTerm[];
  note: string | null;
}

export interface Alert {
  alert_id: string;
  /**
   * Usually a track id. On an untracked-detection alert it is a *det_id*
   * (`img_008333#001`): the rule engine raises a WATCH on a box that matched no
   * track but sits inside a zone buffer, so there is no track state, no speed
   * and no ETA behind it. Seven of the 149 alerts in the shipped data are of this
   * kind. Check for `#` before looking the id up among the track states.
   */
  track_id: string;
  zone_id: string | null;
  zone_name: string | null;
  /** Denormalised from the zone assessment this alert names; null when untracked. */
  cls: VehicleClass | null;
  dist_now_m: number | null;
  cpa_m: number | null;
  eta_entry_s: number | null;
  closing_speed_mps: number | null;
  approach_conf: number | null;
  speed_mps: number | null;
  stationary: boolean | null;
  baseline_level: Level;
  agent_level: Level | null;
  level: Level;
  source: AlertSource;
  priority: number;
  reasons: string[];
  agent_rationale: string[] | null;
  agent_dissent: string | null;
  evidence: string[];
  status: 'open' | 'acknowledged' | 'dismissed';
  first_raised_hhmm: string;
  breakdown: ScoreBreakdown;
  /** Present on the flattened cross-frame list. */
  image_id?: string;
}

export interface FieldReport {
  report_id: string;
  hhmm: string;
  t_min?: number;
  source: ReportSource;
  text: string;
  kind: string;
  zone_ref: string | null;
  geo: { lat: number; lon: number } | null;
  vehicle_type: string | null;
  count: number | null;
  area_wide: boolean;
  parser: 'regex' | 'llm';
  parse_conf: number;
  consistency: ReportConsistency | null;
  consistency_note: string | null;
  matched_track_ids: string[];
}

export interface Match {
  track_id: string;
  det_id: string;
  distance_m: number;
  confidence: 'high' | 'low';
}

export interface UntrackedDetection {
  det_id: string;
  cls: VehicleClass;
  score: number;
  nearest_track_id: string | null;
  nearest_track_dist_m: number | null;
  inside_buffer_of: string | null;
  /** Set when this box double-counts a track another box already claimed. */
  likely_duplicate_of: string | null;
}

export interface ExpectedNotSeen {
  track_id: string;
  reason: 'outside_footprint' | 'no_detection_in_footprint';
  dist_to_footprint_m: number;
  baseline_level: Level;
}

export interface BriefAssessment {
  track_id: string;
  level: Level;
  needs_attention: boolean;
  rationale: string[];
  cited_ids: string[];
  report_conflicts: { report_id: string; why: string }[];
}

/**
 * The assessment the agent column renders.
 *
 * `source` is the honesty flag: `rules` means the deterministic template built
 * from the rule baseline, which is what ships when the LLM is off or
 * unreachable, and the UI labels it "kural tabanli" rather than passing it off
 * as model output (PLAN principle 2, wireframe edge case A).
 */
export interface Brief {
  source: 'rules' | 'llm';
  image_summary: string;
  assessments: BriefAssessment[];
}

export interface DetectionFunnel {
  image_id: string;
  raw: number;
  after_score: number;
  after_nms: number;
  kept: number;
  dropped: Record<string, number>;
  legacy_px_would_drop: number;
  class_mix: Record<string, number>;
}

/** Everything one frame's evaluation produced. Fetched on demand, ~130 KB. */
export interface FrameDetail {
  image_id: string;
  capture_hhmm: string;
  width_px: number;
  height_px: number;
  gsd_x_m: number;
  gsd_y_m: number;
  footprint_enu: Enu[];
  funnel: DetectionFunnel | null;
  detections: Detection[];
  track_states: TrackStateRow[];
  zone_assessments: Record<string, ZoneAssessmentRow[]>;
  matches: Match[];
  untracked: UntrackedDetection[];
  expected_not_seen: ExpectedNotSeen[];
  alerts: Alert[];
  reports: FieldReport[];
  brief: Brief;
  bundle: unknown;
}

/** An operator's decision on one frame. Appended to the decisions log. */
export interface Decision {
  image_id: string;
  hhmm: string;
  verdict: 'confirmed' | 'false_alarm' | 'not_threat' | 'marked_threat';
  note: string;
  operator: string;
  agent_level: Level;
  agent_score: number;
}
