"""Detection-to-track matching (PLAN.md 6.4, 2.8).

The dataset is aligned to sub-metre precision: each image's vehicles are exactly
the tracks whose two-hour window ends at that image's capture time (A11,
confirmed - the set of track end times equals the set of capture times), and the
measured median detection-to-track distance is 0.19 m.

So matching is an exact-time lookup plus a nearest-neighbour assignment. There is
no extrapolation, no staleness and no uncertainty propagation; revision 1's
machinery for those was deleted once the data was measured.

Two residues matter and are returned rather than swallowed: detections that match
no track (untracked object, expect ~3 in the whole set) and tracks that should be
in frame but have no detection (expected but not seen, expect ~20). The brief
predicts both.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Mapping, Sequence

import numpy as np
from scipy.optimize import linear_sum_assignment

from goru_core.config import Config
from goru_core.geo import Footprint, Frame
from goru_core.schemas import Detection, Match, TrackState

__all__ = ["MatchOutcome", "match_detections_to_tracks", "footprint_distance_m"]

_UNREACHABLE = 1e9


@dataclass
class MatchOutcome:
    """The result of matching one image's detections to its candidate tracks."""

    matches: list[Match] = field(default_factory=list)
    track_by_det: dict[str, str] = field(default_factory=dict)
    det_by_track: dict[str, str] = field(default_factory=dict)
    distances_m: list[float] = field(default_factory=list)
    unmatched_det_ids: list[str] = field(default_factory=list)
    duplicate_of: dict[str, str] = field(default_factory=dict)
    expected_not_seen: list[tuple[str, str, float]] = field(default_factory=list)

    @property
    def median_distance_m(self) -> float:
        return float(np.median(self.distances_m)) if self.distances_m else 0.0

    @property
    def untracked_det_ids(self) -> list[str]:
        """Unmatched detections that are not merely double-detections."""
        return [d for d in self.unmatched_det_ids if d not in self.duplicate_of]


def footprint_distance_m(footprint: Footprint, frame: Frame, east_m: float, north_m: float) -> float:
    """Distance in metres from an ENU point to a footprint, 0 when inside.

    The footprint is axis-aligned in latitude/longitude, and the ENU conversion is
    linear, so it stays an axis-aligned rectangle here.
    """
    corners = np.array(footprint.corners_enu(frame), dtype=float)
    min_e, min_n = corners.min(axis=0)
    max_e, max_n = corners.max(axis=0)
    dx = max(min_e - east_m, 0.0, east_m - max_e)
    dy = max(min_n - north_m, 0.0, north_m - max_n)
    return math.hypot(dx, dy)


def match_detections_to_tracks(
    detections: Sequence[Detection],
    track_states: Mapping[str, TrackState],
    *,
    cfg: Config,
    footprint: Footprint,
    frame: Frame,
) -> MatchOutcome:
    """Assign kept detections to candidate tracks within the gate.

    `track_states` must already be restricted to the tracks belonging to this
    image (those whose last fix is the capture time). Cost is Euclidean distance
    in ENU metres; assignment is Hungarian, which with ~5x5 matrices is free and
    is cheap insurance against the handful of genuinely ambiguous pairs.
    """
    outcome = MatchOutcome()
    kept = [d for d in detections if d.kept]
    track_ids = sorted(track_states)

    if kept and track_ids:
        det_xy = np.array([[d.center_enu.e_m, d.center_enu.n_m] for d in kept], dtype=float)
        trk_xy = np.array([[track_states[t].pos.e_m, track_states[t].pos.n_m] for t in track_ids], dtype=float)
        cost = np.linalg.norm(det_xy[:, None, :] - trk_xy[None, :, :], axis=2)

        gated = np.where(cost <= cfg.matching.gate_m, cost, _UNREACHABLE)
        rows, cols = linear_sum_assignment(gated)
        for row, col in zip(rows, cols):
            distance = float(cost[row, col])
            if distance > cfg.matching.gate_m:
                continue
            detection = kept[row]
            track_id = track_ids[col]
            confidence = "high" if distance <= cfg.matching.low_conf_m else "low"
            outcome.matches.append(
                Match(
                    match_id=f"M-{detection.det_id}",
                    track_id=track_id,
                    evidence_type="detection",
                    evidence_id=detection.det_id,
                    distance_m=distance,
                    gate_m=cfg.matching.gate_m,
                    cost=distance,
                    confidence=confidence,
                    rules_version=cfg.rules_version,
                )
            )
            outcome.track_by_det[detection.det_id] = track_id
            outcome.det_by_track[track_id] = detection.det_id
            outcome.distances_m.append(distance)

    outcome.unmatched_det_ids = [d.det_id for d in kept if d.det_id not in outcome.track_by_det]

    # Separate double-detections from genuinely untracked objects. The exclusive
    # assignment above leaves one box unmatched whenever NMS@0.5 failed to merge
    # two offset boxes on the same vehicle; those sit within metres of a track
    # another detection already claimed, and calling them "untracked objects"
    # would overstate the residue by a factor of two (measured: 13 of 27).
    if outcome.unmatched_det_ids and outcome.det_by_track:
        by_id = {d.det_id: d for d in kept}
        for det_id in outcome.unmatched_det_ids:
            detection = by_id[det_id]
            best_id: str | None = None
            best_distance = float("inf")
            for track_id in outcome.det_by_track:
                state = track_states[track_id]
                distance = math.hypot(
                    detection.center_enu.e_m - state.pos.e_m,
                    detection.center_enu.n_m - state.pos.n_m,
                )
                if distance < best_distance:
                    best_id, best_distance = track_id, distance
            if best_id is not None and best_distance <= cfg.matching.duplicate_radius_m:
                outcome.duplicate_of[det_id] = best_id

    for track_id in track_ids:
        if track_id in outcome.det_by_track:
            continue
        state = track_states[track_id]
        distance = footprint_distance_m(footprint, frame, state.pos.e_m, state.pos.n_m)
        reason = "no_detection_in_footprint" if distance == 0.0 else "outside_footprint"
        outcome.expected_not_seen.append((track_id, reason, distance))

    return outcome


def nearest_neighbour_reference(
    detections: Sequence[Detection],
    track_states: Mapping[str, TrackState],
    *,
    gate_m: float,
) -> tuple[int, list[float]]:
    """Non-exclusive nearest-neighbour matching: the PLAN 2.8 reference measurement.

    Not the system's matcher - it lets several detections claim the same track,
    which is why it reports a higher match rate than the exclusive assignment
    above. It exists so the two figures can be quoted side by side honestly
    instead of one being mistaken for the other.
    """
    kept = [d for d in detections if d.kept]
    if not kept or not track_states:
        return 0, []
    trk = np.array([[s.pos.e_m, s.pos.n_m] for s in track_states.values()], dtype=float)
    matched = 0
    distances: list[float] = []
    for detection in kept:
        point = np.array([detection.center_enu.e_m, detection.center_enu.n_m], dtype=float)
        distance = float(np.min(np.linalg.norm(trk - point, axis=1)))
        if distance <= gate_m:
            matched += 1
            distances.append(distance)
    return matched, distances
