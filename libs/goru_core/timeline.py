"""Exercise time handling (PLAN.md 6.1).

The dataset carries bare ``HH:MM`` strings. Everything downstream needs
timezone-aware UTC instants, and every computation must obey the as-of rule: at
simulation time ``now``, only records with ``ts <= now`` may be used.

`Timeline` is the single place that knows how to cross that gap. Named
`timeline` rather than `time` so that `goru_core.timeline` can never be confused
with the standard library module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterable, Sequence, TypeVar
from zoneinfo import ZoneInfo

__all__ = ["Timeline", "TimeFormatError", "HHMM_RE"]

HHMM_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

T = TypeVar("T")


class TimeFormatError(ValueError):
    """Raised when a time string is not a strict ``HH:MM``."""


@dataclass(frozen=True)
class Timeline:
    """Maps the exercise's ``HH:MM`` strings onto absolute UTC instants.

    One exercise day in one timezone (A3). Day rollover inside a track is
    handled by `advance_past`, which is the only sanctioned way to interpret a
    time that goes backwards.
    """

    exercise_date: date
    tz: ZoneInfo

    @classmethod
    def from_config(cls, cfg) -> "Timeline":
        return cls(exercise_date=cfg.exercise_date, tz=ZoneInfo(cfg.tz))

    def at(self, hhmm: str, *, day_offset: int = 0) -> datetime:
        """Strictly parse ``HH:MM`` and return an aware UTC datetime."""
        if not isinstance(hhmm, str) or not HHMM_RE.match(hhmm.strip()):
            raise TimeFormatError(f"expected strict HH:MM, got {hhmm!r}")
        hour, minute = (int(part) for part in hhmm.strip().split(":"))
        local = datetime(
            self.exercise_date.year,
            self.exercise_date.month,
            self.exercise_date.day,
            hour,
            minute,
            tzinfo=self.tz,
        ) + timedelta(days=day_offset)
        return local.astimezone(timezone.utc)

    def hhmm(self, ts: datetime) -> str:
        """Render an instant back as ``HH:MM`` in exercise-local time."""
        return ts.astimezone(self.tz).strftime("%H:%M")

    def advance_past(self, hhmm: str, previous: datetime) -> datetime:
        """Parse `hhmm`, rolling to the next day if it would precede `previous`.

        Used by the track loader: a time that decreases within one track means
        the window crossed midnight (A3). Not observed in the shipped data, but
        the loader logs a warning when it fires.
        """
        ts = self.at(hhmm)
        while ts < previous:
            ts += timedelta(days=1)
        return ts

    def window(self, ts: datetime, minutes: float) -> tuple[datetime, datetime]:
        """The symmetric +/- window around `ts`, for report-to-track matching."""
        delta = timedelta(minutes=minutes)
        return ts - delta, ts + delta

    @staticmethod
    def as_of(items: Iterable[T], now: datetime, key: Callable[[T], datetime]) -> list[T]:
        """Filter to records at or before `now`. The no-future-leakage gate.

        Every query the engine makes against the dataset goes through here, so
        there is exactly one place to test that the simulation cannot see its
        own future.
        """
        return [item for item in items if key(item) <= now]

    def ticks(self, start: str, end: str, step_s: int) -> Sequence[datetime]:
        """Simulation tick instants over ``[start, end]`` inclusive."""
        first, last = self.at(start), self.at(end)
        if last < first:
            raise TimeFormatError(f"sim end {end} precedes start {start}")
        step = timedelta(seconds=step_s)
        out: list[datetime] = []
        cursor = first
        while cursor <= last:
            out.append(cursor)
            cursor += step
        return out
