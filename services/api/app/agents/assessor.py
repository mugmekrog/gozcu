"""The ImageAssessor: the graded deliverable (PLAN.md 6.9, tasks M3.1-M3.2).

The brief asks for an agent that evaluates an image together with the movement
data and the field reports, and states what needs attention, why, and on what
evidence. This is that agent.

It owns only four things - its prompt, its output schema, its guardrails and its
fallback. Everything else (cache, budget, retry, audit) belongs to the runner, and
the facts it reasons over belong to the engine. That division is what makes the
central claim testable: the agent supplies judgement, never facts, and it can
raise a warning but never lower one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Sequence

from goru_core.config import Config
from goru_core.schemas import (
    AgentAssessment,
    Alert,
    EvidenceBundle,
    ImageAssessment,
    Level,
)

from app.agents.guardrails import (
    check_citations,
    check_numeric_drift,
    check_zone_scope,
    collect_bundle_numbers,
    data_block,
    enforce_floor,
    strict_json_schema,
    vehicle_numbers,
)
from app.agents.runner import ValidationResult
from app.llm.port import Message

__all__ = ["ImageAssessorPolicy", "apply_assessment_to_alerts", "PROMPT_DIR"]

PROMPT_DIR = Path(__file__).parent / "prompts"
MAX_RATIONALE_BULLETS = 3


@lru_cache(maxsize=8)
def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


@dataclass(frozen=True)
class ImageAssessorPolicy:
    """Assess one image's vehicles from its evidence bundle."""

    cfg: Config
    kind: str = "assess"
    schema_name: str = "image_assessment"

    # --- prompt ----------------------------------------------------------- #

    def build_messages(self, payload: EvidenceBundle) -> list[Message]:
        bundle_json = payload.model_dump_json(indent=None, exclude_none=False)
        user = (
            f"Assess image {payload.image.image_id}, captured at {payload.image.capture_hhmm}.\n"
            f"{len(payload.vehicles)} vehicle(s) with movement records, "
            f"{len(payload.untracked_detections)} detection(s) without one, "
            f"{len(payload.expected_not_seen)} record(s) with no detection, "
            f"{len(payload.reports_in_window)} field report(s) in the window.\n\n"
            + data_block("EVIDENCE", bundle_json)
            + "\n\nReturn the JSON object described in your instructions."
        )
        return [
            {"role": "system", "content": _prompt("assessor_system.md")},
            {"role": "user", "content": user},
        ]

    def response_schema(self) -> dict[str, Any] | None:
        return strict_json_schema(ImageAssessment)

    # --- guardrails ------------------------------------------------------- #

    def validate(self, data: dict[str, Any], payload: EvidenceBundle) -> ValidationResult:
        """Check the answer against the bundle. Order matters: fatal first."""
        try:
            assessment = ImageAssessment.model_validate(data)
        except Exception as exc:  # pydantic ValidationError
            return ValidationResult(value=None, problems=[f"output does not match the schema: {exc}"])

        problems: list[str] = []
        warnings: list[str] = []

        known_tracks = {v.track_id for v in payload.vehicles} | {
            m.track_id for m in payload.expected_not_seen
        }
        allowed_ids = payload.citable_ids()

        unknown = sorted({a.track_id for a in assessment.assessments} - known_tracks)
        if unknown:
            problems.append(
                f"assessments reference track ids that are not in the bundle: {', '.join(unknown)}"
            )

        duplicates = _duplicate_track_ids(assessment.assessments)
        if duplicates:
            problems.append(f"more than one assessment for: {', '.join(duplicates)}")

        invented = check_citations(
            (cited for item in assessment.assessments for cited in item.cited_ids), allowed_ids
        )
        if invented:
            problems.append(f"cited ids that do not exist: {', '.join(invented)}")

        bad_conflicts = check_citations(
            (conflict.report_id for item in assessment.assessments for conflict in item.report_conflicts),
            {r.report_id for r in payload.reports_in_window},
        )
        if bad_conflicts:
            problems.append(f"report_conflicts cite unknown reports: {', '.join(bad_conflicts)}")

        # Reasoning about a zone that was not supplied for this vehicle means the
        # geometry being quoted was not supplied either. Fatal, and worth a retry.
        problems.extend(check_zone_scope(assessment.assessments, payload))

        if problems:
            return ValidationResult(value=None, problems=problems)

        missing = sorted(known_tracks - {a.track_id for a in assessment.assessments})
        if missing:
            warnings.append(f"no assessment returned for: {', '.join(missing)}")

        over_long = [a.track_id for a in assessment.assessments if len(a.rationale) > MAX_RATIONALE_BULLETS]
        if over_long:
            warnings.append(f"more than {MAX_RATIONALE_BULLETS} rationale bullets for: {', '.join(over_long)}")

        # Drift is checked against each vehicle's own numbers, not the bundle's
        # whole set, so quoting another vehicle's figures is caught too.
        for item in assessment.assessments:
            for problem in check_numeric_drift(item.rationale, vehicle_numbers(payload, item.track_id)):
                warnings.append(f"{item.track_id}: {problem}")
        warnings.extend(
            check_numeric_drift([assessment.image_summary], collect_bundle_numbers(payload))
        )

        corrected, dissents = enforce_floor(assessment.assessments, payload)
        if dissents:
            warnings.extend(
                f"agent tried to lower {track_id} below the baseline; baseline kept"
                for track_id in sorted(dissents)
            )

        # Fill in the vehicles the model skipped, so the display is never blank.
        covered = {a.track_id for a in corrected}
        for filled in self._template_assessments(payload):
            if filled.track_id not in covered:
                corrected.append(filled)

        value = assessment.model_copy(update={"assessments": corrected})
        return ValidationResult(value=value, problems=[], warnings=warnings, extra={"dissents": dissents})

    # --- fallback --------------------------------------------------------- #

    def fallback(self, payload: EvidenceBundle) -> ImageAssessment:
        """The deterministic template answer (PLAN 9.3): baseline levels, code-written reasons."""
        assessments = self._template_assessments(payload)
        attention = sum(1 for a in assessments if a.needs_attention)
        return ImageAssessment(
            assessments=assessments,
            image_summary=(
                f"Template assessment for {payload.image.image_id} at {payload.image.capture_hhmm}: "
                f"{len(payload.vehicles)} vehicle(s), {attention} needing attention on the rule "
                f"baseline. Generated without the model."
            ),
        )

    def _template_assessments(self, payload: EvidenceBundle) -> list[AgentAssessment]:
        """One entry per track in the bundle, deduplicated.

        A track with no detection appears in both `vehicles` and
        `expected_not_seen`; emitting it twice would produce two assessments for
        one vehicle, which the duplicate check then rejects.
        """
        not_seen = {item.track_id: item for item in payload.expected_not_seen}
        out: list[AgentAssessment] = []
        for vehicle in payload.vehicles:
            cited = [vehicle.track_id]
            if vehicle.det_id:
                cited.append(vehicle.det_id)
            cited.extend(zone.zone_id for zone in vehicle.zones[:1])
            reasons = list(vehicle.reasons[:MAX_RATIONALE_BULLETS])
            missing = not_seen.get(vehicle.track_id)
            if missing is not None and len(reasons) < MAX_RATIONALE_BULLETS:
                reasons.append(
                    f"movement record present but no detection in this image "
                    f"({missing.reason.replace('_', ' ')}, "
                    f"{missing.dist_to_footprint_m:.0f} m from the footprint)"
                )
            out.append(
                AgentAssessment(
                    track_id=vehicle.track_id,
                    level=vehicle.baseline_level,
                    needs_attention=vehicle.baseline_level is not Level.CLEAR,
                    rationale=reasons,
                    cited_ids=cited,
                    report_conflicts=[],
                )
            )
        covered = {item.track_id for item in out}
        for missing in payload.expected_not_seen:
            if missing.track_id in covered:
                continue
            out.append(
                AgentAssessment(
                    track_id=missing.track_id,
                    level=missing.baseline_level,
                    needs_attention=missing.baseline_level is not Level.CLEAR,
                    rationale=[
                        f"movement record present but no detection in this image "
                        f"({missing.reason.replace('_', ' ')}, "
                        f"{missing.dist_to_footprint_m:.0f} m from the footprint)"
                    ],
                    cited_ids=[missing.track_id],
                    report_conflicts=[],
                )
            )
        return out

    # --- audit ------------------------------------------------------------ #

    def cited_ids(self, value: ImageAssessment) -> list[str]:
        return sorted({cited for item in value.assessments for cited in item.cited_ids})

    def input_refs(self, payload: EvidenceBundle) -> list[str]:
        return [payload.image.image_id, *(v.track_id for v in payload.vehicles)]

    def output_json(self, value: ImageAssessment) -> dict[str, Any]:
        return value.model_dump(mode="json")


