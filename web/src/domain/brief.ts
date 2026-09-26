/* Assembling the brief the agent column shows.
 *
 * The wireframe's brief card has a fixed anatomy -- badge, score, headline,
 * summary, BULGULAR, RAPOR DEĞERLENDİRMESİ, ÖNERİLEN EYLEMLER, SKOR DÖKÜMÜ --
 * and this module is the only thing that fills it. Every line it produces is
 * traceable to a field the engine computed: the summary quotes the lead alert's
 * own distance and speed, the findings count real vehicles and real stops, the
 * report section only lists reports the fusion layer actually judged, and the
 * score breakdown is `RuleEngine._priority` read back at 100x.
 *
 * Nothing here invents a number. Where the data cannot support a section, the
 * section is omitted rather than filled with something plausible.
 */

import { bandOf, riskRank } from './risk';
import * as fmt from './format';
import { classLabel, T } from './strings';
import { stopsOf, stopTotal } from './tracks';
import type {
  Alert,
  FieldReport,
  FrameDetail,
  Level,
  ScoreBreakdown,
  TrackHistory,
  TrackStateRow,
  Zone,
  ZoneAssessmentRow,
} from './types';

export interface BriefFinding {
  text: string;
  /** Ids this line rests on, so hovering it can highlight the map evidence. */
  cites: string[];
}

export interface BriefReportLine {
  report: FieldReport;
  verdict: string;
  detail: string;
}

export interface LeadVehicle {
  alert: Alert;
  state: TrackStateRow | null;
  zone: Zone | null;
  assessment: ZoneAssessmentRow | null;
  stops: { count: number; totalMin: number };
}

export interface AssembledBrief {
  level: Level;
  score: number;
  band: ReturnType<typeof bandOf>;
  source: 'rules' | 'llm';
  confidence: string;
  headline: string;
  summary: string;
  findings: BriefFinding[];
  reportLines: BriefReportLine[];
  actions: string[];
  breakdown: ScoreBreakdown | null;
  lead: LeadVehicle | null;
  /** Set when the agent's level differs from the rule baseline. */
  dissent: { baseline: Level; agent: Level; note: string | null } | null;
  vehicleCount: number;
}

/** The alert the frame is about: worst level, then highest score. */
export function leadAlert(alerts: readonly Alert[]): Alert | null {
  if (alerts.length === 0) return null;
  return [...alerts].sort(
    (a, b) => riskRank(b.level) - riskRank(a.level) || b.priority - a.priority,
  )[0] as Alert;
}

function zoneOf(zones: readonly Zone[], zoneId: string | null): Zone | null {
  if (!zoneId) return null;
  return zones.find((z) => z.zone_id === zoneId) ?? null;
}

function trendWord(state: TrackStateRow | null, assessment: ZoneAssessmentRow | null): string {
  if (state?.stationary) return T.vehicle.stopped;
  if (assessment && assessment.closing_speed_mps > 0.15) return T.vehicle.approaching;
  if (assessment && assessment.closing_speed_mps < -0.15) return T.vehicle.receding;
  return T.vehicle.steady;
}

/**
 * The headline: which zone, what kind of vehicle, and what it is doing.
 *
 * Built from the lead alert only. A frame with twelve WATCH vehicles still gets
 * one headline, because an operator reading a queue needs the single fact that
 * decides whether to open the frame.
 */
function buildHeadline(lead: LeadVehicle | null, frame: FrameDetail): string {
  if (!lead) {
    return frame.track_states.length === 0
      ? T.agent.noVehicles
      : `${frame.image_id}: dikkat gerektiren araç yok`;
  }
  const zone = lead.zone?.name ?? 'bölge';
  const cls = classLabel(lead.state?.cls);
  const verb = trendWord(lead.state, lead.assessment);
  const tail =
    lead.stops.count > 0
      ? `, ${fmt.count(lead.stops.count)} duraklama sonrası`
      : '';
  return `${zone}: ${verb} ${cls}${tail}`;
}

