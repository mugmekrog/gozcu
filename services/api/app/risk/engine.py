"""The deterministic warning baseline, centred on the protected base (PLAN.md 6.7).

Team decision (2026-09-27): Merkez Us is the protected asset; the eight zones are
observation sectors that name where a vehicle is. So every rule here is about the
base, and it reads two things: the instantaneous geometry against the base's rings
(`assess_zones` with the base as the target) and the whole two-hour record
(`BehaviourProfile`), because the brief says to judge movement from the whole record.

Each rule that fires is a `Signal` in one of the two families the team asked for:

* **approach**     - inside the critical ring, about to cross it, closing on the base
                     over the last hour, or on a path that passes close soon;
* **surveillance** - circling the base at a steady range, having come inside the
                     critical ring and pulled back, or sitting still nearby.

The level follows from the signals: any strong signal, or signals from both
families, is ALERT with a *high* likelihood; any single signal is WATCH with a
*possible* one. This is the floor. The agent reasons over it and may raise it;
it can never lower it, and if the agent is unavailable this is what ships.

Keeping the rules here, rather than in a prompt, is what makes the core safety
property checkable: a hostile field report cannot argue its way past arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

from goru_core.config import Config
from goru_core.schemas import Level, Likelihood, ThreatCategory, TrackState, ZoneAssessment

from app.kinematics.behaviour import BehaviourProfile

__all__ = [
    "BaselineVerdict",
    "ReportSupport",
    "RuleEngine",
    "Hysteresis",
    "Signal",
    "PriorityTerm",
    "likelihood_of",
]

HEAVY_CLASSES = frozenset({"truck", "bus"})


@dataclass(frozen=True)
class ReportSupport:
    """What the field reports alone may justify for one track (PLAN 6.8.5)."""

    cap: Level = Level.CLEAR
    report_ids: tuple[str, ...] = ()
    note: str | None = None


@dataclass(frozen=True)
class Signal:
    """One rule that fired, with the sentence the operator reads."""

    kind: str
    category: ThreatCategory
    strong: bool
    reason: str


@dataclass(frozen=True)
class PriorityTerm:
    """One weighted part of the priority. The display explains the score from these,
    so the formula lives here once and a screen cannot drift from it."""

    name: str  # eta_critical | proximity | approach_conf
    weight: float
    value: float  # 0..1

    @property
    def contribution(self) -> float:
        return self.weight * self.value


@dataclass(frozen=True)
class BaselineVerdict:
    """The rule engine's output for one track."""

    level: Level
    zone_id: str | None  # the observation sector the vehicle is in
    priority: float
    reasons: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    destination_zone_id: str | None = None
    category: ThreatCategory | None = None
    likelihood: Likelihood | None = None
    signals: tuple[Signal, ...] = ()
    priority_terms: tuple[PriorityTerm, ...] = ()
    heavy_multiplier: float | None = None  # set when a truck or bus scaled the priority


