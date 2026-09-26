"""Chat-generated situational detail with no authority over threat levels."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from goru_core.config import Config
from goru_core.schemas import EvidenceBundle, ReportConflict

from app.agents.assessor import ImageAssessorPolicy
from app.agents.guardrails import (
    check_citations,
    check_numeric_drift,
    check_zone_scope,
    collect_bundle_numbers,
    data_block,
    strict_json_schema,
    vehicle_numbers,
)
from app.agents.runner import ValidationResult
from app.llm.port import Message


class ReportItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    track_id: str
    rationale: list[str] = Field(default_factory=list, max_length=3)
    cited_ids: list[str] = Field(default_factory=list)
    report_conflicts: list[ReportConflict] = Field(default_factory=list)


class SituationalReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessments: list[ReportItem] = Field(default_factory=list)
    image_summary: str = Field(default="", max_length=1000)


@dataclass(frozen=True)
class SituationalReportPolicy:
    cfg: Config
    kind: str = "assess"
    schema_name: str = "situational_report"

    def build_messages(self, payload: EvidenceBundle) -> list[Message]:
        instructions = (Path(__file__).parent / "prompts" / "situational_report_system.md").read_text(
            encoding="utf-8"
        )
        return [
            {"role": "system", "content": instructions},
            {
                "role": "user",
                "content": (
                    f"Report on image {payload.image.image_id} at {payload.image.capture_hhmm}.\n"
                    + data_block("EVIDENCE", payload.model_dump_json(exclude_none=False))
                    + "\nReturn the JSON report described in your instructions."
                ),
            },
        ]

    def response_schema(self) -> dict[str, Any]:
        return strict_json_schema(SituationalReport)

    def validate(self, data: dict[str, Any], payload: EvidenceBundle) -> ValidationResult:
        try:
            report = SituationalReport.model_validate(data)
        except Exception as exc:
            return ValidationResult(value=None, problems=[f"output does not match schema: {exc}"])

        known = {v.track_id for v in payload.vehicles}
        ids = [item.track_id for item in report.assessments]
        problems: list[str] = []
        if len(ids) != len(set(ids)):
            problems.append("duplicate track reports")
        if set(ids) - known:
            problems.append("report references unknown tracks")
        invented = check_citations(
            (cited for item in report.assessments for cited in item.cited_ids), payload.citable_ids()
        )
        if invented:
            problems.append(f"unknown citations: {', '.join(invented)}")
        bad_reports = check_citations(
            (c.report_id for item in report.assessments for c in item.report_conflicts),
            {r.report_id for r in payload.reports_in_window},
        )
        if bad_reports:
            problems.append(f"unknown report conflicts: {', '.join(bad_reports)}")
        problems.extend(check_zone_scope(report.assessments, payload))
        if problems:
            return ValidationResult(value=None, problems=problems)

        warnings = check_numeric_drift([report.image_summary], collect_bundle_numbers(payload))
        for item in report.assessments:
            warnings.extend(
                f"{item.track_id}: {problem}"
                for problem in check_numeric_drift(
                    item.rationale, vehicle_numbers(payload, item.track_id)
                )
            )
        covered = set(ids)
        filled = [item for item in self.fallback(payload).assessments if item.track_id not in covered]
        return ValidationResult(
            value=report.model_copy(update={"assessments": [*report.assessments, *filled]}),
            problems=[],
            warnings=warnings,
        )

    def fallback(self, payload: EvidenceBundle) -> SituationalReport:
        template = ImageAssessorPolicy(self.cfg).fallback(payload)
        return SituationalReport(
            image_summary=template.image_summary,
            assessments=[
                ReportItem(
                    track_id=item.track_id,
                    rationale=item.rationale,
                    cited_ids=item.cited_ids,
                    report_conflicts=item.report_conflicts,
                )
                for item in template.assessments
            ],
        )

    def cited_ids(self, value: SituationalReport) -> list[str]:
        return sorted({cited for item in value.assessments for cited in item.cited_ids})

    def input_refs(self, payload: EvidenceBundle) -> list[str]:
        return [payload.image.image_id, *(v.track_id for v in payload.vehicles)]

    def output_json(self, value: SituationalReport) -> dict[str, Any]:
        return value.model_dump(mode="json")
