"""Export the deterministic pipeline's output as static JSON for the web app.

Why this exists: the frontend needs real data today, and `services/api/app/api/`
(REST + WS) belongs to the backend stream and does not exist yet. Rather than
mock 226 tracks and 137 reports by hand -- which would bake in numbers that
disagree with the engine and then disagree again when the API lands -- this
script drives the real `Pipeline` and writes what the REST endpoints of
PLAN 5.4 will eventually serve.

It is deliberately a *frontend-owned consumer* of the backend's public surface:
it imports `Pipeline`, `load_dataset` and `ImageAssessorPolicy` and calls them,
and it modifies nothing. When `rest.py` ships, `web/src/api/http.ts` replaces
`fixture.ts` behind the same interface and this script becomes a fallback for
the offline demo (PLAN 9.3).

Run from the repo root:

    .venv/Scripts/python web/scripts/export_fixtures.py
    .venv/Scripts/python web/scripts/export_fixtures.py --no-images   # skip the 7.9 MB copy

Outputs under `web/public/fixtures/`:

    dataset.json          base, zones, 40 frame summaries, sim window, thresholds
    tracks.json           226 tracks as parallel arrays (compact; loaded once)
    reports.json          137 field reports with parse + consistency
    alerts.json           every alert from every frame, flattened
    frames/<id>.json      one frame in full: detections, states, zones, brief
    frames/<id>.jpg       the drone image (unless --no-images)
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO_ROOT / "libs"), str(REPO_ROOT / "services" / "api")]

from goru_core.config import Config, load_config  # noqa: E402
from goru_core.geo import Footprint, bearing_deg  # noqa: E402
from goru_core.schemas import (  # noqa: E402
    Alert,
    Detection,
    EvidenceBundle,
    FieldReport,
    ImageAssessment,
    Level,
    TrackState,
    Zone,
    ZoneAssessment,
)

from app.agents.assessor import ImageAssessorPolicy  # noqa: E402
from app.evidence.bundle import ImageAnalysis  # noqa: E402
from app.ingest.loaders import Dataset, load_dataset  # noqa: E402
from app.pipeline import Pipeline  # noqa: E402

OUT_DIR = REPO_ROOT / "web" / "public" / "fixtures"

# Classes the warning table treats as heavy (PLAN 6.7). Mirrored here only to
# label the score breakdown; the engine remains the authority on the number.
HEAVY_CLASSES = {"truck", "bus"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


_TZ: ZoneInfo | None = None


def hhmm(ts: datetime) -> str:
    """The exercise wall clock, which is what every screen labels things by.

    The source timestamps are UTC; the exercise ran on `tz` from goru.yaml
    (Europe/Istanbul, +03). Printing the UTC hour would label the first image
    07:10 when the brief and PLAN 2.1 both call it 10:10, so the conversion is
    not cosmetic.
    """
    return ts.astimezone(_TZ).strftime("%H:%M") if _TZ else ts.strftime("%H:%M")


def r(value: float | None, places: int = 1) -> float | None:
    return None if value is None else round(float(value), places)


def minutes_from(origin: datetime, ts: datetime) -> float:
    return round((ts - origin).total_seconds() / 60.0, 2)


PRIORITY_DP = 4
"""Decimal places `priority` is shipped at. The score is derived from the shipped
value, not from full precision, so the two can never disagree on screen."""


def shipped_priority(alert: Alert) -> float:
    return round(alert.priority, PRIORITY_DP)


def pct100(fraction: float) -> int:
    """A 0..1 fraction as a 0..100 score, rounding halves up.

    Not `round()`: Python rounds halves to even, so a priority of 0.205 becomes
    20 while JavaScript's `Math.round` makes it 21. The frontend has a test that
    the shipped score equals `Math.round(priority * 100)`, and an operator reading
    "20" beside a priority of 0.205 has found a real inconsistency. Half-up in both
    languages removes the disagreement.
    """
    return int(math.floor(fraction * 100 + 0.5))


# --------------------------------------------------------------------------- #
# score breakdown -- a presentation of `RuleEngine._priority`, not a new score
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ScoreTerm:
    label: str
    points: int
    detail: str


def score_breakdown(
    alert: Alert,
    assessment: ZoneAssessment | None,
    state: TrackState | None,
    zone_name: str,
    cfg: Config,
) -> dict[str, Any]:
    """Decompose `alert.priority` into the terms that produced it.

    `RuleEngine._priority` is `0.5*eta_term + 0.3*cpa_term + 0.2*approach_conf`,
    scaled by `heavy_vehicle_multiplier` for a truck or bus and clamped to 1.
    Every row below is one of those terms read back at 100x, so the rows sum to
    the score the engine computed rather than to a second opinion about it.

    The frontend shows this table verbatim; `web/src/domain/score.ts` holds the
    same decomposition for the HTTP adapter, and a test pins the two together.
    """
    warning = cfg.warning
    terms: list[ScoreTerm] = []

    if assessment is None:
        # An alert with no zone assessment behind it is an *untracked detection*
        # inside a zone buffer: `RuleEngine.untracked_detection_level` raises a
        # WATCH on the box alone, and `alert.track_id` carries a det_id rather
        # than a track id. There is no kinematics for it -- nothing matched it to
        # a track, so it has no speed, heading or ETA -- and the priority is the
        # engine's flat figure for that case. Saying so is the honest breakdown;
        # decomposing a constant into invented terms would not be.
        score = pct100(shipped_priority(alert))
        return {
            "score": score,
            "base_score": score,
            "heavy_multiplier": None,
            "terms": [
                {
                    "label": "Tampon içinde eşleşmeyen tespit",
                    "points": score,
                    "detail": "ize bağlanamadı · hareket verisi yok",
                }
            ],
            "note": (
                "Bu uyarı bir tespit kutusundan geldi, bir izden değil: hiçbir "
                "hareket kaydıyla eşleşmedi, bu yüzden hız, yön ve ETA "
                "hesaplanamadı. Puan sabit."
            ),
        }

    horizon_s = warning.horizon_s
    eta = assessment.eta_entry_s
    eta_term = 1.0 - min(1.0, (eta if eta is not None else horizon_s) / horizon_s)
    span = assessment.dist_now_m - assessment.cpa_m  # not the radius; see below
    # `_radius_plus_buffer` is private, so recompute the span the same way the
    # engine does: radius + buffer for the zone this alert names.
    zone_cfg = cfg.zones
    span = zone_cfg.default_radius_m + zone_cfg.default_buffer_m
    cpa_term = 1.0 - min(1.0, assessment.cpa_m / span if span > 0 else 1.0)

    eta_txt = "ufkun ötesinde" if eta is None else f"{eta / 60:.1f} dk"
    terms.append(
        ScoreTerm(
            label=f"Bölgeye giriş süresi · {eta_txt}",
            points=pct100(0.5 * eta_term),
            detail=f"{warning.horizon_min} dk ufka göre",
        )
    )
    terms.append(
        ScoreTerm(
            label=f"En yakın yaklaşma · {assessment.cpa_m:.0f} m",
            points=pct100(0.3 * cpa_term),
            detail=f"{span:.0f} m yarıçap+tampon içinde",
        )
    )
    terms.append(
        ScoreTerm(
            label=f"Yaklaşma güveni · {assessment.approach_conf:.2f}",
            points=pct100(0.2 * assessment.approach_conf),
            detail=f"{zone_name} yönünde",
        )
    )

    base = 0.5 * eta_term + 0.3 * cpa_term + 0.2 * assessment.approach_conf
    heavy = bool(state and state.class_hint in HEAVY_CLASSES)
    multiplier = warning.heavy_vehicle_multiplier if heavy else None
    score = pct100(shipped_priority(alert))

    if heavy:
        terms.append(
            ScoreTerm(
                label=f"Ağır araç · {state.class_hint} (x{multiplier:g})",
                points=score - pct100(base),
                detail="ağır araç çarpanı",
            )
        )

    # Reconcile. Each term is rounded independently, and `priority` is clamped at
    # 1.0, so the rows can miss the total by a point or two. A breakdown whose
    # rows do not add up to the figure above them is worse than useless -- it
    # invites the reader to distrust both -- so the drift is pushed onto the
    # largest term, which is the one it came from.
    drift = score - sum(t.points for t in terms)
    if drift != 0 and terms:
        biggest = max(range(len(terms)), key=lambda i: abs(terms[i].points))
        terms[biggest] = ScoreTerm(
            label=terms[biggest].label,
            points=terms[biggest].points + drift,
            detail=terms[biggest].detail,
        )

    return {
        "score": score,
        "base_score": pct100(base),
        "heavy_multiplier": multiplier,
        "terms": [{"label": t.label, "points": t.points, "detail": t.detail} for t in terms],
        "note": None,
    }


# --------------------------------------------------------------------------- #
# serialisers
# --------------------------------------------------------------------------- #


def zone_json(zone: Zone) -> dict[str, Any]:
    east, north = zone.center_enu.e_m, zone.center_enu.n_m
    return {
        "zone_id": zone.zone_id,
        "name": zone.name,
        "enu": {"e_m": r(east), "n_m": r(north)},
        "lat": zone.center.lat,
        "lon": zone.center.lon,
        "range_m": r(math.hypot(east, north)),
        "bearing_deg": r(bearing_deg(east, north), 2),
        "radius_m": zone.radius_m,
        "buffer_m": zone.buffer_m,
    }


def detection_json(det: Detection) -> dict[str, Any]:
    return {
        "det_id": det.det_id,
        "cls": det.cls,
        "score": round(det.score, 5),
        "bbox_px": [r(v, 1) for v in det.bbox_px],
        "area_m2": r(det.area_m2, 2),
        "center_px": [r(v, 1) for v in det.center_px],
        "enu": {"e_m": r(det.center_enu.e_m), "n_m": r(det.center_enu.n_m)},
        "kept": det.kept,
        "drop_reason": det.drop_reason,
        "suppressed_by": det.suppressed_by,
    }


def track_state_json(state: TrackState, destination: str | None) -> dict[str, Any]:
    return {
        "track_id": state.track_id,
        "enu": {"e_m": r(state.pos.e_m), "n_m": r(state.pos.n_m)},
        "speed_mps": r(state.speed_mps, 2),
        "heading_deg": r(state.heading_deg, 1),
        "stationary": state.stationary,
        "cls": state.class_hint,
        "class_conf": r(state.class_conf, 3),
        "dist_to_base_m": {k: r(v) for k, v in state.dist_to_base_m.items()},
        "last_fix_hhmm": hhmm(state.last_fix_ts),
        "destination_zone_id": destination,
        "outlier_steps": state.outlier_steps,
    }


def track_position_json(state: TrackState, footprint: Footprint) -> dict[str, Any]:
    """Project the recorded GPS fix into the source image's pixel coordinates."""
    lat, lon = state.pos_geo.lat, state.pos_geo.lon
    x, y = footprint.latlon_to_pixel(lat, lon)
    return {
        "track_id": state.track_id,
        "lat": lat,
        "lon": lon,
        "pixel": [r(x, 2), r(y, 2)],
        "in_frame": footprint.contains_latlon(lat, lon),
    }