class RuleEngine:
    """Evaluates one track against the base: signals, then level, category and likelihood."""

    def __init__(self, cfg: Config, zone_names: Mapping[str, str]) -> None:
        self._cfg = cfg
        self._zone_names = dict(zone_names)

    def _name(self, zone_id: str | None) -> str:
        return self._zone_names.get(zone_id or "", zone_id or "bilinmeyen sektör")

    def evaluate(
        self,
        state: TrackState,
        base: ZoneAssessment,
        behaviour: BehaviourProfile,
        *,
        sector_id: str | None,
        detection_id: str | None = None,
        report_support: ReportSupport | None = None,
        destination_zone_id: str | None = None,
    ) -> BaselineVerdict:
        """Level, threat category, likelihood and code-written reasons for one track."""
        support = report_support or ReportSupport()
        heavy = state.class_hint in HEAVY_CLASSES
        evidence: list[str] = [state.track_id]
        if detection_id:
            evidence.append(detection_id)
        evidence.extend(support.report_ids)

        signals = self._approach_signals(state, base, behaviour, heavy=heavy)
        signals += self._surveillance_signals(behaviour)
        # Strong signals first, so the first reason is the one that set the level.
        signals.sort(key=lambda s: not s.strong)

        families = {s.category for s in signals}
        if any(s.strong for s in signals) or len(families) > 1:
            level = Level.ALERT
        elif signals:
            level = Level.WATCH
        else:
            level = Level.CLEAR

        reasons = [s.reason for s in signals]
        # Reports may raise, never lower, and only up to their own cap.
        if support.cap.rank > level.rank:
            level = support.cap
            reasons.insert(
                0, support.note or f"saha raporu kanıtı ({', '.join(support.report_ids)})"
            )
        if not reasons:
            state_text = "duruyor" if state.stationary else f"{state.speed_mps:.1f} m/s"
            reasons.append(
                f"Üsse {behaviour.range_m / 1000:.2f} km, {self._name(sector_id)} sektöründe; "
                f"{state_text}; tehdit sinyali yok"
            )

        priority, terms, multiplier = self._priority(base, behaviour, heavy=heavy)
        return BaselineVerdict(
            level=level,
            zone_id=sector_id,
            priority=priority,
            priority_terms=terms,
            heavy_multiplier=multiplier,
            reasons=reasons[:4],
            evidence=evidence,
            destination_zone_id=destination_zone_id,
            category=signals[0].category if signals else None,
            likelihood=likelihood_of(level),
            signals=tuple(signals),
        )

    # ------------------------------------------------------------------ #
    # The two families
    # ------------------------------------------------------------------ #

    def _approach_signals(
        self, state: TrackState, base: ZoneAssessment, behaviour: BehaviourProfile, *, heavy: bool
    ) -> list[Signal]:
        rings, threat, warning = self._cfg.base, self._cfg.threat, self._cfg.warning
        signals: list[Signal] = []

        if base.inside_zone:
            signals.append(
                Signal("inside_critical", "approach", True,
                       f"Kritik halkanın içinde: üsse {base.dist_now_m:.0f} m")
            )
        elif (
            base.eta_entry_s is not None
            and base.eta_entry_s <= warning.alert_eta_s
            and base.approach_conf >= warning.alert_conf
        ):
            signals.append(
                Signal("imminent_entry", "approach", True,
                       f"Kritik halkaya {base.eta_entry_s / 60.0:.1f} dk içinde giriyor "
                       f"({state.speed_mps:.1f} m/s, yaklaşma {base.approach_conf:.2f})")
            )

        closed = behaviour.closing_m.get(threat.approach_window_min)
        heading = behaviour.heading_to_base_cos
        if (
            closed is not None
            and closed >= threat.approach_min_closing_m
            and heading is not None
            and heading >= threat.approach_heading_cos
        ):
            signals.append(
                Signal("sustained_approach", "approach",
                       heavy and behaviour.range_m <= rings.warning_radius_m,
                       f"Son {threat.approach_window_min} dk'da üsse {closed / 1000:.2f} km yaklaştı; "
                       f"şimdi {behaviour.range_m / 1000:.2f} km")
            )
        elif (
            not state.stationary
            and base.cpa_m <= rings.warning_radius_m
            and 0.0 < base.t_cpa_s <= warning.horizon_s
            and base.approach_conf >= warning.watch_conf
        ):
            signals.append(
                Signal("closing_path", "approach", False,
                       f"Rotası üsse {base.cpa_m:.0f} m'ye, {base.t_cpa_s / 60.0:.1f} dk içinde "
                       f"yaklaştırıyor (yaklaşma {base.approach_conf:.2f})")
            )
        return signals

    def _surveillance_signals(self, behaviour: BehaviourProfile) -> list[Signal]:
        rings, threat = self._cfg.base, self._cfg.threat
        signals: list[Signal] = []

        if (
            behaviour.sweep_deg >= threat.circling_min_sweep_deg
            and behaviour.range_spread <= threat.circling_max_range_spread
            and behaviour.range_m <= rings.observation_radius_m
        ):
            signals.append(
                Signal("circling", "surveillance",
                       behaviour.sweep_deg >= threat.circling_strong_sweep_deg
                       and behaviour.range_m <= rings.warning_radius_m,
                       f"Üs çevresinde {behaviour.sweep_deg:.0f}° döndü; "
                       f"mesafe {behaviour.range_m / 1000:.2f} km civarında sabit")
            )
        # Came in from outside the critical ring and is outside again. A record that
        # starts near the base and drives away is a departure, not a probe.
        came_in = behaviour.came_in_from_m is not None and behaviour.came_in_from_m > rings.critical_radius_m
        if came_in and behaviour.closest_m <= rings.critical_radius_m < behaviour.range_m:
            signals.append(
                Signal("probe", "surveillance", False,
                       f"Kayıt içinde üsse {behaviour.closest_m:.0f} m'ye girdi "
                       f"({behaviour.closest_min_ago:.0f} dk önce); şimdi {behaviour.range_m / 1000:.2f} km")
            )
        if behaviour.loiter_min >= threat.loiter_min:
            signals.append(
                Signal("loiter", "surveillance", False,
                       f"Üsse {threat.dwell_radius_m / 1000:.0f} km içinde {behaviour.loiter_min:.0f} dk durdu; "
                       f"şimdi {behaviour.range_m / 1000:.2f} km")
            )
        return signals

    # ------------------------------------------------------------------ #

    def _priority(
        self, base: ZoneAssessment, behaviour: BehaviourProfile, *, heavy: bool
    ) -> tuple[float, tuple[PriorityTerm, ...], float | None]:
        """0..1 ranking within a level: soon, near and pointed at the base; heavy weighted up."""
        warning = self._cfg.warning
        eta = base.eta_entry_s
        terms = (
            PriorityTerm(
                "eta_critical", 0.5,
                1.0 - min(1.0, eta / warning.horizon_s) if eta is not None else 0.0,
            ),
            PriorityTerm(
                "proximity", 0.3,
                1.0 - min(1.0, behaviour.range_m / self._cfg.base.observation_radius_m),
            ),
            PriorityTerm("approach_conf", 0.2, base.approach_conf),
        )
        score = sum(term.contribution for term in terms)
        multiplier = warning.heavy_vehicle_multiplier if heavy else None
        if multiplier:
            score *= multiplier
        return float(min(1.0, max(0.0, score))), terms, multiplier

    def untracked_detection_level(self, inside_warning_ring: bool) -> Level:
        """An untracked detection inside the warning ring is a WATCH; otherwise CLEAR."""
        return Level.WATCH if inside_warning_ring else Level.CLEAR


