"""The LLM gateway port: the seam the agents are written against.

Agents never import `openai`, never see a base URL and never handle a 429. They
call `LlmGateway.chat` with a `ChatRequest` and get a `ChatResult`. That is the
whole contract.

Two adapters satisfy it - `GlmGateway` (the organizers' gateway, over the OpenAI
SDK) and `ScriptedGateway` (offline, deterministic, used by the tests) - so the
seam is a real one rather than a hypothetical. Putting an orchestration framework
underneath later means writing a third adapter and changing no agent code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator, Literal, Protocol, Sequence, runtime_checkable

__all__ = [
    "Message",
    "ToolCall",
    "ChatRequest",
    "ChatResult",
    "KeyInfo",
    "LlmGateway",
    "GatewayError",
    "EmptyAnswerError",
    "BudgetExceeded",
    "AgentKind",
]

AgentKind = Literal["assess", "parse", "copilot"]

Message = dict[str, Any]


class GatewayError(RuntimeError):
    """The gateway could not produce a usable answer."""


class EmptyAnswerError(GatewayError):
    """The model returned no answer text because thinking consumed `max_tokens`.

    The single most common failure mode on this gateway: `max_tokens` covers the
    model's thinking, so a value that is too low yields empty `content` with
    ``finish_reason == "length"`` (PLAN 6.11). Raised as its own type so the
    runner can retry with a larger budget instead of treating it as a bad answer.
    """


class BudgetExceeded(GatewayError):
    """The call was refused because it would breach the spend guard."""


@dataclass(frozen=True, slots=True)
class ToolCall:
    """One tool invocation the model asked for."""

    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class ChatRequest:
    """One completion request, in provider-neutral terms."""

    messages: Sequence[Message]
    max_tokens: int
    reasoning_effort: Literal["low", "high", "max"] = "low"
    response_schema: dict[str, Any] | None = None
    schema_name: str = "output"
    tools: Sequence[dict[str, Any]] | None = None
    tool_choice: str | None = None
    stream: bool = False
    purpose: AgentKind = "assess"

    def replace_max_tokens(self, value: int) -> "ChatRequest":
        return ChatRequest(
            messages=self.messages,
            max_tokens=value,
            reasoning_effort=self.reasoning_effort,
            response_schema=self.response_schema,
            schema_name=self.schema_name,
            tools=self.tools,
            tool_choice=self.tool_choice,
            stream=self.stream,
            purpose=self.purpose,
        )

    def with_messages(self, messages: Sequence[Message]) -> "ChatRequest":
        return ChatRequest(
            messages=messages,
            max_tokens=self.max_tokens,
            reasoning_effort=self.reasoning_effort,
            response_schema=self.response_schema,
            schema_name=self.schema_name,
            tools=self.tools,
            tool_choice=self.tool_choice,
            stream=self.stream,
            purpose=self.purpose,
        )


@dataclass(frozen=True)
class ChatResult:
    """One completion response, with the accounting the budget ledger needs."""

    text: str
    reasoning: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    finish_reason: str = "stop"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    model: str = ""
    from_cache: bool = False
    attempts: int = 1
    schema_mode: str = "none"

    def as_cache_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "reasoning": self.reasoning,
            "tool_calls": [
                {"call_id": c.call_id, "name": c.name, "arguments": c.arguments}
                for c in self.tool_calls
            ],
            "finish_reason": self.finish_reason,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_usd": self.cost_usd,
            "latency_ms": self.latency_ms,
            "model": self.model,
            "schema_mode": self.schema_mode,
        }

    @classmethod
    def from_cache_dict(cls, data: dict[str, Any]) -> "ChatResult":
        return cls(
            text=data.get("text", ""),
            reasoning=data.get("reasoning", ""),
            tool_calls=tuple(
                ToolCall(call_id=c["call_id"], name=c["name"], arguments=c["arguments"])
                for c in data.get("tool_calls", [])
            ),
            finish_reason=data.get("finish_reason", "stop"),
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            cost_usd=data.get("cost_usd", 0.0),
            latency_ms=data.get("latency_ms", 0),
            model=data.get("model", ""),
            from_cache=True,
            schema_mode=data.get("schema_mode", "none"),
        )


@dataclass(frozen=True)
class KeyInfo:
    """What the gateway says about our key. `spend` here is authoritative."""

    spend_usd: float | None = None
    max_budget_usd: float | None = None
    models: tuple[str, ...] = ()
    key_alias: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def remaining_usd(self) -> float | None:
        if self.spend_usd is None or self.max_budget_usd is None:
            return None
        return self.max_budget_usd - self.spend_usd


@runtime_checkable
class LlmGateway(Protocol):
    """Everything the agents need from a language model."""

    @property
    def model(self) -> str: ...

    def chat(self, request: ChatRequest) -> ChatResult:
        """Complete `request`, or raise `GatewayError`."""
        ...

    def stream(self, request: ChatRequest) -> Iterator[str]:
        """Yield answer text as it arrives. Used by the copilot."""
        ...

    def key_info(self) -> KeyInfo | None:
        """Authoritative spend for this key, or None when unavailable."""
        ...