def _duplicate_track_ids(assessments: Sequence[AgentAssessment]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in assessments:
        if item.track_id in seen:
            duplicates.add(item.track_id)
        seen.add(item.track_id)
    return sorted(duplicates)


def apply_assessment_to_alerts(
    alerts: Sequence[Alert],
    assessment: ImageAssessment,
    *,
    bundle: EvidenceBundle,
    run_id: str,
    dissents: dict[str, str] | None = None,
    fallback_used: bool = False,
    ts: datetime | None = None,
    rules_version: str = "",
) -> list[Alert]:
    """Merge the agent's verdict into the baseline alerts (PLAN 6.9).

    `level` becomes the stronger of the two, the source is recorded, and any
    dissent is carried as text. Where the agent raises a vehicle the rules left
    CLEAR, a new alert is created - otherwise the agent could see something the
    rules missed and it would never reach the queue.
    """
    dissents = dissents or {}
    by_track = {item.track_id: item for item in assessment.assessments}
    updated: list[Alert] = []
    touched: set[str] = set()

    for alert in alerts:
        item = by_track.get(alert.track_id)
        if item is None:
            updated.append(alert)
            continue
        touched.add(alert.track_id)
        level = Level.highest(alert.baseline_level, item.level)
        updated.append(
            alert.model_copy(
                update={
                    "agent_level": item.level,
                    "level": level,
                    "source": "rules_fallback" if fallback_used else "agent",
                    "agent_rationale": list(item.rationale),
                    "agent_dissent": dissents.get(alert.track_id),
                    "agent_run_id": run_id,
                    "evidence": sorted(set(alert.evidence) | set(item.cited_ids)),
                    "updated_ts": ts or alert.updated_ts,
                }
            )
        )

    for track_id, item in by_track.items():
        if track_id in touched or item.level is Level.CLEAR:
            continue
        baseline = bundle.baseline_for(track_id)
        if baseline is not Level.CLEAR:
            continue  # the rules already raised it; an alert exists above
        stamp = ts or datetime.now().astimezone()
        updated.append(
            Alert(
                alert_id=f"A-{bundle.image.image_id}-{track_id}",
                track_id=track_id,
                zone_id=_first_zone_id(item, bundle),
                baseline_level=Level.CLEAR,
                agent_level=item.level,
                level=item.level,
                source="agent",
                priority=0.2 if item.level is Level.WATCH else 0.5,
                reasons=[f"raised by the assessment agent above a CLEAR rule baseline"],
                agent_rationale=list(item.rationale),
                agent_run_id=run_id,
                evidence=list(item.cited_ids),
                first_raised_ts=stamp,
                updated_ts=stamp,
                rules_version=rules_version,
            )
        )

    updated.sort(key=lambda a: (-a.level.rank, -a.priority))
    return updated


def _first_zone_id(item: AgentAssessment, bundle: EvidenceBundle) -> str | None:
    zone_ids = {zone.zone_id for zone in bundle.zone_catalog}
    for cited in item.cited_ids:
        if cited in zone_ids:
            return cited
    for vehicle in bundle.vehicles:
        if vehicle.track_id == item.track_id and vehicle.zones:
            return vehicle.zones[0].zone_id
    return None
