"""The reviewer copilot: a bounded, read-only tool loop (PLAN.md 6.9, task M3.5).

The reviewer asks "why is T0187 red?" and gets an answer that cites the same ids
they can click on screen. The agent reaches that answer by calling read-only
lookups, at most `agents.max_tool_calls` of them per question - the DoS control
from the threat model, and the reason this loop is written out by hand rather than
delegated: the bound, the read-only registry and the spend guard are the whole
point, and they are ten lines each.

Transport, cache, budget and audit come from `AgentRunner`, so the copilot spends
from the same $15 counter as everything else.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Iterator, Sequence

from goru_core.config import Config
from goru_core.provenance import payload_sha256
from goru_core.schemas import AgentRun

from app.agents.runner import AgentRunner
from app.agents.tools import ReadOnlyTools
from app.llm.port import ChatRequest, GatewayError, Message

__all__ = ["ReviewerCopilot", "CopilotAnswer"]

PROMPT_DIR = Path(__file__).parent / "prompts"

_ID_RE = re.compile(r"\b(?:T\d{4}|R\d{3}|Z\d{2}|img_\d{6}(?:#\d{3})?)\b")


@lru_cache(maxsize=8)
def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


@dataclass
class CopilotAnswer:
    """What the reviewer sees, plus how it was produced."""

    text: str
    citations: list[str] = field(default_factory=list)
    tool_calls: list[tuple[str, str]] = field(default_factory=list)
    run: AgentRun | None = None
    truncated: bool = False

    @property
    def unverified_citations(self) -> list[str]:
        """Ids mentioned in the answer that no tool call actually returned."""
        return [c for c in self.citations if c not in self._returned_ids]

    _returned_ids: set[str] = field(default_factory=set, repr=False)


class ReviewerCopilot:
    """Answers a reviewer's question from the engine's data, with citations."""

    def __init__(
        self,
        runner: AgentRunner,
        cfg: Config,
        tools: ReadOnlyTools,
    ) -> None:
        self._runner = runner
        self._cfg = cfg
        self._tools = tools

    def ask(self, question: str) -> CopilotAnswer:
        """Answer one question. Interactive, so the soft budget stop does not apply."""
        agents = self._cfg.agents
        call_cfg = agents.call_config("copilot")
        started = datetime.now(timezone.utc)

        messages: list[Message] = [
            {"role": "system", "content": _prompt("copilot_system.md")},
            {"role": "user", "content": question},
        ]
        base_request = ChatRequest(
            messages=messages,
            max_tokens=call_cfg.max_tokens,
            reasoning_effort=call_cfg.reasoning_effort,
            tools=self._tools.schemas(),
            tool_choice="auto",
            purpose="copilot",
        )

        prompt_sha = payload_sha256(messages)
        calls_made: list[tuple[str, str]] = []
        returned_ids: set[str] = set()
        totals = {"prompt": 0, "completion": 0, "cost": 0.0, "latency": 0, "calls": 0, "cached": 0}
        problems: list[str] = []
        truncated = False
        answer = ""

        for _ in range(agents.max_tool_calls + 1):
            try:
                result = self._runner.complete(
                    base_request.with_messages(messages), interactive=True
                )
            except GatewayError as exc:
                problems.append(f"gateway: {exc}")
                answer = (
                    "I could not reach the assessment model just now, so I cannot answer "
                    "from it. The alert queue and the evidence inspector are unaffected - "
                    "they are computed by the rule engine."
                )
                break

            totals["prompt"] += result.prompt_tokens
            totals["completion"] += result.completion_tokens
            totals["cost"] += result.cost_usd
            totals["latency"] += result.latency_ms
            totals["calls"] += 1
            totals["cached"] += 1 if result.from_cache else 0

            if not result.tool_calls:
                answer = result.text
                break

            if len(calls_made) + len(result.tool_calls) > agents.max_tool_calls:
                truncated = True
                problems.append(
                    f"tool-call cap of {agents.max_tool_calls} reached; answering with what is known"
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "You have reached the tool-call limit for this question. "
                            "Answer now from what you already retrieved, and say which part "
                            "you could not check."
                        ),
                    }
                )
                continue

            messages.append(
                {
                    "role": "assistant",
                    "content": result.text or None,
                    "tool_calls": [
                        {
                            "id": call.call_id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.arguments},
                        }
                        for call in result.tool_calls
                    ],
                }
            )
            for call in result.tool_calls:
                payload = self._tools.call(call.name, call.arguments)
                calls_made.append((call.name, call.arguments))
                returned_ids.update(_ID_RE.findall(payload))
                messages.append(
                    {"role": "tool", "tool_call_id": call.call_id, "content": payload}
                )
        else:
            truncated = True
            problems.append("the agent kept calling tools without answering")
            answer = answer or "I could not settle on an answer within the tool-call budget."

        citations = sorted(set(_ID_RE.findall(answer)))
        unverified = [c for c in citations if c not in returned_ids]
        if unverified:
            problems.append(f"answer cites ids no tool returned: {', '.join(unverified)}")

        run = AgentRun(
            run_id=f"copilot-{prompt_sha[:10]}",
            kind="copilot",
            model=self._runner.gateway.model,
            prompt_sha256=prompt_sha,
            input_refs=[question[:200]],
            output_json={"answer": answer, "tool_calls": [name for name, _ in calls_made]},
            cited_ids=citations,
            valid=not unverified and bool(answer),
            fallback_used=not bool(answer) or bool([p for p in problems if p.startswith("gateway")]),
            problems=problems,
            prompt_tokens=int(totals["prompt"]),
            completion_tokens=int(totals["completion"]),
            cost_usd=round(float(totals["cost"]), 6),
            latency_ms=int(totals["latency"]),
            from_cache=bool(totals["cached"]),
            attempts=int(totals["calls"]) or 1,
            ts=started,
        )
        self._runner.log_run(run)

        return CopilotAnswer(
            text=answer,
            citations=citations,
            tool_calls=calls_made,
            run=run,
            truncated=truncated,
            _returned_ids=returned_ids,
        )