def zone_assessment_json(za: ZoneAssessment) -> dict[str, Any]:
    return {
        "zone_id": za.zone_id,
        "dist_now_m": r(za.dist_now_m),
        "cpa_m": r(za.cpa_m),
        "t_cpa_s": r(za.t_cpa_s),
        "eta_entry_s": r(za.eta_entry_s),
        "closing_speed_mps": r(za.closing_speed_mps, 2),
        "approach_conf": r(za.approach_conf, 3),
        "inside_zone": za.inside_zone,
        "inside_buffer": za.inside_buffer,
    }


def alert_json(
    alert: Alert,
    breakdown: dict[str, Any],
    *,
    zone_name: str | None,
    assessment: ZoneAssessment | None,
    state: TrackState | None,
) -> dict[str, Any]:
    """One alert, with the figures the screens quote alongside it.

    `zone_name`, the geometry and the class are denormalised onto the alert on
    purpose: the motion table and the logs view read the flattened cross-frame
    alert list and would otherwise have to fetch all 40 frame payloads to print
    an ETA. They are copies of the zone assessment the alert already names, not
    new numbers.
    """
    return {
        "alert_id": alert.alert_id,
        "track_id": alert.track_id,
        "zone_id": alert.zone_id,
        "zone_name": zone_name,
        "cls": state.class_hint if state else None,
        "dist_now_m": r(assessment.dist_now_m) if assessment else None,
        "cpa_m": r(assessment.cpa_m) if assessment else None,
        "eta_entry_s": r(assessment.eta_entry_s) if assessment else None,
        "closing_speed_mps": r(assessment.closing_speed_mps, 2) if assessment else None,
        "approach_conf": r(assessment.approach_conf, 3) if assessment else None,
        "speed_mps": r(state.speed_mps, 2) if state else None,
        "stationary": state.stationary if state else None,
        "baseline_level": alert.baseline_level,
        "agent_level": alert.agent_level,
        "jev_level": alert.jev_level,
        "jev_confidence": alert.jev_confidence,
        "level": alert.level,
        "source": alert.source,
        "priority": shipped_priority(alert),
        "reasons": alert.reasons,
        "agent_rationale": alert.agent_rationale,
        "agent_dissent": alert.agent_dissent,
        "evidence": alert.evidence,
        "status": alert.status,
        "first_raised_hhmm": hhmm(alert.first_raised_ts),
        "breakdown": breakdown,
    }


