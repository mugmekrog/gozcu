"""Map matching on the routing graph: the HMM as Newson & Krumm wrote it.

The geometry-only matcher next door approximates the transition term with the
straight-line distance between two candidates, because without topology there
is nothing else to measure. With a graph the term is the real one: how far a
vehicle would have had to *drive* between the two, against how far the two
fixes are apart. That is what separates a candidate on the near side of a
motorway from one on the far side, and it is why the two produce different
answers on the same fixes.

    emission   -(offset / sigma)^2 / 2          how far the fix is off the road
    transition -|route - straight| / beta       how implausible the drive is

The route distance also gives the thing the geometry matcher could never
produce: the path itself. Each pair of consecutive matched fixes the router can
join becomes a leg running along the streets between them, which is what turns
a scatter of snapped dots into a trajectory. A pair it cannot join leaves a gap
rather than a straight line through the buildings.
"""

from __future__ import annotations

import math
from typing import Sequence

from goru_core.schemas import MapMatch, RoadFix, RouteLeg, TrackPoint

from app.roads.graph import EdgePoint, RoadGraph

__all__ = ["match_on_graph", "GraphMatchParams"]


class GraphMatchParams:
    """Tuning. `budget` decides how hard the router tries before giving up."""

    __slots__ = (
        "sigma_m",
        "gate_m",
        "beta_m",
        "max_candidates",
        "budget_slack_m",
        "budget_cap_m",
        "near_field_m",
    )

    def __init__(
        self,
        sigma_m: float = 20.0,
        gate_m: float = 30.0,
        beta_m: float = 120.0,
        max_candidates: int = 6,
        budget_slack_m: float = 600.0,
        budget_cap_m: float = 9000.0,
        near_field_m: float = 50.0,
    ) -> None:
        self.sigma_m = sigma_m
        self.gate_m = gate_m
        self.beta_m = beta_m
        self.max_candidates = max_candidates
        self.budget_slack_m = budget_slack_m
        self.budget_cap_m = budget_cap_m
        self.near_field_m = near_field_m

    def budget_for(self, straight_m: float) -> float:
        """How far the router may look for a route covering `straight_m`.

        Twice the straight line plus slack: urban detours around blocks and
        one-way systems routinely cost that, and past it the pair is
        implausible anyway, which is the answer the matcher wants.
        """
        return min(self.budget_cap_m, straight_m * 2.0 + self.budget_slack_m)


def _emission(offset_m: float, params: GraphMatchParams) -> float:
    return -0.5 * (offset_m / params.sigma_m) ** 2


