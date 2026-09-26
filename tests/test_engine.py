"""The deterministic engine: perception, matching, kinematics, zones, rules.

These are the facts the agent is not allowed to invent, so they are tested
independently of any model.
"""

from __future__ import annotations

import math
from datetime import timedelta

import numpy as np
import pytest

from goru_core.schemas import ENU, LatLon, Level, SourceRefModel, TrackPoint, TrackState
from goru_core.timeline import Timeline, TimeFormatError
from app.kinematics.profile import track_profile
from app.perception.postprocess import class_agnostic_nms
from app.risk.engine import Hysteresis, ReportSupport, RuleEngine
from app.risk.zones import assess_zones, most_likely_destination


# --------------------------------------------------------------------------- #
# Perception
# --------------------------------------------------------------------------- #


def test_detection_funnel_totals(analyses):
    """PLAN 10.1: 217 boxes survive threshold 0.35 plus class-agnostic NMS@0.5."""
    after_score = sum(a.postprocess.after_score for a in analyses)
    after_nms = sum(a.postprocess.after_nms for a in analyses)
    kept = sum(a.postprocess.kept for a in analyses)
    assert after_score == 226
    assert after_nms == 217
    # PLAN 10.1 claims min_area_m2 drops 0 boxes. At its stated 3.0 it drops three
    # genuine cars (2.83 / 2.92 / 3.00 m2), so goru.yaml uses 2.5 and nothing is
    # dropped - which is the behaviour PLAN describes.
    assert kept == 217


def test_min_area_filter_drops_nothing_at_the_configured_value(analyses):
    dropped = [d for a in analyses for d in a.detections if d.drop_reason == "area<min_m2"]
    assert dropped == []


def test_legacy_pixel_rule_would_also_drop_nothing(analyses):
    assert sum(a.postprocess.legacy_px_would_drop for a in analyses) == 0


def test_kept_class_mix(analyses):
    mix: dict[str, int] = {}
    for analysis in analyses:
        for cls, count in analysis.postprocess.class_mix.items():
            mix[cls] = mix.get(cls, 0) + count
    assert mix == {"car": 172, "truck": 24, "van": 20, "bus": 1}


def test_every_dropped_box_has_a_reason(analyses):
    for analysis in analyses:
        for detection in analysis.detections:
            if detection.kept:
                assert detection.drop_reason is None
            else:
                assert detection.drop_reason in {"score<thr", "nms_suppressed", "area<min_m2"}
                if detection.drop_reason == "nms_suppressed":
                    assert detection.suppressed_by is not None


def test_class_agnostic_nms_keeps_the_best_of_a_cluster():
    """The CSV emits one vehicle under several classes within a pixel of each other."""
    boxes = np.array(
        [
            [100.0, 100.0, 140.0, 140.0],
            [101.0, 101.0, 141.0, 141.0],
            [500.0, 500.0, 540.0, 540.0],
        ]
    )
    scores = np.array([0.90, 0.85, 0.80])
    keep, suppressed_by = class_agnostic_nms(boxes, scores, 0.5)
    assert sorted(keep.tolist()) == [0, 2]
    assert suppressed_by[1] == 0
    assert suppressed_by[0] == -1


def test_nms_on_empty_input():
    keep, suppressed = class_agnostic_nms(np.empty((0, 4)), np.empty(0), 0.5)
    assert keep.size == 0
    assert suppressed.size == 0


def test_detections_carry_provenance_and_thresholds(analyses, cfg):
    detection = analyses[0].kept_detections[0]
    assert detection.thresholds_version == cfg.thresholds_version
    assert detection.source_ref.file_name == "bounding_boxes.csv"
    assert len(detection.source_ref.file_sha256) == 64


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #


def test_exclusive_and_reference_match_rates(pipeline, analyses):
    """Two measurements, both reported, because PLAN quotes them interchangeably.

    PLAN 2.8's "214 of 217 within 60 m, median 0.19, p90 6.04, max 42.96" is a
    non-exclusive nearest-neighbour figure - reproduced here exactly. The system
    itself uses the Hungarian assignment PLAN 6.4 prescribes, which is 1:1 and
    therefore matches fewer detections.
    """
    quality = pipeline.match_quality(analyses).as_dict()
    assert quality["kept_detections"] == 217

    reference = quality["nearest_neighbour_reference"]
    assert reference["matched"] == 214
    assert reference["match_rate"] >= 0.98
    assert math.isclose(reference["median_m"], 0.19, abs_tol=0.01)
    assert math.isclose(reference["p90_m"], 6.03, abs_tol=0.05)
    assert math.isclose(reference["max_m"], 42.96, abs_tol=0.05)

    exclusive = quality["exclusive"]
    assert exclusive["matched"] == 188
    assert exclusive["likely_duplicates"] + exclusive["untracked_objects"] == exclusive[
        "unmatched_detections"
    ]
    assert exclusive["median_m"] < 1.0


