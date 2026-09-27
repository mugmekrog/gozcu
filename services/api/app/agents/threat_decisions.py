"""Typed threat choices over the assessor's evidence bundle."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from goru_core.schemas import Alert, EvidenceBundle, ImageAssessment, Level


@dataclass(frozen=True)
class ChoiceQuestion:
    instructions: str
    criteria: list[str]
    type: str = "score"


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


_CRITERIA = [
    "The evidence does not support the assessor's effective decision.",
    "The evidence supports the assessor's effective decision.",
]


def build_request(bundle: EvidenceBundle, *, model: str, assessment: ImageAssessment | None = None) -> JevRequest:
    assessed = {item.track_id: item for item in assessment.assessments} if assessment else {}
    questions = {
        vehicle.track_id: ChoiceQuestion(
            instructions=(
                f"For vehicle {vehicle.track_id}, score how strongly the full evidence supports "
                f"the effective {Level.highest(vehicle.baseline_level, assessed[vehicle.track_id].level).value if vehicle.track_id in assessed else vehicle.baseline_level.value} decision. "
                "Do not choose or change a threat level. "
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
                "Where `map_match` is present it is the same track read against the "
                "road network: `roads` names the roads it used, in order. Read "
                "`matched_fraction` first - it is the share of fixes close enough to a "
                "mapped road to snap to one, about half for a typical vehicle here, so "
                "`roads` is a partial itinerary. A road missing from the list is not "
                "evidence the vehicle avoided it. The raw measurements above outrank "
                "the map match wherever the two disagree. "
            ),
            criteria=list(_CRITERIA),
        )
        for vehicle in bundle.vehicles
    }
    state = bundle.model_dump(mode="json")
    state["assessor_decision"] = assessment.model_dump(mode="json") if assessment else None
    return JevRequest(model=model, state=state, questions=questions)


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
        score, probabilities = valid
        level = baseline
        decisions[track_id] = ThreatDecision(
            track_id,
            baseline,
            level,
            None,
            score,
            probabilities,
            "jev",
        )
    return decisions


def _valid_choice(answer: Any) -> tuple[float, dict[str, float]] | None:
    if not isinstance(answer, dict) or answer.get("type") != "score":
        return None
    try:
        score = float(answer["score"])
        raw = answer["probabilities"]
        if not isinstance(raw, dict) or set(raw) != {"0", "1"}:
            return None
        probabilities = {key: float(value) for key, value in raw.items()}
    except (KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(score) or not 0 <= score <= 1:
        return None
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()):
        return None
    if abs(sum(probabilities.values()) - 1) > 0.01:
        return None
    if abs(probabilities["1"] - score) > 0.01:
        return None
    return score, probabilities


def apply_threat_decisions(
    alerts: list[Alert],
    bundle: EvidenceBundle,
    decisions: dict[str, ThreatDecision],
    *,
    ts: datetime,
    rules_version: str,
) -> list[Alert]:
    """Attach Jev's second opinion without changing a rule or assessor level."""
    updated: list[Alert] = []
    for alert in alerts:
        decision = decisions.get(alert.track_id)
        if decision is None:
            updated.append(alert)
            continue
        updated.append(
            alert.model_copy(
                update={
                    "jev_level": decision.jev_level,
                    "jev_confidence": decision.jev_confidence,
                    "agent_dissent": "modeller ayrışıyor" if decision.jev_confidence is not None
                    and decision.jev_confidence < 0.5 else alert.agent_dissent,
                    "updated_ts": ts,
                }
            )
        )
    updated.sort(key=lambda alert: (-alert.level.rank, -alert.priority))
    return updated
