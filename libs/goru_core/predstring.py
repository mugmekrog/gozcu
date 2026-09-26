"""The `PredictionString` parser (PLAN.md 5.2, 2.5).

`bounding_boxes.csv` is a Kaggle-style mAP submission, not a label file: one row
per image, and each row is whitespace-separated repeating groups of six tokens

    class score x y w h

where ``x y`` is the box's top-left corner and ``w h`` its size, both in pixels.
That reading was verified across all 17 394 boxes: as ``x y w h`` there are zero
out-of-bounds violations, while as ``x1 y1 x2 y2`` there are 17 179.

This module is the only place in the system that knows that encoding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

__all__ = ["RawBox", "parse_prediction_string", "PredictionStringError", "VEHICLE_CLASSES"]

VEHICLE_CLASSES: Final[frozenset[str]] = frozenset({"car", "van", "truck", "bus"})
TOKENS_PER_BOX: Final[int] = 6


class PredictionStringError(ValueError):
    """Raised when a PredictionString cannot be read as whole six-token groups.

    Carries `index`, the zero-based box position at fault, so the intake
    validation error can point at ``/img_000267/boxes/17`` (PLAN 5.3).
    """

    def __init__(self, message: str, *, index: int | None = None, rule: str = "predictionstring") -> None:
        super().__init__(message)
        self.index = index
        self.rule = rule


@dataclass(frozen=True, slots=True)
class RawBox:
    """One box exactly as the CSV states it: top-left corner plus size."""

    cls: str
    score: float
    x: float
    y: float
    w: float
    h: float

    @property
    def bbox_xyxy(self) -> tuple[float, float, float, float]:
        """The corner form the rest of the system stores (PLAN 5.1)."""
        return (self.x, self.y, self.x + self.w, self.y + self.h)

    @property
    def area_px(self) -> float:
        return self.w * self.h

    @property
    def center_px(self) -> tuple[float, float]:
        """Ground point of the vehicle: the box centre, as the brief specifies (A7)."""
        return (self.x + self.w / 2.0, self.y + self.h / 2.0)


def parse_prediction_string(s: str) -> list[RawBox]:
    """Parse one `PredictionString` into boxes.

    Raises `PredictionStringError` when the token count is not a multiple of six,
    when a class is outside {car, van, truck, bus}, when a score is not in
    [0, 1], or when a coordinate is not a finite number. Verified clean on all
    40 rows of the shipped file.
    """
    tokens = (s or "").split()
    if not tokens:
        return []
    remainder = len(tokens) % TOKENS_PER_BOX
    if remainder:
        raise PredictionStringError(
            f"token count {len(tokens)} is not a multiple of {TOKENS_PER_BOX} "
            f"({remainder} trailing token(s))",
            index=len(tokens) // TOKENS_PER_BOX,
            rule="predictionstring.token_count",
        )

    boxes: list[RawBox] = []
    for index, start in enumerate(range(0, len(tokens), TOKENS_PER_BOX)):
        cls = tokens[start]
        if cls not in VEHICLE_CLASSES:
            raise PredictionStringError(
                f"unknown class {cls!r}; expected one of {sorted(VEHICLE_CLASSES)}",
                index=index,
                rule="predictionstring.class",
            )
        try:
            score, x, y, w, h = (float(tok) for tok in tokens[start + 1 : start + TOKENS_PER_BOX])
        except ValueError as exc:
            raise PredictionStringError(
                f"box {index} has a non-numeric token: {exc}",
                index=index,
                rule="predictionstring.number",
            ) from exc
        if not 0.0 <= score <= 1.0:
            raise PredictionStringError(
                f"score {score} outside [0, 1]", index=index, rule="predictionstring.score"
            )
        if w <= 0.0 or h <= 0.0:
            raise PredictionStringError(
                f"box {index} has non-positive size {w}x{h}",
                index=index,
                rule="predictionstring.size",
            )
        boxes.append(RawBox(cls=cls, score=score, x=x, y=y, w=w, h=h))
    return boxes
