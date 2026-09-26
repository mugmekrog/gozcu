"""Frozen shared contracts (PLAN.md 5.1).

Every entity that crosses a seam - loader to engine, engine to agent, engine to
API, API to display - is defined here exactly once. The agent's input
(`EvidenceBundle`) and its permitted output (`ImageAssessment`, `ParsedReport`)
are contracts too: that is what makes "the model may not invent a fact" a
checkable property rather than a hope.

Changing anything in this file is a contract change (PLAN 5, frozen at H2).
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "Level",
    "LatLon",
    "ENU",
    "VehicleClass",
    "Corners",
    "ImageMeta",
    "Detection",
    "TrackPoint",
    "TrackState",
    "Zone",
    "Match",
    "ZoneAssessment",
    "Alert",
    "ReportKind",
    "ReportConsistency",
    "ParsedReport",
    "FieldReport",
    "AgentRun",
    "AuditEvent",
    "ValidationIssue",
    "ZoneEvidence",
    "VehicleEvidence",
    "UntrackedDetection",
    "ExpectedNotSeen",
    "ReportEvidence",
    "ImageEvidence",
    "EvidenceBundle",
    "ReportConflict",
    "AgentAssessment",
    "ImageAssessment",
    "AgentReportParse",
]

VehicleClass = Literal["car", "van", "truck", "bus"]
Probability = Annotated[float, Field(ge=0.0, le=1.0)]


class Level(str, Enum):
    """Warning level. Ordered, because the agent may raise but never lower one."""

    CLEAR = "CLEAR"
    WATCH = "WATCH"
    ALERT = "ALERT"

    @property
    def rank(self) -> int:
        return {"CLEAR": 0, "WATCH": 1, "ALERT": 2}[self.value]

    @classmethod
    def highest(cls, *levels: "Level | None") -> "Level":
        """The strongest of the given levels; missing values count as CLEAR.

        This single function implements PLAN 6.9's central safety property:
        `Alert.level = max(baseline_level, agent_level)`.
        """
        present = [lv for lv in levels if lv is not None]
        return max(present, key=lambda lv: lv.rank) if present else cls.CLEAR


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _StrictAgentModel(BaseModel):
    """Base for models the LLM is allowed to produce. Unknown fields are refused."""

    model_config = ConfigDict(extra="forbid")


class LatLon(_Model):
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)


class ENU(_Model):
    e_m: float
    n_m: float


class Corners(_Model):
    tl: LatLon
    tr: LatLon
    bl: LatLon
    br: LatLon


class SourceRefModel(_Model):
    file_name: str
    file_sha256: str
    record_key: str


class ImageMeta(_Model):
    image_id: str
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    capture_ts: datetime
    corners: Corners
    footprint_enu: list[ENU] = Field(min_length=4, max_length=4)
    gsd_x_m: float = Field(gt=0)
    gsd_y_m: float = Field(gt=0)
    source_ref: SourceRefModel


DropReason = Literal["score<thr", "nms_suppressed", "area<min_m2"]


class Detection(_Model):
    det_id: str
    image_id: str
    cls: VehicleClass
    score: Probability
    bbox_px: list[float] = Field(min_length=4, max_length=4, description="x1,y1,x2,y2")
    area_px: float
    area_m2: float
    center_px: list[float] = Field(min_length=2, max_length=2)
    center_geo: LatLon
    center_enu: ENU
    kept: bool
    drop_reason: Optional[DropReason] = None
    suppressed_by: Optional[str] = None
    thresholds_version: str
    source_ref: SourceRefModel


class TrackPoint(_Model):
    track_id: str
    ts: datetime
    lat: float
    lon: float
    e_m: float
    n_m: float
    source_ref: SourceRefModel


class TrackState(_Model):
    track_id: str
    as_of_ts: datetime
    pos: ENU
    pos_geo: LatLon
    vel_enu: list[float] = Field(min_length=2, max_length=2)
    speed_mps: float = Field(ge=0)
    heading_deg: float = Field(ge=0, lt=360)
    stationary: bool
    last_fix_ts: datetime
    image_id: Optional[str] = None
    class_hint: Optional[VehicleClass] = None
    class_conf: Optional[Probability] = None
    dist_to_base_m: dict[str, Optional[float]] = Field(
        default_factory=dict, description="keys: t-60, t-30, now"
    )
    outlier_steps: int = 0


class Zone(_Model):
    zone_id: str
    name: str
    center: LatLon
    center_enu: ENU
    radius_m: float = Field(gt=0)
    buffer_m: float = Field(ge=0)


class Match(_Model):
    match_id: str
    track_id: str
    evidence_type: Literal["detection", "report"]
    evidence_id: str
    distance_m: float = Field(ge=0)
    gate_m: float = Field(gt=0)
    cost: float
    confidence: Literal["high", "low"]
    rules_version: str


class ZoneAssessment(_Model):
    track_id: str
    zone_id: str
    as_of_ts: datetime
    dist_now_m: float = Field(ge=0)
    cpa_m: float = Field(ge=0)
    t_cpa_s: float = Field(ge=0)
    eta_entry_s: Optional[float] = None
    closing_speed_mps: float
    approach_conf: Probability
    inside_zone: bool
    inside_buffer: bool


class Alert(_Model):
    alert_id: str
    track_id: str
    zone_id: Optional[str] = None
    baseline_level: Level
    agent_level: Optional[Level] = None
    level: Level
    source: Literal["rules", "agent", "rules_fallback"]
    priority: Probability
    reasons: list[str] = Field(default_factory=list)
    agent_rationale: Optional[list[str]] = None
    agent_dissent: Optional[str] = None
    evidence: list[str] = Field(default_factory=list)
    first_raised_ts: datetime
    updated_ts: datetime
    status: Literal["open", "acknowledged", "dismissed"] = "open"
    reviewer: Optional[str] = None
    review_reason: Optional[str] = None
    rules_version: str
    agent_run_id: Optional[str] = None


ReportKind = Literal[
    "sighting",
    "zone_status",
    "negative_claim",
    "unverified",
    "degraded_coverage",
    "area_wide",
    "identified_friendly",
    "irrelevant",
    "unknown",
]
ReportConsistency = Literal["agrees", "contradicts", "unrelated"]


class ParsedReport(_Model):
    geo: Optional[LatLon] = None
    zone_ref: Optional[str] = None
    vehicle_type: Optional[str] = None
    count: Optional[int] = Field(default=None, ge=0)
    kind: ReportKind = "unknown"
    area_wide: bool = False


class FieldReport(_Model):
    report_id: str
    ts: datetime
    source: Literal["official", "third_party"]
    text: str = Field(min_length=1, max_length=2000)
    parsed: ParsedReport
    parser: Literal["regex", "llm"] = "regex"
    parse_conf: Probability = 1.0
    consistency: Optional[ReportConsistency] = None
    consistency_note: Optional[str] = None
    matched_track_ids: list[str] = Field(default_factory=list)
    source_ref: SourceRefModel


class AgentRun(_Model):
    run_id: str
    kind: Literal["assess", "parse", "copilot"]
    model: str
    prompt_sha256: str
    input_refs: list[str] = Field(default_factory=list)
    output_json: dict[str, Any] = Field(default_factory=dict)
    cited_ids: list[str] = Field(default_factory=list)
    valid: bool
    fallback_used: bool
    problems: list[str] = Field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    from_cache: bool = False
    attempts: int = 1
    ts: datetime


class AuditEvent(_Model):
    seq: int
    ts: datetime
    actor: str
    role: str
    action: str
    object_ref: str
    payload_sha256: str
    prev_hash: str
    hash: str


class ValidationIssue(_Model):
    """One validation finding (PLAN 5.3). `error` blocks the file's import."""

    file: str
    pointer: str
    rule: str
    severity: Literal["error", "warning"]
    message: str
    raw: Optional[str] = None