def report_json(report: FieldReport) -> dict[str, Any]:
    return {
        "report_id": report.report_id,
        "hhmm": hhmm(report.ts),
        "source": report.source,
        "text": report.text,
        "kind": report.parsed.kind,
        "zone_ref": report.parsed.zone_ref,
        "geo": None
        if report.parsed.geo is None
        else {"lat": report.parsed.geo.lat, "lon": report.parsed.geo.lon},
        "vehicle_type": report.parsed.vehicle_type,
        "count": report.parsed.count,
        "area_wide": report.parsed.area_wide,
        "parser": report.parser,
        "parse_conf": r(report.parse_conf, 3),
        "consistency": report.consistency,
        "consistency_note": report.consistency_note,
        "matched_track_ids": report.matched_track_ids,
    }


def bundle_json(bundle: EvidenceBundle) -> dict[str, Any]:
    """The agent's own input, shipped so the UI can show what it was given."""
    return json.loads(bundle.model_dump_json())


def brief_json(assessment: ImageAssessment, analysis: ImageAnalysis) -> dict[str, Any]:
    """The deterministic brief: `ImageAssessorPolicy.fallback` over the bundle.

    This is the "kural tabanlı" (rules-based) brief the wireframe shows in edge
    case A, and it is genuine system output rather than sample copy. When the
    LLM runs, the HTTP adapter supplies the same shape with `source: "llm"`.
    """
    return {
        "source": "rules",
        "image_summary": assessment.image_summary,
        "assessments": [
            {
                "track_id": a.track_id,
                "level": a.level,
                "needs_attention": a.needs_attention,
                "rationale": a.rationale,
                "cited_ids": a.cited_ids,
                "report_conflicts": [
                    {"report_id": c.report_id, "why": c.why} for c in a.report_conflicts
                ],
            }
            for a in assessment.assessments
        ],
    }


