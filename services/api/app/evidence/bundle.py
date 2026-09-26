"""The evidence bundle: the seam between the engine and the agent (PLAN.md 6.9).

`ImageAnalysis` is everything the deterministic engine computed for one image.
`build_bundle` narrows it to the compact, complete JSON the agent is allowed to
reason over.

The narrowing is the point. The agent sees ids and numbers the engine derived -
never raw files, never the rule thresholds, never anything it could mistake for
an instruction - and the bundle's hash is the cache key, so a replayed demo costs
nothing. Trimming to the top three zones per vehicle keeps the busiest image well
inside the token budget, which drives both latency and cost.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Mapping, Sequence

from goru_core.config import Config
from goru_core.provenance import payload_sha256
from goru_core.schemas import (
    Alert,
    Detection,
    EvidenceBundle,
    ExpectedNotSeen,
    FieldReport,
    ImageEvidence,
    ImageMeta,
    Level,
    ReportEvidence,
    TrackState,
    UntrackedDetection,
    VehicleEvidence,
    Zone,
    ZoneAssessment,
    ZoneEvidence,
)

from app.fusion.matching import MatchOutcome
from app.perception.postprocess import PostprocessReport
from app.risk.engine import BaselineVerdict

__all__ = ["ImageAnalysis", "build_bundle", "bundle_hash", "ZONES_PER_VEHICLE"]

ZONES_PER_VEHICLE = 3


@dataclass
class ImageAnalysis:
    """The engine's complete result for one image at its capture time."""

    image: ImageMeta
    as_of: datetime
    detections: list[Detection] = field(default_factory=list)
    postprocess: PostprocessReport | None = None
    track_states: dict[str, TrackState] = field(default_factory=dict)
    zone_assessments: dict[str, list[ZoneAssessment]] = field(default_factory=dict)
    destinations: dict[str, str | None] = field(default_factory=dict)
    match: MatchOutcome | None = None
    verdicts: dict[str, BaselineVerdict] = field(default_factory=dict)
    reports: list[FieldReport] = field(default_factory=list)
    alerts: list[Alert] = field(default_factory=list)
    untracked: list[UntrackedDetection] = field(default_factory=list)
    zones: list[Zone] = field(default_factory=list)

    @property
    def kept_detections(self) -> list[Detection]:
        return [d for d in self.detections if d.kept]

    def detection_by_id(self, det_id: str) -> Detection | None:
        return next((d for d in self.detections if d.det_id == det_id), None)


def _zone_evidence(assessment: ZoneAssessment, zone_names: Mapping[str, str]) -> ZoneEvidence:
    return ZoneEvidence(
        zone_id=assessment.zone_id,
        name=zone_names.get(assessment.zone_id, assessment.zone_id),
        dist_now_m=round(assessment.dist_now_m, 1),
        cpa_m=round(assessment.cpa_m, 1),
        eta_entry_s=None if assessment.eta_entry_s is None else round(assessment.eta_entry_s, 1),
        approach_conf=round(assessment.approach_conf, 3),
        inside_zone=assessment.inside_zone,
        inside_buffer=assessment.inside_buffer,
    )


def _rank_zones(assessments: Sequence[ZoneAssessment]) -> list[ZoneAssessment]:
    """Most interesting zones first: inside, then soonest entry, then nearest."""
    return sorted(
        assessments,
        key=lambda a: (
            0 if a.inside_zone else 1 if a.inside_buffer else 2,
            a.eta_entry_s if a.eta_entry_s is not None else float("inf"),
            a.dist_now_m,
        ),
    )