# --------------------------------------------------------------------------- #
# The agent seam: what the engine hands the model, and what it may hand back.
# --------------------------------------------------------------------------- #


class ZoneEvidence(_Model):
    zone_id: str
    name: str
    dist_now_m: float
    cpa_m: float
    eta_entry_s: Optional[float]
    approach_conf: float
    inside_zone: bool
    inside_buffer: bool


class VehicleEvidence(_Model):
    """One vehicle as the agent sees it: computed facts only, no model output.

    Every track belonging to this image appears here, detected or not, because a
    vehicle heading for a zone matters whether or not this frame caught it. When
    `detected` is false the same track is also listed in the bundle's
    `expected_not_seen`, which adds why it was missed.
    """

    track_id: str
    cls: Optional[VehicleClass]
    score: Optional[float]
    det_id: Optional[str]
    match_dist_m: Optional[float]
    match_confidence: Optional[Literal["high", "low"]] = None
    detected: bool = True
    not_seen_reason: Optional[Literal["outside_footprint", "no_detection_in_footprint"]] = None
    speed_mps: float
    heading_deg: float
    stationary: bool
    dist_to_base_m: dict[str, Optional[float]]
    zones: list[ZoneEvidence] = Field(default_factory=list)
    baseline_level: Level
    reasons: list[str] = Field(default_factory=list)


