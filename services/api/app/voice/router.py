"""The voice router: one transcript in, one command out (stt.md phase 6).

Every finalised transcript is routed by the model. That is a team decision, taken
with the alternatives on the table: a Turkish pattern matcher would have been free,
offline and instant, and it was declined in favour of handling phrasing nobody
anticipated. What that decision costs, and how this module limits the cost:


* **Spend.** Every utterance is a gateway call against a $15 lifetime budget that
  never resets. Mitigated by routing through `AgentRunner`, so the existing
  response cache applies - a command said twice is answered free the second time -
  and by `agents.voice`, the smallest call config of the four (1200 tokens, low
  effort) rather than the assessor's 4000.
* **Latency.** A gateway call is on the operator's critical path now. The prompt is
  a few hundred tokens and the answer is one tool call, so this is the cheapest
  possible shape of the request the decision implies.
* **The network.** With the gateway unreachable the transcript cannot be routed.
  It is still returned, with `ROUTER_UNAVAILABLE`, and the display shows the words
  and lets the operator act by hand. Speech never silently does nothing, which is
  what stt.md phase 10 requires.

The router decides; it does not act. Every command here is a UI action and the UI
performs it - this process has no view to change and no vehicle to pin. Keeping the
decision and the action apart is also what lets the whole layer be tested with a
`ScriptedGateway` and no browser.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from goru_core.config import Config
from goru_core.provenance import payload_sha256
from goru_core.schemas import AgentRun

from app.agents.runner import AgentRunner
from app.llm.port import ChatRequest, GatewayError, Message
from app.stt.schemas import Transcript
from app.voice.registry import RegistryError, VoiceRegistry, load_registry

__all__ = ["VoiceRouter", "RoutedCommand", "RouteFailure", "RouteOutcome"]

PROMPT_DIR = Path(__file__).parent / "prompts"

FALLBACK_COMMAND = "ask_copilot"


@lru_cache(maxsize=4)
def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


@dataclass(frozen=True)
class RoutedCommand:
    """What the display should do, and what it may have to ask first."""

    command: str
    args: dict[str, Any]
    effect: str
    requires_confirmation: bool
    transcript_id: str
    text: str
    reason: str = ""
    from_cache: bool = False
    latency_ms: int = 0
    cost_usd: float = 0.0

    def to_payload(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "args": self.args,
            "effect": self.effect,
            "requires_confirmation": self.requires_confirmation,
            "transcript_id": self.transcript_id,
            "text": self.text,
            "reason": self.reason,
            "from_cache": self.from_cache,
            "latency_ms": self.latency_ms,
            "cost_usd": round(self.cost_usd, 6),
        }


@dataclass(frozen=True)
class RouteFailure:
    """The transcript could not be routed. The words are still returned."""

    code: str
    detail: str
    transcript_id: str
    text: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "command": None,
            "code": self.code,
            "detail": self.detail,
            "transcript_id": self.transcript_id,
            "text": self.text,
        }


RouteOutcome = RoutedCommand | RouteFailure


class VoiceRouter:
    """Turns a transcript into one registry command via the gateway."""

    def __init__(self, runner: AgentRunner, cfg: Config, registry: Optional[VoiceRegistry] = None):
        self._runner = runner
        self._cfg = cfg
        self._registry = registry if registry is not None else load_registry(cfg)

    @property
    def registry(self) -> VoiceRegistry:
        return self._registry

    def route(self, transcript: Transcript) -> RouteOutcome:
        """Route one finalised transcript. Never raises."""
        text = transcript.text.strip()
        if not text:
            return RouteFailure(
                code="EMPTY_TRANSCRIPT",
                detail="there was nothing to route",
                transcript_id=transcript.id,
                text="",
            )

        if not self._cfg.voice.enabled:
            return RouteFailure(
                code="VOICE_DISABLED",
                detail="voice.enabled is false in goru.yaml",
                transcript_id=transcript.id,
                text=text,
            )

        call_cfg = self._cfg.agents.call_config("voice")
        system = _prompt("voice_router_system.md").replace(
            "{COMMANDS}", self._registry.describe_for_prompt()
        )
        messages: list[Message] = [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ]
        request = ChatRequest(
            messages=messages,
            max_tokens=call_cfg.max_tokens,
            reasoning_effort=call_cfg.reasoning_effort,
            tools=self._registry.tool_schemas(),
            tool_choice="auto",
            purpose="voice",
        )

        started = datetime.now(timezone.utc)
        prompt_sha = payload_sha256(messages)

        try:
            # Interactive: the operator is stood there waiting, so the soft budget
            # stop must not refuse this the way it refuses an unattended batch.
            result = self._runner.complete(request, interactive=True)
        except GatewayError as exc:
            self._log(transcript, None, {}, problems=[f"gateway: {exc}"], prompt_sha=prompt_sha,
                      started=started, valid=False)
            return RouteFailure(
                code="ROUTER_UNAVAILABLE",
                detail=(
                    "Komut yönlendirici şu an erişilemiyor. Duyulan metin ekranda; "
                    "işlemi elle yapabilirsiniz."
                ),
                transcript_id=transcript.id,
                text=text,
            )

        command_name, args, problems = self._read_answer(result, text)
        spec = self._registry.get(command_name)
        if spec is None:
            # Should not happen - the model only sees registry tools - but a
            # gateway that echoes a name we do not have must not take the display
            # with it.
            problems.append(f"router named an unknown command {command_name!r}")
            command_name = FALLBACK_COMMAND
            spec = self._registry.get(FALLBACK_COMMAND)
            args = {"question": text}
            assert spec is not None  # load_registry guarantees ask_copilot exists

        try:
            cleaned = spec.validate_args(args)
        except RegistryError as exc:
            problems.append(str(exc))
            spec = self._registry.get(FALLBACK_COMMAND)
            assert spec is not None
            command_name = FALLBACK_COMMAND
            cleaned = {"question": text}

        self._log(
            transcript,
            command_name,
            cleaned,
            problems=problems,
            prompt_sha=prompt_sha,
            started=started,
            valid=not problems,
            result=result,
        )

        return RoutedCommand(
            command=command_name,
            args=cleaned,
            effect=spec.effect,
            requires_confirmation=self._registry.requires_confirmation(
                command_name, self._cfg.voice
            ),
            transcript_id=transcript.id,
            text=text,
            reason="; ".join(problems),
            from_cache=result.from_cache,
            latency_ms=result.latency_ms,
            cost_usd=result.cost_usd,
        )

    # --- reading the model's answer --------------------------------------- #

    def _read_answer(self, result: Any, text: str) -> tuple[str, dict[str, Any], list[str]]:
        """Pull one command out of the completion.

        The prompt asks for a tool call, and a tool call is what the gateway
        normally returns. A model that answered in prose instead has told us it did
        not recognise a command, and the right reading of that is the fall-through,
        not an error the operator has to see.
        """
        problems: list[str] = []

        if result.tool_calls:
            if len(result.tool_calls) > 1:
                problems.append(
                    f"router asked for {len(result.tool_calls)} commands; performing the first"
                )
            call = result.tool_calls[0]
            try:
                args = json.loads(call.arguments) if call.arguments else {}
            except json.JSONDecodeError:
                problems.append(f"{call.name} arguments were not valid JSON")
                args = {}
            if not isinstance(args, dict):
                problems.append(f"{call.name} arguments were not an object")
                args = {}
            return call.name, args, problems

        problems.append(
            "router answered in prose rather than calling a command; treated as a question"
        )
        # The operator's words, never the model's. What the router mused about on
        # its way to not recognising a command is not the question that was asked,
        # and forwarding it would put words in the operator's mouth.
        return FALLBACK_COMMAND, {"question": text}, problems

    # --- the audit record ------------------------------------------------- #

    def _log(
        self,
        transcript: Transcript,
        command: Optional[str],
        args: dict[str, Any],
        *,
        problems: list[str],
        prompt_sha: str,
        started: datetime,
        valid: bool,
        result: Any = None,
    ) -> None:
        """Record the routing decision beside every other agent run.

        A command that changed the display, and especially one that recorded a
        decision, has to be traceable to the words that caused it. Same file, same
        shape as the assessor and the copilot, so `agent_runs.jsonl` remains the
        single place to look.
        """
        run = AgentRun(
            run_id=f"voice-{prompt_sha[:10]}",
            kind="copilot",  # AgentRun.kind is a frozen contract; voice is not in it
            model=self._runner.gateway.model,
            prompt_sha256=prompt_sha,
            input_refs=[transcript.id, transcript.text[:200]],
            output_json={"command": command, "args": args, "raw_text": transcript.raw_text},
            cited_ids=[],
            valid=valid,
            fallback_used=command == FALLBACK_COMMAND,
            problems=problems,
            prompt_tokens=getattr(result, "prompt_tokens", 0) if result else 0,
            completion_tokens=getattr(result, "completion_tokens", 0) if result else 0,
            cost_usd=round(float(getattr(result, "cost_usd", 0.0) if result else 0.0), 6),
            latency_ms=int(getattr(result, "latency_ms", 0) if result else 0),
            from_cache=bool(getattr(result, "from_cache", False) if result else False),
            attempts=1,
            ts=started,
        )
        try:
            self._runner.log_run(run)
        except Exception:
            # Telemetry is not the job. A failure to write the audit line must not
            # stop the command the operator asked for.
            pass
