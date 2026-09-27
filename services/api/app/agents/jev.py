"""Hosted TypeSafe choice decisions with a separate cache and spend guard."""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from goru_core.config import PricingConfig
from goru_core.provenance import payload_sha256
from goru_core.schemas import EvidenceBundle, ImageAssessment

from app.agents.threat_decisions import JevRequest, ThreatDecision, build_request, resolve_answers
from app.llm.budget import BudgetLedger
from app.llm.port import BudgetExceeded


class JevGateway(Protocol):
    def evaluate(self, request: JevRequest) -> dict[str, Any]: ...


class TypeSafeGateway:
    """The direct TypeSafe HTTP API; the key never enters an audit record."""

    def __init__(self, api_key: str, *, timeout_s: float = 10.0) -> None:
        self._key = api_key
        self._timeout = timeout_s

    def evaluate(self, request: JevRequest) -> dict[str, Any]:
        body = json.dumps(
            {
                "model": request.model,
                "state": request.state,
                "questions": {key: asdict(question) for key, question in request.questions.items()},
            },
            separators=(",", ":"),
        ).encode("utf-8")
        http_request = urllib.request.Request(
            "https://api.typesafe.ai/v1/systemone",
            data=body,
            headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(http_request, timeout=self._timeout) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("TypeSafe response is not an object")
        return result


@dataclass(frozen=True)
class JevOutcome:
    decisions: dict[str, ThreatDecision]
    from_cache: bool = False
    fallback_reason: str | None = None
    input_tokens: int = 0
    latency_ms: int = 0
    audit_error: str | None = None


class JevService:
    def __init__(
        self,
        gateway: JevGateway | None,
        *,
        cache_dir: str | Path,
        budget_path: str | Path,
        model: str = "jev-latest",
        cap_usd: float = 5.0,
        input_usd_per_mtok: float = 0.042,
        cache_only: bool = False,
    ) -> None:
        self._gateway = gateway
        self._cache_dir = Path(cache_dir)
        self._model = model
        self._cache_only = cache_only
        self._budget = BudgetLedger(
            budget_path,
            cap_usd=cap_usd,
            soft_stop_usd=cap_usd,
            pricing=PricingConfig(input_usd_per_mtok=input_usd_per_mtok, output_usd_per_mtok=0),
        )
        self._lock = threading.Lock()
        self._runs_path = Path(budget_path).with_name("jev_runs.jsonl")

    def run(self, bundle: EvidenceBundle, assessment: ImageAssessment | None = None) -> JevOutcome:
        request = build_request(bundle, model=self._model, assessment=assessment)
        key = payload_sha256({"version": 2, "request": asdict(request)})
        if not request.questions:
            return self._record(key, JevOutcome(decisions={}))
        cache_path = self._cache_dir / key[:2] / f"{key}.json"
        cached = self._read_cache(cache_path)
        if cached is not None:
            self._budget.record_cache_hit()
            return self._record(key, JevOutcome(resolve_answers(bundle, cached), from_cache=True))
        if self._cache_only:
            return self._record(key, JevOutcome(resolve_answers(bundle, None), fallback_reason="cache_miss"))
        if self._gateway is None:
            return self._record(
                key, JevOutcome(resolve_answers(bundle, None), fallback_reason="missing_key")
            )

        body_bytes = len(json.dumps(asdict(request), separators=(",", ":")).encode("utf-8"))
        # A byte bound plus overhead is deliberately conservative for tokenized input.
        reserved = self._budget.cost_of(body_bytes + 4096, 0)
        started = time.perf_counter()
        try:
            with self._lock:
                self._budget.guard(reserved, interactive=True)
                response = self._gateway.evaluate(request)
                usage = response.get("usage")
                usage = usage if isinstance(usage, dict) else {}
                reported_tokens = usage.get("input_tokens")
                input_tokens = (
                    reported_tokens
                    if isinstance(reported_tokens, int) and reported_tokens > 0
                    else body_bytes + 4096
                )
                self._budget.record(prompt_tokens=input_tokens, completion_tokens=0, purpose="jev")
            answers = response.get("answers")
            if not isinstance(answers, dict):
                raise ValueError("TypeSafe response has no answers")
            decisions = resolve_answers(bundle, answers)
            valid_answers = {
                track_id: answers[track_id]
                for track_id, decision in decisions.items()
                if decision.jev_confidence is not None
            }
            cache_error = None
            try:
                self._write_cache(cache_path, valid_answers)
            except OSError as exc:
                cache_error = type(exc).__name__
            return self._record(
                key,
                JevOutcome(
                    decisions,
                    input_tokens=input_tokens,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    audit_error=cache_error,
                ),
            )
        except BudgetExceeded:
            reason = "budget_exceeded"
        except Exception as exc:
            reason = type(exc).__name__
        return self._record(
            key,
            JevOutcome(
                resolve_answers(bundle, None),
                fallback_reason=reason,
                latency_ms=int((time.perf_counter() - started) * 1000),
            ),
        )

    def _record(self, request_sha256: str, outcome: JevOutcome) -> JevOutcome:
        record = {
            "run_id": str(uuid4()),
            "ts": datetime.now(timezone.utc).isoformat(),
            "model": self._model,
            "request_sha256": request_sha256,
            "from_cache": outcome.from_cache,
            "fallback_reason": outcome.fallback_reason,
            "input_tokens": outcome.input_tokens,
            "latency_ms": outcome.latency_ms,
            "decisions": {
                track_id: asdict(decision) for track_id, decision in outcome.decisions.items()
            },
        }
        try:
            self._runs_path.parent.mkdir(parents=True, exist_ok=True)
            with self._runs_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, sort_keys=True) + "\n")
        except OSError as exc:
            return replace(outcome, audit_error=type(exc).__name__)
        return outcome

    @staticmethod
    def _read_cache(path: Path) -> dict[str, Any] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    @staticmethod
    def _write_cache(path: Path, answers: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(answers, sort_keys=True), encoding="utf-8")
