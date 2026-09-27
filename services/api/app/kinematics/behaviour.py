"""Whole-record behaviour around the protected base (team decision, 2026-09-27).

The brief says to read speed and direction from the whole two-hour record rather
than from one step, and warns that vehicles turn, stop and circle the base. The
instantaneous kinematics in `velocity.py` fit the last fifteen minutes; this module
reads the rest of the record: how far a vehicle has closed on the base over the last
half hour, hour and two hours, how close it ever came, how far round the base it has
swept, and how long it has sat still nearby.

It measures and never judges. Every threshold that turns a number into an approach
or a surveillance signal lives in the risk engine. The one threshold used here is
the stationary distance, shared with the display's route report
(`web/src/domain/tracks.ts`, `stopsOf`), so both screens call the same spells stops.

Merkez Us is the ENU origin, so a fix's range is ``|p|`` and its bearing ``atan2(e, n)``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Mapping, Sequence

import numpy as np

from goru_core.config import Config
from goru_core.schemas import TrackPoint

__all__ = ["BehaviourProfile", "StopSpell", "behaviour_profile", "CLOSING_WINDOWS_MIN"]

CLOSING_WINDOWS_MIN = (30, 60, 120)
HEADING_WINDOW_MIN = 30
# Below this much movement over the heading window a vehicle has no direction worth
# reporting: parked jitter is 4-7 m a step (PLAN 2.6).
MIN_HEADING_DISPLACEMENT_M = 50.0
# A window's start fix may sit up to one track step before the exact clock.
STEP_TOLERANCE = timedelta(minutes=5)


@dataclass(frozen=True)
class StopSpell:
    """A run of fixes that all stay within the stationary distance of the first."""

    start_ts: datetime
    end_ts: datetime
    range_m: float

    @property
    def minutes(self) -> float:
        return (self.end_ts - self.start_ts).total_seconds() / 60.0


@dataclass(frozen=True)
class BehaviourProfile:
    """What the record up to the clock says about one vehicle and the base."""

    range_m: float
    closest_m: float
    closest_min_ago: float
    closing_m: Mapping[int, float | None]  # window -> metres closed on the base, + is nearer
    heading_to_base_cos: float | None  # last half hour of movement against the base's direction
    sweep_deg: float  # span of the bearing from the base over the record
    range_spread: float  # (max - min) / mean range over the record
    stop_spells: int
    loiter_min: float  # minutes stopped within threat.dwell_radius_m of the base
    record_min: float
    # How far out it was before its closest approach; None when the closest fix is the
    # first one - a record that starts near the base and leaves never came in.
    came_in_from_m: float | None = None


def behaviour_profile(points: Sequence[TrackPoint], as_of: datetime, cfg: Config) -> BehaviourProfile:
    """Profile one track from its fixes at or before `as_of`; later fixes are ignored."""
    ordered = sorted((p for p in points if p.ts <= as_of), key=lambda p: p.ts)
    if not ordered:
        raise ValueError("behaviour_profile needs at least one fix at or before the clock")

    positions = np.array([[p.e_m, p.n_m] for p in ordered], dtype=float)
    ranges = np.linalg.norm(positions, axis=1)
    now = ordered[-1]
    closest = int(np.argmin(ranges))

    bearings = np.unwrap(np.arctan2(positions[:, 0], positions[:, 1]))
    mean_range = float(ranges.mean())
    spells = _stop_spells(ordered, positions, ranges, cfg.kinematics.stationary_disp_m)

    return BehaviourProfile(
        range_m=float(ranges[-1]),
        closest_m=float(ranges[closest]),
        closest_min_ago=_minutes(now.ts - ordered[closest].ts),
        closing_m={
            window: _closing(ordered, ranges, window) for window in CLOSING_WINDOWS_MIN
        },
        heading_to_base_cos=_heading_to_base_cos(ordered, positions),
        sweep_deg=float(math.degrees(bearings.max() - bearings.min())),
        range_spread=float((ranges.max() - ranges.min()) / mean_range) if mean_range > 0 else 0.0,
        stop_spells=len(spells),
        loiter_min=sum(s.minutes for s in spells if s.range_m <= cfg.threat.dwell_radius_m),
        record_min=_minutes(now.ts - ordered[0].ts),
        came_in_from_m=float(ranges[:closest].max()) if closest > 0 else None,
    )


def _minutes(delta: timedelta) -> float:
    return delta.total_seconds() / 60.0


def _index_at(ordered: Sequence[TrackPoint], target: datetime) -> int | None:
    """The latest fix at or before `target`, if it is within one step of it."""
    for index in range(len(ordered) - 1, -1, -1):
        ts = ordered[index].ts
        if ts <= target:
            return index if target - ts <= STEP_TOLERANCE else None
    return None


def _closing(ordered: Sequence[TrackPoint], ranges: np.ndarray, window_min: int) -> float | None:
    start = _index_at(ordered, ordered[-1].ts - timedelta(minutes=window_min))
    return None if start is None else float(ranges[start] - ranges[-1])


def _heading_to_base_cos(ordered: Sequence[TrackPoint], positions: np.ndarray) -> float | None:
    start = _index_at(ordered, ordered[-1].ts - timedelta(minutes=HEADING_WINDOW_MIN))
    if start is None:
        return None
    moved = positions[-1] - positions[start]
    to_base = -positions[start]
    moved_m, to_base_m = float(np.linalg.norm(moved)), float(np.linalg.norm(to_base))
    if moved_m < MIN_HEADING_DISPLACEMENT_M or to_base_m == 0.0:
        return None
    return float(moved @ to_base / (moved_m * to_base_m))


def _stop_spells(
    ordered: Sequence[TrackPoint], positions: np.ndarray, ranges: np.ndarray, stationary_m: float
) -> list[StopSpell]:
    """Maximal still runs spanning at least two intervals, exactly as the display's `stopsOf`."""
    spells: list[StopSpell] = []
    count = len(ordered)
    start = 0
    while start < count - 1:
        end = start
        for index in range(start + 1, count):
            if float(np.linalg.norm(positions[index] - positions[start])) > stationary_m:
                break
            end = index
        if end - start >= 2:
            spells.append(StopSpell(ordered[start].ts, ordered[end].ts, float(ranges[start])))
            start = end
        else:
            start += 1
    return spells