def likelihood_of(level: Level) -> Likelihood | None:
    """ALERT is a high-likelihood threat, WATCH a possible one, CLEAR none."""
    return {Level.ALERT: "high", Level.WATCH: "possible"}.get(level)


class Hysteresis:
    """Upgrades apply at once; downgrades need N consecutive quieter ticks (PLAN 6.7).

    Without this, a vehicle hovering at a threshold flickers between levels and
    the queue becomes unreadable.
    """

    def __init__(self, consecutive: int) -> None:
        self._needed = max(1, consecutive)
        self._current: dict[str, Level] = {}
        self._pending: dict[str, tuple[Level, int]] = {}

    def apply(self, key: str, proposed: Level) -> Level:
        current = self._current.get(key)
        if current is None or proposed.rank >= current.rank:
            self._current[key] = proposed
            self._pending.pop(key, None)
            return proposed

        pending_level, count = self._pending.get(key, (proposed, 0))
        count = count + 1 if pending_level is proposed else 1
        if count >= self._needed:
            self._current[key] = proposed
            self._pending.pop(key, None)
            return proposed
        self._pending[key] = (proposed, count)
        return current

    def level_of(self, key: str) -> Level:
        return self._current.get(key, Level.CLEAR)

    def reset(self) -> None:
        self._current.clear()
        self._pending.clear()