def test_twenty_tracks_end_outside_their_footprint(pipeline, analyses):
    """PLAN 2.6 predicts exactly this; the brief calls it normal."""
    quality = pipeline.match_quality(analyses).as_dict()
    assert quality["tracks"]["outside_footprint"] == 20


def test_matches_within_the_gate_and_stamped(analyses, cfg):
    for analysis in analyses:
        for match in analysis.match.matches:
            assert match.distance_m <= cfg.matching.gate_m
            assert match.confidence == ("high" if match.distance_m <= cfg.matching.low_conf_m else "low")
            assert match.rules_version == cfg.rules_version


def test_one_detection_per_track_and_one_track_per_detection(analyses):
    for analysis in analyses:
        track_ids = [m.track_id for m in analysis.match.matches]
        det_ids = [m.evidence_id for m in analysis.match.matches]
        assert len(track_ids) == len(set(track_ids))
        assert len(det_ids) == len(set(det_ids))


def test_duplicates_are_close_and_untracked_are_not(analyses, cfg):
    for analysis in analyses:
        for untracked in analysis.untracked:
            if untracked.likely_duplicate_of:
                assert untracked.nearest_track_dist_m <= cfg.matching.duplicate_radius_m


# --------------------------------------------------------------------------- #
# Kinematics
# --------------------------------------------------------------------------- #


def test_t0001_first_step_speed_and_heading(dataset, cfg):
    """PLAN 2.6: T0001 10:15 to 10:20 is about 4.1 m/s on a heading near 163 degrees."""
    from app.kinematics.velocity import track_state

    points = dataset.tracks["T0001"][:2]
    east = points[1].e_m - points[0].e_m
    north = points[1].n_m - points[0].n_m
    seconds = (points[1].ts - points[0].ts).total_seconds()
    speed = math.hypot(east, north) / seconds
    heading = (math.degrees(math.atan2(east, north)) + 360) % 360
    assert math.isclose(speed, 4.1, abs_tol=0.15)
    assert math.isclose(heading, 163.0, abs_tol=1.5)

    state = track_state(points, points[-1].ts, cfg)
    assert math.isclose(state.speed_mps, speed, rel_tol=0.05)


def test_t0001_is_stationary_between_1020_and_1035(dataset, cfg):
    """Its 4-7 m of jitter must sit below the 25 m stationary threshold."""
    from app.kinematics.velocity import track_state

    timeline = dataset.timeline
    window = [p for p in dataset.tracks["T0001"] if timeline.hhmm(p.ts) in {"10:20", "10:25", "10:30", "10:35"}]
    assert len(window) == 4
    state = track_state(window, window[-1].ts, cfg)
    assert state.stationary
    assert state.speed_mps == 0.0


def test_distance_to_base_series_is_populated(analyses):
    for analysis in analyses:
        for state in analysis.track_states.values():
            assert set(state.dist_to_base_m) == {"t-60", "t-30", "now"}
            assert state.dist_to_base_m["now"] is not None


def test_no_future_leakage(dataset, cfg):
    """The as-of rule: state at t never uses a fix after t."""
    from app.kinematics.velocity import track_state

    points = dataset.tracks["T0001"]
    cutoff = points[10].ts
    visible = Timeline.as_of(points, cutoff, key=lambda p: p.ts)
    assert len(visible) == 11
    assert all(p.ts <= cutoff for p in visible)
    state = track_state(visible, cutoff, cfg)
    assert state.last_fix_ts == cutoff


def test_timeline_rejects_loose_time_strings(cfg):
    timeline = Timeline.from_config(cfg)
    for bad in ("9:05", "0905", "25:00", "09:60", "", "noon"):
        with pytest.raises(TimeFormatError):
            timeline.at(bad)


def test_timeline_round_trips_local_time(cfg):
    timeline = Timeline.from_config(cfg)
    ts = timeline.at("14:10")
    assert timeline.hhmm(ts) == "14:10"
    assert ts.utcoffset() == timedelta(0)  # stored as UTC


# --------------------------------------------------------------------------- #
# Zone geometry
# --------------------------------------------------------------------------- #


def _state(track_id: str, east: float, north: float, ve: float, vn: float) -> TrackState:
    from datetime import datetime, timezone

    now = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)
    return TrackState(
        track_id=track_id,
        as_of_ts=now,
        pos=ENU(e_m=east, n_m=north),
        pos_geo=LatLon(lat=0.0, lon=0.0),
        vel_enu=[ve, vn],
        speed_mps=math.hypot(ve, vn),
        heading_deg=(math.degrees(math.atan2(ve, vn)) + 360) % 360,
        stationary=False,
        last_fix_ts=now,
        dist_to_base_m={"t-60": None, "t-30": None, "now": math.hypot(east, north)},
    )


