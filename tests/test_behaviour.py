"""The whole-record behaviour profile around the protected base.

Team decision (2026-09-27): Merkez Us is the protected asset and the eight zones
are observation sectors. The brief says to read speed and direction from the
whole two-hour record, and that vehicles turn, stop and circle the base; these
tests pin that reading. Synthetic tracks carry hand-computed expectations; the
real tracks are the dataset's clearest examples of each behaviour.
"""

from __future__ import annotations

import math
from datetime import timedelta

import pytest

from goru_core.schemas import SourceRefModel, TrackPoint
from app.kinematics.behaviour import behaviour_profile

STEP_MIN = 5
SOURCE = SourceRefModel(file_name="tracks.csv", file_sha256="0" * 64, record_key="synthetic")


def _track(dataset, positions: list[tuple[float, float]]) -> list[TrackPoint]:
    """A synthetic track: one fix every five minutes at the given ENU positions."""
    start = dataset.timeline.at("10:00")
    points = []
    for index, (east, north) in enumerate(positions):
        lat, lon = dataset.frame.to_latlon(east, north)
        points.append(
            TrackPoint(
                track_id="TSYN",
                ts=start + timedelta(minutes=STEP_MIN * index),
                lat=lat,
                lon=lon,
                e_m=east,
                n_m=north,
                source_ref=SOURCE,
            )
        )
    return points


def _profile(dataset, cfg, points, as_of=None):
    return behaviour_profile(points, as_of or points[-1].ts, cfg)


def test_a_straight_run_at_the_base(dataset, cfg):
    # 300 m every five minutes (1 m/s) from 9 km north, ending 1.8 km out.
    points = _track(dataset, [(0.0, 9000.0 - 300.0 * k) for k in range(25)])
    profile = _profile(dataset, cfg, points)
    assert profile.range_m == pytest.approx(1800.0)
    assert profile.closing_m == {30: pytest.approx(1800.0), 60: pytest.approx(3600.0), 120: pytest.approx(7200.0)}
    assert profile.heading_to_base_cos == pytest.approx(1.0)
    assert profile.closest_m == pytest.approx(1800.0)
    assert profile.closest_min_ago == 0
    assert profile.sweep_deg == pytest.approx(0.0, abs=1e-6)
    assert profile.stop_spells == 0 and profile.loiter_min == 0


def test_circling_the_base_at_a_steady_range(dataset, cfg):
    # 1.6 km out, 10 degrees of bearing every five minutes: 240 degrees in two hours.
    points = _track(
        dataset,
        [(1600.0 * math.sin(math.radians(10 * k)), 1600.0 * math.cos(math.radians(10 * k))) for k in range(25)],
    )
    profile = _profile(dataset, cfg, points)
    assert profile.sweep_deg == pytest.approx(240.0)
    assert profile.range_spread == pytest.approx(0.0, abs=1e-9)
    assert profile.closing_m[60] == pytest.approx(0.0, abs=1e-6)
    assert profile.stop_spells == 0


def test_parked_near_the_base_for_the_whole_record(dataset, cfg):
    # 1.6 km north, wandering 5 m either side of the spot - the GPS jitter PLAN 2.6 measured.
    points = _track(dataset, [(5.0 if k % 2 else -5.0, 1600.0) for k in range(25)])
    profile = _profile(dataset, cfg, points)
    assert profile.stop_spells == 1
    assert profile.loiter_min == 120
    assert profile.heading_to_base_cos is None  # it did not move, so it has no heading


def test_in_to_500_m_and_back_out(dataset, cfg):
    # In at 350 m a step to 500 m (fix 10), then out at 150 m a step to 2.6 km.
    inbound = [(0.0, 4000.0 - 350.0 * k) for k in range(11)]
    outbound = [(0.0, 500.0 + 150.0 * k) for k in range(1, 15)]
    profile = _profile(dataset, cfg, _track(dataset, inbound + outbound))
    assert profile.closest_m == pytest.approx(500.0)
    assert profile.closest_min_ago == 70
    assert profile.range_m == pytest.approx(2600.0)
    assert profile.closing_m[60] < 0  # it is leaving now


def test_a_record_that_starts_near_the_base_did_not_come_in(dataset, cfg):
    # Starts 500 m out and drives away: its closest point is its first fix.
    profile = _profile(dataset, cfg, _track(dataset, [(0.0, 500.0 + 200.0 * k) for k in range(25)]))
    assert profile.closest_m == pytest.approx(500.0)
    assert profile.came_in_from_m is None


def test_a_vehicle_that_came_in_remembers_how_far_out_it_started(dataset, cfg):
    inbound = [(0.0, 4000.0 - 350.0 * k) for k in range(11)]
    outbound = [(0.0, 500.0 + 150.0 * k) for k in range(1, 15)]
    profile = _profile(dataset, cfg, _track(dataset, inbound + outbound))
    assert profile.came_in_from_m == pytest.approx(4000.0)


# --------------------------------------------------------------------------- #
# Acceptance on the real tracks. Expected figures come from an independent probe
# over tracks.csv (session log, 2026-09-27), not from this module.
# --------------------------------------------------------------------------- #


def _real(dataset, cfg, track_id):
    points = dataset.tracks[track_id]
    return behaviour_profile(points, points[-1].ts, cfg)


def test_t0146_circles_the_base_at_a_steady_range(dataset, cfg):
    profile = _real(dataset, cfg, "T0146")
    assert profile.sweep_deg == pytest.approx(278, abs=2)
    assert profile.range_m == pytest.approx(1620, abs=20)
    assert profile.range_spread <= 0.35


def test_t0003_came_inside_a_kilometre_and_pulled_back(dataset, cfg):
    profile = _real(dataset, cfg, "T0003")
    assert profile.closest_m == pytest.approx(488, abs=2)
    assert profile.closest_min_ago == 10
    assert profile.range_m == pytest.approx(2610, abs=20)


def test_t0069_ran_five_kilometres_at_the_base_in_an_hour(dataset, cfg):
    profile = _real(dataset, cfg, "T0069")
    assert profile.closing_m[60] == pytest.approx(5270, abs=20)
    assert profile.range_m == pytest.approx(1560, abs=20)
    assert profile.heading_to_base_cos >= 0.7


def test_t0026_sat_still_1_6_km_out_for_two_hours(dataset, cfg):
    profile = _real(dataset, cfg, "T0026")
    assert profile.loiter_min == 120
    assert profile.range_m == pytest.approx(1600, abs=20)


def test_fixes_after_the_clock_are_never_read(dataset, cfg):
    points = _track(dataset, [(0.0, 9000.0 - 300.0 * k) for k in range(25)])
    profile = _profile(dataset, cfg, points, as_of=points[12].ts)
    assert profile.range_m == pytest.approx(9000.0 - 300.0 * 12)
    assert profile.closing_m[120] is None  # only an hour of record exists at that clock
