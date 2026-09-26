"""Zone proximity assessment (PLAN.md 6.6).

For every (track, zone) pair: current range, closest point of approach along the
predicted path, time to that point, time to crossing the zone radius, closing
speed and an approach confidence. All of it is constant-velocity geometry (A8) on
the velocity the kinematics module fitted.

One vectorised numpy pass covers all tracks against all zones, which is what
keeps a tick under the 50 ms budget with 226 tracks.
"""

from __future__ import annotations

from datetime import datetime
from typing import Mapping, Sequence

import numpy as np

from goru_core.config import Config
from goru_core.schemas import TrackState, Zone, ZoneAssessment

__all__ = ["assess_zones", "most_likely_destination"]


def assess_zones(
    track_states: Mapping[str, TrackState],
    histories: Mapping[str, np.ndarray],
    zones: Sequence[Zone],
    cfg: Config,
    as_of: datetime,
) -> dict[str, list[ZoneAssessment]]:
    """Assess every track against every zone. Returns track_id -> assessments.

    `histories` maps a track id to its recent ENU positions, oldest first; it is
    used only for the "how many of the last steps closed the range" term of the
    approach confidence.
    """
    track_ids = sorted(track_states)
    if not track_ids or not zones:
        return {tid: [] for tid in track_ids}

    positions = np.array([[track_states[t].pos.e_m, track_states[t].pos.n_m] for t in track_ids], dtype=float)
    velocities = np.array([track_states[t].vel_enu for t in track_ids], dtype=float)
    centres = np.array([[z.center_enu.e_m, z.center_enu.n_m] for z in zones], dtype=float)
    radii = np.array([z.radius_m for z in zones], dtype=float)
    buffers = np.array([z.buffer_m for z in zones], dtype=float)

    # r = p - z, shape (T, Z, 2)
    rel = positions[:, None, :] - centres[None, :, :]
    dist_now = np.linalg.norm(rel, axis=2)

    vel = velocities[:, None, :]
    speed = np.linalg.norm(velocities, axis=1)[:, None]
    r_dot_v = np.sum(rel * vel, axis=2)
    speed_sq = speed**2

    with np.errstate(divide="ignore", invalid="ignore"):
        t_cpa = np.where(speed_sq > 0, np.maximum(0.0, -r_dot_v / np.where(speed_sq > 0, speed_sq, 1.0)), 0.0)
        closing = np.where(dist_now > 0, -r_dot_v / np.where(dist_now > 0, dist_now, 1.0), 0.0)

    cpa_vec = rel + vel * t_cpa[:, :, None]
    cpa = np.linalg.norm(cpa_vec, axis=2)

    eta = _eta_entry(rel, vel, speed_sq, radii, r_dot_v, dist_now)

    # approach_conf = 0.5*max(0, cos t) + 0.3*(k_decreasing/3) + 0.2*min(1, speed/5)
    to_zone = -rel
    to_zone_norm = np.linalg.norm(to_zone, axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        cos_theta = np.where(
            (speed > 0) & (to_zone_norm > 0),
            np.sum(vel * to_zone, axis=2) / np.where(speed * to_zone_norm > 0, speed * to_zone_norm, 1.0),
            0.0,
        )
    k_decreasing = _closing_steps(track_ids, histories, centres)
    approach_conf = np.clip(
        0.5 * np.maximum(0.0, cos_theta) + 0.3 * (k_decreasing / 3.0) + 0.2 * np.minimum(1.0, speed / 5.0),
        0.0,
        1.0,
    )

    inside_zone = dist_now <= radii[None, :]
    inside_buffer = (dist_now > radii[None, :]) & (dist_now <= (radii + buffers)[None, :])

    out: dict[str, list[ZoneAssessment]] = {}
    for i, track_id in enumerate(track_ids):
        items: list[ZoneAssessment] = []
        for j, zone in enumerate(zones):
            eta_value = None if not np.isfinite(eta[i, j]) else float(eta[i, j])
            items.append(
                ZoneAssessment(
                    track_id=track_id,
                    zone_id=zone.zone_id,
                    as_of_ts=as_of,
                    dist_now_m=float(dist_now[i, j]),
                    cpa_m=float(cpa[i, j]),
                    t_cpa_s=float(t_cpa[i, j]),
                    eta_entry_s=eta_value,
                    closing_speed_mps=float(closing[i, j]),
                    approach_conf=float(approach_conf[i, j]),
                    inside_zone=bool(inside_zone[i, j]),
                    inside_buffer=bool(inside_buffer[i, j]),
                )
            )
        out[track_id] = items
    return out


def _eta_entry(
    rel: np.ndarray,
    vel: np.ndarray,
    speed_sq: np.ndarray,
    radii: np.ndarray,
    r_dot_v: np.ndarray,
    dist_now: np.ndarray,
) -> np.ndarray:
    """Smallest positive root of |r + v t|^2 = R^2, or inf when there is none.

    Zero when the vehicle is already inside the radius.
    """
    a = np.broadcast_to(speed_sq, rel.shape[:2]).astype(float)
    b = 2.0 * r_dot_v
    c = dist_now**2 - (radii**2)[None, :]

    eta = np.full(rel.shape[:2], np.inf, dtype=float)
    eta[c <= 0.0] = 0.0

    solvable = (a > 0.0) & (c > 0.0)
    disc = b**2 - 4.0 * a * np.where(solvable, c, 0.0)
    ok = solvable & (disc >= 0.0)
    if np.any(ok):
        sqrt_disc = np.sqrt(np.where(ok, disc, 0.0))
        denom = 2.0 * np.where(a > 0.0, a, 1.0)
        root_small = (-b - sqrt_disc) / denom
        root_large = (-b + sqrt_disc) / denom
        candidate = np.where(root_small > 0.0, root_small, np.where(root_large > 0.0, root_large, np.inf))
        eta = np.where(ok, candidate, eta)
    return eta


def _closing_steps(
    track_ids: Sequence[str],
    histories: Mapping[str, np.ndarray],
    centres: np.ndarray,
) -> np.ndarray:
    """How many of the last three steps decreased the range to each zone, 0-3."""
    counts = np.zeros((len(track_ids), len(centres)), dtype=float)
    for i, track_id in enumerate(track_ids):
        history = histories.get(track_id)
        if history is None or len(history) < 2:
            continue
        ranges = np.linalg.norm(history[:, None, :] - centres[None, :, :], axis=2)  # (K, Z)
        deltas = np.diff(ranges, axis=0)[-3:]
        counts[i] = (deltas < 0.0).sum(axis=0)
    return counts


def most_likely_destination(
    assessments: Sequence[ZoneAssessment], cfg: Config
) -> str | None:
    """The zone a vehicle is most likely heading for, or None (PLAN 6.6).

    Smallest time-to-entry among zones whose approach confidence reaches 0.5,
    within the configured horizon.
    """
    horizon_s = cfg.warning.horizon_s
    candidates = [
        a
        for a in assessments
        if a.approach_conf >= 0.5 and a.eta_entry_s is not None and 0.0 <= a.eta_entry_s <= horizon_s
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda a: (a.eta_entry_s or 0.0)).zone_id
