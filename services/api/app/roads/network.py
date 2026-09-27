"""The road network, read from the baked basemap.

`web/scripts/export_basemap.py` already fetches OpenStreetMap over the exercise
area and bakes it into one file of integer ENU metres, through the same
`goru_core.geo.Frame` the engine uses for tracks. So the roads a vehicle could
be on are already on disk, in the same frame as the vehicle, and nothing needs
downloading or a routing server to read them.

Segments are indexed in a uniform grid rather than an R-tree: the network is
~58 000 segments over an 18 km square, the query is always "what is within a
few tens of metres of this point", and a dict of cells answers that in constant
time with no dependency.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Iterator, Sequence

__all__ = ["RoadSegment", "RoadNetwork", "load_network"]

#: Grid pitch in metres. A cell holds ~4 segments at this network's density, and
#: a 60 m query touches at most 4 cells.
CELL_M = 120.0


@dataclass(frozen=True, slots=True)
class RoadSegment:
    """One straight piece of one way, in ENU metres."""

    way_id: int
    name: str | None
    road_class: str
    ax: float
    ay: float
    bx: float
    by: float

    @property
    def length_m(self) -> float:
        return math.hypot(self.bx - self.ax, self.by - self.ay)

    def project(self, x: float, y: float) -> tuple[float, float, float, float]:
        """Closest point on the segment to (x, y).

        Returns (px, py, distance_m, t) where `t` is 0 at A and 1 at B.
        """
        dx, dy = self.bx - self.ax, self.by - self.ay
        denominator = dx * dx + dy * dy
        t = 0.0 if denominator <= 0 else (( x - self.ax) * dx + (y - self.ay) * dy) / denominator
        t = min(1.0, max(0.0, t))
        px, py = self.ax + dx * t, self.ay + dy * t
        return px, py, math.hypot(x - px, y - py), t

    @property
    def bearing_deg(self) -> float:
        """Compass bearing from A to B, the direction of travel along it."""
        return math.degrees(math.atan2(self.bx - self.ax, self.by - self.ay)) % 360.0


def _decode(coords: Sequence[int]) -> Iterator[tuple[float, float]]:
    """The baked delta encoding: first point absolute, the rest offsets."""
    if len(coords) < 2:
        return
    x, y = float(coords[0]), float(coords[1])
    yield x, y
    for i in range(2, len(coords) - 1, 2):
        x += coords[i]
        y += coords[i + 1]
        yield x, y


class RoadNetwork:
    """Segments plus a uniform grid over them."""

    def __init__(self, segments: Sequence[RoadSegment]) -> None:
        self.segments = list(segments)
        self._cells: dict[tuple[int, int], list[int]] = {}
        for index, segment in enumerate(self.segments):
            for cell in self._cells_touched(segment):
                self._cells.setdefault(cell, []).append(index)

    @staticmethod
    def _cell_of(x: float, y: float) -> tuple[int, int]:
        return int(math.floor(x / CELL_M)), int(math.floor(y / CELL_M))

    def _cells_touched(self, segment: RoadSegment) -> Iterable[tuple[int, int]]:
        """Every cell the segment's bounding box covers.

        The box rather than the line itself: a segment is short next to the
        pitch, so the box costs at most a cell or two and keeps this simple.
        """
        x0, x1 = sorted((segment.ax, segment.bx))
        y0, y1 = sorted((segment.ay, segment.by))
        cx0, cy0 = self._cell_of(x0, y0)
        cx1, cy1 = self._cell_of(x1, y1)
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                yield cx, cy

    def near(self, x: float, y: float, radius_m: float) -> list[RoadSegment]:
        """Every segment whose cell is within `radius_m` of the point."""
        reach = int(math.ceil(radius_m / CELL_M))
        cx, cy = self._cell_of(x, y)
        seen: set[int] = set()
        for i in range(cx - reach, cx + reach + 1):
            for j in range(cy - reach, cy + reach + 1):
                seen.update(self._cells.get((i, j), ()))
        return [self.segments[i] for i in seen]

    def __len__(self) -> int:
        return len(self.segments)


def _segments_from(payload: dict) -> list[RoadSegment]:
    out: list[RoadSegment] = []
    for way_id, entry in enumerate(payload.get("roads", [])):
        road_class, name, _tunnel, coords = entry
        points = list(_decode(coords))
        for (ax, ay), (bx, by) in zip(points, points[1:]):
            if ax == bx and ay == by:
                continue
            out.append(RoadSegment(way_id, name, road_class, ax, ay, bx, by))
    return out


@lru_cache(maxsize=4)
def load_network(path: Path) -> RoadNetwork:
    """The baked network at `path`. Cached: building the grid costs ~0.3 s."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return RoadNetwork(_segments_from(payload))
