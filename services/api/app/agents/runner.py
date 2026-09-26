"""The one agent loop (PLAN.md 6.9).

Every agent in Goru is a `AgentPolicy`: it knows how to build its prompt, what
schema its answer must satisfy, how to check that answer against the evidence,
and what to fall back to when the model is unavailable or wrong. `AgentRunner`
supplies everything else - cache, budget, retries, the empty-answer trap,
validation, fallback, and the `AgentRun` audit record.

Because the loop is shared, each safety property is implemented once:

* nothing reaches a screen without passing the policy's guardrails;
* an invalid answer costs at most one repair attempt, then falls back;
* a cache hit costs nothing, so replaying the demo is free;
* every call is recorded with its prompt hash, tokens, cost and latency.

The agent is never on the critical path. Callers render the deterministic
baseline first and attach the agent's verdict when it arrives.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, Sequence

from goru_core.config import Config
from goru_core.provenance import payload_sha256
from goru_core.schemas import AgentRun

from app.agents.guardrails import GuardrailError, describe_problems, extract_json_object
from app.llm.budget import BudgetLedger
from app.llm.cache import ResponseCache
from app.llm.port import (
    AgentKind,
    BudgetExceeded,
    ChatRequest,
    ChatResult,
    EmptyAnswerError,
    GatewayError,
    LlmGateway,
    Message,
)

__all__ = ["AgentPolicy", "AgentRunner", "AgentOutcome", "ValidationResult"]

MAX_MODEL_CALLS = 2  # the initial call plus one repair attempt
EMPTY_ANSWER_MULTIPLIER = 2


@dataclass(frozen=True)
class ValidationResult:
    """A policy's verdict on one model answer."""

    value: Any | None
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.value is not None and not self.problems


class AgentPolicy(Protocol):
    """What one agent contributes; the runner does the rest."""

    kind: AgentKind
    schema_name: str

    def build_messages(self, payload: Any) -> list[Message]: ...

    def response_schema(self) -> dict[str, Any] | None: ...

    def validate(self, data: dict[str, Any], payload: Any) -> ValidationResult: ...

    def fallback(self, payload: Any) -> Any:
        """A deterministic answer for when the model cannot be used."""
        ...

    def cited_ids(self, value: Any) -> list[str]: ...

    def input_refs(self, payload: Any) -> list[str]: ...

    def output_json(self, value: Any) -> dict[str, Any]: ...


@dataclass
class AgentOutcome:
    """The agent's answer plus the audit record of how it was obtained."""

    value: Any
    run: AgentRun
    warnings: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def used_fallback(self) -> bool:
        return self.run.fallback_used


