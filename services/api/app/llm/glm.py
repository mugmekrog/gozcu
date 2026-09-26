"""The GLM gateway adapter (PLAN.md 6.11).

Everything provider-specific about the organizers' gateway is in this one file,
and every item here is something PLAN 6.11 warns is easy to get wrong:

* `max_tokens` **covers thinking**. Too low and `content` comes back empty with
  ``finish_reason == "length"``; that is raised as `EmptyAnswerError` so the
  runner can retry with a bigger budget rather than reporting a bad answer.
* The answer is in `message.content`; the thinking is in `message.reasoning_content`.
  Both are captured - the reasoning is useful in the audit trail but is never
  shown as the agent's rationale.
* Never send a `thinking` parameter: it errors. Use `reasoning_effort`.
* Exactly four concurrent requests and 60 requests/minute are allowed, so the
  adapter holds a semaphore and a rate limiter rather than trusting callers.
* Structured output support is probed once and degraded gracefully: json_schema,
  then json_object, then prompt-only. The runner validates the result either way,
  so a gateway without schema support costs a retry, not a failure.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Iterator

import openai

from goru_core.config import AgentsConfig

from app.llm.port import (
    ChatRequest,
    ChatResult,
    EmptyAnswerError,
    GatewayError,
    KeyInfo,
    ToolCall,
)

__all__ = ["GlmGateway"]

_SCHEMA_MODES = ("json_schema", "json_object", "none")


class _RateLimiter:
    """Sliding-window limiter: at most `per_minute` starts in any 60 seconds."""

    def __init__(self, per_minute: int) -> None:
        self._limit = max(1, per_minute)
        self._starts: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                while self._starts and now - self._starts[0] >= 60.0:
                    self._starts.popleft()
                if len(self._starts) < self._limit:
                    self._starts.append(now)
                    return
                wait = 60.0 - (now - self._starts[0]) + 0.01
            time.sleep(max(0.01, wait))


class GlmGateway:
    """`LlmGateway` over the organizers' OpenAI-compatible endpoint."""

    def __init__(self, cfg: AgentsConfig, api_key: str) -> None:
        if not api_key:
            raise GatewayError(
                "no API key: set GLM_API_KEY in .env (the key is never read from config)"
            )
        self._cfg = cfg
        self._client = openai.OpenAI(
            api_key=api_key,
            base_url=cfg.base_url,
            max_retries=cfg.max_retries,
            timeout=cfg.timeout_s,
        )
        self._api_key = api_key
        self._semaphore = threading.BoundedSemaphore(cfg.max_concurrency)
        self._limiter = _RateLimiter(cfg.requests_per_min)
        self._schema_mode: str | None = None

    @property
    def model(self) -> str:
        return self._cfg.model

    # --- request construction --------------------------------------------- #

    def _kwargs(self, request: ChatRequest, schema_mode: str) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self._cfg.model,
            "messages": list(request.messages),
            "max_tokens": request.max_tokens,
            "reasoning_effort": request.reasoning_effort,
        }
        if request.tools:
            kwargs["tools"] = list(request.tools)
            if request.tool_choice:
                kwargs["tool_choice"] = request.tool_choice
        if request.response_schema is not None:
            if schema_mode == "json_schema":
                kwargs["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": request.schema_name,
                        "schema": request.response_schema,
                        "strict": True,
                    },
                }
            elif schema_mode == "json_object":
                kwargs["response_format"] = {"type": "json_object"}
        return kwargs

    def _modes_to_try(self, request: ChatRequest) -> list[str]:
        if request.response_schema is None:
            return ["none"]
        if self._schema_mode is not None:
            # Once probed, keep using what worked - and still allow a fallback.
            start = _SCHEMA_MODES.index(self._schema_mode)
            return list(_SCHEMA_MODES[start:])
        return list(_SCHEMA_MODES)

    @staticmethod
    def _is_schema_rejection(exc: openai.APIStatusError) -> bool:
        if exc.status_code not in (400, 422):
            return False
        text = str(getattr(exc, "message", "") or exc).lower()
        return any(
            token in text
            for token in ("response_format", "json_schema", "schema", "unsupported", "not support")
        )

    # --- the port ---------------------------------------------------------- #

    def chat(self, request: ChatRequest) -> ChatResult:
        """Complete `request`, degrading structured-output mode if the gateway refuses."""
        last_error: Exception | None = None
        for mode in self._modes_to_try(request):
            try:
                result = self._call(request, mode)
            except openai.APIStatusError as exc:
                if request.response_schema is not None and self._is_schema_rejection(exc):
                    last_error = exc
                    continue
                raise GatewayError(f"gateway returned {exc.status_code}: {exc}") from exc
            except openai.APIError as exc:
                raise GatewayError(f"gateway call failed: {exc}") from exc
            self._schema_mode = mode
            return result
        raise GatewayError(f"gateway rejected every structured-output mode: {last_error}")

    def _call(self, request: ChatRequest, schema_mode: str) -> ChatResult:
        kwargs = self._kwargs(request, schema_mode)
        self._limiter.acquire()
        started = time.perf_counter()
        with self._semaphore:
            response = self._client.chat.completions.create(**kwargs)
        latency_ms = int((time.perf_counter() - started) * 1000)

        choice = response.choices[0]
        message = choice.message
        text = (message.content or "").strip()
        reasoning = self._reasoning_of(message)

        tool_calls = tuple(
            ToolCall(call_id=call.id, name=call.function.name, arguments=call.function.arguments or "{}")
            for call in (message.tool_calls or [])
        )

        usage = response.usage
        prompt_tokens = getattr(usage, "prompt_tokens", 0) or 0
        completion_tokens = getattr(usage, "completion_tokens", 0) or 0

        if not text and not tool_calls:
            if choice.finish_reason == "length":
                raise EmptyAnswerError(
                    f"empty answer with finish_reason=length: thinking consumed all "
                    f"{request.max_tokens} tokens (PLAN 6.11); retry with more"
                )
            raise GatewayError(f"empty answer with finish_reason={choice.finish_reason!r}")

        return ChatResult(
            text=text,
            reasoning=reasoning,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            latency_ms=latency_ms,
            model=response.model or self._cfg.model,
            schema_mode=schema_mode,
        )

    @staticmethod
    def _reasoning_of(message: Any) -> str:
        """GLM returns its thinking separately; the field is not in the SDK's model."""
        direct = getattr(message, "reasoning_content", None)
        if isinstance(direct, str):
            return direct
        extra = getattr(message, "model_extra", None) or {}
        for key in ("reasoning_content", "reasoning"):
            value = extra.get(key)
            if isinstance(value, str):
                return value
        return ""

    def stream(self, request: ChatRequest) -> Iterator[str]:
        """Yield answer text as it arrives; thinking chunks are skipped."""
        kwargs = self._kwargs(request, self._schema_mode or "none")
        kwargs["stream"] = True
        self._limiter.acquire()
        with self._semaphore:
            try:
                stream = self._client.chat.completions.create(**kwargs)
            except openai.APIError as exc:
                raise GatewayError(f"gateway stream failed: {exc}") from exc
            for chunk in stream:
                if not chunk.choices:
                    continue
                piece = chunk.choices[0].delta.content
                if piece:
                    yield piece

    def key_info(self) -> KeyInfo | None:
        """Read the authoritative spend from the gateway (`GET /key/info`).

        The endpoint sits at the gateway root, not under `/v1`. Returns None when
        it cannot be reached, because an unreachable budget endpoint must not
        block the demo - the local estimate takes over.
        """
        root = self._cfg.base_url.rstrip("/")
        if root.endswith("/v1"):
            root = root[: -len("/v1")]
        request = urllib.request.Request(
            f"{root}/key/info",
            headers={"Authorization": f"Bearer {self._api_key}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10.0) as response:  # noqa: S310
                payload = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
            return None

        info = payload.get("info", payload) if isinstance(payload, dict) else {}
        if not isinstance(info, dict):
            return None
        models = info.get("models") or []
        return KeyInfo(
            spend_usd=_as_float(info.get("spend")),
            max_budget_usd=_as_float(info.get("max_budget")),
            models=tuple(str(m) for m in models if isinstance(m, (str, int))),
            key_alias=info.get("key_alias"),
            raw=info,
        )


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
