"""Assembling the agent stack (PLAN.md 6.10, 9.3).

One function builds the gateway, cache, budget ledger and runner from config, so
the CLI, the tests and the future FastAPI service all get the same wiring and the
same fallback behaviour.

The degradation path is deliberate. With no key, or with `agents.enabled: false`,
the stack is still built - around a gateway that refuses every call - so the
runner takes its normal fallback branch and the demo runs on the deterministic
baseline, labelled as such. Nothing has to be reconfigured to survive a venue with
no network.
"""

from __future__ import annotations

from dataclasses import dataclass

from goru_core.config import Config

from app.agents.runner import AgentRunner
from app.llm.budget import BudgetLedger
from app.llm.cache import ResponseCache
from app.llm.glm import GlmGateway
from app.llm.port import LlmGateway
from app.llm.stub import ScriptedGateway

__all__ = ["AgentStack", "build_agent_stack"]


@dataclass
class AgentStack:
    """Everything needed to run an agent, plus why it might be degraded."""

    runner: AgentRunner
    gateway: LlmGateway
    cache: ResponseCache
    budget: BudgetLedger
    live: bool
    reason: str | None = None

    @property
    def mode(self) -> str:
        if not self.live:
            return "offline"
        return "cache-only" if self._cache_only else "live"

    _cache_only: bool = False

    def describe(self) -> str:
        """One line for the operator: what the agent layer will actually do."""
        if not self.live:
            return f"agent layer OFFLINE ({self.reason}); deterministic baseline only"
        if self._cache_only:
            return f"agent layer CACHE-ONLY ({len(self.cache)} cached responses); no spend"
        snapshot = self.budget.snapshot()
        return (
            f"agent layer LIVE on {self.gateway.model}; "
            f"spend ${snapshot.effective_spend_usd:.4f} of ${snapshot.cap_usd:.2f}, "
            f"{len(self.cache)} cached"
        )


def build_agent_stack(
    cfg: Config,
    *,
    interactive: bool = False,
    gateway: LlmGateway | None = None,
) -> AgentStack:
    """Build the agent stack for this config.

    Pass `gateway` to inject an adapter (the tests pass a `ScriptedGateway`).
    """
    cache = ResponseCache(cfg.resolve(cfg.agents.cache_dir))
    budget = BudgetLedger(
        cfg.resolve(cfg.agents.budget_file),
        cap_usd=cfg.agents.budget_cap_usd,
        soft_stop_usd=cfg.agents.budget_soft_stop_usd,
        pricing=cfg.agents.pricing,
    )

    live = True
    reason: str | None = None

    if gateway is None:
        if not cfg.agents.enabled:
            gateway = ScriptedGateway([], model=cfg.agents.model)
            live, reason = False, "agents.enabled is false in goru.yaml"
        else:
            api_key = cfg.agent_api_key()
            if not api_key:
                gateway = ScriptedGateway([], model=cfg.agents.model)
                live, reason = False, f"{cfg.agents.api_key_env} is not set in .env"
            else:
                gateway = GlmGateway(cfg.agents, api_key)

    runner = AgentRunner(
        gateway,
        cfg,
        cache=cache,
        budget=budget,
        interactive=interactive,
    )
    return AgentStack(
        runner=runner,
        gateway=gateway,
        cache=cache,
        budget=budget,
        live=live,
        reason=reason,
        _cache_only=cfg.agents.cache_only,
    )