class UntrackedDetection(_Model):
    det_id: str
    cls: VehicleClass
    score: float
    center_geo: LatLon
    nearest_track_id: Optional[str] = None
    nearest_track_dist_m: Optional[float] = None
    inside_buffer_of: Optional[str] = None
    likely_duplicate_of: Optional[str] = Field(
        default=None,
        description=(
            "Track id this detection probably double-counts: it sits within the duplicate "
            "radius of a track that another detection already claimed, so it is an NMS "
            "miss rather than a new object."
        ),
    )


class ExpectedNotSeen(_Model):
    """A track with no detection in this image. Also present in `vehicles`."""

    track_id: str
    reason: Literal["outside_footprint", "no_detection_in_footprint"]
    dist_to_footprint_m: float
    baseline_level: Level


class ReportEvidence(_Model):
    report_id: str
    ts_hhmm: str
    source: Literal["official", "third_party"]
    kind: ReportKind
    text: str
    zone_ref: Optional[str] = None
    geo: Optional[LatLon] = None
    vehicle_type: Optional[str] = None
    count: Optional[int] = None
    matched_track_ids: list[str] = Field(default_factory=list)
    consistency: Optional[ReportConsistency] = None
    consistency_note: Optional[str] = None
    trust_note: Optional[str] = None


class ImageEvidence(_Model):
    image_id: str
    capture_hhmm: str
    width_px: int
    height_px: int
    gsd_x_m: float
    gsd_y_m: float
    raw_box_count: int
    kept_box_count: int


class EvidenceBundle(_Model):
    """Everything the agent is allowed to reason over, and nothing else.

    Deterministic by construction: every number here was computed by the engine
    from the source files. The bundle's hash is the agent cache key, so replaying
    the demo costs nothing.
    """

    bundle_version: Literal[1] = 1
    as_of_hhmm: str
    thresholds_version: str
    rules_version: str
    image: ImageEvidence
    vehicles: list[VehicleEvidence] = Field(default_factory=list)
    untracked_detections: list[UntrackedDetection] = Field(default_factory=list)
    expected_not_seen: list[ExpectedNotSeen] = Field(default_factory=list)
    reports_in_window: list[ReportEvidence] = Field(default_factory=list)
    zone_catalog: list[ZoneEvidence] = Field(default_factory=list)

    def citable_ids(self) -> set[str]:
        """Every id the agent may legitimately cite. Anything else is invented."""
        ids: set[str] = {self.image.image_id}
        for vehicle in self.vehicles:
            ids.add(vehicle.track_id)
            if vehicle.det_id:
                ids.add(vehicle.det_id)
            ids.update(zone.zone_id for zone in vehicle.zones)
            ids.update(zone.name for zone in vehicle.zones)
        for det in self.untracked_detections:
            ids.add(det.det_id)
        for missing in self.expected_not_seen:
            ids.add(missing.track_id)
        for report in self.reports_in_window:
            ids.add(report.report_id)
        for zone in self.zone_catalog:
            ids.add(zone.zone_id)
            ids.add(zone.name)
        return ids

    def baseline_for(self, track_id: str) -> Level:
        for vehicle in self.vehicles:
            if vehicle.track_id == track_id:
                return vehicle.baseline_level
        for missing in self.expected_not_seen:
            if missing.track_id == track_id:
                return missing.baseline_level
        return Level.CLEAR


class ReportConflict(_StrictAgentModel):
    report_id: str
    why: str = Field(max_length=400)


class AgentAssessment(_StrictAgentModel):
    """The agent's verdict for one vehicle."""

    track_id: str
    level: Level
    needs_attention: bool
    rationale: list[str] = Field(default_factory=list, max_length=3)
    cited_ids: list[str] = Field(default_factory=list)
    report_conflicts: list[ReportConflict] = Field(default_factory=list)


class ImageAssessment(_StrictAgentModel):
    """The ImageAssessor's whole output for one image."""

    assessments: list[AgentAssessment] = Field(default_factory=list)
    image_summary: str = Field(default="", max_length=1000)


class AgentReportParse(_StrictAgentModel):
    """The ReportParser's output for one field report."""

    kind: ReportKind
    zone_ref: Optional[str] = None
    geo: Optional[LatLon] = None
    vehicle_type: Optional[str] = None
    count: Optional[int] = Field(default=None, ge=0)
    area_wide: bool = False
    confidence: Probability = 0.5
