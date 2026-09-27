"""The deterministic pipeline: dataset in, evidence and alerts out.

This is the wiring layer. It owns the order of operations for one image at its
capture time - post-process, match, derive kinematics, assess zones, fuse
reports, apply the rule baseline - and nothing else. Each step it calls is a
module that can be tested on its own.

Everything here obeys the as-of rule: a computation at simulation time `now` sees
only records with ``ts <= now``. That is enforced in one place,
`Timeline.as_of`, so the no-future-leakage test has a single seam to sit on.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Iterable, Mapping, Sequence

from goru_core.config import Config
from goru_core.schemas import (
    Alert,
    Detection,
    EvidenceBundle,
    FieldReport,
    Level,
    TrackState,
    UntrackedDetection,
)
from goru_core.timeline import Timeline

from app.evidence.bundle import ImageAnalysis, build_bundle
from app.fusion.matching import (
    MatchOutcome,
    match_detections_to_tracks,
    nearest_neighbour_reference,
)
from app.fusion.report_resolver import Scene, report_cap, resolve_reports
from app.ingest.loaders import Dataset
from app.kinematics.behaviour import behaviour_profile
from app.kinematics.velocity import recent_positions, track_state
from app.perception.postprocess import postprocess_image
from app.risk.base import base_target, sector_of
from app.risk.engine import BaselineVerdict, Hysteresis, ReportSupport, RuleEngine, likelihood_of
from app.risk.threat import assess_threat
from app.risk.zones import assess_zones, most_likely_destination

__all__ = ["Pipeline", "MatchQuality"]

@dataclass
class MatchQuality:
    """Aggregate matching statistics over the whole set.

    Reports two figures deliberately, because PLAN quotes them interchangeably
    and they are not the same measurement:

    * the *exclusive* assignment the system actually uses (PLAN 6.4, Hungarian),
      under which one track belongs to at most one detection;
    * the *nearest-neighbour reference* of PLAN 2.8, which lets several detections
      claim one track and therefore scores higher.
    """

    kept_detections: int = 0
    matched: int = 0
    unmatched_detections: int = 0
    likely_duplicates: int = 0
    untracked_objects: int = 0
    expected_not_seen: int = 0
    outside_footprint: int = 0
    no_detection_in_footprint: int = 0
    nn_matched: int = 0
    distances_m: list[float] = field(default_factory=list)
    nn_distances_m: list[float] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        import numpy as np

        def stats(values: Sequence[float]) -> dict[str, float]:
            ordered = sorted(values)
            if not ordered:
                return {"median_m": 0.0, "p90_m": 0.0, "max_m": 0.0}
            return {
                "median_m": round(float(np.median(ordered)), 3),
                "p90_m": round(float(np.percentile(ordered, 90)), 3),
                "max_m": round(ordered[-1], 3),
            }

        distances = sorted(self.distances_m)
        return {
            "kept_detections": self.kept_detections,
            "exclusive": {
                "matched": self.matched,
                "match_rate": round(self.matched / self.kept_detections, 4)
                if self.kept_detections
                else 0.0,
                "unmatched_detections": self.unmatched_detections,
                "likely_duplicates": self.likely_duplicates,
                "untracked_objects": self.untracked_objects,
                **stats(distances),
                "within_5m": sum(1 for d in distances if d <= 5.0),
                "within_10m": sum(1 for d in distances if d <= 10.0),
                "within_25m": sum(1 for d in distances if d <= 25.0),
            },
            "nearest_neighbour_reference": {
                "matched": self.nn_matched,
                "match_rate": round(self.nn_matched / self.kept_detections, 4)
                if self.kept_detections
                else 0.0,
                **stats(self.nn_distances_m),
            },
            "tracks": {
                "expected_not_seen": self.expected_not_seen,
                "outside_footprint": self.outside_footprint,
                "no_detection_in_footprint": self.no_detection_in_footprint,
            },
        }


class Pipeline:
    """Turns a loaded `Dataset` into per-image analyses, alerts and bundles."""

    def __init__(self, dataset: Dataset, cfg: Config) -> None:
        self._dataset = dataset
        self._cfg = cfg
        self._zone_names = {z.zone_id: z.name for z in dataset.zones}
        self._engine = RuleEngine(cfg, self._zone_names)
        self._base = base_target(dataset.base, dataset.base_name, cfg)
        self._hysteresis = Hysteresis(cfg.warning.downgrade_consecutive)

    @property
    def dataset(self) -> Dataset:
        return self._dataset

    @property
    def config(self) -> Config:
        return self._cfg

    # ------------------------------------------------------------------ #
    # One image
    # ------------------------------------------------------------------ #

    def analyse_image(self, image_id: str, *, apply_hysteresis: bool = False) -> ImageAnalysis:
        """Everything the engine knows about one image at its capture time."""
        dataset = self._dataset
        cfg = self._cfg
        try:
            meta = dataset.images[image_id]
        except KeyError as exc:
            raise KeyError(f"unknown image {image_id!r}") from exc

        as_of = meta.capture_ts
        footprint = dataset.footprints[image_id]

        detections, post = postprocess_image(
            image_id=image_id,
            raw_boxes=list(dataset.raw_boxes.get(image_id, [])),
            footprint=footprint,
            frame=dataset.frame,
            cfg=cfg,
            source_ref=dataset.version.ref(cfg.boxes_csv.name, image_id),
        )

        # A11: this image's vehicles are the tracks whose window ends here.
        candidate_ids = dataset.tracks_ending_at(as_of)
        histories: dict[str, object] = {}
        states: dict[str, TrackState] = {}
        behaviours = {}
        points_by_track = {}
        for track_id in candidate_ids:
            points = dataset.track_points_as_of(track_id, as_of)
            if not points:
                continue
            states[track_id] = track_state(points, as_of, cfg, image_id=image_id)
            histories[track_id] = recent_positions(points, count=4)
            behaviours[track_id] = behaviour_profile(points, as_of, cfg)
            points_by_track[track_id] = points

        match = match_detections_to_tracks(
            detections, states, cfg=cfg, footprint=footprint, frame=dataset.frame
        )

        # Tracks carry no class; the matched detection supplies it.
        for track_id, det_id in match.det_by_track.items():
            detection = next((d for d in detections if d.det_id == det_id), None)
            if detection is not None:
                states[track_id] = states[track_id].model_copy(
                    update={"class_hint": detection.cls, "class_conf": detection.score}
                )

        # The zones are observation sectors: their geometry is context for the agent
        # and the display, never a trigger. The base is the one target the rules read.
        assessments = assess_zones(states, histories, dataset.zones, cfg, as_of)  # type: ignore[arg-type]
        base_assessments = {
            track_id: items[0]
            for track_id, items in assess_zones(
                states, histories, [self._base], cfg, as_of  # type: ignore[arg-type]
            ).items()
        }
        sectors = {
            track_id: sector_of(state.pos.e_m, state.pos.n_m, dataset.zones).zone_id
            for track_id, state in states.items()
        }
        destinations = {
            track_id: most_likely_destination(items, cfg) for track_id, items in assessments.items()
        }

        def evaluate(track_id: str, support: ReportSupport | None = None) -> BaselineVerdict:
            return self._engine.evaluate(
                states[track_id],
                base_assessments[track_id],
                behaviours[track_id],
                sector_id=sectors[track_id],
                detection_id=match.det_by_track.get(track_id),
                report_support=support,
                destination_zone_id=destinations.get(track_id),
            )

        # The data decides first. Reports are then tested against it - including the
        # sector claims, which read what this frame rates as alarming - and may only
        # add to a level the data set, under `report_cap`'s policy.
        verdicts: dict[str, BaselineVerdict] = {track_id: evaluate(track_id) for track_id in states}
        corners = footprint.corners_enu(dataset.frame)
        centre_e = sum(e for e, _ in corners) / len(corners)
        centre_n = sum(n for _, n in corners) / len(corners)
        reports = resolve_reports(
            dataset.reports,
            Scene(
                as_of=as_of,
                footprint=footprint,
                frame=dataset.frame,
                sector_id=sector_of(centre_e, centre_n, dataset.zones).zone_id,
                histories=points_by_track,
                detections=[d for d in detections if d.kept],
                alarming=frozenset(t for t, v in verdicts.items() if v.level is Level.ALERT),
            ),
            cfg,
        )
        for track_id, support in self._report_support(reports).items():
            if track_id in verdicts:
                verdicts[track_id] = evaluate(track_id, support)

        if apply_hysteresis:
            for track_id, verdict in verdicts.items():
                held = self._hysteresis.apply(track_id, verdict.level)
                if held is not verdict.level:
                    verdicts[track_id] = replace(
                        verdict,
                        level=held,
                        likelihood=likelihood_of(held),
                        reasons=[*verdict.reasons, f"histerezis nedeniyle {held.value} seviyesinde tutuldu"],
                    )

        untracked = self._untracked(match, detections, states)

        analysis = ImageAnalysis(
            image=meta,
            as_of=as_of,
            detections=detections,
            postprocess=post,
            track_states=states,
            zone_assessments=assessments,
            base_assessments=base_assessments,
            behaviours=behaviours,
            sectors=sectors,
            destinations=destinations,
            match=match,
            verdicts=verdicts,
            reports=reports,
            untracked=untracked,
            zones=list(dataset.zones),
        )
        analysis.threats = {
            track_id: threat
            for track_id, verdict in verdicts.items()
            if (threat := assess_threat(track_id, verdict, analysis, reports=reports)) is not None
        }
        analysis.alerts = self._alerts(analysis)
        return analysis

    def bundle_for(self, image_id: str, *, apply_hysteresis: bool = False) -> EvidenceBundle:
        """The agent's input for one image."""
        analysis = self.analyse_image(image_id, apply_hysteresis=apply_hysteresis)
        return self.bundle_of(analysis)

    def bundle_of(self, analysis: ImageAnalysis) -> EvidenceBundle:
        return build_bundle(
            analysis, self._cfg, hhmm=self._dataset.timeline.hhmm(analysis.as_of)
        )

    # ------------------------------------------------------------------ #
    # The whole set
    # ------------------------------------------------------------------ #

    def analyse_all(self) -> list[ImageAnalysis]:
        """Every image in capture order, with hysteresis carried between ticks."""
        self._hysteresis.reset()
        ordered = sorted(self._dataset.images.values(), key=lambda m: m.capture_ts)
        return [self.analyse_image(meta.image_id, apply_hysteresis=True) for meta in ordered]

    def match_quality(self, analyses: Sequence[ImageAnalysis] | None = None) -> MatchQuality:
        """Reproduces the PLAN 2.8 measurement over the whole dataset."""
        analyses = analyses if analyses is not None else self.analyse_all()
        quality = MatchQuality()
        for analysis in analyses:
            if analysis.match is None:
                continue
            quality.kept_detections += len(analysis.kept_detections)
            quality.matched += len(analysis.match.matches)
            quality.unmatched_detections += len(analysis.match.unmatched_det_ids)
            quality.likely_duplicates += len(analysis.match.duplicate_of)
            quality.untracked_objects += len(analysis.match.untracked_det_ids)
            quality.expected_not_seen += len(analysis.match.expected_not_seen)
            quality.outside_footprint += sum(
                1 for _, reason, _ in analysis.match.expected_not_seen if reason == "outside_footprint"
            )
            quality.no_detection_in_footprint += sum(
                1
                for _, reason, _ in analysis.match.expected_not_seen
                if reason == "no_detection_in_footprint"
            )
            quality.distances_m.extend(analysis.match.distances_m)

            nn_matched, nn_distances = nearest_neighbour_reference(
                analysis.detections,
                analysis.track_states,
                gate_m=self._cfg.matching.nn_reference_gate_m,
            )
            quality.nn_matched += nn_matched
            quality.nn_distances_m.extend(nn_distances)
        return quality

    # ------------------------------------------------------------------ #
    # Reports
    # ------------------------------------------------------------------ #

    def _report_support(self, reports: Iterable[FieldReport]) -> dict[str, ReportSupport]:
        """Per-track caps the reports may justify, under `report_cap`'s policy."""
        support: dict[str, ReportSupport] = {}
        for report in reports:
            cap = report_cap(report)
            if cap is Level.CLEAR or not report.matched_track_ids:
                continue
            note = f"doğrulanmış rapor {report.report_id} ({report.parsed.kind}) en fazla {cap.value} destekler"
            for track_id in report.matched_track_ids:
                existing = support.get(track_id)
                if existing is None or cap.rank > existing.cap.rank:
                    support[track_id] = ReportSupport(cap=cap, report_ids=(report.report_id,), note=note)
        return support

    # ------------------------------------------------------------------ #
    # Residues and alerts
    # ------------------------------------------------------------------ #

    def _untracked(
        self,
        match: MatchOutcome,
        detections: Sequence[Detection],
        states: Mapping[str, TrackState],
    ) -> list[UntrackedDetection]:
        """Detections that matched no track, duplicates flagged as such.

        Both cases are returned: a genuine untracked object may raise a WATCH,
        while a probable double-detection is shown to the reviewer but raises
        nothing, because it is the same vehicle counted twice.
        """
        out: list[UntrackedDetection] = []
        duplicate_of = match.duplicate_of
        by_id = {d.det_id: d for d in detections}
        for det_id in match.unmatched_det_ids:
            detection = by_id.get(det_id)
            if detection is None:
                continue
            nearest_id: str | None = None
            nearest_dist: float | None = None
            for track_id, state in states.items():
                distance = math.hypot(
                    detection.center_enu.e_m - state.pos.e_m,
                    detection.center_enu.n_m - state.pos.n_m,
                )
                if nearest_dist is None or distance < nearest_dist:
                    nearest_id, nearest_dist = track_id, distance
            # Inside the base's warning ring: record the observation sector it is in.
            inside_of: str | None = None
            east, north = detection.center_enu.e_m, detection.center_enu.n_m
            if math.hypot(east, north) <= self._cfg.base.warning_radius_m:
                inside_of = sector_of(east, north, self._dataset.zones).zone_id
            out.append(
                UntrackedDetection(
                    det_id=det_id,
                    cls=detection.cls,
                    score=round(detection.score, 4),
                    center_geo=detection.center_geo,
                    nearest_track_id=nearest_id,
                    nearest_track_dist_m=None if nearest_dist is None else round(nearest_dist, 2),
                    inside_buffer_of=inside_of,
                    likely_duplicate_of=duplicate_of.get(det_id),
                )
            )
        return out

    def _alerts(self, analysis: ImageAnalysis) -> list[Alert]:
        """Baseline alerts for this image. The agent layer may raise these later."""
        cfg = self._cfg
        ts = analysis.as_of
        alerts: list[Alert] = []

        for track_id, verdict in analysis.verdicts.items():
            if verdict.level is Level.CLEAR:
                continue
            alerts.append(
                Alert(
                    alert_id=f"A-{analysis.image.image_id}-{track_id}",
                    track_id=track_id,
                    zone_id=verdict.zone_id,
                    baseline_level=verdict.level,
                    level=verdict.level,
                    source="rules",
                    priority=verdict.priority,
                    reasons=list(verdict.reasons),
                    evidence=list(verdict.evidence),
                    first_raised_ts=ts,
                    updated_ts=ts,
                    rules_version=cfg.rules_version,
                )
            )

        for untracked in analysis.untracked:
            if not untracked.inside_buffer_of or untracked.likely_duplicate_of:
                continue
            sector_name = self._zone_names.get(untracked.inside_buffer_of, untracked.inside_buffer_of)
            base_range = self._dataset.frame.range_m(untracked.center_geo.lat, untracked.center_geo.lon)
            alerts.append(
                Alert(
                    alert_id=f"A-{analysis.image.image_id}-{untracked.det_id}",
                    track_id=untracked.det_id,
                    zone_id=untracked.inside_buffer_of,
                    baseline_level=Level.WATCH,
                    level=Level.WATCH,
                    source="rules",
                    priority=0.3,
                    reasons=[
                        f"İzsiz {untracked.cls} (skor {untracked.score:.2f}) uyarı halkasında: "
                        f"üsse {base_range / 1000:.2f} km, {sector_name} sektörü; en yakın iz "
                        f"{untracked.nearest_track_id}, {untracked.nearest_track_dist_m} m"
                    ],
                    evidence=[untracked.det_id],
                    first_raised_ts=ts,
                    updated_ts=ts,
                    rules_version=cfg.rules_version,
                )
            )

        alerts.sort(key=lambda a: (-a.level.rank, -a.priority))
        return alerts