# --------------------------------------------------------------------------- #
# the export
# --------------------------------------------------------------------------- #


def frame_level(alerts: Sequence[Alert]) -> tuple[str, int]:
    """A frame's headline level and score: its worst alert, then its highest priority."""
    if not alerts:
        return (Level.CLEAR.value, 0)
    worst = max(alerts, key=lambda a: (a.level.rank, a.priority))
    return (worst.level.value, pct100(shipped_priority(worst)))


def build_frame_payload(
    analysis: ImageAnalysis,
    pipeline: Pipeline,
    cfg: Config,
    policy: ImageAssessorPolicy,
    zone_names: Mapping[str, str],
) -> dict[str, Any]:
    bundle = pipeline.bundle_of(analysis)
    brief = brief_json(policy.fallback(bundle), analysis)
    footprint = pipeline.dataset.footprints[analysis.image.image_id]

    assessment_by_key: dict[tuple[str, str], ZoneAssessment] = {
        (track_id, za.zone_id): za
        for track_id, zas in analysis.zone_assessments.items()
        for za in zas
    }
    alerts: list[dict[str, Any]] = []
    for alert in analysis.alerts:
        assessment = assessment_by_key.get((alert.track_id, alert.zone_id or ""))
        state = analysis.track_states.get(alert.track_id)
        zone_name = zone_names.get(alert.zone_id or "") if alert.zone_id else None
        alerts.append(
            alert_json(
                alert,
                score_breakdown(alert, assessment, state, zone_name or "", cfg),
                zone_name=zone_name,
                assessment=assessment,
                state=state,
            )
        )

    post = analysis.postprocess
    return {
        "image_id": analysis.image.image_id,
        "capture_hhmm": hhmm(analysis.as_of),
        "width_px": analysis.image.width_px,
        "height_px": analysis.image.height_px,
        "gsd_x_m": r(analysis.image.gsd_x_m, 4),
        "gsd_y_m": r(analysis.image.gsd_y_m, 4),
        "footprint_enu": [
            {"e_m": r(c.e_m), "n_m": r(c.n_m)} for c in analysis.image.footprint_enu
        ],
        "funnel": post.as_dict() if post else None,
        "detections": [detection_json(d) for d in analysis.detections],
        "track_states": [
            track_state_json(state, analysis.destinations.get(track_id))
            for track_id, state in sorted(analysis.track_states.items())
        ],
        "track_positions": [
            track_position_json(state, footprint)
            for _, state in sorted(analysis.track_states.items())
        ],
        "zone_assessments": {
            track_id: [zone_assessment_json(za) for za in zas]
            for track_id, zas in sorted(analysis.zone_assessments.items())
        },
        "matches": [
            {
                "track_id": m.track_id,
                "det_id": m.evidence_id,
                "distance_m": r(m.distance_m, 2),
                "confidence": m.confidence,
            }
            for m in (analysis.match.matches if analysis.match else [])
        ],
        "untracked": [
            {
                "det_id": u.det_id,
                "cls": u.cls,
                "score": round(u.score, 5),
                "nearest_track_id": u.nearest_track_id,
                "nearest_track_dist_m": r(u.nearest_track_dist_m),
                "inside_buffer_of": u.inside_buffer_of,
                "likely_duplicate_of": u.likely_duplicate_of,
            }
            for u in analysis.untracked
        ],
        "expected_not_seen": [
            {
                "track_id": e.track_id,
                "reason": e.reason,
                "dist_to_footprint_m": r(e.dist_to_footprint_m),
                "baseline_level": e.baseline_level,
            }
            for e in bundle.expected_not_seen
        ],
        "alerts": alerts,
        "reports": [report_json(rep) for rep in analysis.reports],
        "brief": brief,
        "bundle": bundle_json(bundle),
    }


