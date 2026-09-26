"""Configuration loading for Goru (PLAN.md 6.10).

One call, `load_config()`, turns `goru.yaml` plus `.env` into a frozen, typed
`Config`. Callers never read YAML, never touch `os.environ`, and never see the
API key unless they ask for it explicitly.

The module also owns the two provenance hashes that every decision is stamped
with, because they are derived from config and nothing else:

* ``thresholds_version`` - hash of the ``detection`` block; stamped on Detections.
* ``rules_version``      - hash of the ``warning`` + ``zones`` + ``matching`` +
                           ``kinematics`` blocks; stamped on Alerts and Matches.

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
from pydantic import BaseModel, ConfigDict, Field

__all__ = ["Config", "load_config", "ConfigError"]

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
    report_time_window_min: int = Field(15, gt=0)


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
        """Per-agent sampling settings. `kind` is one of assess|parse|copilot."""
        value = getattr(self, kind, None)
        if not isinstance(value, AgentCallConfig):
            raise ConfigError(f"unknown agent kind {kind!r}")
        return value


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
    zones: ZonesConfig = ZonesConfig()
    warning: WarningConfig = WarningConfig()
    sim: SimConfig = SimConfig()
    agents: AgentsConfig
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
    return cfg