def match_on_graph(
    points: Sequence[TrackPoint],
    graph: RoadGraph,
    *,
    params: GraphMatchParams | None = None,
    with_legs: bool = False,
) -> MapMatch | None:
    """Match one track. `with_legs` reconstructs the driven path between fixes.

    The legs are for drawing and nothing else -- the engine's own answers and
    the LLM bundle use only the summary and the per-fix roads -- and they cost a
    second Dijkstra per pair. So they are off unless asked for, which is the
    difference between a 4-second test suite and a 48-second one.
    """
    params = params or GraphMatchParams()
    ordered = sorted(points, key=lambda p: p.ts)
    if not ordered:
        return None

    per_fix: list[list[EdgePoint]] = [
        graph.candidates(p.e_m, p.n_m, params.gate_m, params.max_candidates) for p in ordered
    ]

    scores: list[list[float]] = []
    back: list[list[int]] = []
    for i, candidates in enumerate(per_fix):
        if not candidates:
            scores.append([])
            back.append([])
            continue

        previous_candidates = per_fix[i - 1] if i else []
        previous_scores = scores[i - 1] if i and scores[i - 1] else []
        emissions = [_emission(c.offset_m, params) for c in candidates]

        if not previous_scores:
            scores.append(list(emissions))
            back.append([-1] * len(candidates))
            continue

        straight = math.hypot(
            ordered[i].e_m - ordered[i - 1].e_m, ordered[i].n_m - ordered[i - 1].n_m
        )
        budget = params.budget_for(straight)
        # A vehicle that has barely moved is the common case here -- the median
        # step in this data is 5 m -- and over a few tens of metres the drive
        # and the straight line cannot meaningfully differ. Routing those pairs
        # is most of the work for none of the information, so they take the
        # straight line between candidates instead.
        near_field = straight <= params.near_field_m

        row = [-math.inf] * len(candidates)
        row_back = [-1] * len(candidates)
        # One search per previous candidate, answering every current candidate
        # at once. That is what keeps a graph HMM affordable here.
        for j, previous in enumerate(previous_candidates):
            if j >= len(previous_scores):
                break
            distances = (
                [math.hypot(c.x - previous.x, c.y - previous.y) for c in candidates]
                if near_field
                else graph.route(previous, candidates, budget)
            )
            for k, route_m in enumerate(distances):
                if route_m is None:
                    continue
                total = previous_scores[j] - abs(route_m - straight) / params.beta_m + emissions[k]
                if total > row[k]:
                    row[k], row_back[k] = total, j

        # A fix no previous candidate could reach starts a new run rather than
        # being forced onto an unreachable road.
        for k, value in enumerate(row):
            if value == -math.inf:
                row[k], row_back[k] = emissions[k], -1
        scores.append(row)
        back.append(row_back)

    chosen: list[int | None] = [None] * len(ordered)
    for i in range(len(ordered) - 1, -1, -1):
        if chosen[i] is not None or not scores[i]:
            continue
        index = max(range(len(scores[i])), key=lambda k: scores[i][k])
        j = i
        while j >= 0 and index >= 0 and scores[j]:
            chosen[j] = index
            index = back[j][index]
            j -= 1

    fixes: list[RoadFix] = []
    picked: list[EdgePoint | None] = []
    for i, point in enumerate(ordered):
        index = chosen[i]
        if index is None or not per_fix[i]:
            fixes.append(RoadFix(ts=point.ts, matched=False))
            picked.append(None)
            continue
        candidate = per_fix[i][index]
        name, road_class, _oneway = graph.way_of(candidate.edge)
        picked.append(candidate)
        fixes.append(
            RoadFix(
                ts=point.ts,
                matched=True,
                road_name=name,
                road_class=road_class,
                e_m=round(candidate.x, 1),
                n_m=round(candidate.y, 1),
                offset_m=round(candidate.offset_m, 1),
                road_bearing_deg=round(graph.bearing_of(candidate.edge), 1),
            )
        )

    legs: list[RouteLeg] = []
    total_route = 0.0
    for i in range(len(picked) - 1 if with_legs else 0):
        start, goal = picked[i], picked[i + 1]
        if start is None or goal is None:
            continue
        straight = math.hypot(
            ordered[i + 1].e_m - ordered[i].e_m, ordered[i + 1].n_m - ordered[i].n_m
        )
        path = graph.path(start, goal, params.budget_for(straight))
        if len(path) < 2:
            continue
        length = sum(math.dist(a, b) for a, b in zip(path, path[1:]))
        total_route += length
        legs.append(
            RouteLeg(
                from_index=i,
                length_m=round(length, 1),
                points=[[round(x, 1), round(y, 1)] for x, y in path],
            )
        )

    matched = [f for f in fixes if f.matched]
    offsets = sorted(f.offset_m or 0.0 for f in matched)
    roads: list[str] = []
    for fix in matched:
        if fix.road_name and (not roads or roads[-1] != fix.road_name):
            roads.append(fix.road_name)

    return MapMatch(
        n_fixes=len(ordered),
        n_matched=len(matched),
        matched_fraction=round(len(matched) / len(ordered), 2),
        median_offset_m=round(offsets[len(offsets) // 2], 1) if offsets else 0.0,
        roads=roads,
        method="graph",
        route_length_m=round(total_route, 1),
        legs=legs,
        fixes=fixes,
    )