def test_cpa_and_eta_for_a_head_on_approach(cfg, dataset):
    """PLAN 10.1: 1000 m south of a zone, 5 m/s north, R=250 -> ETA 150 s, CPA 0."""
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -1000.0, 0.0, 5.0)
    histories = {"TX": np.array([[0.0, -1300.0], [0.0, -1200.0], [0.0, -1100.0], [0.0, -1000.0]])}

    result = assess_zones({"TX": state}, histories, [zone], cfg, state.as_of_ts)["TX"][0]
    assert math.isclose(result.dist_now_m, 1000.0, abs_tol=0.1)
    assert math.isclose(result.eta_entry_s, 150.0, abs_tol=0.1)
    assert math.isclose(result.cpa_m, 0.0, abs_tol=0.1)
    assert math.isclose(result.closing_speed_mps, 5.0, abs_tol=0.01)
    assert result.approach_conf > 0.9  # heading straight at it, closing every step
    # 1000 m out with R+B = 1000 m puts it exactly on the buffer edge.
    assert not result.inside_zone
    assert result.inside_buffer


def test_a_vehicle_moving_away_has_no_eta(cfg, dataset):
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -2000.0, 0.0, -5.0)
    histories = {"TX": np.array([[0.0, -1700.0], [0.0, -1800.0], [0.0, -1900.0], [0.0, -2000.0]])}
    result = assess_zones({"TX": state}, histories, [zone], cfg, state.as_of_ts)["TX"][0]
    assert result.eta_entry_s is None
    assert result.closing_speed_mps < 0
    assert result.approach_conf < 0.3


def test_inside_zone_reports_zero_eta(cfg, dataset):
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 100.0, 0.0, 1.0, 0.0)
    result = assess_zones({"TX": state}, {}, [zone], cfg, state.as_of_ts)["TX"][0]
    assert result.inside_zone
    assert result.eta_entry_s == 0.0


def test_stationary_vehicle_has_cpa_equal_to_range(cfg, dataset):
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -1000.0, 0.0, 0.0)
    result = assess_zones({"TX": state}, {}, [zone], cfg, state.as_of_ts)["TX"][0]
    assert math.isclose(result.cpa_m, 1000.0, abs_tol=0.1)
    assert result.eta_entry_s is None


def test_most_likely_destination_needs_confidence(cfg, dataset):
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -1000.0, 0.0, 5.0)
    histories = {"TX": np.array([[0.0, -1300.0], [0.0, -1200.0], [0.0, -1100.0], [0.0, -1000.0]])}
    items = assess_zones({"TX": state}, histories, [zone], cfg, state.as_of_ts)["TX"]
    assert most_likely_destination(items, cfg) == zone.zone_id

    away = _state("TY", 0.0, -2000.0, 0.0, -5.0)
    items_away = assess_zones({"TY": away}, {}, [zone], cfg, away.as_of_ts)["TY"]
    assert most_likely_destination(items_away, cfg) is None


# --------------------------------------------------------------------------- #
# Rule baseline
# --------------------------------------------------------------------------- #


def test_alert_when_inside_a_zone(cfg, dataset):
    engine = RuleEngine(cfg, {z.zone_id: z.name for z in dataset.zones})
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 100.0, 0.0, 1.0, 0.0)
    items = assess_zones({"TX": state}, {}, [zone], cfg, state.as_of_ts)["TX"]
    verdict = engine.evaluate(state, items)
    assert verdict.level is Level.ALERT
    assert any("inside" in reason for reason in verdict.reasons)


def test_alert_on_imminent_entry(cfg, dataset):
    engine = RuleEngine(cfg, {z.zone_id: z.name for z in dataset.zones})
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    # 1250 m out at 5 m/s: 200 s to the radius, inside the 10 minute ALERT window.
    state = _state("TX", 0.0, -1250.0, 0.0, 5.0)
    histories = {"TX": np.array([[0.0, -1550.0], [0.0, -1450.0], [0.0, -1350.0], [0.0, -1250.0]])}
    items = assess_zones({"TX": state}, histories, [zone], cfg, state.as_of_ts)["TX"]
    verdict = engine.evaluate(state, items)
    assert verdict.level is Level.ALERT
    assert any("ETA" in reason for reason in verdict.reasons)
    assert verdict.priority > 0.5