def build_bundle(
    analysis: ImageAnalysis,
    cfg: Config,
    *,
    hhmm: str,
    zones_per_vehicle: int = ZONES_PER_VEHICLE,
) -> EvidenceBundle:
    """Narrow an `ImageAnalysis` to the agent's input contract."""
    zone_names = {z.zone_id: z.name for z in analysis.zones}
    post = analysis.postprocess

    not_seen = {
        track_id: (reason, distance)
        for track_id, reason, distance in (analysis.match.expected_not_seen if analysis.match else [])
    }

    vehicles: list[VehicleEvidence] = []
    for track_id in sorted(analysis.track_states):
        state = analysis.track_states[track_id]
        verdict = analysis.verdicts.get(track_id)
        det_id = analysis.match.det_by_track.get(track_id) if analysis.match else None
        detection = analysis.detection_by_id(det_id) if det_id else None
        match_row = None
        if analysis.match:
            match_row = next((m for m in analysis.match.matches if m.track_id == track_id), None)
        ranked = _rank_zones(analysis.zone_assessments.get(track_id, []))[:zones_per_vehicle]
        vehicles.append(
            VehicleEvidence(
                track_id=track_id,
                cls=detection.cls if detection else state.class_hint,
                score=round(detection.score, 4) if detection else None,
                det_id=det_id,
                match_dist_m=round(match_row.distance_m, 2) if match_row else None,
                match_confidence=match_row.confidence if match_row else None,
                detected=track_id not in not_seen,
                not_seen_reason=not_seen[track_id][0] if track_id in not_seen else None,
                speed_mps=round(state.speed_mps, 2),
                heading_deg=round(state.heading_deg, 1),
                stationary=state.stationary,
                dist_to_base_m={
                    key: (None if value is None else round(value, 1))
                    for key, value in state.dist_to_base_m.items()
                },
                zones=[_zone_evidence(a, zone_names) for a in ranked],
                baseline_level=verdict.level if verdict else Level.CLEAR,
                reasons=list(verdict.reasons) if verdict else [],
            )
        )

    expected_not_seen: list[ExpectedNotSeen] = []
    if analysis.match:
        for track_id, reason, distance in analysis.match.expected_not_seen:
            verdict = analysis.verdicts.get(track_id)
            expected_not_seen.append(
                ExpectedNotSeen(
                    track_id=track_id,
                    reason=reason,  # type: ignore[arg-type]
                    dist_to_footprint_m=round(distance, 1),
                    baseline_level=verdict.level if verdict else Level.CLEAR,
                )
            )

    reports_evidence = [
        ReportEvidence(
            report_id=report.report_id,
            ts_hhmm=hhmm_of(report.ts, cfg),
            source=report.source,
            kind=report.parsed.kind,
            text=report.text,
            zone_ref=report.parsed.zone_ref,
            geo=report.parsed.geo,
            vehicle_type=report.parsed.vehicle_type,
            count=report.parsed.count,
            matched_track_ids=list(report.matched_track_ids),
            consistency=report.consistency,
            consistency_note=report.consistency_note,
            trust_note=_trust_note(report),
        )
        for report in analysis.reports
    ]

    return EvidenceBundle(
        as_of_hhmm=hhmm,
        thresholds_version=cfg.thresholds_version,
        rules_version=cfg.rules_version,
        image=ImageEvidence(
            image_id=analysis.image.image_id,
            capture_hhmm=hhmm,
            width_px=analysis.image.width_px,
            height_px=analysis.image.height_px,
            gsd_x_m=round(analysis.image.gsd_x_m, 4),
            gsd_y_m=round(analysis.image.gsd_y_m, 4),
            raw_box_count=post.raw if post else 0,
            kept_box_count=post.kept if post else len(analysis.kept_detections),
        ),
        vehicles=vehicles,
        untracked_detections=analysis.untracked,
        expected_not_seen=expected_not_seen,
        reports_in_window=reports_evidence,
        zone_catalog=[
            ZoneEvidence(
                zone_id=zone.zone_id,
                name=zone.name,
                dist_now_m=0.0,
                cpa_m=0.0,
                eta_entry_s=None,
                approach_conf=0.0,
                inside_zone=False,
                inside_buffer=False,
            )
            for zone in analysis.zones
        ],
    )


def _trust_note(report: FieldReport) -> str | None:
    """A plain statement of the policy that applies to this report (PLAN 6.8.5).

    Carried into the bundle so the agent is told the rule rather than asked to
    infer it - and so the reviewer sees the same sentence the agent saw.
    """
    kind = report.parsed.kind
    if kind == "identified_friendly":
        return (
            "de-escalation hint only: a report may never lower a level; "
            "only the human reviewer may act on this"
        )
    if kind == "degraded_coverage":
        return "reporting from this zone is unreliable for the stated window; detections are unaffected"
    if kind in {"area_wide", "unverified", "irrelevant"}:
        return "context only; cannot raise or lower a level"
    if report.source == "third_party":
        return "third-party: may raise at most WATCH, and only if a detection corroborates it"
    return "official: may raise WATCH or ALERT when located and matched"


def hhmm_of(ts: datetime, cfg: Config) -> str:
    return ts.astimezone(cfg.tzinfo).strftime("%H:%M")


def bundle_hash(bundle: EvidenceBundle) -> str:
    """Content hash of a bundle; the agent cache key (PLAN 6.9)."""
    return payload_sha256(bundle.model_dump(mode="json"))
