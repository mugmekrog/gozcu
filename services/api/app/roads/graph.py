"""The routing graph, and shortest paths on it.

`network.py` answers "what road is near this point". This answers "how far
would a vehicle have had to drive to get from here to there", which is the
question Newson & Krumm's transition term actually asks and the one geometry
alone cannot answer.

Dijkstra rather than A*: the heuristic would save little at these ranges and
the budget below is what really bounds the work. Every search is bounded twice
-- by distance and by nodes popped -- and returns None rather than running long,
because a route that far outside expectation is one the matcher should score as
implausible anyway.
"""

from __future__ import annotations

import heapq
import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Sequence

__all__ = ["RoadGraph", "load_graph", "EdgePoint"]

#: Grid pitch for the edge index, metres.
CELL_M = 120.0

#: Hard ceiling on nodes popped in one search. At this graph's density a 3 km
#: radius is ~12 000 nodes, so this admits the searches worth doing and stops
#: the pathological ones.
NODE_BUDGET = 30_000


@dataclass(frozen=True, slots=True)
class EdgePoint:
    """A position on the graph: how far along one edge, and where that is."""

    edge: int
    #: 0 at the edge's `u` node, 1 at its `v` node.
    t: float
    x: float
    y: float
    #: Distance from the raw fix to this point.
    offset_m: float


