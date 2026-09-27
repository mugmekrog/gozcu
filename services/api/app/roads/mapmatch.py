"""Map matching: which road each fix is on, smoothed along the track.

A Viterbi pass over road candidates, in the shape Newson & Krumm describe, with
one deliberate substitution. Their transition term compares the *route* distance
between two candidates against the straight-line distance between the two fixes,
which needs a routing graph; we have geometry but no graph, so the term here is
the straight-line distance between the two candidates against the same figure.
That is a documented weakening -- it cannot tell a pair separated by a river
from a pair on the same street -- and it is what buys a matcher with no routing
server behind it.

What the HMM still earns without routing is the thing a per-fix nearest-road
snap gets wrong: consistency. A track running between two parallel streets
flickers between them under nearest-snap, and the same-way term here holds it on
one of them unless the evidence really moves.

READ THE MATCH RATE BEFORE TRUSTING A NAME. MEASURED on the shipped day: the
median fix sits 23 m from the nearest mapped road and the 90th percentile sits
141 m, and moving fixes are no closer than stationary ones. Tracks that were
driven on roads do not look like that. So this gates hard at `gate_m` and
reports `matched_fraction`; a fix past the gate stays unmatched rather than
being given the nearest street name.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

from goru_core.schemas import MapMatch, RoadFix, TrackPoint

from app.roads.network import RoadNetwork, RoadSegment

__all__ = ["match_track", "MatchParams"]


@dataclass(frozen=True, slots=True)
class MatchParams:
    """Tuning, all in metres.

    `sigma_m` is the assumed position error; `gate_m` is how far a candidate may
    sit before it is not a candidate at all; `beta_m` scales the transition
    penalty -- larger is more willing to accept a jump between roads.
    """

    sigma_m: float = 20.0
    gate_m: float = 30.0
    beta_m: float = 120.0
    #: Log-odds bonus for staying on the way the previous fix matched.
    same_way_bonus: float = 1.2
    #: Candidates kept per fix. Beyond a handful they never win.
    max_candidates: int = 8


@dataclass(slots=True)
class _Candidate:
    segment: RoadSegment
    x: float
    y: float
    distance_m: float


def _candidates(network: RoadNetwork, x: float, y: float, params: MatchParams) -> list[_Candidate]:
    found: list[_Candidate] = []
    for segment in network.near(x, y, params.gate_m):
        px, py, distance, _t = segment.project(x, y)
        if distance <= params.gate_m:
            found.append(_Candidate(segment, px, py, distance))
    found.sort(key=lambda c: c.distance_m)
    return found[: params.max_candidates]


def _emission(distance_m: float, params: MatchParams) -> float:
    """Log probability that a fix this far from a road is on it."""
    return -0.5 * (distance_m / params.sigma_m) ** 2


def _transition(
    previous: _Candidate, current: _Candidate, straight_m: float, params: MatchParams
) -> float:
    """Log probability of moving from one candidate to the next."""
    on_road = math.hypot(current.x - previous.x, current.y - previous.y)
    cost = abs(on_road - straight_m) / params.beta_m
    bonus = params.same_way_bonus if previous.segment.way_id == current.segment.way_id else 0.0
    return -cost + bonus


def match_track(
    points: Sequence[TrackPoint],
    network: RoadNetwork,
    *,
    params: MatchParams | None = None,
) -> MapMatch | None:
    """Map-match one track. None when there is nothing to match."""
    params = params or MatchParams()
    ordered = sorted(points, key=lambda p: p.ts)
    if not ordered:
        return None

    per_fix = [_candidates(network, p.e_m, p.n_m, params) for p in ordered]

    # Viterbi. Unmatchable fixes (no candidate inside the gate) break the chain
    # rather than ending it: the run after the gap starts fresh, which is the
    # honest reading -- we do not know how the vehicle got there.
    scores: list[list[float]] = []
    back: list[list[int]] = []
    for i, candidates in enumerate(per_fix):
        if not candidates:
            scores.append([])
            back.append([])
            continue
        previous_candidates = per_fix[i - 1] if i else []
        previous_scores = scores[i - 1] if i and scores[i - 1] else []
        row: list[float] = []
        row_back: list[int] = []
        straight = (
            math.hypot(ordered[i].e_m - ordered[i - 1].e_m, ordered[i].n_m - ordered[i - 1].n_m)
            if i
            else 0.0
        )
        for candidate in candidates:
            best_score, best_index = _emission(candidate.distance_m, params), -1
            for j, previous in enumerate(previous_candidates):
                if j >= len(previous_scores):
                    break
                total = (
                    previous_scores[j]
                    + _transition(previous, candidate, straight, params)
                    + _emission(candidate.distance_m, params)
                )
                if best_index < 0 or total > best_score:
                    best_score, best_index = total, j
            row.append(best_score)
            row_back.append(best_index)
        scores.append(row)
        back.append(row_back)

    chosen: list[int | None] = [None] * len(ordered)
    # Walk back from every run's end, so a track broken by a gap is still
    # smoothed within each of its runs.
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
    for i, point in enumerate(ordered):
        index = chosen[i]
        if index is None or not per_fix[i]:
            fixes.append(RoadFix(ts=point.ts, matched=False))
            continue
        candidate = per_fix[i][index]
        fixes.append(
            RoadFix(
                ts=point.ts,
                matched=True,
                road_name=candidate.segment.name,
                road_class=candidate.segment.road_class,
                e_m=round(candidate.x, 1),
                n_m=round(candidate.y, 1),
                offset_m=round(candidate.distance_m, 1),
                road_bearing_deg=round(candidate.segment.bearing_deg, 1),
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
        fixes=fixes,
    )
