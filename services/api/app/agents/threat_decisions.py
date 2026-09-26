"""Typed threat choices over the assessor's evidence bundle."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from goru_core.schemas import Alert, EvidenceBundle, Level


@dataclass(frozen=True)
class ChoiceQuestion:
    instructions: str
    criteria: dict[str, str]
    type: str = "choice"


@dataclass(frozen=True)
class JevRequest:
    model: str
    state: dict[str, Any]
    questions: dict[str, ChoiceQuestion]


@dataclass(frozen=True)
class ThreatDecision:
    track_id: str
    baseline_level: Level
    level: Level
    jev_level: Level | None
    jev_confidence: float | None
    probabilities: dict[str, float] | None
    source: str


_CRITERIA = {
    "CLEAR": "No immediate human review is needed; the vehicle is stationary or far from protected zones.",
    "WATCH": "Human review is warranted because the vehicle may approach or affect a protected zone.",
    "ALERT": "Urgent human review is needed because the vehicle is inside a protected area or poses an imminent threat.",
}


def build_request(bundle: EvidenceBundle, *, model: str) -> JevRequest:
    questions = {
        vehicle.track_id: ChoiceQuestion(
            instructions=(
                f"For vehicle {vehicle.track_id}, choose its threat level from the evidence. "
                "Weigh zone and buffer presence, time to entry, approach confidence, "
                "recent closing movement, vehicle type, and field report consistency. "
                "Where `profile` is present it summarises the whole two-hour record. "
                "Speed: `speed_mean_mps` against `speed_max_mps` shows whether the current "
                "speed is normal for this vehicle. Stops: `moving_fraction`, `stop_count` and "
                "`longest_stop_min` show whether idle time was one long wait or many short "
                "ones. Path: `straightness` near 1 is a beeline and low is wandering, while "
                "`reversals` counts doubling-backs. Range to base: `base_closing_rate_mps` is "
                "positive when the range has been shrinking and `closing_step_fraction` is how "
                "many steps closed it, so a high fraction is a sustained approach rather than "
                "momentary proximity. A low `moving_fraction` with a high `speed_max_mps` is a "
                "vehicle that waited and then moved. `profile.behaviour` names the "
                "behaviours those scalars support and is empty for about four vehicles in "
                "five: `waited_then_moved`, `sustained_approach_to_base`, `doubled_back`, "
                "`direct_run`. A name there means the track stands apart from its peers. "
                "Behaviour unlike a vehicle's own history is context for the choice, never "
                "on its own a reason to raise the level. "
            ),
            criteria=dict(_CRITERIA),
        )
        for vehicle in bundle.vehicles
    }
    return JevRequest(model=model, state=bundle.model_dump(mode="json"), questions=questions)


def resolve_answers(
    bundle: EvidenceBundle, answers: dict[str, Any] | None
) -> dict[str, ThreatDecision]:
    answers = answers or {}
    decisions: dict[str, ThreatDecision] = {}
    for vehicle in bundle.vehicles:
        track_id = vehicle.track_id
        baseline = vehicle.baseline_level
        answer = answers.get(track_id)
        valid = _valid_choice(answer)
        if valid is None:
            decisions[track_id] = ThreatDecision(
                track_id, baseline, baseline, None, None, None, "rules_fallback"
            )
            continue
        choice, confidence, probabilities = valid
        level = Level.highest(baseline, choice)
        decisions[track_id] = ThreatDecision(
            track_id,
            baseline,
            level,
            choice,
            confidence,
            probabilities,
            "rules_floor" if level is not choice else "jev",
        )
    return decisions


def _valid_choice(answer: Any) -> tuple[Level, float, dict[str, float]] | None:
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return None
    try:
        choice = Level(answer["choice"])
        confidence = float(answer["confidence"])
        raw = answer["probabilities"]
        if not isinstance(raw, dict) or set(raw) != set(_CRITERIA):
            return None
        probabilities = {key: float(value) for key, value in raw.items()}
    except (KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        return None
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()):
        return None
    if abs(sum(probabilities.values()) - 1) > 0.01:
        return None
    if probabilities[choice.value] + 0.01 < max(probabilities.values()):
        return None
    return choice, confidence, probabilities


def apply_threat_decisions(
    alerts: list[Alert],
    bundle: EvidenceBundle,
    decisions: dict[str, ThreatDecision],
    *,
    ts: datetime,
    rules_version: str,
) -> list[Alert]:
    """Apply Jev choices while keeping the engine's level as a floor."""
    updated: list[Alert] = []
    covered: set[str] = set()
    for alert in alerts:
        decision = decisions.get(alert.track_id)
        if decision is None:
            updated.append(alert)
            continue
        covered.add(alert.track_id)
        updated.append(
            alert.model_copy(
                update={
                    "level": decision.level,
                    "jev_level": decision.jev_level,
                    "jev_confidence": decision.jev_confidence,
                    "source": decision.source,
                    "updated_ts": ts,
                }
            )
        )
    vehicles = {vehicle.track_id: vehicle for vehicle in bundle.vehicles}
    for track_id, decision in decisions.items():
        if track_id in covered or decision.level is Level.CLEAR:
            continue
        vehicle = vehicles[track_id]
        updated.append(
            Alert(
                alert_id=f"A-{bundle.image.image_id}-{track_id}",
                track_id=track_id,
                zone_id=vehicle.zones[0].zone_id if vehicle.zones else None,
                baseline_level=decision.baseline_level,
                jev_level=decision.jev_level,
                jev_confidence=decision.jev_confidence,
                level=decision.level,
                source=decision.source,
                priority=0.2 if decision.level is Level.WATCH else 0.5,
                reasons=["raised by Jev above the deterministic baseline"],
                evidence=[track_id],
                first_raised_ts=ts,
                updated_ts=ts,
                rules_version=rules_version,
            )
        )
    updated.sort(key=lambda alert: (-alert.level.rank, -alert.priority))
    return updated