class RoadGraph:
    """Nodes, edges, adjacency and an edge index, all in ENU metres."""

    def __init__(self, payload: dict) -> None:
        self.nodes: list[tuple[float, float]] = [(float(e), float(n)) for e, n in payload["nodes"]]
        self.edges: list[tuple[int, int, int, float]] = [
            (int(u), int(v), int(w), float(length)) for u, v, w, length in payload["edges"]
        ]
        self.ways: list[tuple[str | None, str, int]] = [
            (name, road_class, int(oneway)) for name, road_class, oneway in payload["ways"]
        ]

        self.adjacency: list[list[tuple[int, float]]] = [[] for _ in self.nodes]
        for u, v, way, length in self.edges:
            oneway = self.ways[way][2] if way < len(self.ways) else 0
            # A one-way edge is still walked backwards here. Matching asks how
            # far apart two places are, not whether the turn was legal, and OSM
            # oneway tags are noisy enough that honouring them strictly loses
            # more real routes than it rejects wrong ones.
            self.adjacency[u].append((v, length))
            self.adjacency[v].append((u, length))
            del oneway

        self._cells: dict[tuple[int, int], list[int]] = {}
        for index, (u, v, _way, _length) in enumerate(self.edges):
            for cell in self._cells_touched(self.nodes[u], self.nodes[v]):
                self._cells.setdefault(cell, []).append(index)

    # --- geometry ---------------------------------------------------------- #

    @staticmethod
    def _cell_of(x: float, y: float) -> tuple[int, int]:
        return int(math.floor(x / CELL_M)), int(math.floor(y / CELL_M))

    def _cells_touched(
        self, a: tuple[float, float], b: tuple[float, float]
    ) -> Iterable[tuple[int, int]]:
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        cx0, cy0 = self._cell_of(x0, y0)
        cx1, cy1 = self._cell_of(x1, y1)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                yield cx, cy

    def way_of(self, edge: int) -> tuple[str | None, str, int]:
        return self.ways[self.edges[edge][2]]

    def bearing_of(self, edge: int) -> float:
        u, v, _way, _length = self.edges[edge]
        (ax, ay), (bx, by) = self.nodes[u], self.nodes[v]
        return math.degrees(math.atan2(bx - ax, by - ay)) % 360.0

    def candidates(self, x: float, y: float, radius_m: float, limit: int) -> list[EdgePoint]:
        """Edge points within `radius_m` of (x, y), nearest first, one per way."""
        reach = int(math.ceil(radius_m / CELL_M))
        cx, cy = self._cell_of(x, y)
        seen: set[int] = set()
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                seen.update(self._cells.get((i, j), ()))

        found: list[EdgePoint] = []
        for index in seen:
            u, v, _way, _length = self.edges[index]
            ax, ay = self.nodes[u]
            bx, by = self.nodes[v]
            dx, dy = bx - ax, by - ay
            denominator = dx * dx + dy * dy
            t = 0.0 if denominator <= 0 else ((x - ax) * dx + (y - ay) * dy) / denominator
            t = min(1.0, max(0.0, t))
            px, py = ax + dx * t, ay + dy * t
            offset = math.hypot(x - px, y - py)
            if offset <= radius_m:
                found.append(EdgePoint(index, t, px, py, offset))

        found.sort(key=lambda c: c.offset_m)
        # One candidate per way: the same street contributes many edges, and
        # eight candidates all on one road is eight ways of saying the same
        # thing while the parallel street next to it goes unconsidered.
        kept: list[EdgePoint] = []
        taken: set[int] = set()
        for candidate in found:
            way = self.edges[candidate.edge][2]
            if way in taken:
                continue
            taken.add(way)
            kept.append(candidate)
            if len(kept) >= limit:
                break
        return kept

    # --- routing ----------------------------------------------------------- #

    def _ends(self, point: EdgePoint) -> tuple[tuple[int, float], tuple[int, float]]:
        """The edge's two nodes and the distance from `point` to each."""
        u, v, _way, length = self.edges[point.edge]
        return (u, point.t * length), (v, (1.0 - point.t) * length)

    def route(
        self, start: EdgePoint, goals: Sequence[EdgePoint], budget_m: float
    ) -> list[float | None]:
        """Driving distance from `start` to each goal, or None past the budget.

        One search serves every goal, which is what keeps this affordable: the
        matcher asks for one previous candidate against all of the current
        fix's candidates at once.
        """
        if budget_m <= 0:
            return [None] * len(goals)

        same_edge: dict[int, float] = {}
        goal_nodes: dict[int, list[int]] = {}
        for index, goal in enumerate(goals):
            if goal.edge == start.edge:
                length = self.edges[goal.edge][3]
                same_edge[index] = abs(goal.t - start.t) * length
                continue
            for node, _cost in self._ends(goal):
                goal_nodes.setdefault(node, []).append(index)

        results: list[float | None] = [None] * len(goals)
        for index, distance in same_edge.items():
            results[index] = distance
        if not goal_nodes:
            return results

        best: dict[int, float] = {}
        queue: list[tuple[float, int]] = []
        for node, cost in self._ends(start):
            if cost < best.get(node, math.inf):
                best[node] = cost
                heapq.heappush(queue, (cost, node))

        # What each goal still needs once its nearer node is reached.
        remaining: dict[int, dict[int, float]] = {}
        for index, goal in enumerate(goals):
            if index in same_edge:
                continue
            for node, cost in self._ends(goal):
                remaining.setdefault(index, {})[node] = cost

        outstanding = set(remaining)
        popped = 0
        while queue and outstanding and popped < NODE_BUDGET:
            cost, node = heapq.heappop(queue)
            if cost > best.get(node, math.inf):
                continue
            if cost > budget_m:
                break
            popped += 1

            for index in goal_nodes.get(node, ()):
                total = cost + remaining[index][node]
                if results[index] is None or total < results[index]:
                    results[index] = total

            # A goal whose best route is already shorter than the frontier can
            # no longer be improved, so it leaves. Once they have all left the
            # search stops -- without this it runs out to the full budget
            # radius every time, which MEASURED at ~13 000 nodes popped per
            # call and was the whole cost of matching.
            if outstanding:
                outstanding = {
                    index
                    for index in outstanding
                    if results[index] is None or cost < results[index]
                }
                if not outstanding:
                    break

            for neighbour, length in self.adjacency[node]:
                step = cost + length
                if step <= budget_m and step < best.get(neighbour, math.inf):
                    best[neighbour] = step
                    heapq.heappush(queue, (step, neighbour))

        return results

    def path(self, start: EdgePoint, goal: EdgePoint, budget_m: float) -> list[tuple[float, float]]:
        """The driven route between two edge points, as ENU points.

        Empty when no route exists inside the budget. This is what the map
        draws: without it the matched trace is a scatter of snapped dots, with
        it the vehicle runs along the streets it was matched to.
        """
        if goal.edge == start.edge:
            return [(start.x, start.y), (goal.x, goal.y)]

        goal_ends = dict(self._ends(goal))
        best: dict[int, float] = {}
        previous: dict[int, int] = {}
        queue: list[tuple[float, int]] = []
        for node, cost in self._ends(start):
            if cost < best.get(node, math.inf):
                best[node] = cost
                heapq.heappush(queue, (cost, node))

        reached: int | None = None
        reached_cost = math.inf
        popped = 0
        while queue and popped < NODE_BUDGET:
            cost, node = heapq.heappop(queue)
            if cost > best.get(node, math.inf) or cost > budget_m:
                continue
            popped += 1
            if node in goal_ends:
                total = cost + goal_ends[node]
                if total < reached_cost:
                    reached, reached_cost = node, total
                # The other end cannot beat this by more than the goal edge.
                if cost > reached_cost:
                    break
            for neighbour, length in self.adjacency[node]:
                step = cost + length
                if step <= budget_m and step < best.get(neighbour, math.inf):
                    best[neighbour] = step
                    previous[neighbour] = node
                    heapq.heappush(queue, (step, neighbour))

        if reached is None:
            return []

        chain = [reached]
        while chain[-1] in previous:
            chain.append(previous[chain[-1]])
        chain.reverse()
        return [(start.x, start.y), *(self.nodes[n] for n in chain), (goal.x, goal.y)]


@lru_cache(maxsize=2)
def load_graph(path: Path) -> RoadGraph:
    """The baked graph at `path`. Cached: building it costs a second or two."""
    return RoadGraph(json.loads(Path(path).read_text(encoding="utf-8")))