/** The summary: the lead vehicle's measured facts, in one sentence. */
function buildSummary(lead: LeadVehicle | null, conflicts: readonly BriefReportLine[]): string {
  if (!lead) return '';
  const parts: string[] = [];
  const zone = lead.zone?.name;
  const a = lead.assessment;

  if (a && zone) {
    parts.push(
      `${lead.alert.track_id}, ${zone} bölgesine ${fmt.distance(a.dist_now_m)} mesafede`,
    );
    if (a.eta_entry_s != null) {
      parts.push(`giriş ${fmt.eta(a.eta_entry_s)}`);
    }
    if (Math.abs(a.closing_speed_mps) > 0.15) {
      parts.push(`kapanma ${fmt.speed(Math.abs(a.closing_speed_mps))}`);
    }
  } else if (lead.state) {
    parts.push(`${lead.alert.track_id}, ${fmt.speed(lead.state.speed_mps)}`);
  }

  let sentence = parts.join(', ') + '.';
  const contradiction = conflicts.find((line) => line.report.consistency === 'contradicts');
  if (contradiction) {
    sentence += ` ${contradiction.report.report_id} çelişiyor; kendi tespitimiz esas alındı.`;
  }
  return sentence;
}

/**
 * The findings: what this frame actually contains.
 *
 * Each line is a count or a measurement, never a judgement -- the judgement is
 * the level badge above it.
 */
function buildFindings(
  frame: FrameDetail,
  lead: LeadVehicle | null,
  histories: ReadonlyMap<string, TrackHistory>,
  stationaryDispM: number,
  originIso: string,
): BriefFinding[] {
  const out: BriefFinding[] = [];
  const kept = frame.detections.filter((d) => d.kept);
  const heavy = kept.filter((d) => d.cls === 'truck' || d.cls === 'bus');

  out.push({
    text: `${fmt.count(frame.track_states.length)} araç izlendi · ${fmt.count(kept.length)} tespit eşleşti${
      heavy.length > 0 ? ` · ${fmt.count(heavy.length)} ağır araç` : ''
    }`,
    cites: [frame.image_id],
  });

  const alerting = frame.alerts.filter((a) => a.level === 'ALERT');
  const watching = frame.alerts.filter((a) => a.level === 'WATCH');
  if (alerting.length + watching.length > 0) {
    out.push({
      text: `${fmt.count(alerting.length)} tehdit · ${fmt.count(watching.length)} inceleme seviyesinde uyarı`,
      cites: frame.alerts.slice(0, 6).map((a) => a.track_id),
    });
  }

  if (lead) {
    const history = histories.get(lead.alert.track_id);
    if (history) {
      const stops = stopsOf(history, stationaryDispM);
      if (stops.length > 0) {
        const spells = stops
          .slice(0, 2)
          .map(
            (s) =>
              `${fmt.clockOf(originIso, s.fromMin)}–${fmt.clockOf(originIso, s.toMin)} (${fmt.distance(s.range_m)})`,
          )
          .join(', ');
        out.push({
          text: `${lead.alert.track_id} duraklama: ${spells} · toplam ${fmt.minutes(stopTotal(stops))}`,
          cites: [lead.alert.track_id],
        });
      }
    }
  }

  const duplicates = frame.untracked.filter((u) => u.likely_duplicate_of);
  const genuine = frame.untracked.filter((u) => !u.likely_duplicate_of);
  if (genuine.length > 0) {
    out.push({
      text: `${fmt.count(genuine.length)} tespit hiçbir ize eşleşmedi`,
      cites: genuine.slice(0, 5).map((u) => u.det_id),
    });
  }
  if (duplicates.length > 0) {
    out.push({
      text: `${fmt.count(duplicates.length)} tespit çift sayım olarak işaretlendi · uyarı üretmedi`,
      cites: duplicates.slice(0, 5).map((u) => u.det_id),
    });
  }

  const missed = frame.expected_not_seen.filter(
    (e) => e.reason === 'no_detection_in_footprint',
  );
  if (missed.length > 0) {
    out.push({
      text: `${fmt.count(missed.length)} iz kare içinde olmalıydı ama tespit edilmedi`,
      cites: missed.slice(0, 5).map((e) => e.track_id),
    });
  }

  return out;
}

/** Only reports the fusion layer judged. An unjudged report is not evidence. */
function buildReportLines(frame: FrameDetail): BriefReportLine[] {
  return frame.reports
    .filter((r) => r.consistency !== null || r.kind === 'unverified')
    .sort((a, b) => (a.consistency === 'contradicts' ? -1 : 0) - (b.consistency === 'contradicts' ? -1 : 0))
    .slice(0, 5)
    .map((report) => ({
      report,
      verdict:
        report.consistency === 'contradicts'
          ? T.consistency.contradicts
          : report.consistency === 'agrees'
            ? T.consistency.agrees
            : report.consistency === 'unrelated'
              ? T.consistency.unrelated
              : T.consistency.unknown,
      detail: report.consistency_note ?? '',
    }));
}

