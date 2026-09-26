"""The spend guard (PLAN.md 6.11, risk R13).

The gateway key carries $15 for the whole competition and never resets, so the
budget is a hard engineering constraint rather than a footnote: one retry loop
without a cap can drain it before the demo.

`BudgetLedger` is the one place that knows how much has been spent. It persists
across processes, refuses non-interactive calls past the soft stop, refuses
everything past the cap, and reconciles its local estimate against the gateway's
own `spend` whenever that is reachable - because the gateway's figure is the
authoritative one and our per-token estimate is only an estimate.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from goru_core.config import PricingConfig

from app.llm.port import BudgetExceeded

__all__ = ["BudgetLedger", "BudgetSnapshot"]


@dataclass(frozen=True)
class BudgetSnapshot:
    """What `/agents/budget` returns and the UI meter shows."""

    local_spend_usd: float
    remote_spend_usd: float | None
    cap_usd: float
    soft_stop_usd: float
    calls: int
    prompt_tokens: int
    completion_tokens: int
    cache_hits: int
    remote_checked_at: str | None

    @property
    def effective_spend_usd(self) -> float:
        """The figure to act on: the gateway's if we have it, else our estimate."""
        return self.remote_spend_usd if self.remote_spend_usd is not None else self.local_spend_usd

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.cap_usd - self.effective_spend_usd)

    def as_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["effective_spend_usd"] = round(self.effective_spend_usd, 6)
        data["remaining_usd"] = round(self.remaining_usd, 6)
        return data


@dataclass
class _State:
    local_spend_usd: float = 0.0
    remote_spend_usd: float | None = None
    remote_checked_at: str | None = None
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hits: int = 0
    by_purpose: dict[str, float] = field(default_factory=dict)


class BudgetLedger:
    """Persistent, thread-safe spend counter with a hard cap and a soft stop."""

    def __init__(
        self,
        path: str | Path,
        *,
        cap_usd: float,
        soft_stop_usd: float,
        pricing: PricingConfig,
    ) -> None:
        self._path = Path(path)
        self._cap = float(cap_usd)
        self._soft_stop = float(soft_stop_usd)
        self._pricing = pricing
        self._lock = threading.Lock()
        self._state = self._read()

    # --- persistence ------------------------------------------------------ #

    def _read(self) -> _State:
        if not self._path.exists():
            return _State()
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _State()
        return _State(
            local_spend_usd=float(data.get("local_spend_usd", 0.0)),
            remote_spend_usd=data.get("remote_spend_usd"),
            remote_checked_at=data.get("remote_checked_at"),
            calls=int(data.get("calls", 0)),
            prompt_tokens=int(data.get("prompt_tokens", 0)),
            completion_tokens=int(data.get("completion_tokens", 0)),
            cache_hits=int(data.get("cache_hits", 0)),
            by_purpose=dict(data.get("by_purpose", {})),
        )

    def _write(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(asdict(self._state), indent=2, sort_keys=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(payload, encoding="utf-8")
        os.replace(temporary, self._path)

    # --- accounting ------------------------------------------------------- #

    def cost_of(self, prompt_tokens: int, completion_tokens: int) -> float:
        """Our local cost estimate for a call, in dollars."""
        return (
            prompt_tokens * self._pricing.input_usd_per_mtok
            + completion_tokens * self._pricing.output_usd_per_mtok
        ) / 1_000_000.0

    def estimate(self, prompt_chars: int, max_tokens: int) -> float:
        """Worst-case cost of a call before making it.

        Four characters per token is the usual rule of thumb for English and is
        close enough for a pre-flight guard; the output side assumes the model
        spends its whole allowance, because with thinking enabled it may.
        """
        return self.cost_of(prompt_chars // 4, max_tokens)

    def guard(self, estimated_usd: float, *, interactive: bool) -> None:
        """Refuse a call that would breach the guard. Raises `BudgetExceeded`.

        Past the soft stop, only a human-initiated call may proceed: an operator
        asking the copilot a question is worth a cent, an unattended batch is not.
        """
        with self._lock:
            spend = self._effective_spend()
            if spend + estimated_usd > self._cap:
                raise BudgetExceeded(
                    f"call refused: estimated ${estimated_usd:.4f} would take spend "
                    f"${spend:.4f} past the ${self._cap:.2f} cap"
                )
            if not interactive and spend + estimated_usd > self._soft_stop:
                raise BudgetExceeded(
                    f"non-interactive call refused: spend ${spend:.4f} is at the "
                    f"${self._soft_stop:.2f} soft stop; run from the cache or raise the limit"
                )

    def record(
        self,
        *,
        prompt_tokens: int,
        completion_tokens: int,
        cost_usd: float | None = None,
        purpose: str = "assess",
    ) -> float:
        """Book a completed call and return the cost charged locally."""
        charge = self.cost_of(prompt_tokens, completion_tokens) if cost_usd is None else cost_usd
        with self._lock:
            self._state.local_spend_usd += charge
            self._state.calls += 1
            self._state.prompt_tokens += prompt_tokens
            self._state.completion_tokens += completion_tokens
            self._state.by_purpose[purpose] = self._state.by_purpose.get(purpose, 0.0) + charge
            self._write()
        return charge

    def record_cache_hit(self) -> None:
        with self._lock:
            self._state.cache_hits += 1
            self._write()

    def reconcile(self, remote_spend_usd: float | None) -> None:
        """Adopt the gateway's authoritative spend figure."""
        if remote_spend_usd is None:
            return
        with self._lock:
            self._state.remote_spend_usd = float(remote_spend_usd)
            self._state.remote_checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self._write()

    def _effective_spend(self) -> float:
        remote = self._state.remote_spend_usd
        return max(remote, self._state.local_spend_usd) if remote is not None else self._state.local_spend_usd

    def snapshot(self) -> BudgetSnapshot:
        with self._lock:
            return BudgetSnapshot(
                local_spend_usd=round(self._state.local_spend_usd, 6),
                remote_spend_usd=self._state.remote_spend_usd,
                cap_usd=self._cap,
                soft_stop_usd=self._soft_stop,
                calls=self._state.calls,
                prompt_tokens=self._state.prompt_tokens,
                completion_tokens=self._state.completion_tokens,
                cache_hits=self._state.cache_hits,
                remote_checked_at=self._state.remote_checked_at,
            )
