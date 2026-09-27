/* What each evaluation step found, in words and in numbers.
 *
 * The step list is the operator's answer to "how did you get there?", so every
 * step says in one sentence what it did and then shows the values it produced:
 * the pixel box, the coordinate it became, the track it matched and how close
 * the runner-up was, the speed fit, the score terms. All of it is read from the
 * frame the engine exported; nothing here computes a fact the engine did not.
 *
 * The walk follows one vehicle -- the frame's lead alert, or its first match --
 * the way an analyst would narrate a single case rather than a table.
 */

import * as fmt from './format';
import { classLabel } from './strings';
import type { Alert, Detection, Enu, FrameDetail, Match, TrackStateRow, Zone } from './types';

export interface StepContext {
  base: { name?: string; lat: number; lon: number } | null;
  zones: readonly Zone[];
}

export interface StepText {
  /** One first-person sentence: what this step did. */
  detail: string;
  /** The values it produced, shown in a fixed-width face. */
  lines: string[];
}

export type StepId =
  | 'open'
  | 'place'
  | 'detect'
  | 'georef'
  | 'tracks'
  | 'kinematics'
  | 'reports'
  | 'score'
  | 'assess';

const LEVEL_WORD = { ALERT: 'ALARM', WATCH: 'İZLE', CLEAR: 'TEMİZ' } as const;

