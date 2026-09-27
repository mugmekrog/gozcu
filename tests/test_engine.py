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
from app.kinematics.behaviour import BehaviourProfile
from app.kinematics.profile import track_profile
from app.perception.postprocess import class_agnostic_nms
from app.risk.base import base_target
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


def _engine(cfg, dataset) -> RuleEngine:
    return RuleEngine(cfg, {z.zone_id: z.name for z in dataset.zones})


def _base(cfg, dataset, state, histories=None):
    """The base assessment: Merkez Us as a target, radius = critical ring."""
    target = base_target(dataset.base, dataset.base_name, cfg)
    return assess_zones({state.track_id: state}, histories or {}, [target], cfg, state.as_of_ts)[
        state.track_id
    ][0]


def _behaviour(state, **overrides) -> BehaviourProfile:
    """A quiet record: nothing closed, no sweep, no stops - override what the case needs."""
    range_m = math.hypot(state.pos.e_m, state.pos.n_m)
    values = dict(
        range_m=range_m,
        closest_m=range_m,
        closest_min_ago=0.0,
        closing_m={30: 0.0, 60: 0.0, 120: 0.0},
        heading_to_base_cos=None,
        sweep_deg=0.0,
        range_spread=0.0,
        stop_spells=0,
        loiter_min=0.0,
        record_min=120.0,
        came_in_from_m=None,
    )
    values.update(overrides)
    return BehaviourProfile(**values)


def _evaluate(cfg, dataset, state, *, histories=None, **behaviour):
    return _engine(cfg, dataset).evaluate(
        state,
        _base(cfg, dataset, state, histories),
        _behaviour(state, **behaviour),
        sector_id=dataset.zones[0].zone_id,
    )


def test_alert_inside_the_critical_ring(cfg, dataset):
    verdict = _evaluate(cfg, dataset, _state("TX", 0.0, 800.0, 0.0, 0.0))
    assert verdict.level is Level.ALERT
    assert (verdict.category, verdict.likelihood) == ("approach", "high")
    assert [s.kind for s in verdict.signals] == ["inside_critical"]


def test_alert_on_imminent_entry_to_the_critical_ring(cfg, dataset):
    # 1250 m south at 5 m/s north: 50 s to the 1 km ring, inside the 10 minute ALERT window.
    state = _state("TX", 0.0, -1250.0, 0.0, 5.0)
    histories = {"TX": np.array([[0.0, -1550.0], [0.0, -1450.0], [0.0, -1350.0], [0.0, -1250.0]])}
    verdict = _evaluate(cfg, dataset, state, histories=histories)
    assert verdict.level is Level.ALERT
    assert "imminent_entry" in [s.kind for s in verdict.signals]
    assert verdict.priority > 0.5


def test_a_sustained_approach_far_out_is_a_possible_threat(cfg, dataset):
    # 3.5 km out, closed 3 km in the last hour pointing at the base - but no entry soon.
    state = _state("TX", 0.0, 3500.0, 0.0, 0.0)
    verdict = _evaluate(cfg, dataset, state, closing_m={30: 1500.0, 60: 3000.0, 120: 4000.0}, heading_to_base_cos=0.95)
    assert verdict.level is Level.WATCH
    assert (verdict.category, verdict.likelihood) == ("approach", "possible")
    assert [s.kind for s in verdict.signals] == ["sustained_approach"]
    assert verdict.zone_id == dataset.zones[0].zone_id  # the observation sector, not a target


def test_a_heavy_vehicle_approaching_inside_the_warning_ring_is_high(cfg, dataset):
    state = _state("TX", 0.0, 1700.0, 0.0, 0.0).model_copy(update={"class_hint": "truck"})
    verdict = _evaluate(cfg, dataset, state, closing_m={30: 1500.0, 60: 3000.0, 120: 4000.0}, heading_to_base_cos=0.95)
    assert verdict.level is Level.ALERT
    assert verdict.likelihood == "high"


def test_coming_inside_the_critical_ring_and_pulling_back_is_possible_surveillance(cfg, dataset):
    state = _state("TX", 0.0, 2600.0, 0.0, 0.0)
    verdict = _evaluate(cfg, dataset, state, closest_m=490.0, closest_min_ago=10.0, came_in_from_m=3500.0)
    assert verdict.level is Level.WATCH
    assert (verdict.category, verdict.likelihood) == ("surveillance", "possible")
    assert [s.kind for s in verdict.signals] == ["probe"]


def test_leaving_from_near_the_base_is_not_a_probe(cfg, dataset):
    # Its record starts 500 m out and it drives away: a departure, not a probe.
    state = _state("TX", 0.0, 4500.0, 0.0, 0.0)
    verdict = _evaluate(cfg, dataset, state, closest_m=500.0, closest_min_ago=120.0, came_in_from_m=None)
    assert "probe" not in [s.kind for s in verdict.signals]


