"""Map matching against the baked road network (app/roads)."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.roads.mapmatch import MatchParams, match_track
from app.roads.network import RoadNetwork, RoadSegment
from goru_core.schemas import TrackPoint

SOURCE = {"file_name": "tracks.csv", "file_sha256": "0" * 64, "record_key": "x"}
T0 = datetime(2026, 9, 26, 10, 0)


def _points(coords: list[tuple[float, float]], step_min: int = 5) -> list[TrackPoint]:
    return [
        TrackPoint(
            track_id="T0001",
            ts=T0 + timedelta(minutes=step_min * i),
            e_m=e,
            n_m=n,
            lat=39.9 + n / 111_000,
            lon=32.8 + e / 85_000,
            source_ref=SOURCE,
        )
        for i, (e, n) in enumerate(coords)
    ]


def _straight_road(way_id: int, name: str, x: float, length: float = 400.0) -> list[RoadSegment]:
    """A north-south road at easting `x`, in 100 m segments."""
    steps = int(length // 100)
    return [
        RoadSegment(way_id, name, "minor", x, i * 100.0, x, (i + 1) * 100.0)
        for i in range(steps)
    ]


def test_snaps_fixes_to_the_road_beside_them():
    network = RoadNetwork(_straight_road(1, "Vatan Caddesi", 0.0))
    match = match_track(_points([(6, 20), (-5, 140), (8, 260)]), network)

    assert match is not None
    assert match.matched_fraction == 1.0
    assert match.roads == ["Vatan Caddesi"]
    # Snapped onto the road, not left where the raw fix was.
    assert all(fix.e_m == 0.0 for fix in match.fixes)
    assert match.median_offset_m <= 8


def test_leaves_a_fix_past_the_gate_unmatched_rather_than_guessing():
    """A name for a fix 200 m from any road would be a fabrication."""
    network = RoadNetwork(_straight_road(1, "Vatan Caddesi", 0.0))
    match = match_track(_points([(5, 100), (200, 200), (5, 300)]), network)

    assert match is not None
    assert [fix.matched for fix in match.fixes] == [True, False, True]
    assert match.n_matched == 2
    assert match.matched_fraction == 0.67
    # The unmatched fix carries no road and no snapped position.
    assert match.fixes[1].road_name is None
    assert match.fixes[1].e_m is None


def test_holds_one_road_rather_than_flickering_between_parallel_streets():
    """What the HMM buys over a per-fix nearest snap.

    Two streets 22 m apart, and a track that wobbles just across the midline.
    Nearest-snap alternates; the same-way term holds the run on one of them.
    """
    network = RoadNetwork(_straight_road(1, "Birinci Sokak", 0.0) + _straight_road(2, "İkinci Sokak", 22.0))
    match = match_track(_points([(2, 20), (13, 120), (9, 220), (14, 320)]), network)

    assert match is not None
    assert match.matched_fraction == 1.0
    assert match.roads == ["Birinci Sokak"], "one street for the whole run"


def test_reports_the_road_bearing_so_a_reader_knows_where_it_could_go():
    network = RoadNetwork(_straight_road(1, "Vatan Caddesi", 0.0))
    match = match_track(_points([(4, 50), (4, 150)]), network)

    assert match is not None
    assert match.fixes[0].road_bearing_deg == pytest.approx(0.0, abs=0.1)


def test_collapses_repeats_but_keeps_the_order_of_travel():
    network = RoadNetwork(
        _straight_road(1, "Birinci Sokak", 0.0) + _straight_road(2, "İkinci Sokak", 500.0)
    )
    match = match_track(_points([(0, 50), (0, 150), (500, 150), (500, 250), (0, 250)]), network)

    assert match is not None
    assert match.roads == ["Birinci Sokak", "İkinci Sokak", "Birinci Sokak"]


def test_no_road_anywhere_leaves_everything_unmatched():
    match = match_track(_points([(0, 0), (100, 100)]), RoadNetwork([]))

    assert match is not None
    assert match.matched_fraction == 0.0
    assert match.roads == []
    assert all(not fix.matched for fix in match.fixes)


def test_an_empty_track_has_nothing_to_match():
    assert match_track([], RoadNetwork(_straight_road(1, "Vatan Caddesi", 0.0))) is None


def test_the_gate_is_configurable():
    network = RoadNetwork(_straight_road(1, "Vatan Caddesi", 0.0))
    points = _points([(45, 100), (45, 200)])

    assert match_track(points, network).matched_fraction == 0.0
    wide = match_track(points, network, params=MatchParams(gate_m=60))
    assert wide is not None and wide.matched_fraction == 1.0
