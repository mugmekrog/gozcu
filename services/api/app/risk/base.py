"""Merkez Us as the protected target, and the observation sectors around it.

Team decision (2026-09-27): the base is what the system protects. The eight zones
in `zones.json` are observation sectors on a 3.2 km ring at 45 degree steps - the
brief introduces them as the names reports use for places. They say where a vehicle
is and which reports apply to it; they raise nothing by themselves.

The base goes through the same vectorised geometry as any target (`assess_zones`):
its radius is the critical ring and its buffer runs out to the warning ring, so
``inside_zone`` means inside the critical ring and ``eta_entry_s`` is the time to
cross it.
"""

from __future__ import annotations

from typing import Sequence

from goru_core.config import Config
from goru_core.geo import bearing_deg
from goru_core.schemas import ENU, LatLon, Zone

__all__ = ["BASE_ID", "base_target", "sector_of", "ring_of"]

BASE_ID = "BASE"


def base_target(base: LatLon, name: str, cfg: Config) -> Zone:
    """The base as a target: critical ring as its radius, warning ring as its buffer's edge."""
    rings = cfg.base
    return Zone(
        zone_id=BASE_ID,
        name=name,
        center=base,
        center_enu=ENU(e_m=0.0, n_m=0.0),
        radius_m=rings.critical_radius_m,
        buffer_m=rings.warning_radius_m - rings.critical_radius_m,
    )


def sector_of(east_m: float, north_m: float, zones: Sequence[Zone]) -> Zone:
    """The observation sector a point lies in: the zone nearest to it in bearing from the base."""
    bearing = bearing_deg(east_m, north_m)

    def separation(zone: Zone) -> float:
        diff = abs(bearing - bearing_deg(zone.center_enu.e_m, zone.center_enu.n_m)) % 360.0
        return min(diff, 360.0 - diff)

    return min(zones, key=separation)


def ring_of(range_m: float, cfg: Config) -> str:
    """Which of the base's rings a range falls in."""
    rings = cfg.base
    if range_m <= rings.critical_radius_m:
        return "critical"
    if range_m <= rings.warning_radius_m:
        return "warning"
    if range_m <= rings.observation_radius_m:
        return "observation"
    return "outside"
