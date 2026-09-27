"""Configuration loading for Goru (PLAN.md 6.10).

One call, `load_config()`, turns `goru.yaml` plus `.env` into a frozen, typed
`Config`. Callers never read YAML, never touch `os.environ`, and never see the
API key unless they ask for it explicitly.

The module also owns the two provenance hashes that every decision is stamped
with, because they are derived from config and nothing else:

* ``thresholds_version`` - hash of the ``detection`` block; stamped on Detections.
* ``rules_version``      - hash of the ``warning`` + ``zones`` + ``matching`` +
                           ``kinematics`` + ``base`` + ``threat`` blocks; stamped
                           on Alerts and Matches.

Changing a threshold therefore changes the version string, and an alert can
always be traced to the exact numbers that produced it.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import date
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

__all__ = ["Config", "load_config", "ConfigError", "SttConfig", "VoiceConfig"]

DEFAULT_CONFIG_PATH = "goru.yaml"


class ConfigError(Exception):
    """Raised when the config file is missing, malformed or self-inconsistent."""


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class PathsConfig(_Frozen):
    stage2_dir: str = "stage2"
    boxes_csv: str = "bounding_boxes.csv"
    processed_dir: str = "data/processed"


class GeoConfig(_Frozen):
    projection: Literal["linear", "homography"] = "linear"
    ground_point: Literal["center", "bottom_center"] = "center"


class DetectionConfig(_Frozen):
    score_threshold: float = Field(0.35, ge=0.0, le=1.0)
    nms_iou: float = Field(0.50, gt=0.0, le=1.0)
    nms_class_agnostic: bool = True
    min_area_m2: float = Field(3.0, ge=0.0)
    legacy_min_bbox_area_px: float = Field(200.0, ge=0.0)


class MatchingConfig(_Frozen):
    gate_m: float = Field(30.0, gt=0)
    low_conf_m: float = Field(25.0, gt=0)
    duplicate_radius_m: float = Field(12.0, ge=0)
    nn_reference_gate_m: float = Field(60.0, gt=0)
    report_gate_m: float = Field(150.0, gt=0)
    # A report is filed up to two hours before the image it belongs to (measured);
    # the window is the two hours an image's tracks cover.
    report_lookback_min: int = Field(120, gt=0)
    report_claim_radius_m: float = Field(50.0, gt=0)  # the vehicles a report's type and count are about


class RoadsConfig(_Frozen):
    """Map matching (app/roads). `basemap_json` is the file the web app ships."""

    enabled: bool = True
    #: The routing graph (web/scripts/export_roadgraph.py). When it is present
    #: matching runs the real HMM on the topology; when it is not, the engine
    #: falls back to the geometry in `basemap_json`.
    graph_json: str = "data/processed/roadgraph.json"
    basemap_json: str = "web/public/basemap/ankara.json"
    sigma_m: float = Field(20.0, gt=0)
    gate_m: float = Field(30.0, gt=0)
    beta_m: float = Field(120.0, gt=0)
    same_way_bonus: float = Field(1.2, ge=0)


class KinematicsConfig(_Frozen):
    fit_points: int = Field(4, ge=2)
    stationary_disp_m: float = Field(25.0, ge=0)
    max_step_speed_mps: float = Field(40.0, gt=0)


class ZonesConfig(_Frozen):
    default_radius_m: float = Field(250.0, gt=0)
    default_buffer_m: float = Field(750.0, ge=0)
    overrides: dict[str, dict[str, float]] = Field(default_factory=dict)

    def radius_for(self, zone_name: str) -> float:
        return float(self.overrides.get(zone_name, {}).get("radius_m", self.default_radius_m))

    def buffer_for(self, zone_name: str) -> float:
        return float(self.overrides.get(zone_name, {}).get("buffer_m", self.default_buffer_m))


class BaseConfig(_Frozen):
    """The protected asset's rings (team decision, 2026-09-27).

    Merkez Us is what the system protects; the eight zones are observation
    sectors around it. The observation ring is where those sectors sit (measured
    3.19-3.20 km), so crossing inward from it is the transition that matters.
    """

    critical_radius_m: float = Field(1000.0, gt=0)
    warning_radius_m: float = Field(2000.0, gt=0)
    observation_radius_m: float = Field(3200.0, gt=0)

    @model_validator(mode="after")
    def _rings_nest(self) -> "BaseConfig":
        if not self.critical_radius_m < self.warning_radius_m < self.observation_radius_m:
            raise ValueError("base rings must nest: critical < warning < observation")
        return self


class ThreatConfig(_Frozen):
    """When whole-record behaviour counts as an approach or as surveillance."""

    approach_window_min: int = Field(60, gt=0)
    approach_min_closing_m: float = Field(1500.0, gt=0)
    approach_heading_cos: float = Field(0.7, ge=-1, le=1)
    circling_min_sweep_deg: float = Field(90.0, gt=0)
    circling_strong_sweep_deg: float = Field(180.0, gt=0)
    circling_max_range_spread: float = Field(0.35, gt=0)
    loiter_min: float = Field(30.0, gt=0)
    dwell_radius_m: float = Field(3000.0, gt=0)


class WarningConfig(_Frozen):
    horizon_min: int = Field(30, gt=0)
    alert_eta_min: float = Field(10.0, gt=0)
    alert_conf: float = Field(0.6, ge=0, le=1)
    watch_conf: float = Field(0.4, ge=0, le=1)
    heavy_vehicle_multiplier: float = Field(1.25, ge=1)
    downgrade_consecutive: int = Field(2, ge=1)

    @property
    def horizon_s(self) -> float:
        return self.horizon_min * 60.0

    @property
    def alert_eta_s(self) -> float:
        return self.alert_eta_min * 60.0


class SimConfig(_Frozen):
    start: str = "08:10"
    end: str = "15:50"
    default_speed: float = 120.0
    tick_sim_s: int = 60


class AgentCallConfig(_Frozen):
    reasoning_effort: Literal["low", "high", "max"] = "low"
    max_tokens: int = Field(4000, ge=1000)  # 6.11: max_tokens covers thinking


class PricingConfig(_Frozen):
    input_usd_per_mtok: float = Field(0.10, ge=0)
    output_usd_per_mtok: float = Field(0.30, ge=0)


class AgentsConfig(_Frozen):
    enabled: bool = True
    cache_only: bool = False
    base_url: str
    model: str = "glm-5.3-flash"
    api_key_env: str = "GLM_API_KEY"
    assess: AgentCallConfig = AgentCallConfig(reasoning_effort="low", max_tokens=4000)
    parse: AgentCallConfig = AgentCallConfig(reasoning_effort="low", max_tokens=1500)
    copilot: AgentCallConfig = AgentCallConfig(reasoning_effort="high", max_tokens=6000)
    voice: AgentCallConfig = AgentCallConfig(reasoning_effort="low", max_tokens=1200)
    max_concurrency: int = Field(4, ge=1)
    requests_per_min: int = Field(55, ge=1)
    timeout_s: float = Field(45.0, gt=0)
    max_retries: int = Field(5, ge=0)
    budget_cap_usd: float = Field(15.0, gt=0)
    budget_soft_stop_usd: float = Field(11.0, gt=0)
    send_images: bool = False
    max_tool_calls: int = Field(10, ge=1)
    cache_dir: str = "data/processed/agent_cache"
    budget_file: str = "data/processed/agent_budget.json"
    runs_file: str = "data/processed/agent_runs.jsonl"
    pricing: PricingConfig = PricingConfig()

    def call_config(self, kind: str) -> AgentCallConfig:
        """Per-agent sampling settings. `kind` is one of assess|parse|copilot|voice."""
        value = getattr(self, kind, None)
        if not isinstance(value, AgentCallConfig):
            raise ConfigError(f"unknown agent kind {kind!r}")
        return value


class SttConfig(_Frozen):
    """Local speech-to-text (stt.md phases 1-11).

    Every number a transcription depends on lives here, for the same reason the
    detection thresholds do: a transcript that reached the agent should be
    traceable to the exact settings that produced it.
    """

    enabled: bool = True
    provider: Literal["local_whisper", "scripted"] = "local_whisper"
    model: str = "oguzhangokboru/whisper-large-v3-tr"
    device: Literal["auto", "cuda", "cpu"] = "auto"
    compute_type: Literal["auto", "float16", "int8_float16", "int8", "float32"] = "float16"
    language: str = "tr"
    beam_size: int = Field(1, ge=1, le=10)
    condition_on_previous_text: bool = False
    vad_filter: bool = True
    vad_min_silence_ms: int = Field(500, ge=0, le=5000)
    vad_speech_pad_ms: int = Field(200, ge=0, le=2000)
    max_utterance_s: float = Field(15.0, gt=0, le=120)
    min_utterance_s: float = Field(0.25, ge=0)
    sample_rate: int = Field(16000, ge=8000, le=48000)
    warm_on_start: bool = True
    host: str = "127.0.0.1"
    port: int = Field(8800, ge=1, le=65535)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    metrics_file: str = "data/processed/stt_runs.jsonl"


class VoiceConfig(_Frozen):
    """What a finalised transcript is allowed to do.

    `admin` is a team decision recorded in the step log: speech reaches every
    command in the registry, including the one that writes an operator decision.
    `confirm_audit_commands` is the one safeguard left on that path.
    """

    enabled: bool = True
    admin: bool = True
    registry_file: str = "contracts/voice_commands.json"
    confirm_audit_commands: bool = True
    confirm_timeout_s: float = Field(20.0, gt=0)
    router: Literal["llm"] = "llm"
    max_transcript_chars: int = Field(400, ge=1)


class JevConfig(_Frozen):
    enabled: bool = True
    cache_only: bool = False
    model: str = "jev-latest"
    api_key_env: str = "TYPESAFE_API_KEY"
    timeout_s: float = Field(10.0, gt=0)
    budget_cap_usd: float = Field(5.0, gt=0)
    input_usd_per_mtok: float = Field(0.042, ge=0)
    cache_dir: str = "data/processed/jev_cache"
    budget_file: str = "data/processed/jev_budget.json"


class SecurityConfig(_Frozen):
    jwt_ttl_h: int = Field(8, gt=0)
    retention_days: int = Field(7, gt=0)


class Config(_Frozen):
    """The whole configuration, frozen. Built only by `load_config`."""

    exercise_date: date
    tz: str
    paths: PathsConfig = PathsConfig()
    geo: GeoConfig = GeoConfig()
    detection: DetectionConfig = DetectionConfig()
    matching: MatchingConfig = MatchingConfig()
    kinematics: KinematicsConfig = KinematicsConfig()
    roads: RoadsConfig = RoadsConfig()
    zones: ZonesConfig = ZonesConfig()
    base: BaseConfig = BaseConfig()
    threat: ThreatConfig = ThreatConfig()
    warning: WarningConfig = WarningConfig()
    sim: SimConfig = SimConfig()
    agents: AgentsConfig
    stt: SttConfig = SttConfig()
    voice: VoiceConfig = VoiceConfig()
    jev: JevConfig = JevConfig()
    security: SecurityConfig = SecurityConfig()

    # Set by load_config; not read from the file.
    root: Path = Path(".")
    thresholds_version: str = ""
    rules_version: str = ""

    @property
    def tzinfo(self) -> ZoneInfo:
        return ZoneInfo(self.tz)

    def resolve(self, relative: str) -> Path:
        """Resolve a config-relative path against the project root."""
        p = Path(relative)
        return p if p.is_absolute() else self.root / p

    @property
    def stage2_dir(self) -> Path:
        return self.resolve(self.paths.stage2_dir)

    @property
    def boxes_csv(self) -> Path:
        return self.resolve(self.paths.boxes_csv)

    def agent_api_key(self) -> str | None:
        """The gateway key from the environment, or None if unset.

        Deliberately a method and not a field: the key must never end up in a
        model dump, a log line, a prompt or an audit payload.
        """
        value = os.environ.get(self.agents.api_key_env, "").strip()
        return value or None

    def jev_api_key(self) -> str | None:
        value = os.environ.get(self.jev.api_key_env, "").strip()
        return value or None


def _digest(blocks: dict[str, Any]) -> str:
    canonical = json.dumps(blocks, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def load_config(path: str | Path | None = None, *, load_env: bool = True) -> Config:
    """Read `goru.yaml` (and `.env`) and return a frozen, validated Config.

    `path` defaults to `goru.yaml` in the current directory. The project root is
    taken to be the directory containing the config file, so every relative path
    in the file resolves the same way no matter where the process was started.
    """
    cfg_path = Path(path) if path else Path(DEFAULT_CONFIG_PATH)
    if not cfg_path.is_absolute():
        cfg_path = Path.cwd() / cfg_path
    if not cfg_path.exists():
        raise ConfigError(f"config file not found: {cfg_path}")

    root = cfg_path.parent

    if load_env:
        try:
            from dotenv import load_dotenv
        except ImportError:  # pragma: no cover - dotenv is a declared dependency
            pass
        else:
            load_dotenv(root / ".env", override=False)

    try:
        raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{cfg_path.name} is not valid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{cfg_path.name} must contain a mapping at the top level")

    raw = dict(raw)
    raw["root"] = root
    raw["thresholds_version"] = _digest(
        {"detection": raw.get("detection", {}), "geo": raw.get("geo", {})}
    )
    raw["rules_version"] = _digest(
        {
            "warning": raw.get("warning", {}),
            "zones": raw.get("zones", {}),
            "matching": raw.get("matching", {}),
            "kinematics": raw.get("kinematics", {}),
            "base": raw.get("base", {}),
            "threat": raw.get("threat", {}),
        }
    )

    try:
        cfg = Config(**raw)
    except Exception as exc:  # pydantic ValidationError, or a bad type
        raise ConfigError(f"invalid configuration in {cfg_path.name}: {exc}") from exc

    if cfg.agents.budget_soft_stop_usd > cfg.agents.budget_cap_usd:
        raise ConfigError("agents.budget_soft_stop_usd must not exceed budget_cap_usd")
    if cfg.matching.low_conf_m > cfg.matching.gate_m:
        raise ConfigError("matching.low_conf_m must not exceed matching.gate_m")
    if cfg.stt.min_utterance_s >= cfg.stt.max_utterance_s:
        raise ConfigError("stt.min_utterance_s must be below stt.max_utterance_s")
    if cfg.stt.language != "tr":
        # The model is a Turkish fine-tune of large-v3. Asking it for another
        # language does not fail, it just transcribes badly, which is worse.
        raise ConfigError(
            f"stt.language must be 'tr' for {cfg.stt.model!r}; got {cfg.stt.language!r}"
        )
    return cfg