/**
 * Suggested actions.
 *
 * Only actions the data supports are offered, and each names the thing it acts
 * on, so an operator can tell whether it applies. This is the one part of the
 * brief that is advice rather than measurement, and the heading says so.
 */
function buildActions(lead: LeadVehicle | null, reportLines: readonly BriefReportLine[]): string[] {
  if (!lead) return [];
  const out: string[] = [];
  const zone = lead.zone?.name;
  if (zone) out.push(`${zone} kontrol noktasını uyar`);
  if (lead.alert.level === 'ALERT') {
    out.push(`Drone’u ${lead.alert.track_id} üzerine yönlendir`);
  }
  const contradiction = reportLines.find((l) => l.report.consistency === 'contradicts');
  if (contradiction) {
    out.push(`${contradiction.report.report_id} kaynağından teyit iste`);
  }
  return out.slice(0, 3);
}

export interface AssembleOptions {
  zones: readonly Zone[];
  histories: ReadonlyMap<string, TrackHistory>;
  stationaryDispM: number;
  originIso: string;
}

/** Turn one frame's evaluation into the brief card's content. */
export function assembleBrief(frame: FrameDetail, opts: AssembleOptions): AssembledBrief {
  const alert = leadAlert(frame.alerts);
  const state = alert ? frame.track_states.find((s) => s.track_id === alert.track_id) ?? null : null;
  const assessment =
    alert && alert.zone_id
      ? frame.zone_assessments[alert.track_id]?.find((z) => z.zone_id === alert.zone_id) ?? null
      : null;
  const history = alert ? opts.histories.get(alert.track_id) : undefined;
  const stops = history ? stopsOf(history, opts.stationaryDispM) : [];

  const lead: LeadVehicle | null = alert
    ? {
        alert,
        state,
        zone: zoneOf(opts.zones, alert.zone_id),
        assessment,
        stops: { count: stops.length, totalMin: stopTotal(stops) },
      }
    : null;

  const reportLines = buildReportLines(frame);
  const level = alert?.level ?? 'CLEAR';
  const score = alert?.breakdown.score ?? 0;
  const jevConfidence = alert?.jev_confidence ?? frame.jev_confidence;

  return {
    level,
    score,
    band: frame.track_states.length === 0 ? 'empty' : bandOf(level, score),
    source: frame.brief.source,
    confidence: jevConfidence == null ? '—' : fmt.percent(jevConfidence),
    headline: buildHeadline(lead, frame),
    summary: frame.brief.image_summary || buildSummary(lead, reportLines),
    findings: buildFindings(
      frame,
      lead,
      opts.histories,
      opts.stationaryDispM,
      opts.originIso,
    ),
    reportLines,
    actions: buildActions(lead, reportLines),
    breakdown: alert?.breakdown ?? null,
    lead,
    dissent:
      alert && alert.source === 'rules_floor' && alert.jev_level
        ? {
            baseline: alert.baseline_level,
            agent: alert.jev_level,
            note: null,
          }
        : null,
    vehicleCount: frame.track_states.length,
  };
}

/** The rows the threat modal lists under the camera, worst vehicle first. */
export function modalRows(frame: FrameDetail): {
  alert: Alert | null;
  state: TrackStateRow;
  level: Level;
  score: number;
  detail: string;
}[] {
  const byTrack = new Map(frame.alerts.map((a) => [a.track_id, a]));
  return [...frame.track_states]
    .map((state) => {
      const alert = byTrack.get(state.track_id) ?? null;
      const level = alert?.level ?? 'CLEAR';
      const assessment = alert?.zone_id
        ? frame.zone_assessments[state.track_id]?.find((z) => z.zone_id === alert.zone_id)
        : frame.zone_assessments[state.track_id]?.[0];
      const bits = [
        classLabel(state.cls),
        state.stationary ? T.vehicle.stopped : fmt.speed(state.speed_mps),
      ];
      if (assessment) {
        bits.push(`${fmt.distance(assessment.dist_now_m)} → bölge`);
        if (assessment.eta_entry_s != null) bits.push(fmt.eta(assessment.eta_entry_s));
      }
      return {
        alert,
        state,
        level,
        score: alert?.breakdown.score ?? 0,
        detail: bits.join(' · '),
      };
    })
    .sort((a, b) => riskRank(b.level) - riskRank(a.level) || b.score - a.score);
}