def test_clear_when_far_and_stationary(cfg, dataset):
    engine = RuleEngine(cfg, {z.zone_id: z.name for z in dataset.zones})
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -8000.0, 0.0, 0.0)
    items = assess_zones({"TX": state}, {}, [zone], cfg, state.as_of_ts)["TX"]
    verdict = engine.evaluate(state, items)
    assert verdict.level is Level.CLEAR
    assert verdict.reasons  # it still explains itself


def test_a_report_can_raise_but_never_lower(cfg, dataset):
    engine = RuleEngine(cfg, {z.zone_id: z.name for z in dataset.zones})
    zone = dataset.zones[0].model_copy(
        update={"center_enu": ENU(e_m=0.0, n_m=0.0), "radius_m": 250.0, "buffer_m": 750.0}
    )
    state = _state("TX", 0.0, -8000.0, 0.0, 0.0)
    items = assess_zones({"TX": state}, {}, [zone], cfg, state.as_of_ts)["TX"]

    raised = engine.evaluate(
        state, items, report_support=ReportSupport(cap=Level.WATCH, report_ids=("R001",), note="official sighting")
    )
    assert raised.level is Level.WATCH
    assert "R001" in raised.evidence

    # An inside-zone vehicle stays ALERT no matter what a report caps at.
    inside = _state("TY", 100.0, 0.0, 1.0, 0.0)
    inside_items = assess_zones({"TY": inside}, {}, [zone], cfg, inside.as_of_ts)["TY"]
    held = engine.evaluate(
        inside, inside_items, report_support=ReportSupport(cap=Level.CLEAR, report_ids=("R002",))
    )
    assert held.level is Level.ALERT


def test_hysteresis_upgrades_at_once_and_downgrades_slowly(cfg):
    hysteresis = Hysteresis(cfg.warning.downgrade_consecutive)
    assert hysteresis.apply("T1", Level.WATCH) is Level.WATCH
    assert hysteresis.apply("T1", Level.ALERT) is Level.ALERT      # up immediately
    assert hysteresis.apply("T1", Level.CLEAR) is Level.ALERT      # first quiet tick held
    assert hysteresis.apply("T1", Level.CLEAR) is Level.CLEAR      # second releases it


def test_level_ordering_and_highest():
    assert Level.ALERT.rank > Level.WATCH.rank > Level.CLEAR.rank
    assert Level.highest(Level.CLEAR, Level.ALERT) is Level.ALERT
    assert Level.highest(None, Level.WATCH) is Level.WATCH
    assert Level.highest() is Level.CLEAR


def test_alerts_are_ordered_and_stamped(analyses, cfg):
    for analysis in analyses:
        ranks = [(-a.level.rank, -a.priority) for a in analysis.alerts]
        assert ranks == sorted(ranks)
        for alert in analysis.alerts:
            assert alert.rules_version == cfg.rules_version
            assert alert.status == "open"
            assert alert.level is not Level.CLEAR


# --- trajectory profile (app/kinematics/profile.py) ------------------------- #


def _straight_track(speeds_mps: list[float], step_s: float = 300.0) -> list[TrackPoint]:
    """A track heading due east, one step per entry in `speeds_mps`."""
    from datetime import datetime, timedelta, timezone

    t0 = datetime(2024, 5, 1, 12, 0, tzinfo=timezone.utc)
    ref = SourceRefModel(file_name="synthetic", file_sha256="0" * 64, record_key="T0001")
    points, e = [], 0.0
    for i, speed in enumerate([0.0, *speeds_mps]):
        e += speed * step_s
        points.append(
            TrackPoint(
                track_id="T0001",
                ts=t0 + timedelta(seconds=i * step_s),
                lat=39.9,
                lon=32.8,
                e_m=e,
                n_m=0.0,
                source_ref=ref,
            )
        )
    return points


def test_track_profile_measures_the_whole_history():
    profile = track_profile(_straight_track([10.0, 10.0, 10.0, 10.0]))
    assert profile is not None
    assert profile.n_steps == 4
    assert profile.speed_mean_mps == pytest.approx(10.0)
    assert profile.speed_max_mps == pytest.approx(10.0)
    assert profile.moving_fraction == 1.0
    assert profile.total_distance_m == pytest.approx(12000.0)


def test_track_profile_separates_a_waiting_vehicle_from_a_steady_one():
    """Same mean speed, very different behaviour - this is what the agent reads."""
    steady = track_profile(_straight_track([2.0] * 8))
    waited = track_profile(_straight_track([0.0] * 6 + [8.0, 8.0]))
    assert steady.speed_mean_mps == pytest.approx(waited.speed_mean_mps)
    assert waited.moving_fraction < steady.moving_fraction
    assert waited.speed_max_mps > steady.speed_max_mps


def test_track_profile_needs_enough_fixes():
    assert track_profile(_straight_track([5.0])) is None