/** Metres per degree at a latitude, WGS-84 series (as in goru_core.geo). */
function metresPerDegree(latDeg: number): { lat: number; lon: number } {
  const p = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

/** A base-relative ENU point back to latitude and longitude. */
export function enuToLatLon(enu: Enu, base: { lat: number; lon: number }): [number, number] {
  const m = metresPerDegree(base.lat);
  return [base.lat + enu.n_m / m.lat, base.lon + enu.e_m / m.lon];
}

/** Latitude and longitude into the base-relative ENU frame. */
export function latLonToEnu(lat: number, lon: number, base: { lat: number; lon: number }): Enu {
  const m = metresPerDegree(base.lat);
  return { e_m: (lon - base.lon) * m.lon, n_m: (lat - base.lat) * m.lat };
}

/** Compass bearing from `from` to `to`, degrees clockwise from north. */
function bearingOf(from: Enu, to: Enu): number {
  const deg = (Math.atan2(to.e_m - from.e_m, to.n_m - from.n_m) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const ORIGIN: Enu = { e_m: 0, n_m: 0 };
const latLon = (pair: [number, number]) => `${pair[0].toFixed(6)}, ${pair[1].toFixed(6)}`;
const enuText = (p: Enu) => `D ${round(p.e_m)} m, K ${round(p.n_m)} m`;
/** Range and bearing from the base, the way an operator reads a radar. */
const fromBase = (p: Enu) => `üsten ${fmt.distance(Math.hypot(p.e_m, p.n_m))} · ${fmt.heading(bearingOf(ORIGIN, p))}`;
const dist = (a: Enu, b: Enu) => Math.hypot(a.e_m - b.e_m, a.n_m - b.n_m);
const round = (v: number) => Math.round(v);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The vehicle the narration follows: the highest-priority alert with a box. */
function leadOf(frame: FrameDetail): {
  match: Match | null;
  det: Detection | null;
  state: TrackStateRow | null;
  alert: Alert | null;
} {
  const matched = new Map(frame.matches.map((m) => [m.track_id, m]));
  const alerts = [...frame.alerts].sort((a, b) => b.priority - a.priority);
  const alert = alerts.find((a) => matched.has(a.track_id)) ?? alerts[0] ?? null;
  const match = (alert && matched.get(alert.track_id)) ?? frame.matches[0] ?? null;
  const det = match ? (frame.detections.find((d) => d.det_id === match.det_id) ?? null) : null;
  const trackId = match?.track_id ?? alert?.track_id ?? null;
  const state = trackId ? (frame.track_states.find((s) => s.track_id === trackId) ?? null) : null;
  return { match, det, state, alert };
}

export function describeSteps(frame: FrameDetail, ctx: StepContext): Record<StepId, StepText> {
  const { base, zones } = ctx;
  /** A point as lat/lon when the base is known, as ENU metres otherwise. */
  const where = (p: Enu) => (base ? latLon(enuToLatLon(p, base)) : enuText(p));
  const kept = frame.detections.filter((d) => d.kept);
  const lead = leadOf(frame);
  const leadId = lead.match?.track_id ?? lead.state?.track_id ?? null;

  // --- 1. open --------------------------------------------------------------
  const es = frame.footprint_enu.map((p) => p.e_m);
  const ns = frame.footprint_enu.map((p) => p.n_m);
  const hasFootprint = es.length > 0;
  const widthM = hasFootprint ? Math.max(...es) - Math.min(...es) : null;
  const heightM = hasFootprint ? Math.max(...ns) - Math.min(...ns) : null;
  // On a north-up nadir image, top-left is the westmost-northmost corner.
  const topLeft = hasFootprint
    ? frame.footprint_enu.reduce((b, p) => (p.n_m - p.e_m > b.n_m - b.e_m ? p : b))
    : null;
  const bottomRight = hasFootprint
    ? frame.footprint_enu.reduce((b, p) => (p.e_m - p.n_m > b.e_m - b.n_m ? p : b))
    : null;
  const open: StepText = {
    detail: 'Boyut, çekim saati ve köşe koordinatlarını image_meta.json’dan okudum.',
    lines: [
      `${frame.width_px}×${frame.height_px} px · ${frame.capture_hhmm}`,
      `${fmt.confidence(frame.gsd_x_m)} m/px` +
        (widthM != null && heightM != null ? ` · yerde ~${round(widthM)}×${round(heightM)} m` : ''),
      ...(topLeft ? [`sol üst ${where(topLeft)}`] : []),
      ...(bottomRight ? [`sağ alt ${where(bottomRight)}`] : []),
    ],
  };

  // --- 2. place ------------------------------------------------------------
  let place: StepText;
  if (hasFootprint) {
    const centre: Enu = {
      e_m: es.reduce((a, b) => a + b, 0) / es.length,
      n_m: ns.reduce((a, b) => a + b, 0) / ns.length,
    };
    const nearest = [...zones]
      .map((z) => ({ z, d: dist(z.enu, centre) }))
      .sort((x, y) => x.d - y.d)[0];
    place = {
      detail: 'Karenin yerdeki alanını üssü merkez alan doğu/kuzey koordinat sistemine yerleştirdim.',
      lines: [
        ...(base ? [`üs ${base.name ? `${base.name} ` : ''}${latLon([base.lat, base.lon])}`] : []),
        `kare merkezi ${where(centre)}`,
        `${enuText(centre)} · ${fromBase(centre)}`,
        ...(nearest ? [`en yakın bölge ${nearest.z.name} · ${fmt.distance(nearest.d)}`] : []),
      ],
    };
  } else {
    place = { detail: 'Karenin yer izdüşümü kayıtta yok.', lines: [] };
  }

  // --- 3. detect -----------------------------------------------------------
  const f = frame.funnel;
  const mix = f
    ? Object.entries(f.class_mix)
        .map(([cls, n]) => `${n} ${classLabel(cls).toLocaleLowerCase('tr-TR')}`)
        .join(', ')
    : '';
  const detectLines = f
    ? [`${fmt.count(f.raw)} kutu → eşikten ${f.after_score} → NMS'ten ${f.after_nms} → ${f.kept} tespit`]
    : [`${kept.length} tespit`];
  if (mix) detectLines.push(mix);
  if (lead.det) {
    const [x1, y1, x2, y2] = lead.det.bbox_px;
    detectLines.push(
      `${lead.det.cls} · kutu (${round(x1)}, ${round(y1)}, ${round(x2 - x1)}, ${round(y2 - y1)}) · güven ${fmt.percent(lead.det.score)}`,
    );
  }
  const detect: StepText = {
    detail: lead.det
      ? `Dedektör çıktısını eşik, çakışma ve alan filtresinden geçirdim; öne çıkan araç bir ${classLabel(lead.det.cls).toLocaleLowerCase('tr-TR')}.`
      : 'Dedektör çıktısını eşik, çakışma ve alan filtresinden geçirdim.',
    lines: detectLines,
  };

  // --- 4. georef -----------------------------------------------------------
  const georef: StepText = lead.det
    ? {
        detail: 'Kutunun merkezini köşe koordinatlarından doğrusal orantıyla yere çevirdim.',
        lines: [
          `merkez piksel (${round(lead.det.center_px[0])}, ${round(lead.det.center_px[1])})`,
          where(lead.det.enu),
          `${enuText(lead.det.enu)} · ${fromBase(lead.det.enu)}`,
          `yer alanı ${fmt.count(round(lead.det.area_m2))} m²`,
        ],
      }
    : {
        detail: 'Çevrilecek tespit kalmadı.',
        lines: [],
      };

  // --- 5. tracks -----------------------------------------------------------
  const trackLines: string[] = [];
  const med = median(frame.matches.map((m) => m.distance_m));
  trackLines.push(
    `${frame.matches.length} / ${kept.length} tespit eşlendi` +
      (med != null ? ` · medyan ${fmt.confidence(med)} m` : ''),
  );
  if (lead.match && lead.det) {
    const others = frame.track_states
      .filter((s) => s.track_id !== lead.match!.track_id)
      .map((s) => ({ id: s.track_id, d: dist(s.enu, lead.det!.enu) }))
      .sort((a, b) => a.d - b.d);
    const second = others[0];
    const own = lead.match.distance_m < 1 ? '<1 m' : fmt.distance(lead.match.distance_m);
    trackLines.push(
      `${lead.match.track_id} · ${own}` +
        (second ? ` (ikinci en yakın: ${second.id} · ${fmt.distance(second.d)})` : ''),
    );
  }
  const fix = lead.match
    ? frame.track_positions?.find((p) => p.track_id === lead.match!.track_id)
    : undefined;
  if (fix) {
    trackLines.push(
      `GPS kaydı ${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)} · piksel (${round(fix.pixel[0])}, ${round(fix.pixel[1])})`,
    );
  }
  if (frame.untracked.length || frame.expected_not_seen.length) {
    trackLines.push(
      `izsiz tespit ${frame.untracked.length} · görünmesi beklenip görünmeyen ${frame.expected_not_seen.length}`,
    );
  }
  const tracks: StepText = {
    detail: 'tracks.csv’de çekim saatindeki konumları süzdüm; her tespite en yakın kaydı eşledim.',
    lines: trackLines,
  };

  // --- 6. kinematics -------------------------------------------------------
  const s = lead.state;
  const series = s?.dist_to_base_m;
  const destination = s?.destination_zone_id
    ? (zones.find((z) => z.zone_id === s.destination_zone_id) ?? null)
    : null;
  const kinematics: StepText = s
    ? {
        detail: `${s.track_id} için son konumlara doğru oturtup hızı ve yönü çıkardım.`,
        lines: [
          s.stationary
            ? `${s.track_id} · duruyor`
            : `${s.track_id} · ${fmt.speed(s.speed_mps)} (${fmt.speedKmh(s.speed_mps)}) · ${fmt.heading(s.heading_deg)}`,
          `konum ${where(s.enu)} · ${s.last_fix_hhmm}`,
          series
            ? `üsse: t-60 ${fmt.distance(series['t-60'])} → t-30 ${fmt.distance(series['t-30'])} → şimdi ${fmt.distance(series.now)}`
            : '',
          destination ? `gidiş yönündeki bölge ${destination.name} · ${fmt.distance(dist(s.enu, destination.enu))}` : '',
        ].filter(Boolean),
      }
    : { detail: 'Hareketini çıkaracak iz yok.', lines: [] };

  // --- 7. reports ----------------------------------------------------------
  const tally = { agrees: 0, contradicts: 0, unrelated: 0, unknown: 0 };
  for (const r of frame.reports) tally[r.consistency ?? 'unknown'] += 1;
  const reportLines = [
    `${tally.agrees} tutarlı · ${tally.contradicts} çelişkili · ${tally.unrelated} ilgisiz · ${tally.unknown} değerlendirilmedi`,
  ];
  const notable =
    frame.reports.find((r) => r.consistency === 'contradicts') ??
    frame.reports.find((r) => leadId != null && r.matched_track_ids.includes(leadId)) ??
    frame.reports.find((r) => r.consistency === 'agrees');
  if (notable) {
    const text = notable.text.length > 48 ? `${notable.text.slice(0, 47)}…` : notable.text;
    reportLines.push(`${notable.report_id} ${notable.hhmm} · “${text}”`);
    if (notable.geo) {
      const at = `rapor konumu ${notable.geo.lat.toFixed(6)}, ${notable.geo.lon.toFixed(6)}`;
      const gap =
        base && lead.det
          ? ` · tespite ${fmt.distance(dist(latLonToEnu(notable.geo.lat, notable.geo.lon, base), lead.det.enu))}`
          : '';
      reportLines.push(at + gap);
    } else if (notable.zone_ref) {
      const named = zones.find((z) => z.zone_id === notable.zone_ref);
      reportLines.push(
        named
          ? `rapor konumu: ${named.name} · ${latLon([named.lat, named.lon])}`
          : `rapor konumu: ${notable.zone_ref}`,
      );
    }
    if (notable.consistency_note) reportLines.push(`→ ${notable.consistency_note}`);
  }
  const reports: StepText = {
    detail: frame.reports.length
      ? `Zaman penceresindeki ${frame.reports.length} saha raporunu kendi tespitlerimle karşılaştırdım.`
      : 'Bu karenin penceresinde saha raporu yok.',
    lines: frame.reports.length ? reportLines : [],
  };

  // --- 8. score ------------------------------------------------------------
  const levels = { ALERT: 0, WATCH: 0, CLEAR: 0 };
  for (const a of frame.alerts) levels[a.level] += 1;
  const scoreLines = [
    `${frame.alerts.length} uyarı · ${levels.ALERT} alarm, ${levels.WATCH} izle`,
  ];
  const a = lead.alert;
  if (a) {
    scoreLines.push(
      `${a.track_id} → ${a.zone_name ?? 'bölge yok'} · ${LEVEL_WORD[a.level]} · ${a.breakdown.score} puan`,
    );
    const zone = zones.find((z) => z.zone_id === a.zone_id);
    if (zone) {
      scoreLines.push(
        `bölge merkezi ${latLon([zone.lat, zone.lon])} · yarıçap ${fmt.distance(zone.radius_m)}`,
      );
    }
    const row = frame.zone_assessments[a.track_id]?.find((r) => r.zone_id === a.zone_id);
    if (row) {
      scoreLines.push(
        `şimdi ${fmt.distance(row.dist_now_m)} · en yakın geçiş ${fmt.distance(row.cpa_m)} · giriş ${fmt.eta(row.eta_entry_s)}`,
      );
    }
    for (const term of a.breakdown.terms) scoreLines.push(`${fmt.signed(term.points)}  ${term.label}`);
  }
  const score: StepText = {
    detail: frame.alerts.length
      ? 'Kural motoru her araç–bölge yaklaşımını puanladı; bu seviye ajanın düşüremeyeceği taban.'
      : 'Kural motoru bu karede uyarı gerektiren bir yaklaşım bulmadı.',
    lines: scoreLines,
  };

  // --- 9. assess -----------------------------------------------------------
  const fromRules = frame.brief.source === 'rules';
  const assessLines = [
    `kaynak: ${fromRules ? 'kural şablonu (model yok)' : 'LLM ajanı'} · ${frame.brief.assessments.length} değerlendirme`,
  ];
  if (frame.jev_confidence != null) assessLines.push(`karar güveni ${fmt.percent(frame.jev_confidence)}`);
  const assess: StepText = {
    detail: fromRules
      ? 'Brief’i model kullanmadan, kural şablonuyla yazdım.'
      : 'Kanıt paketini ajana verdim; gerekçeli değerlendirmesi guardrail’lerden geçti.',
    lines: assessLines,
  };

  return { open, place, detect, georef, tracks, kinematics, reports, score, assess };
}
