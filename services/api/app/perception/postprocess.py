"""Detection post-processing (PLAN.md 6.3, 2.5).

`bounding_boxes.csv` is an mAP submission: about 430 boxes per image, median
score 0.0065, the same object emitted under four different class names. This
module turns one such row into the handful of real vehicles, and - just as
importantly - keeps every box it rejected together with the reason, so the
display can show what was dropped and why.

Order is deliberate (PLAN 6.3): threshold, then NMS, then the ground-area
filter. Thresholding first removes ~98.7 % of boxes before any IoU work, and
running the area filter last means a suppressed tiny duplicate cannot mask the
winner that survived for it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from goru_core.config import Config
from goru_core.geo import Footprint, Frame
from goru_core.predstring import RawBox
from goru_core.provenance import SourceRef
from goru_core.schemas import ENU, Detection, LatLon, SourceRefModel

__all__ = ["postprocess_image", "PostprocessReport", "class_agnostic_nms"]


@dataclass
class PostprocessReport:
    """What the funnel did to one image, for the intake log and the pitch metrics."""

    image_id: str
    raw: int = 0
    after_score: int = 0
    after_nms: int = 0
    kept: int = 0
    dropped_score: int = 0
    dropped_nms: int = 0
    dropped_area: int = 0
    legacy_px_would_drop: int = 0
    class_mix: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "image_id": self.image_id,
            "raw": self.raw,
            "after_score": self.after_score,
            "after_nms": self.after_nms,
            "kept": self.kept,
            "dropped": {
                "score<thr": self.dropped_score,
                "nms_suppressed": self.dropped_nms,
                "area<min_m2": self.dropped_area,
            },
            "legacy_200px_would_drop": self.legacy_px_would_drop,
            "class_mix": dict(sorted(self.class_mix.items())),
        }


def class_agnostic_nms(
    boxes_xyxy: np.ndarray, scores: np.ndarray, iou_threshold: float
) -> tuple[np.ndarray, np.ndarray]:
    """Greedy NMS ignoring class labels (PLAN 6.3 step 3).

    Class-agnostic is not a detail: the CSV emits one physical vehicle as `van`,
    `truck`, `bus` and `car` within a pixel of each other, so class-aware NMS
    would leave the same car on screen four times. The highest-scoring box of a
    cluster wins and its class becomes the object's class.

    Returns ``(keep, suppressed_by)``: indices that survive, and for every input
    box the index of the box that suppressed it (-1 when it was not suppressed).
    """
    count = len(scores)
    suppressed_by = np.full(count, -1, dtype=int)
    if count == 0:
        return np.empty(0, dtype=int), suppressed_by

    order = np.argsort(-scores, kind="stable")
    x1, y1, x2, y2 = boxes_xyxy[:, 0], boxes_xyxy[:, 1], boxes_xyxy[:, 2], boxes_xyxy[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)

    keep: list[int] = []
    alive = np.ones(count, dtype=bool)
    for idx in order:
        if not alive[idx]:
            continue
        keep.append(int(idx))
        alive[idx] = False
        rest = np.flatnonzero(alive)
        if rest.size == 0:
            continue
        inter_w = np.maximum(0.0, np.minimum(x2[idx], x2[rest]) - np.maximum(x1[idx], x1[rest]))
        inter_h = np.maximum(0.0, np.minimum(y2[idx], y2[rest]) - np.maximum(y1[idx], y1[rest]))
        inter = inter_w * inter_h
        union = areas[idx] + areas[rest] - inter
        with np.errstate(divide="ignore", invalid="ignore"):
            iou = np.where(union > 0, inter / union, 0.0)
        losers = rest[iou >= iou_threshold]
        suppressed_by[losers] = idx
        alive[losers] = False
    return np.asarray(keep, dtype=int), suppressed_by


def postprocess_image(
    image_id: str,
    raw_boxes: list[RawBox],
    footprint: Footprint,
    frame: Frame,
    cfg: Config,
    source_ref: SourceRef,
) -> tuple[list[Detection], PostprocessReport]:
    """Turn one image's raw boxes into `Detection`s, keeping the rejects.

    Every returned Detection carries `kept`, and when false a `drop_reason` and
    (for NMS) the `det_id` of the box that beat it. `thresholds_version` stamps
    the settings that admitted it, so a box on screen can always be traced back
    to the operating point that let it through.
    """
    report = PostprocessReport(image_id=image_id, raw=len(raw_boxes))
    if not raw_boxes:
        return [], report

    scores = np.array([b.score for b in raw_boxes], dtype=float)
    boxes_xyxy = np.array([b.bbox_xyxy for b in raw_boxes], dtype=float)
    area_px = np.array([b.area_px for b in raw_boxes], dtype=float)
    area_m2 = area_px * footprint.area_m2_per_px

    det_ids = [f"{image_id}#{index:03d}" for index in range(len(raw_boxes))]

    above = scores >= cfg.detection.score_threshold
    report.after_score = int(above.sum())
    report.dropped_score = int((~above).sum())

    survivor_idx = np.flatnonzero(above)
    if cfg.detection.nms_class_agnostic:
        keep_local, suppressed_local = class_agnostic_nms(
            boxes_xyxy[survivor_idx], scores[survivor_idx], cfg.detection.nms_iou
        )
    else:  # per-class NMS, kept behind the config switch for completeness
        keep_parts: list[np.ndarray] = []
        suppressed_local = np.full(len(survivor_idx), -1, dtype=int)
        classes = np.array([raw_boxes[i].cls for i in survivor_idx])
        for cls in np.unique(classes):
            members = np.flatnonzero(classes == cls)
            keep_cls, supp_cls = class_agnostic_nms(
                boxes_xyxy[survivor_idx][members], scores[survivor_idx][members], cfg.detection.nms_iou
            )
            keep_parts.append(members[keep_cls])
            for local, winner in enumerate(supp_cls):
                if winner >= 0:
                    suppressed_local[members[local]] = members[winner]
        keep_local = np.concatenate(keep_parts) if keep_parts else np.empty(0, dtype=int)

    nms_winners = {int(survivor_idx[i]) for i in keep_local}
    report.after_nms = len(nms_winners)
    report.dropped_nms = report.after_score - report.after_nms

    suppressed_by_global: dict[int, int] = {}
    for local, winner_local in enumerate(suppressed_local):
        if winner_local >= 0:
            suppressed_by_global[int(survivor_idx[local])] = int(survivor_idx[winner_local])

    detections: list[Detection] = []
    for index, box in enumerate(raw_boxes):
        kept = False
        drop_reason: str | None = None
        suppressed_by: str | None = None

        if not above[index]:
            drop_reason = "score<thr"
        elif index not in nms_winners:
            drop_reason = "nms_suppressed"
            winner = suppressed_by_global.get(index)
            suppressed_by = det_ids[winner] if winner is not None else None
        elif area_m2[index] < cfg.detection.min_area_m2:
            drop_reason = "area<min_m2"
            report.dropped_area += 1
        else:
            kept = True

        u, v = box.center_px
        lat, lon = footprint.pixel_to_latlon(u, v)
        east, north = frame.to_enu(lat, lon)

        if kept:
            report.kept += 1
            report.class_mix[box.cls] = report.class_mix.get(box.cls, 0) + 1
            if area_px[index] < cfg.detection.legacy_min_bbox_area_px:
                report.legacy_px_would_drop += 1

        detections.append(
            Detection(
                det_id=det_ids[index],
                image_id=image_id,
                cls=box.cls,  # type: ignore[arg-type]
                score=box.score,
                bbox_px=list(box.bbox_xyxy),
                area_px=float(area_px[index]),
                area_m2=float(area_m2[index]),
                center_px=[u, v],
                center_geo=LatLon(lat=lat, lon=lon),
                center_enu=ENU(e_m=east, n_m=north),
                kept=kept,
                drop_reason=drop_reason,  # type: ignore[arg-type]
                suppressed_by=suppressed_by,
                thresholds_version=cfg.thresholds_version,
                source_ref=SourceRefModel(**source_ref.as_dict()),
            )
        )
    return detections, report
