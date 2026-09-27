"""Threat candidates and the evidence behind them (Faz 2, team decision 2026-09-27).

The level says how urgent, the category says what kind of threat - approach or
surveillance of Merkez Us - and the confidence says how much independent evidence
stands behind it. The confidence is not a model's self-report: it is a sum of
labelled terms, each one a fact the operator can check, so "why 0.60?" always has
a list for an answer.

The weights add up to exactly 1.0 at most, so no term is ever clipped away:

    strong signal 0.30 | any signal 0.15      the rule that fired, and how hard
    both families 0.15                         approach and surveillance together
    clear detection 0.15 | detection 0.08      the vehicle is in the image itself
    heavy vehicle 0.10                         a truck or a bus
    verified report 0.15                       a report our data confirmed
    contradicted friendly claim 0.15           "it is one of ours" - and the data disagrees

A friendly claim the data does not contradict adds nothing: identity cannot be
checked from the air, so it is flagged for the human and never counts either way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from goru_core.schemas import FieldReport, Level, Likelihood, ThreatCategory

from app.evidence.bundle import ImageAnalysis
from app.risk.engine import BaselineVerdict

__all__ = ["ThreatCandidate", "assess_threat"]

HEAVY = frozenset({"truck", "bus"})
CLEAR_DETECTION_SCORE = 0.5


@dataclass(frozen=True)
class ThreatCandidate:
    """One vehicle the data raised, with what kind of threat and how sure we are."""

    track_id: str
    level: Level
    category: ThreatCategory | None
    likelihood: Likelihood | None
    confidence: float
    terms: tuple[tuple[str, float], ...]
    flags: tuple[str, ...] = ()  # not_detected | contradicted_friendly_claim | friendly_claim_unconfirmed_identity
    report_ids: tuple[str, ...] = ()


def assess_threat(
    track_id: str,
    verdict: BaselineVerdict,
    analysis: ImageAnalysis,
    *,
    reports: Sequence[FieldReport],
) -> ThreatCandidate | None:
    """The threat candidate for one vehicle, or None when the data raised nothing."""
    if verdict.level is Level.CLEAR:
        return None

    terms: list[tuple[str, float]] = []
    flags: list[str] = []

    if any(signal.strong for signal in verdict.signals):
        terms.append(("Güçlü sinyal", 0.30))
    elif verdict.signals:
        terms.append(("Sinyal", 0.15))
    if len({signal.category for signal in verdict.signals}) > 1:
        terms.append(("Yaklaşma ve gözetleme birlikte", 0.15))

    det_id = analysis.match.det_by_track.get(track_id) if analysis.match else None
    detection = analysis.detection_by_id(det_id) if det_id else None
    if detection is None:
        flags.append("not_detected")  # a record without a sighting: a coverage gap, not evidence
    else:
        row = next((m for m in analysis.match.matches if m.track_id == track_id), None)
        clear = detection.score >= CLEAR_DETECTION_SCORE and row is not None and row.confidence == "high"
        terms.append(("Görüntüde net tespit", 0.15) if clear else ("Görüntüde tespit", 0.08))

    state = analysis.track_states.get(track_id)
    if state is not None and state.class_hint in HEAVY:
        terms.append(("Ağır araç", 0.10))

    linked = [r for r in reports if track_id in r.matched_track_ids]
    if any(r.verdict == "verified" and not r.parsed.friendly for r in linked):
        terms.append(("Doğrulanmış rapor", 0.15))
    if any(r.parsed.friendly and r.verdict == "contradicted" for r in linked):
        terms.append(("Çelişen dost iddiası", 0.15))
        flags.append("contradicted_friendly_claim")
    elif any(r.parsed.friendly for r in linked):
        flags.append("friendly_claim_unconfirmed_identity")

    return ThreatCandidate(
        track_id=track_id,
        level=verdict.level,
        category=verdict.category,
        likelihood=verdict.likelihood,
        confidence=sum(points for _, points in terms),
        terms=tuple(terms),
        flags=tuple(flags),
        report_ids=tuple(r.report_id for r in linked),
    )
