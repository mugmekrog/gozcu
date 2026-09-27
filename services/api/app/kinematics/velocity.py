"""Kinematics from a track's history (PLAN.md 6.5).

Every track carries a full 25-point, two-hour window at five-minute steps, and
the brief says to read speed and heading from the whole record rather than from
one step. So: a least-squares line fit over the last few fixes, a stationarity
test sized above the observed jitter, and outlier rejection.

The distance-to-base series at t-60, t-30 and now is not decoration. The brief's
own worked example reasons in exactly those terms ("5.8 km at 12:25, 3.0 km at
13:25, approaching"), and it is what lets the agent talk about a trend instead of
an instantaneous number.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Sequence

import numpy as np

from goru_core.config import Config
from goru_core.geo import bearing_deg
from goru_core.schemas import ENU, LatLon, TrackPoint, TrackState

from app.kinematics.profile import track_profile

__all__ = ["track_state", "recent_positions"]


def _fit_velocity(times_s: np.ndarray, values_m: np.ndarray) -> float:
    """Least-squares slope of position against time, in metres per second."""
    if len(times_s) < 2:
        return 0.0
    spread = times_s - times_s.mean()
    denominator = float((spread**2).sum())
    if denominator <= 0.0:
        return 0.0
    return float((spread * (values_m - values_m.mean())).sum() / denominator)


def track_state(
    points: Sequence[TrackPoint],
    as_of: datetime,
    cfg: Config,
    *,
    image_id: str | None = None,
    class_hint: str | None = None,
    class_conf: float | None = None,
) -> TrackState:
    """Derive the state of one track at `as_of` from its fixes up to `as_of`.

    `points` must already be filtered to ``ts <= as_of`` (the as-of rule is
    enforced by the caller through `Timeline.as_of`, so there is one place to
    test it).
    """
    if not points:
        raise ValueError("track_state needs at least one fix")

    ordered = sorted(points, key=lambda p: p.ts)
    last = ordered[-1]

    positions = np.array([[p.e_m, p.n_m] for p in ordered], dtype=float)
    times = np.array([p.ts.timestamp() for p in ordered], dtype=float)

    # Outlier rejection: a step implying an implausible speed is excluded from
    # the fit but still reported, so the display can flag the track.
    usable = np.ones(len(ordered), dtype=bool)
    outliers = 0
    for i in range(1, len(ordered)):
        step_s = times[i] - times[i - 1]
        if step_s <= 0:
            continue
        step_m = float(np.hypot(*(positions[i] - positions[i - 1])))
        if step_m / step_s > cfg.kinematics.max_step_speed_mps:
            usable[i] = False
            outliers += 1

    fit_slice = np.flatnonzero(usable)[-cfg.kinematics.fit_points :]
    if len(fit_slice) >= 2:
        ve = _fit_velocity(times[fit_slice], positions[fit_slice, 0])
        vn = _fit_velocity(times[fit_slice], positions[fit_slice, 1])
    else:
        ve = vn = 0.0

    # Stationary: net displacement over the last two steps, i.e. ten minutes.
    # T0001's 4-7 m of jitter sits well under the 25 m threshold.
    stationary = False
    if len(ordered) >= 3:
        net_m = float(np.hypot(*(positions[-1] - positions[-3])))
        stationary = net_m < cfg.kinematics.stationary_disp_m
    elif len(ordered) == 2:
        stationary = float(np.hypot(*(positions[-1] - positions[-2]))) < cfg.kinematics.stationary_disp_m
    if stationary:
        ve = vn = 0.0

    speed = math.hypot(ve, vn)
    heading = bearing_deg(ve, vn) if speed > 0 else bearing_deg(
        *(positions[-1] - positions[max(0, len(positions) - 2)])
    )

    return TrackState(
        track_id=last.track_id,
        as_of_ts=as_of,
        pos=ENU(e_m=last.e_m, n_m=last.n_m),
        pos_geo=LatLon(lat=last.lat, lon=last.lon),
        vel_enu=[ve, vn],
        speed_mps=speed,
        heading_deg=heading,
        stationary=stationary,
        last_fix_ts=last.ts,
        image_id=image_id,
        class_hint=class_hint,  # type: ignore[arg-type]
        class_conf=class_conf,
        dist_to_base_m=_distance_to_base_series(ordered, as_of),
        outlier_steps=outliers,
        profile=track_profile(ordered),
    )


def _distance_to_base_series(
    points: Sequence[TrackPoint], as_of: datetime
) -> dict[str, float | None]:
    """Range from base at t-60, t-30 and now, in metres (base is the ENU origin)."""

    def nearest(target: datetime) -> float | None:
        candidates = [p for p in points if p.ts <= target]
        if not candidates:
            return None
        chosen = max(candidates, key=lambda p: p.ts)
        if (target - chosen.ts).total_seconds() > 10 * 60:
            return None
        return math.hypot(chosen.e_m, chosen.n_m)

    last = points[-1]
    return {
        "t-60": nearest(as_of - timedelta(minutes=60)),
        "t-30": nearest(as_of - timedelta(minutes=30)),
        "now": math.hypot(last.e_m, last.n_m),
    }


def recent_positions(points: Sequence[TrackPoint], count: int = 4) -> np.ndarray:
    """The last `count` fixes as an (n, 2) ENU array, oldest first.

    Used by the zone assessment to decide how many of the last steps closed the
    range on a zone.
    """
    ordered = sorted(points, key=lambda p: p.ts)[-count:]
    if not ordered:
        return np.empty((0, 2), dtype=float)
    return np.array([[p.e_m, p.n_m] for p in ordered], dtype=float)