def test_clear_when_far_and_quiet(cfg, dataset):
    verdict = _evaluate(cfg, dataset, _state("TX", 0.0, -8000.0, 0.0, 0.0))
    assert verdict.level is Level.CLEAR
    assert verdict.category is None and verdict.signals == ()
    assert verdict.reasons  # it still explains itself


def test_a_report_can_raise_but_never_lower(cfg, dataset):
    engine = _engine(cfg, dataset)
    far = _state("TX", 0.0, -8000.0, 0.0, 0.0)
    raised = engine.evaluate(
        far,
        _base(cfg, dataset, far),
        _behaviour(far),
        sector_id=dataset.zones[0].zone_id,
        report_support=ReportSupport(cap=Level.WATCH, report_ids=("R001",), note="official sighting"),
    )
    assert raised.level is Level.WATCH
    assert "R001" in raised.evidence

    inside = _state("TY", 0.0, 800.0, 0.0, 0.0)
    held = engine.evaluate(
        inside,
        _base(cfg, dataset, inside),
        _behaviour(inside),
        sector_id=dataset.zones[0].zone_id,
        report_support=ReportSupport(cap=Level.CLEAR, report_ids=("R002",)),
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


def _walk(offsets: list[tuple[float, float]], step_s: float = 300.0) -> list[TrackPoint]:
    """A track visiting each (e_m, n_m) in turn, one step apart."""
    from datetime import datetime, timedelta, timezone

    t0 = datetime(2024, 5, 1, 12, 0, tzinfo=timezone.utc)
    ref = SourceRefModel(file_name="synthetic", file_sha256="0" * 64, record_key="T0002")
    return [
        TrackPoint(
            track_id="T0002",
            ts=t0 + timedelta(seconds=i * step_s),
            lat=39.9,
            lon=32.8,
            e_m=e,
            n_m=n,
            source_ref=ref,
        )
        for i, (e, n) in enumerate(offsets)
    ]


def test_profile_stop_structure_separates_one_long_wait_from_many_short_ones():
    one_long = track_profile(_straight_track([0.0] * 6 + [5.0] * 6))
    many_short = track_profile(_straight_track([0.0, 5.0] * 6))
    assert one_long.moving_fraction == pytest.approx(many_short.moving_fraction)
    assert one_long.stop_count == 1
    assert many_short.stop_count > one_long.stop_count
    assert one_long.longest_stop_min > many_short.longest_stop_min


def test_profile_straightness_separates_a_beeline_from_a_wander():
    beeline = track_profile(_walk([(0, 0), (1000, 0), (2000, 0), (3000, 0)]))
    wander = track_profile(_walk([(0, 0), (1000, 0), (1000, 1000), (0, 1000)]))
    assert beeline.straightness == pytest.approx(1.0)
    assert wander.straightness < 0.5
    assert wander.heading_change_deg > beeline.heading_change_deg


def test_profile_counts_a_doubling_back_as_a_reversal():
    there_and_back = track_profile(_walk([(0, 0), (1000, 0), (2000, 0), (1000, 0), (0, 0)]))
    assert there_and_back.reversals == 1


def test_profile_reads_a_sustained_approach_to_base():
    """Base is the ENU origin, so the range is just the distance from (0, 0)."""
    closing = track_profile(_walk([(5000, 0), (4000, 0), (3000, 0), (2000, 0), (1000, 0)]))
    assert closing.base_closing_rate_mps > 0  # positive = closing
    assert closing.closing_step_fraction == pytest.approx(1.0)
    assert closing.base_range_start_m == pytest.approx(5000.0)
    assert closing.base_range_min_m == pytest.approx(1000.0)

    leaving = track_profile(_walk([(1000, 0), (2000, 0), (3000, 0), (4000, 0)]))
    assert leaving.base_closing_rate_mps < 0
    assert leaving.closing_step_fraction == pytest.approx(0.0)


def test_behaviour_flags_are_silent_on_ordinary_stop_and_go():
    """The median track in the shipped day moves ~25% of the window and reverses
    once. Thresholds are calibrated so that shape earns no flag."""
    ordinary = track_profile(_straight_track([0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 0.0]))
    assert ordinary.behaviour == []


def test_waited_then_moved_needs_a_long_halt_and_a_real_burst():
    waited = track_profile(_straight_track([0.0] * 20 + [20.0, 20.0]))
    assert "waited_then_moved" in waited.behaviour


def test_sustained_approach_needs_most_steps_to_close_the_range():
    closing = track_profile(_walk([(6000 - 500 * i, 0.0) for i in range(11)]))
    assert "sustained_approach_to_base" in closing.behaviour
    # The same distance covered away from base is not an approach.
    leaving = track_profile(_walk([(1000 + 500 * i, 0.0) for i in range(11)]))
    assert "sustained_approach_to_base" not in leaving.behaviour


def test_a_single_reversal_is_not_yet_doubled_back():
    once = track_profile(_walk([(0, 0), (1000, 0), (2000, 0), (1000, 0), (0, 0)]))
    assert once.reversals == 1
    assert "doubled_back" not in once.behaviour
