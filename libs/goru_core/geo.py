"""Geodesy for Goru: the ENU working frame and image footprints (PLAN.md 2.2, 6.2).

Two deep modules:

* `Frame` - a local east/north frame in metres anchored at the base. Everything
  downstream (kinematics, CPA, matching, the display) works in this frame, so
  latitude/longitude appears only at the edges of the system.
* `Footprint` - one drone image's ground quad. Converts pixels to coordinates,
  reports ground sampling distance, and answers containment. It also validates
  its own geometry, which is how the ``[lat, lon]`` corner order (A5) and the
  nadir assumption (A6) get checked on real data rather than assumed.

The metres-per-degree conversion is computed from the base latitude with the
standard WGS-84 series, never hardcoded. At the base (39.92184 N) it yields
111 033.0 m/deg latitude and 85 491.5 m/deg longitude, matching PLAN 2.2.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

__all__ = [
    "Frame",
    "Footprint",
    "m_per_deg",
    "bearing_deg",
    "GeometryError",
    "LatLonPair",
]

LatLonPair = tuple[float, float]


class GeometryError(ValueError):
    """Raised when a footprint's corners cannot describe a usable ground quad."""


def m_per_deg(lat_deg: float) -> tuple[float, float]:
    """Metres per degree of latitude and longitude at `lat_deg` (WGS-84 series)."""
    phi = math.radians(lat_deg)
    m_lat = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    m_lon = (
        111412.84 * math.cos(phi)
        - 93.5 * math.cos(3 * phi)
        + 0.118 * math.cos(5 * phi)
    )
    return m_lat, m_lon


def bearing_deg(east_m: float, north_m: float) -> float:
    """Compass bearing (0 = north, 90 = east) of an ENU vector, in [0, 360)."""
    if east_m == 0.0 and north_m == 0.0:
        return 0.0
    return math.degrees(math.atan2(east_m, north_m)) % 360.0


@dataclass(frozen=True)
class Frame:
    """Local ENU frame in metres, origin at the base (PLAN 2.2).

    Flat-earth by design: the exercise spans ~10 km, where the error of a linear
    conversion is centimetres, and every measured figure in PLAN 2 was produced
    this way.
    """

    origin_lat: float
    origin_lon: float
    m_per_deg_lat: float
    m_per_deg_lon: float

    @classmethod
    def at(cls, lat: float, lon: float) -> "Frame":
        m_lat, m_lon = m_per_deg(lat)
        return cls(origin_lat=lat, origin_lon=lon, m_per_deg_lat=m_lat, m_per_deg_lon=m_lon)

    def to_enu(self, lat: float, lon: float) -> tuple[float, float]:
        return (
            (lon - self.origin_lon) * self.m_per_deg_lon,
            (lat - self.origin_lat) * self.m_per_deg_lat,
        )

    def to_latlon(self, east_m: float, north_m: float) -> LatLonPair:
        return (
            self.origin_lat + north_m / self.m_per_deg_lat,
            self.origin_lon + east_m / self.m_per_deg_lon,
        )

    def to_enu_array(self, lats: Sequence[float], lons: Sequence[float]) -> np.ndarray:
        """Vectorised `to_enu`; returns an (N, 2) array of [east, north] metres."""
        lat_arr = np.asarray(lats, dtype=float)
        lon_arr = np.asarray(lons, dtype=float)
        return np.column_stack(
            (
                (lon_arr - self.origin_lon) * self.m_per_deg_lon,
                (lat_arr - self.origin_lat) * self.m_per_deg_lat,
            )
        )

    def range_m(self, lat: float, lon: float) -> float:
        """Slant-free ground distance from the frame origin, in metres."""
        east, north = self.to_enu(lat, lon)
        return math.hypot(east, north)