class AgentRunner:
    """Runs policies against a gateway, with cache, budget and guardrails."""

    def __init__(
        self,
        gateway: LlmGateway,
        cfg: Config,
        *,
        cache: ResponseCache | None = None,
        budget: BudgetLedger | None = None,
        runs_path: str | Path | None = None,
        interactive: bool = False,
    ) -> None:
        self._gateway = gateway
        self._cfg = cfg
        self._cache = cache
        self._budget = budget
        self._interactive = interactive
        resolved = runs_path if runs_path is not None else cfg.agents.runs_file
        self._runs_path = cfg.resolve(str(resolved)) if resolved else None

    @property
    def gateway(self) -> LlmGateway:
        return self._gateway

    # ------------------------------------------------------------------ #

    def run(self, policy: AgentPolicy, payload: Any, *, interactive: bool | None = None) -> AgentOutcome:
        """Produce this policy's answer for `payload`, whatever it takes."""
        agents = self._cfg.agents
        call_cfg = agents.call_config(policy.kind)
        messages = policy.build_messages(payload)
        prompt_sha = payload_sha256(messages)
        started = datetime.now(timezone.utc)

        request = ChatRequest(
            messages=messages,
            max_tokens=call_cfg.max_tokens,
            reasoning_effort=call_cfg.reasoning_effort,
            response_schema=policy.response_schema(),
            schema_name=policy.schema_name,
            purpose=policy.kind,
        )

        if not agents.enabled:
            return self._fallback_outcome(
                policy, payload, prompt_sha, started, ["agents.enabled is false"]
            )

        problems: list[str] = []
        warnings: list[str] = []
        extra: dict[str, Any] = {}
        totals = {"prompt": 0, "completion": 0, "cost": 0.0, "latency": 0, "calls": 0, "cached": 0}
        attempt_request = request

        for attempt in range(1, MAX_MODEL_CALLS + 1):
            try:
                result = self._complete(attempt_request, interactive=interactive)
            except BudgetExceeded as exc:
                problems.append(f"budget guard: {exc}")
                break
            except GatewayError as exc:
                problems.append(f"gateway: {exc}")
                break

            totals["prompt"] += result.prompt_tokens
            totals["completion"] += result.completion_tokens
            totals["cost"] += result.cost_usd
            totals["latency"] += result.latency_ms
            totals["calls"] += 1
            totals["cached"] += 1 if result.from_cache else 0

            try:
                data = extract_json_object(result.text)
            except GuardrailError as exc:
                validation = ValidationResult(value=None, problems=[str(exc)])
            else:
                validation = policy.validate(data, payload)

            warnings = list(validation.warnings)
            extra = dict(validation.extra)

            if validation.ok:
                run = self._record_run(
                    policy=policy,
                    payload=payload,
                    value=validation.value,
                    prompt_sha=prompt_sha,
                    totals=totals,
                    valid=True,
                    fallback_used=False,
                    problems=warnings,
                    started=started,
                )
                return AgentOutcome(value=validation.value, run=run, warnings=warnings, extra=extra)

            problems = list(validation.problems)
            if attempt >= MAX_MODEL_CALLS:
                break
            attempt_request = request.with_messages(
                [*messages, *self._repair_turn(result.text, problems)]
            )

        return self._fallback_outcome(
            policy, payload, prompt_sha, started, problems, totals=totals, warnings=warnings
        )

    # ------------------------------------------------------------------ #

    def complete(self, request: ChatRequest, *, interactive: bool | None = None) -> ChatResult:
        """One gateway round trip with cache, budget and the empty-answer retry.

        Public so that the copilot's multi-turn tool loop gets the same spend
        discipline and the same cache as the single-shot policies, instead of
        reimplementing them.
        """
        return self._complete(request, interactive=interactive)

    def log_run(self, run: AgentRun) -> None:
        """Append an `AgentRun` written by a caller that drives its own loop."""
        self._append_run(run)

    def _complete(self, request: ChatRequest, *, interactive: bool | None) -> ChatResult:
        """One gateway round trip, through the cache and the budget guard."""
        cache_key = (
            self._cache.key_for(self._gateway.model, request) if self._cache is not None else None
        )
        if cache_key is not None:
            cached = self._cache.get(cache_key)
            if cached is not None:
                if self._budget is not None:
                    self._budget.record_cache_hit()
                # A replay costs nothing. The money was spent once, on the call
                # that filled the cache, and the ledger booked it then; carrying
                # the original price here would make a cache-warm rehearsal
                # report a spend that never happened.
                return _with_cost(cached, 0.0)

        if self._cfg.agents.cache_only:
            raise GatewayError("cache-only mode is on and this prompt is not in the cache")

        is_interactive = self._interactive if interactive is None else interactive
        prompt_chars = sum(len(str(m.get("content", ""))) for m in request.messages)

        attempt_request = request
        last_error: Exception | None = None
        for _ in range(2):  # the empty-answer trap gets exactly one larger retry
            if self._budget is not None:
                self._budget.guard(
                    self._budget.estimate(prompt_chars, attempt_request.max_tokens),
                    interactive=is_interactive,
                )
            try:
                result = self._gateway.chat(attempt_request)
            except EmptyAnswerError as exc:
                last_error = exc
                attempt_request = attempt_request.replace_max_tokens(
                    attempt_request.max_tokens * EMPTY_ANSWER_MULTIPLIER
                )
                continue

            cost = result.cost_usd
            if self._budget is not None:
                cost = self._budget.record(
                    prompt_tokens=result.prompt_tokens,
                    completion_tokens=result.completion_tokens,
                    cost_usd=result.cost_usd or None,
                    purpose=request.purpose,
                )
            priced = result if cost == result.cost_usd else _with_cost(result, cost)
            if cache_key is not None:
                self._cache.put(cache_key, priced)
            return priced

        raise GatewayError(f"model returned no answer even with a doubled token budget: {last_error}")

    @staticmethod
    def _repair_turn(answer: str, problems: Sequence[str]) -> list[Message]:
        return [
            {"role": "assistant", "content": answer[:2000]},
            {
                "role": "user",
                "content": (
                    "Your previous answer was rejected by validation. Fix exactly these "
                    "problems and reply with the corrected JSON object only, no prose:\n"
                    + describe_problems({"validation": list(problems)})
                ),
            },
        ]

    def _fallback_outcome(
        self,
        policy: AgentPolicy,
        payload: Any,
        prompt_sha: str,
        started: datetime,
        problems: Sequence[str],
        *,
        totals: dict[str, Any] | None = None,
        warnings: Sequence[str] | None = None,
    ) -> AgentOutcome:
        """Deterministic answer, clearly marked as such."""
        value = policy.fallback(payload)
        run = self._record_run(
            policy=policy,
            payload=payload,
            value=value,
            prompt_sha=prompt_sha,
            totals=totals or {},
            valid=False,
            fallback_used=True,
            problems=list(problems),
            started=started,
        )
        return AgentOutcome(value=value, run=run, warnings=list(warnings or []))

    def _record_run(
        self,
        *,
        policy: AgentPolicy,
        payload: Any,
        value: Any,
        prompt_sha: str,
        totals: dict[str, Any],
        valid: bool,
        fallback_used: bool,
        problems: Sequence[str],
        started: datetime,
    ) -> AgentRun:
        run = AgentRun(
            run_id=f"{policy.kind}-{prompt_sha[:10]}",
            kind=policy.kind,
            model=self._gateway.model,
            prompt_sha256=prompt_sha,
            input_refs=policy.input_refs(payload),
            output_json=policy.output_json(value),
            cited_ids=policy.cited_ids(value),
            valid=valid,
            fallback_used=fallback_used,
            problems=list(problems),
            prompt_tokens=int(totals.get("prompt", 0)),
            completion_tokens=int(totals.get("completion", 0)),
            cost_usd=round(float(totals.get("cost", 0.0)), 6),
            latency_ms=int(totals.get("latency", 0)),
            from_cache=bool(totals.get("cached", 0)),
            attempts=int(totals.get("calls", 0)) or 1,
            ts=started,
        )
        self._append_run(run)
        return run

    def _append_run(self, run: AgentRun) -> None:
        if self._runs_path is None:
            return
        self._runs_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._runs_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(run.model_dump(mode="json"), sort_keys=True) + "\n")


def _with_cost(result: ChatResult, cost_usd: float) -> ChatResult:
    return ChatResult(
        text=result.text,
        reasoning=result.reasoning,
        tool_calls=result.tool_calls,
        finish_reason=result.finish_reason,
        prompt_tokens=result.prompt_tokens,
        completion_tokens=result.completion_tokens,
        cost_usd=cost_usd,
        latency_ms=result.latency_ms,
        model=result.model,
        from_cache=result.from_cache,
        attempts=result.attempts,
        schema_mode=result.schema_mode,
    )
