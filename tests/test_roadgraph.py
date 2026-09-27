"""The routing graph and the HMM that runs on it (app/roads/graph, graphmatch)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta

import pytest

from app.roads.graph import RoadGraph
from app.roads.graphmatch import GraphMatchParams, match_on_graph
from goru_core.schemas import TrackPoint

SOURCE = {"file_name": "tracks.csv", "file_sha256": "0" * 64, "record_key": "x"}
T0 = datetime(2026, 9, 26, 10, 0)


def grid(spacing: float = 200.0, size: int = 4) -> RoadGraph:
    """A street grid: `size` x `size` nodes, every neighbour joined."""
    nodes = [[c * spacing, r * spacing] for r in range(size) for c in range(size)]
    index = lambda r, c: r * size + c  # noqa: E731
    edges, ways = [], []
    for r in range(size):
        for c in range(size):
            for dr, dc in ((0, 1), (1, 0)):
                nr, nc = r + dr, c + dc
                if nr >= size or nc >= size:
                    continue
                ways.append([f"{'Cadde' if dr == 0 else 'Sokak'} {r if dr == 0 else c}", "residential", 0])
                edges.append([index(r, c), index(nr, nc), len(ways) - 1, spacing])
    return RoadGraph({"nodes": nodes, "edges": edges, "ways": ways})


def _points(coords: list[tuple[float, float]]) -> list[TrackPoint]:
    return [
        TrackPoint(
            track_id="T0001",
            ts=T0 + timedelta(minutes=5 * i),
            e_m=e,
            n_m=n,
            lat=39.9 + n / 111_000,
            lon=32.8 + e / 85_000,
            source_ref=SOURCE,
        )
        for i, (e, n) in enumerate(coords)
    ]


# --- the router ------------------------------------------------------------ #


def test_route_distance_follows_the_streets_not_the_crow():
    """The whole reason for the graph: a diagonal is two sides of a block."""
    graph = grid()
    start = graph.candidates(0, 10, 30, 4)[0]
    goal = graph.candidates(200, 210, 30, 4)[0]

    (distance,) = graph.route(start, [goal], budget_m=2000)
    straight = math.hypot(200, 200)

    assert distance == pytest.approx(400, abs=30), "along two edges"
    assert distance > straight, "a car cannot cut the corner"


def test_route_returns_none_past_its_budget():
    graph = grid()
    start = graph.candidates(0, 0, 30, 4)[0]
    goal = graph.candidates(600, 600, 30, 4)[0]

    assert graph.route(start, [goal], budget_m=100) == [None]
    assert graph.route(start, [goal], budget_m=3000)[0] is not None


def test_path_runs_through_the_junctions_between_two_points():
    graph = grid()
    start = graph.candidates(0, 10, 30, 4)[0]
    goal = graph.candidates(400, 10, 30, 4)[0]

    path = graph.path(start, goal, budget_m=2000)

    assert len(path) >= 3, "endpoints plus the junctions it passed"
    assert path[0] == (start.x, start.y)
    assert path[-1] == (goal.x, goal.y)


# --- the matcher ----------------------------------------------------------- #


def test_matches_along_a_street_and_routes_between_the_fixes():
    graph = grid()
    match = match_on_graph(_points([(20, 0), (180, 0), (380, 0)]), graph, with_legs=True)

    assert match is not None
    assert match.method == "graph"
    assert match.matched_fraction == 1.0
    assert len(match.legs) == 2
    assert match.route_length_m > 0


def test_legs_cost_extra_so_they_are_off_unless_asked_for():
    graph = grid()
    match = match_on_graph(_points([(20, 0), (180, 0)]), graph)

    assert match is not None and match.legs == []
    assert match.route_length_m == 0.0


def test_prefers_the_reachable_candidate_over_the_merely_near_one():
    """What route distance buys over straight-line distance.

    Two parallel streets 40 m apart with no connection between them. A fix
    sitting between them is nearer the disconnected one, but the vehicle came
    along the connected one and could not have crossed.
    """
    nodes = [[0, 0], [400, 0], [0, 40], [400, 40]]
    ways = [["Bağlı Sokak", "residential", 0], ["Kopuk Sokak", "residential", 0]]
    graph = RoadGraph(
        {"nodes": nodes, "edges": [[0, 1, 0, 400.0], [2, 3, 1, 400.0]], "ways": ways}
    )
    # Starts unambiguously on the connected street, then drifts to the midline.
    match = match_on_graph(_points([(20, 0), (200, 19), (380, 19)]), graph)

    assert match is not None
    assert match.roads == ["Bağlı Sokak"]


def test_an_unreachable_fix_starts_a_new_run_rather_than_being_forced():
    graph = grid()
    # The middle fix is far outside the grid: no candidate, no route.
    match = match_on_graph(_points([(20, 0), (9000, 9000), (380, 0)]), graph)

    assert match is not None
    assert [fix.matched for fix in match.fixes] == [True, False, True]


def test_a_fix_past_the_gate_is_left_unmatched():
    graph = grid()
    match = match_on_graph(
        _points([(20, 0), (100, 100), (380, 0)]), graph, params=GraphMatchParams(gate_m=25)
    )

    assert match is not None
    assert match.fixes[1].matched is False
    assert match.fixes[1].road_name is None


def test_an_empty_track_has_nothing_to_match():
    assert match_on_graph([], grid()) is None