@dataclass(frozen=True)
class Footprint:
    """One image's ground footprint, built from its four corner coordinates.

    Corners arrive as ``[lat, lon]`` pairs (A5, confirmed on all 40 images by the
    GSD cross-check below). All 40 footprints are axis-aligned and north-up
    (A6), so pixel-to-ground is the linear interpolation the brief specifies.
    """

    image_id: str
    width_px: int
    height_px: int
    top_left: LatLonPair
    top_right: LatLonPair
    bottom_left: LatLonPair
    bottom_right: LatLonPair

    @property
    def lat_top(self) -> float:
        return self.top_left[0]

    @property
    def lat_bottom(self) -> float:
        return self.bottom_left[0]

    @property
    def lon_left(self) -> float:
        return self.top_left[1]

    @property
    def lon_right(self) -> float:
        return self.top_right[1]

    @property
    def gsd_x_m(self) -> float:
        """Ground sampling distance across the image, metres per pixel."""
        _, m_lon = m_per_deg(self.lat_top)
        return abs(self.lon_right - self.lon_left) * m_lon / self.width_px

    @property
    def gsd_y_m(self) -> float:
        """Ground sampling distance down the image, metres per pixel."""
        m_lat, _ = m_per_deg(self.lat_top)
        return abs(self.lat_top - self.lat_bottom) * m_lat / self.height_px

    @property
    def area_m2_per_px(self) -> float:
        return self.gsd_x_m * self.gsd_y_m

    def pixel_to_latlon(self, u: float, v: float) -> LatLonPair:
        """Linear pixel-to-ground interpolation (PLAN 6.2), the spec-compliant path.

        `u` runs left to right, `v` top to bottom, both in pixels.
        """
        lon = self.lon_left + (u / self.width_px) * (self.lon_right - self.lon_left)
        lat = self.lat_top + (v / self.height_px) * (self.lat_bottom - self.lat_top)
        return lat, lon

    def contains_latlon(self, lat: float, lon: float) -> bool:
        """True when a ground point falls inside this footprint."""
        lo_lat, hi_lat = sorted((self.lat_top, self.lat_bottom))
        lo_lon, hi_lon = sorted((self.lon_left, self.lon_right))
        return lo_lat <= lat <= hi_lat and lo_lon <= lon <= hi_lon

    def corners_enu(self, frame: Frame) -> list[tuple[float, float]]:
        return [
            frame.to_enu(*self.top_left),
            frame.to_enu(*self.top_right),
            frame.to_enu(*self.bottom_right),
            frame.to_enu(*self.bottom_left),
        ]

    def geometry_problems(self, *, gsd_tolerance: float = 0.05) -> list[str]:
        """Self-validation (PLAN 7.2.1). Empty list means the quad is usable.

        The GSD cross-check is the A5 guard: with ``[lat, lon]`` read correctly
        the two ground sampling distances agree to well under a percent (worst
        observed 0.56 %), while a swapped pair disagrees by orders of magnitude.
        """
        problems: list[str] = []
        if self.width_px <= 0 or self.height_px <= 0:
            problems.append("non-positive image dimensions")
            return problems
        for name, (lat, lon) in (
            ("top_left", self.top_left),
            ("top_right", self.top_right),
            ("bottom_left", self.bottom_left),
            ("bottom_right", self.bottom_right),
        ):
            if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
                problems.append(f"{name} is not a plausible [lat, lon] pair")
        if problems:
            return problems
        if self.lat_top <= self.lat_bottom:
            problems.append("top edge is not north of the bottom edge")
        if self.lon_right <= self.lon_left:
            problems.append("right edge is not east of the left edge")
        if problems:
            return problems
        gx, gy = self.gsd_x_m, self.gsd_y_m
        if gy > 0 and abs(gx - gy) / gy > gsd_tolerance:
            problems.append(
                f"GSD x/y disagree by {100 * abs(gx - gy) / gy:.1f}% "
                f"({gx:.4f} vs {gy:.4f} m/px) - corner order may be swapped"
            )
        return problems

    def requires_area_filter_review(self, legacy_min_px: float, car_area_m2: float = 8.0) -> bool:
        """True when the legacy pixel-area rule sits at passenger-car size here.

        At the coarse end of this dataset (GSD 0.199 m/px) a car measures about
        202 px^2, so the inherited 200 px^2 filter would start dropping real
        vehicles. PLAN 2.5 replaces it with a ground-area filter; this flag is
        what makes the affected images visible in the log.
        """
        px_per_car = car_area_m2 / self.area_m2_per_px if self.area_m2_per_px else float("inf")
        return px_per_car <= legacy_min_px * 1.25


def footprint_gsd_span(footprints: Iterable[Footprint]) -> tuple[float, float]:
    """Min and max GSD-x over a set of footprints, for the intake report."""
    values = [fp.gsd_x_m for fp in footprints]
    if not values:
        return (0.0, 0.0)
    return (min(values), max(values))
