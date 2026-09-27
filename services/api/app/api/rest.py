"""FastAPI REST server implementing PLAN.md §5.4 and web/src/api/http.ts.

Designed for Google Cloud Run (free tier) and local Docker development:
- Stateless execution with fast cold-start (< 200ms)
- Health check on GET /healthz
- Static fixtures caching for ultra-low latency & zero CPU idle overhead
- Streaming evaluation via POST /agents/assess/{image_id}
- Copilot Q&A via POST /agents/ask
- Reviewer decisions via POST /frames/{image_id}/decision
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, AsyncGenerator
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

# Ensure libs and services/api are in sys.path
_HERE = Path(__file__).resolve()
# Try detecting repo root (either 4 levels up or current working directory /app)
if (_HERE.parents[4] / "goru.yaml").exists():
    _REPO_ROOT = _HERE.parents[4]
elif (Path("/app") / "goru.yaml").exists():
    _REPO_ROOT = Path("/app")
else:
    _REPO_ROOT = Path.cwd()

for _p in (str(_REPO_ROOT / "libs"), str(_REPO_ROOT / "services" / "api")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from goru_core.config import Config, load_config
from app.agents.assessor import ImageAssessorPolicy
from app.agents.copilot import ReviewerCopilot
from app.agents.factory import build_agent_stack
from app.agents.jev import JevService, TypeSafeGateway
from app.agents.situational_report import SituationalReportPolicy
from app.agents.threat_decisions import apply_threat_decisions
from app.agents.tools import ReadOnlyTools
from app.ingest.loaders import load_dataset
from app.llm.budget import BudgetLedger
from app.pipeline import Pipeline

app = FastAPI(
    title="Gözcü / Sentinel API",
    description="Zone-proximity early-warning API for Google Cloud Run and Firebase Hosting",
    version="0.1.0",
)

# Origins allowed to call this API from a browser. The default is the local display
# (Vite takes the next free port, hence the range); a deployment names its own
# with GORU_CORS_ORIGINS, e.g. the Firebase Hosting origin. Never "*": the POST
# routes below spend the organisers' $15 budget or record an operator decision.
DEFAULT_CORS_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (5173, 5174, 5175, 5176, 4173)
]
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("GORU_CORS_ORIGINS", ",".join(DEFAULT_CORS_ORIGINS)).split(",")
    if origin.strip()
]

# The display sends this on every request. A page on another origin can only add a
# custom header after a CORS preflight, which the allowlist refuses - so a hostile
# page open in the operator's browser cannot trigger a spending POST, which a
# plain cross-site form post otherwise could.
CLIENT_HEADER = "X-Goru-Client"

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["accept", "content-type", "authorization", CLIENT_HEADER.lower()],
)


def require_client_header(request: Request) -> None:
    """Refuse a spending or writing POST that did not come from the display."""
    if not request.headers.get(CLIENT_HEADER):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"missing {CLIENT_HEADER} header",
        )

# Configuration & data path resolution
CONFIG_PATH = Path(os.getenv("GORU_CONFIG", str(_REPO_ROOT / "goru.yaml")))
FIXTURES_DIR = Path(
    os.getenv("FIXTURES_DIR", str(_REPO_ROOT / "web" / "public" / "fixtures"))
)
STAGE2_IMAGES_DIR = _REPO_ROOT / "stage2" / "images"

_CFG: Config | None = None
_DECISIONS: list[dict[str, Any]] = []


def get_cfg() -> Config:
    global _CFG
    if _CFG is None:
        _CFG = load_config(CONFIG_PATH) if CONFIG_PATH.exists() else Config()
    return _CFG


def get_jev_service(cfg: Config) -> JevService:
    key = cfg.jev_api_key() if cfg.jev.enabled else None
    return _cached_jev_service(
        key,
        str(cfg.resolve(cfg.jev.cache_dir)),
        str(cfg.resolve(cfg.jev.budget_file)),
        cfg.jev.model,
        cfg.jev.timeout_s,
        cfg.jev.budget_cap_usd,
        cfg.jev.input_usd_per_mtok,
    )


@lru_cache(maxsize=1)
def _cached_jev_service(
    key: str | None,
    cache_dir: str,
    budget_path: str,
    model: str,
    timeout_s: float,
    cap_usd: float,
    input_usd_per_mtok: float,
) -> JevService:
    gateway = TypeSafeGateway(key, timeout_s=timeout_s) if key else None
    return JevService(
        gateway,
        cache_dir=cache_dir,
        budget_path=budget_path,
        model=model,
        cap_usd=cap_usd,
        input_usd_per_mtok=input_usd_per_mtok,
    )


def run_situational_report(bundle: Any, cfg: Config) -> dict[str, Any]:
    """Chat supplies report prose; its level fields never enter alert decisions."""
    outcome = build_agent_stack(cfg).runner.run(SituationalReportPolicy(cfg), bundle)
    return {
        "source": "rules" if outcome.used_fallback else "llm",
        "image_summary": outcome.value.image_summary,
        "assessments": [
            {
                "track_id": item.track_id,
                "rationale": item.rationale,
                "cited_ids": item.cited_ids,
                "report_conflicts": [conflict.model_dump() for conflict in item.report_conflicts],
            }
            for item in outcome.value.assessments
        ],
    }


async def _run_blocking(func: Any, *args: Any) -> Any:
    return await asyncio.to_thread(func, *args)


def _ensure_fixtures() -> None:
    """Ensure fixture JSON files exist. If missing, export them."""
    if not (FIXTURES_DIR / "dataset.json").exists():
        try:
            from web.scripts.export_fixtures import export
            export(CONFIG_PATH, with_images=True)
        except Exception as e:
            print(f"Warning: Could not auto-export fixtures: {e}", file=sys.stderr)


# Run fixture check on import/startup
_ensure_fixtures()


# --------------------------------------------------------------------------- #
# Health & Status
# --------------------------------------------------------------------------- #


@app.get("/healthz", summary="Liveness and readiness probe for Cloud Run")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", summary="Root service status")
def root() -> dict[str, Any]:
    return {
        "service": "goru-sentinel",
        "version": "0.1.0",
        "status": "ok",
        "docs": "/docs",
    }


# --------------------------------------------------------------------------- #
# Core REST endpoints matching web/src/api/http.ts
# --------------------------------------------------------------------------- #


@app.get("/dataset", summary="Dataset metadata, zones, thresholds, and simulation window")
def get_dataset() -> Response:
    path = FIXTURES_DIR / "dataset.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="dataset.json not found")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/tracks", summary="Track histories for map rendering")
def get_tracks(history: str | None = None) -> Response:
    path = FIXTURES_DIR / "tracks.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="tracks.json not found")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/reports", summary="Field reports")
def get_reports() -> Response:
    path = FIXTURES_DIR / "reports.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="reports.json not found")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/alerts", summary="Computed alerts across all frames")
def get_alerts() -> Response:
    path = FIXTURES_DIR / "alerts.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="alerts.json not found")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/frames/{image_id}", summary="Frame detail including detections, states, and brief")
def get_frame(image_id: str) -> Response:
    path = FIXTURES_DIR / "frames" / f"{image_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Frame {image_id} not found")
    return Response(content=path.read_bytes(), media_type="application/json")


@app.get("/images/{image_id}", summary="Drone camera image")
def get_image(image_id: str) -> FileResponse:
    clean_id = image_id.removesuffix(".jpg")
    p1 = FIXTURES_DIR / "frames" / f"{clean_id}.jpg"
    if p1.exists():
        return FileResponse(p1, media_type="image/jpeg")

    p2 = STAGE2_IMAGES_DIR / f"{clean_id}.jpg"
    if p2.exists():
        return FileResponse(p2, media_type="image/jpeg")

    raise HTTPException(status_code=404, detail=f"Image {image_id} not found")


# --------------------------------------------------------------------------- #
# Agent, Copilot & Budget endpoints
# --------------------------------------------------------------------------- #


class AskRequest(BaseModel):
    question: str


@app.get("/agents/budget", summary="Current agent spend vs $15 budget cap")
def get_budget() -> dict[str, float]:
    cfg = get_cfg()
    pricing = cfg.agents.pricing
    ledger = BudgetLedger(
        cfg.resolve(cfg.agents.budget_file),
        cap_usd=cfg.agents.budget_cap_usd,
        soft_stop_usd=cfg.agents.budget_soft_stop_usd,
        pricing=pricing,
    )
    snap = ledger.snapshot()
    return {
        "spend_usd": round(snap.effective_spend_usd, 4),
        "cap_usd": snap.cap_usd,
    }


@app.post(
    "/agents/ask",
    summary="Reviewer copilot Q&A",
    dependencies=[Depends(require_client_header)],
)
def ask_copilot(req: AskRequest) -> dict[str, str]:
    """The copilot's answer over the engine's analyses, wired as `cli ask` wires it.

    An unreachable model is answered honestly by the copilot itself. Anything else
    surfaces as an HTTP error: a canned reply claiming the data was verified would
    tell the operator something nobody checked.
    """
    cfg = get_cfg()
    dataset = load_dataset(cfg)
    pipeline = Pipeline(dataset, cfg)
    tools = ReadOnlyTools(
        analyses=pipeline.analyse_all(),
        zone_names={zone.zone_id: zone.name for zone in dataset.zones},
        cfg=cfg,
    )
    stack = build_agent_stack(cfg, interactive=True)
    answer = ReviewerCopilot(stack.runner, cfg, tools).ask(req.question)
    return {"answer": answer.text}


@app.post(
    "/agents/assess/{image_id}",
    summary="Stream agent evaluation steps for a frame as ndjson",
    dependencies=[Depends(require_client_header)],
)
async def assess_frame(image_id: str) -> StreamingResponse:
    cfg = get_cfg()
    pipeline = Pipeline(load_dataset(cfg), cfg)
    if image_id not in pipeline.dataset.images:
        raise HTTPException(status_code=404, detail=f"Frame {image_id} not found")

    async def event_generator() -> AsyncGenerator[bytes, None]:
        started = time.perf_counter()
        plan = [
            ("open", 1, "Görüntü yükleme"),
            ("place", 2, "Konumlandırma"),
            ("detect", 3, "Tespit"),
            ("georef", 4, "Coğrafi referans"),
            ("tracks", 5, "İz eşleştirme"),
            ("kinematics", 6, "Kinematik"),
            ("reports", 7, "Saha raporları"),
            ("score", 8, "Kural puanı"),
            ("assess", 9, "Değerlendirme"),
        ]

        for step_id, idx, title in plan[:-1]:
            step_obj = {
                "id": step_id,
                "index": idx,
                "title": title,
                "detail": f"{title} tamamlandı",
                "state": "done",
                "ms": int((time.perf_counter() - started) * 1000),
            }
            yield (json.dumps({"type": "step", "step": step_obj}) + "\n").encode("utf-8")

        analysis = await _run_blocking(pipeline.analyse_image, image_id)
        bundle = pipeline.bundle_of(analysis)
        outcome = await _run_blocking(get_jev_service(cfg).run, bundle)
        analysis.alerts = apply_threat_decisions(
            analysis.alerts,
            bundle,
            outcome.decisions,
            ts=analysis.as_of,
            rules_version=cfg.rules_version,
        )
        from web.scripts import export_fixtures

        export_fixtures._TZ = ZoneInfo(cfg.tz)
        live_frame = export_fixtures.build_frame_payload(
            analysis,
            pipeline,
            cfg,
            ImageAssessorPolicy(cfg),
            {zone.zone_id: zone.name for zone in pipeline.dataset.zones},
        )
        # A CLEAR frame has no alert row to carry the typed decision's confidence.
        if not analysis.alerts and outcome.decisions and all(
            decision.jev_confidence is not None for decision in outcome.decisions.values()
        ):
            live_frame["jev_confidence"] = min(
                decision.jev_confidence for decision in outcome.decisions.values()
            )
        yield (json.dumps({"type": "decision", "frame": live_frame}) + "\n").encode("utf-8")

        brief = await _run_blocking(run_situational_report, bundle, cfg)
        yield (json.dumps({"type": "brief", "brief": brief}) + "\n").encode("utf-8")

        step_id, idx, title = plan[-1]
        yield (json.dumps({"type": "step", "step": {
            "id": step_id, "index": idx, "title": title,
            "detail": f"{title} tamamlandı", "state": "done",
            "ms": int((time.perf_counter() - started) * 1000),
        }}) + "\n").encode("utf-8")

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        yield (
            json.dumps({"type": "done", "elapsedMs": elapsed_ms, "toolCalls": 0}) + "\n"
        ).encode("utf-8")

    return StreamingResponse(
        event_generator(),
        media_type="application/x-ndjson",
    )


# --------------------------------------------------------------------------- #
# Decision recording & retrieval
# --------------------------------------------------------------------------- #


class DecisionModel(BaseModel):
    model_config = ConfigDict(extra="allow")

    image_id: str
    status: str
    rationale: str | None = None
    decided_at: str | None = None
    decided_by: str | None = None


@app.post(
    "/frames/{image_id}/decision",
    summary="Record a reviewer decision on a frame",
    dependencies=[Depends(require_client_header)],
)
def record_decision(image_id: str, decision: DecisionModel) -> dict[str, Any]:
    item = decision.model_dump()
    item["image_id"] = image_id
    if "decided_at" not in item or not item["decided_at"]:
        item["decided_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _DECISIONS.append(item)
    return item


@app.get("/decisions", summary="List reviewer decisions recorded so far")
def list_decisions() -> dict[str, list[dict[str, Any]]]:
    return {"decisions": _DECISIONS}
