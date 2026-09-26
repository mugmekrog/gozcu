"""The ReportParser agent (PLAN.md 6.8 step 2, task M3.3).

The rules parser handles the 137 reports' common shapes - coordinates, zone names,
counts and vehicle words - and classifies most of them. What it cannot classify
confidently is handed here, and only that: the LLM is the second pass, not the
first, because a regex that resolves 115 of 137 locations is cheaper, faster and
more predictable than a model call.

On any doubt the regex result stands. A model that cannot improve on the rules
must not be allowed to make things worse.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

from goru_core.config import Config
from goru_core.schemas import AgentReportParse, FieldReport, LatLon, ParsedReport, Zone

from app.agents.guardrails import data_block, strict_json_schema
from app.agents.runner import ValidationResult
from app.llm.port import Message

__all__ = ["ReportParserPolicy", "ReportParsePayload", "merge_parse", "needs_llm_parse"]

PROMPT_DIR = Path(__file__).parent / "prompts"

_VEHICLE_TYPES = {"car", "van", "truck", "bus", "heavy", "vehicle"}


@lru_cache(maxsize=8)
def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def needs_llm_parse(report: FieldReport) -> bool:
    """True when the rules left this report unclassified or unlocated.

    These are the only reports worth spending a model call on: 'unknown' kind, or
    a classification that found no location at all while claiming to describe one.
    """
    parsed = report.parsed
    if parsed.kind == "unknown":
        return True
    if parsed.kind == "sighting" and parsed.geo is None and parsed.zone_ref is None:
        return True
    return False


@dataclass(frozen=True)
class ReportParsePayload:
    """One report plus the zone vocabulary it may refer to."""

    report: FieldReport
    zones: tuple[Zone, ...]

    @property
    def zone_names(self) -> tuple[str, ...]:
        return tuple(z.name for z in self.zones)

    def zone_id_for(self, reference: str | None) -> str | None:
        if not reference:
            return None
        folded = reference.strip().casefold()
        for zone in self.zones:
            if zone.zone_id.casefold() == folded or zone.name.casefold() == folded:
                return zone.zone_id
        return None


@dataclass(frozen=True)
class ReportParserPolicy:
    """Classify one field report the rules could not."""

    cfg: Config
    kind: str = "parse"
    schema_name: str = "report_parse"

    def build_messages(self, payload: ReportParsePayload) -> list[Message]:
        zones = "\n".join(f"- {name}" for name in payload.zone_names)
        user = (
            f"Zone names in this exercise:\n{zones}\n\n"
            f"Report filed at {payload.report.ts.isoformat()} by a "
            f"{payload.report.source} source.\n\n"
            + data_block("REPORT_TEXT", payload.report.text)
            + "\n\nClassify it and return the JSON object described in your instructions."
        )
        return [
            {"role": "system", "content": _prompt("report_parser_system.md")},
            {"role": "user", "content": user},
        ]

    def response_schema(self) -> dict[str, Any] | None:
        return strict_json_schema(AgentReportParse)

    def validate(self, data: dict[str, Any], payload: ReportParsePayload) -> ValidationResult:
        try:
            parsed = AgentReportParse.model_validate(data)
        except Exception as exc:
            return ValidationResult(value=None, problems=[f"output does not match the schema: {exc}"])

        problems: list[str] = []
        warnings: list[str] = []

        if parsed.zone_ref is not None and payload.zone_id_for(parsed.zone_ref) is None:
            problems.append(
                f"zone_ref {parsed.zone_ref!r} is not one of this exercise's zones"
            )
        if parsed.vehicle_type is not None and parsed.vehicle_type not in _VEHICLE_TYPES:
            problems.append(
                f"vehicle_type {parsed.vehicle_type!r} is not one of {sorted(_VEHICLE_TYPES)}"
            )
        if parsed.geo is not None and payload.report.parsed.geo is None:
            # The rules parser found no coordinates in the text, so the model
            # inventing some is exactly the failure mode to catch.
            problems.append("geo returned for a report whose text contains no coordinates")

        if problems:
            return ValidationResult(value=None, problems=problems)

        if parsed.kind != payload.report.parsed.kind and payload.report.parsed.kind != "unknown":
            warnings.append(
                f"model reclassified {payload.report.report_id} from "
                f"{payload.report.parsed.kind} to {parsed.kind}"
            )
        return ValidationResult(value=parsed, problems=[], warnings=warnings)

    def fallback(self, payload: ReportParsePayload) -> AgentReportParse:
        """Keep whatever the rules parser found."""
        rules = payload.report.parsed
        return AgentReportParse(
            kind=rules.kind,
            zone_ref=rules.zone_ref,
            geo=rules.geo,
            vehicle_type=rules.vehicle_type,
            count=rules.count,
            area_wide=rules.area_wide,
            confidence=payload.report.parse_conf,
        )

    def cited_ids(self, value: AgentReportParse) -> list[str]:
        return [value.zone_ref] if value.zone_ref else []

    def input_refs(self, payload: ReportParsePayload) -> list[str]:
        return [payload.report.report_id]

    def output_json(self, value: AgentReportParse) -> dict[str, Any]:
        return value.model_dump(mode="json")


def merge_parse(
    report: FieldReport,
    parsed: AgentReportParse,
    zones: Sequence[Zone],
    *,
    from_model: bool = True,
) -> FieldReport:
    """Apply a model parse to a report without discarding what the rules found.

    The rules parser's coordinates always win: they came from a regex over the
    literal text, and a model has no better source for them.
    """
    zone_id = None
    if parsed.zone_ref:
        folded = parsed.zone_ref.strip().casefold()
        zone_id = next(
            (z.zone_id for z in zones if z.zone_id.casefold() == folded or z.name.casefold() == folded),
            None,
        )

    merged = ParsedReport(
        geo=report.parsed.geo or parsed.geo,
        zone_ref=report.parsed.zone_ref or zone_id,
        vehicle_type=report.parsed.vehicle_type or parsed.vehicle_type,
        count=report.parsed.count if report.parsed.count is not None else parsed.count,
        kind=parsed.kind,
        area_wide=parsed.area_wide or report.parsed.area_wide,
    )
    return report.model_copy(
        update={
            "parsed": merged,
            "parser": "llm" if from_model else "regex",
            "parse_conf": parsed.confidence,
        }
    )