def export(cfg_path: Path, with_images: bool) -> dict[str, Any]:
    global _TZ
    started = time.perf_counter()
    cfg = load_config(cfg_path)
    _TZ = ZoneInfo(cfg.tz)
    dataset = load_dataset(cfg)
    pipeline = Pipeline(dataset, cfg)
    policy = ImageAssessorPolicy(cfg)
    zone_names = {z.zone_id: z.name for z in dataset.zones}

    analyses = pipeline.analyse_all()
    sim_start = min(a.as_of for a in analyses)
    origin = min(
        min(points[0].ts for points in dataset.tracks.values()),
        min(rep.ts for rep in dataset.reports),
        sim_start,
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    frames_dir = OUT_DIR / "frames"
    frames_dir.mkdir(exist_ok=True)

    frame_summaries: list[dict[str, Any]] = []
    all_alerts: list[dict[str, Any]] = []

    for analysis in analyses:
        payload = build_frame_payload(analysis, pipeline, cfg, policy, zone_names)
        (frames_dir / f"{analysis.image.image_id}.json").write_text(
            json.dumps(payload, separators=(",", ":")), encoding="utf-8"
        )

        level, score = frame_level(analysis.alerts)
        # The zone this frame is about: the one its worst alert names, else the
        # nearest zone to the footprint centre.
        worst = max(analysis.alerts, key=lambda a: (a.level.rank, a.priority), default=None)
        zone_id = worst.zone_id if worst else None
        frame_summaries.append(
            {
                "image_id": analysis.image.image_id,
                "capture_hhmm": hhmm(analysis.as_of),
                "capture_min": minutes_from(origin, analysis.as_of),
                "width_px": analysis.image.width_px,
                "height_px": analysis.image.height_px,
                "zone_id": zone_id,
                "zone_name": zone_names.get(zone_id or "", None),
                "vehicle_count": len(analysis.track_states),
                "kept_boxes": len(analysis.kept_detections),
                "raw_boxes": len(analysis.detections),
                "level": level,
                "score": score,
                "alert_count": len(analysis.alerts),
                "report_count": len(analysis.reports),
                "centre_enu": {
                    "e_m": r(sum(c.e_m for c in analysis.image.footprint_enu) / 4),
                    "n_m": r(sum(c.n_m for c in analysis.image.footprint_enu) / 4),
                },
            }
        )
        for alert in analysis.alerts:
            record = next(a for a in payload["alerts"] if a["alert_id"] == alert.alert_id)
            all_alerts.append({**record, "image_id": analysis.image.image_id})

        if with_images:
            src = REPO_ROOT / cfg.paths.stage2_dir / "images" / f"{analysis.image.image_id}.jpg"
            if src.exists():
                shutil.copyfile(src, frames_dir / f"{analysis.image.image_id}.jpg")

    # Tracks as parallel arrays: 226 x 25 points stays under ~150 KB this way,
    # which is small enough to load once and interpolate in the browser.
    track_class: dict[str, str | None] = {}
    track_frame: dict[str, str] = {}
    for analysis in analyses:
        for track_id, state in analysis.track_states.items():
            if state.class_hint:
                track_class[track_id] = state.class_hint
            if state.image_id:
                track_frame[track_id] = state.image_id

    tracks_payload = {
        "origin_ts": origin.isoformat(),
        "tracks": [
            {
                "track_id": track_id,
                "cls": track_class.get(track_id),
                "image_id": track_frame.get(track_id),
                "t": [minutes_from(origin, p.ts) for p in points],
                "e": [r(p.e_m) for p in points],
                "n": [r(p.n_m) for p in points],
            }
            for track_id, points in sorted(dataset.tracks.items())
        ],
    }
    (OUT_DIR / "tracks.json").write_text(
        json.dumps(tracks_payload, separators=(",", ":")), encoding="utf-8"
    )

    # Consistency is judged per frame, against that frame's detections, so the
    # dataset-level reports carry none of their own. Fold the frame verdicts back
    # in: the most decisive one wins (a contradiction outranks agreement, which
    # outranks "nothing nearby"), and `checked_in` names the frame that judged it.
    verdict_rank = {"contradicts": 3, "agrees": 2, "unrelated": 1}
    judged: dict[str, tuple[str, str | None, str]] = {}
    for analysis in analyses:
        for rep in analysis.reports:
            if rep.consistency is None:
                continue
            best = judged.get(rep.report_id)
            if best is None or verdict_rank[rep.consistency] > verdict_rank[best[0]]:
                judged[rep.report_id] = (
                    rep.consistency,
                    rep.consistency_note,
                    analysis.image.image_id,
                )

    def report_with_verdict(rep: FieldReport) -> dict[str, Any]:
        out = {**report_json(rep), "t_min": minutes_from(origin, rep.ts), "checked_in": None}
        if rep.report_id in judged:
            consistency, note, image_id = judged[rep.report_id]
            out.update(consistency=consistency, consistency_note=note, checked_in=image_id)
        return out

    (OUT_DIR / "reports.json").write_text(
        json.dumps(
            {
                "origin_ts": origin.isoformat(),
                "reports": [report_with_verdict(rep) for rep in dataset.reports],
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    (OUT_DIR / "alerts.json").write_text(
        json.dumps({"alerts": all_alerts}, separators=(",", ":")), encoding="utf-8"
    )

    quality = pipeline.match_quality(analyses)
    dataset_payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "exercise_date": str(cfg.exercise_date),
        "origin_ts": origin.isoformat(),
        "base": {
            "name": dataset.base_name,
            "lat": dataset.base.lat,
            "lon": dataset.base.lon,
        },
        "sim": {
            "start_hhmm": cfg.sim.start,
            "end_hhmm": cfg.sim.end,
            "start_min": 0.0,
            # end_min is filled in below, once the last track fix is known.
            "end_min": 0.0,
            "default_speed": cfg.sim.default_speed,
            "tick_sim_s": cfg.sim.tick_sim_s,
        },
        "zones": [zone_json(z) for z in dataset.zones],
        "frames": frame_summaries,
        "thresholds": {
            "score_threshold": cfg.detection.score_threshold,
            "nms_iou": cfg.detection.nms_iou,
            "min_area_m2": cfg.detection.min_area_m2,
            "gate_m": cfg.matching.gate_m,
            "duplicate_radius_m": cfg.matching.duplicate_radius_m,
            "zone_radius_m": cfg.zones.default_radius_m,
            "zone_buffer_m": cfg.zones.default_buffer_m,
            "horizon_min": cfg.warning.horizon_min,
            "alert_eta_min": cfg.warning.alert_eta_min,
            "alert_conf": cfg.warning.alert_conf,
            "watch_conf": cfg.warning.watch_conf,
            "heavy_vehicle_multiplier": cfg.warning.heavy_vehicle_multiplier,
            "stationary_disp_m": cfg.kinematics.stationary_disp_m,
        },
        "counts": {
            "images": len(dataset.images),
            "tracks": len(dataset.tracks),
            "reports": len(dataset.reports),
            "zones": len(dataset.zones),
            "raw_boxes": sum(len(b) for b in dataset.raw_boxes.values()),
            "alerts": len(all_alerts),
        },
        "match_quality": quality.as_dict(),
        "validation_issues": [
            {
                "file": i.file,
                "pointer": i.pointer,
                "rule": i.rule,
                "severity": i.severity,
                "message": i.message,
            }
            for i in dataset.issues
        ],
        "agents": {"mode": "rules", "budget_cap_usd": cfg.agents.budget_cap_usd},
    }
    # The sim window in minutes-from-origin, which is what the timeline uses.
    last_ts = max(p.ts for points in dataset.tracks.values() for p in points)
    dataset_payload["sim"]["end_min"] = minutes_from(origin, last_ts)

    (OUT_DIR / "dataset.json").write_text(
        json.dumps(dataset_payload, separators=(",", ":")), encoding="utf-8"
    )

    elapsed = time.perf_counter() - started
    return {
        "elapsed_s": round(elapsed, 2),
        "frames": len(analyses),
        "alerts": len(all_alerts),
        "levels": _level_counts(all_alerts),
        "bytes": _dir_bytes(OUT_DIR),
        "max_track_range_km": round(
            max(
                math.hypot(p.e_m, p.n_m)
                for points in dataset.tracks.values()
                for p in points
            )
            / 1000.0,
            2,
        ),
    }


def _level_counts(alerts: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for alert in alerts:
        counts[alert["level"]] = counts.get(alert["level"], 0) + 1
    return counts


def _dir_bytes(path: Path) -> dict[str, int]:
    json_bytes = sum(p.stat().st_size for p in path.rglob("*.json"))
    jpg_bytes = sum(p.stat().st_size for p in path.rglob("*.jpg"))
    return {"json": json_bytes, "jpg": jpg_bytes}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=REPO_ROOT / "goru.yaml")
    parser.add_argument(
        "--no-images",
        action="store_true",
        help="skip copying the 40 drone JPEGs (the camera view then shows a placeholder)",
    )
    args = parser.parse_args(argv)

    stats = export(args.config, with_images=not args.no_images)
    print(f"exported {stats['frames']} frames in {stats['elapsed_s']}s -> {OUT_DIR}")
    print(f"  alerts        {stats['alerts']}  {stats['levels']}")
    print(f"  json          {stats['bytes']['json'] / 1024:.0f} KB")
    print(f"  images        {stats['bytes']['jpg'] / 1024 / 1024:.1f} MB")
    print(f"  track extent  {stats['max_track_range_km']} km from base")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
