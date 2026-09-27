"""Per-track movement profile over the whole history.

`track_state` reads the *current* state from a short least-squares fit. This
reads the *shape of the whole two-hour record*, in four families:

  speed      how fast it usually moves, and whether now is normal for it
  stops      how its motion is broken up - one long wait reads very differently
             from the same idle minutes scattered across the window
  path       whether it travelled purposefully or wandered
  base       whether the range to base has been closing, and how steadily

A steady commuter and a vehicle that sat still for 90 minutes then bolted have
the same instantaneous speed and completely different profiles. Only the second
is interesting, and none of these families can be seen from one fix.

Summary scalars only - the full series and histograms belong in the offline
`trajectory_analysis/traj_json.py`, not in a prompt.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

from goru_core.schemas import TrackPoint, TrackProfile

__all__ = ["track_profile"]

MOVING_MPS = 0.5      # below this a step counts as stopped
REVERSAL_DEG = 120.0  # a turn this sharp is a doubling-back, not a bend

# Thresholds for the named behaviours. Local to this module, like MOVING_MPS
# above: they label evidence, they do not set a warning level, so they are not
# part of `rules_version`.
#
# CALIBRATED against all 226 tracks in the shipped day. Stop-and-go is the norm
# here - the median track moves only 25% of the window, tops out at 4.2x its own
# mean and reverses once - so thresholds set by intuition fire on almost
# everything. These sit at roughly the 90th percentile of each distribution, so
# a flag marks a track apart from its peers rather than restating the median.
DASH_SPEED_RATIO = 6.0    # p90 of speed_max / speed_mean (median is 4.2)
DASH_MOVING_MAX = 0.15    # well under the p10 of 0.25
DASH_STOP_MIN = 60.0      # median longest stop is 40 min
APPROACH_STEP_MIN = 0.67  # p90 of closing_step_fraction (median 0.54)
APPROACH_RATE_MIN = 0.6   # p90 of base_closing_rate_mps (median 0.08)
REVERSAL_COUNT_MIN = 3    # p90 of reversals (median 1)
DIRECT_STRAIGHTNESS = 0.9 # p95 of straightness (median 0.44)
DIRECT_MOVING_MIN = 0.33  # p90 of moving_fraction


def _slope(x: np.ndarray, y: np.ndarray) -> float:
    """Least-squares slope of y against x. Zero when x has no spread."""
    spread = x - x.mean()
    denominator = float((spread**2).sum())
    if denominator <= 0.0:
        return 0.0
    return float((spread * (y - y.mean())).sum() / denominator)


def _run_lengths(flags: np.ndarray) -> list[int]:
    """Lengths of each maximal run of True in `flags`."""
    runs: list[int] = []
    current = 0
    for flag in flags:
        if flag:
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    return runs


def track_profile(points: Sequence[TrackPoint]) -> TrackProfile | None:
    """Movement profile for one track. None if the record is too short."""
    ordered = sorted(points, key=lambda p: p.ts)
    if len(ordered) < 3:
        return None

    pos = np.array([[p.e_m, p.n_m] for p in ordered], dtype=float)
    times = np.array([p.ts.timestamp() for p in ordered], dtype=float)

    delta = np.diff(pos, axis=0)
    dt = np.diff(times)
    good = dt > 0
    if good.sum() < 2:
        return None
    delta, dt = delta[good], dt[good]

    steps = np.hypot(delta[:, 0], delta[:, 1])
    speed = steps / dt
    accel = np.diff(speed) / dt[1:]
    moving = speed > MOVING_MPS

    # --- path shape ------------------------------------------------------- #
    total_m = float(steps.sum())
    net_m = float(np.hypot(*(pos[-1] - pos[0])))
    # A stopped step has no meaningful heading, so turning is measured over the
    # moving ones only - otherwise GPS jitter while parked reads as a turn.
    turns = np.array([], dtype=float)
    if moving.sum() >= 2:
        headings = np.degrees(np.arctan2(delta[moving, 0], delta[moving, 1]))
        turns = np.abs((np.diff(headings) + 180.0) % 360.0 - 180.0)

    # --- stop structure --------------------------------------------------- #
    stop_runs = _run_lengths(~moving)
    step_s = float(np.median(dt))

    # --- range to base (base is the ENU origin) --------------------------- #
    radius = np.hypot(pos[:, 0], pos[:, 1])
    d_radius = np.diff(radius)[good]

    behaviour = _behaviours(
        moving_fraction=float(moving.mean()),
        speed_mean=float(speed.mean()),
        speed_max=float(speed.max()),
        longest_stop_min=max(stop_runs, default=0) * step_s / 60.0,
        closing_step_fraction=float((d_radius < 0).mean()),
        closing_rate=-_slope(times[1:][good], radius[1:][good]),
        straightness=net_m / total_m if total_m > 0 else 0.0,
        reversals=int((turns > REVERSAL_DEG).sum()) if turns.size else 0,
    )

    return TrackProfile(
        n_steps=int(good.sum()),
        total_distance_m=round(total_m, 1),
        # speed
        speed_mean_mps=round(float(speed.mean()), 2),
        speed_max_mps=round(float(speed.max()), 2),
        speed_p95_mps=round(float(np.percentile(speed, 95)), 2),
        speed_std_mps=round(float(speed.std()), 2),
        accel_max_mps2=round(float(np.abs(accel).max()), 3) if accel.size else 0.0,
        # stops
        moving_fraction=round(float(moving.mean()), 2),
        stop_count=len(stop_runs),
        longest_stop_min=round(max(stop_runs, default=0) * step_s / 60.0, 1),
        # path shape
        net_displacement_m=round(net_m, 1),
        straightness=round(net_m / total_m, 2) if total_m > 0 else 0.0,
        heading_change_deg=round(float(turns.sum()), 1) if turns.size else 0.0,
        reversals=int((turns > REVERSAL_DEG).sum()) if turns.size else 0,
        # range to base
        base_range_start_m=round(float(radius[0]), 1),
        base_range_min_m=round(float(radius.min()), 1),
        base_closing_rate_mps=round(-_slope(times[1:][good], radius[1:][good]), 3),
        closing_step_fraction=round(float((d_radius < 0).mean()), 2),
        behaviour=behaviour,
    )


def _behaviours(
    *,
    moving_fraction: float,
    speed_mean: float,
    speed_max: float,
    longest_stop_min: float,
    closing_step_fraction: float,
    closing_rate: float,
    straightness: float,
    reversals: int,
) -> list[str]:
    """Named behaviours the scalars above support, for the agent to weigh.

    Deterministic labels over deterministic numbers. They describe what the
    record shows; they never set a level. Each one is derivable by hand from the
    fields in the same profile, so the agent can check any of them.
    """
    flags: list[str] = []
    if (
        moving_fraction <= DASH_MOVING_MAX
        and longest_stop_min >= DASH_STOP_MIN
        and speed_mean > 0
        and speed_max >= DASH_SPEED_RATIO * speed_mean
    ):
        flags.append("waited_then_moved")
    if closing_step_fraction >= APPROACH_STEP_MIN and closing_rate >= APPROACH_RATE_MIN:
        flags.append("sustained_approach_to_base")
    if reversals >= REVERSAL_COUNT_MIN:
        flags.append("doubled_back")
    if straightness >= DIRECT_STRAIGHTNESS and moving_fraction >= DIRECT_MOVING_MIN:
        flags.append("direct_run")
    return flags
