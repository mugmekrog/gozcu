"""Content-addressed response cache (PLAN.md 6.9, 9.3).

Keyed by the exact request - model, messages, schema, effort, token budget - so a
replay of the demo returns the same answers for free. Two things depend on this:

* budget discipline (R13): rehearsals must not re-spend the $15;
* the offline fallback (9.3): with the cache warm, the agent panel works with the
  gateway unreachable, and the UI can say so honestly.

Deliberately a directory of JSON files rather than a database: it can be inspected,
diffed, committed as a scenario pack, and copied to a venue machine.
"""

from __future__ import annotations

import json
from pathlib import Path

from goru_core.provenance import payload_sha256

from app.llm.port import ChatRequest, ChatResult

__all__ = ["ResponseCache"]


class ResponseCache:
    """A read-through cache of gateway responses."""

    def __init__(self, directory: str | Path) -> None:
        self._dir = Path(directory)

    @property
    def directory(self) -> Path:
        return self._dir

    def key_for(self, model: str, request: ChatRequest) -> str:
        """Stable key for a request. Any change to the prompt changes the key."""
        return payload_sha256(
            {
                "model": model,
                "messages": list(request.messages),
                "schema": request.response_schema,
                "effort": request.reasoning_effort,
                "max_tokens": request.max_tokens,
                "tools": list(request.tools or []),
                "tool_choice": request.tool_choice,
            }
        )

    def _path(self, key: str) -> Path:
        return self._dir / f"{key[:2]}" / f"{key}.json"

    def get(self, key: str) -> ChatResult | None:
        path = self._path(key)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return ChatResult.from_cache_dict(data)

    def put(self, key: str, result: ChatResult) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(result.as_cache_dict(), indent=2, sort_keys=True), encoding="utf-8"
        )

    def __len__(self) -> int:
        if not self._dir.exists():
            return 0
        return sum(1 for _ in self._dir.glob("*/*.json"))

    def __bool__(self) -> bool:
        """A cache object is always present, even when it holds nothing.

        Without this, `__len__` makes an empty cache falsy, and every
        `if self._cache:` in a caller silently becomes "if the cache is warm" -
        which is how the first version of the runner never wrote to it at all.
        """
        return True

    def clear(self) -> int:
        """Remove every cached response. Returns how many were removed."""
        removed = 0
        for path in self._dir.glob("*/*.json"):
            path.unlink()
            removed += 1
        return removed
