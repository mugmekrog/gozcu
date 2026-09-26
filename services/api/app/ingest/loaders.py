"""Intake: load and validate the six sources (PLAN.md 7.2.1, 5.3).

One call, `load_dataset(config)`, returns an immutable `Dataset` plus every
validation finding. Nothing downstream parses a file again, and nothing
downstream has to wonder whether a field was checked.

Validation is *reported*, not raised: the intake screen needs the whole list of
findings with file, JSON pointer, offending raw text and rule name. Callers
decide whether `error`-severity findings block them (the CLI refuses to run the
engine unless `--allow-errors` is given).
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from goru_core.config import Config
from goru_core.geo import Footprint, Frame
from goru_core.predstring import PredictionStringError, RawBox, parse_prediction_string
from goru_core.provenance import DatasetVersion
from goru_core.schemas import (
    Corners,
    ENU,
    FieldReport,
    ImageMeta,
    LatLon,
    SourceRefModel,
    TrackPoint,
    ValidationIssue,
    Zone,
)
from goru_core.timeline import HHMM_RE, Timeline

__all__ = ["Dataset", "ValidationLog", "load_dataset", "DatasetError"]

MAX_BASE_DISTANCE_M = 15_000.0
TRACK_STEP_MIN = 5
EXPECTED_ZONE_COUNT = 8


class DatasetError(Exception):
    """Raised when a source file is so broken that nothing can be loaded from it."""


class ValidationLog:
    """Collects findings. The only way issues enter the system."""

    def __init__(self) -> None:
        self._issues: list[ValidationIssue] = []

    def add(
        self,
        file: str,
        pointer: str,
        rule: str,
        severity: str,
        message: str,
        raw: str | None = None,
    ) -> None:
        self._issues.append(
            ValidationIssue(
                file=file,
                pointer=pointer,
                rule=rule,
                severity=severity,  # type: ignore[arg-type]
                message=message,
                raw=(raw[:200] if raw else None),
            )
        )

    def error(self, file: str, pointer: str, rule: str, message: str, raw: str | None = None) -> None:
        self.add(file, pointer, rule, "error", message, raw)

    def warning(self, file: str, pointer: str, rule: str, message: str, raw: str | None = None) -> None:
        self.add(file, pointer, rule, "warning", message, raw)

    @property
    def issues(self) -> list[ValidationIssue]:
        return list(self._issues)

    @property
    def errors(self) -> list[ValidationIssue]:
        return [i for i in self._issues if i.severity == "error"]

    @property
    def warnings(self) -> list[ValidationIssue]:
        return [i for i in self._issues if i.severity == "warning"]


@dataclass(frozen=True)
class Dataset:
    """The whole exercise dataset, normalised and cross-referenced.

    Holds only facts read from files. Everything derived - detections, matches,
    kinematics, assessments - is computed by the pipeline from this.
    """

    version: DatasetVersion
    frame: Frame
    timeline: Timeline
    base_name: str
    base: LatLon
    images: Mapping[str, ImageMeta]
    footprints: Mapping[str, Footprint]
    raw_boxes: Mapping[str, list[RawBox]]
    tracks: Mapping[str, list[TrackPoint]]
    zones: Sequence[Zone]
    reports: Sequence[FieldReport]
    issues: Sequence[ValidationIssue] = field(default_factory=list)

    # --- derived indexes (cheap, built once) --------------------------------- #

    @property
    def image_ids(self) -> list[str]:
        return sorted(self.images)

    def image_at(self, capture_ts: datetime) -> ImageMeta | None:
        for meta in self.images.values():
            if meta.capture_ts == capture_ts:
                return meta
        return None

    def tracks_ending_at(self, ts: datetime) -> list[str]:
        """Track ids whose last fix is exactly `ts` (A11: the image's vehicles)."""
        return sorted(tid for tid, pts in self.tracks.items() if pts and pts[-1].ts == ts)

    def track_points_as_of(self, track_id: str, now: datetime) -> list[TrackPoint]:
        return Timeline.as_of(self.tracks[track_id], now, key=lambda p: p.ts)

    def zone_by_id(self, zone_id: str) -> Zone | None:
        return next((z for z in self.zones if z.zone_id == zone_id), None)

    def zone_by_name(self, name: str) -> Zone | None:
        folded = name.strip().casefold()
        return next((z for z in self.zones if z.name.casefold() == folded), None)

    def reports_in_window(self, start: datetime, end: datetime) -> list[FieldReport]:
        return [r for r in self.reports if start <= r.ts <= end]

    def census(self) -> dict[str, object]:
        """The numbers PLAN 2 measured, recomputed. Used by `cli data-report`."""
        resolutions: dict[str, int] = {}
        for meta in self.images.values():
            key = f"{meta.width_px}x{meta.height_px}"
            resolutions[key] = resolutions.get(key, 0) + 1
        point_counts = {len(pts) for pts in self.tracks.values()}
        gsds = [fp.gsd_x_m for fp in self.footprints.values()]
        return {
            "dataset_version": self.version.version_id,
            "images": len(self.images),
            "resolutions": dict(sorted(resolutions.items())),
            "gsd_x_min": min(gsds) if gsds else 0.0,
            "gsd_x_max": max(gsds) if gsds else 0.0,
            "raw_boxes": sum(len(b) for b in self.raw_boxes.values()),
            "tracks": len(self.tracks),
            "track_point_counts": sorted(point_counts),
            "reports": len(self.reports),
            "reports_official": sum(1 for r in self.reports if r.source == "official"),
            "reports_third_party": sum(1 for r in self.reports if r.source == "third_party"),
            "zones": len(self.zones),
            "errors": sum(1 for i in self.issues if i.severity == "error"),
            "warnings": sum(1 for i in self.issues if i.severity == "warning"),
        }


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #


def _json_error_pointer(text: str, exc: json.JSONDecodeError) -> tuple[str, str]:
    """Best-effort JSON pointer and raw snippet for a decode failure.

    A malformed number such as ``"lon": 3'2.85306`` aborts the whole file, so the
    intake screen would otherwise only be able to say "invalid JSON". Walking
    back to the nearest key turns that into ``/base/lon`` with the raw text,
    which is what the operator actually needs (PLAN 9.2 step 1).
    """
    head = text[: exc.pos]
    keys: list[str] = []
    depth_stack: list[str] = []
    for token in _iter_json_keys(head):
        depth_stack = token
    keys = depth_stack
    pointer = "/" + "/".join(keys) if keys else f"/(offset {exc.pos})"
    line_start = text.rfind("\n", 0, exc.pos) + 1
    line_end = text.find("\n", exc.pos)
    raw = text[line_start : line_end if line_end != -1 else len(text)].strip()
    return pointer, raw


def _iter_json_keys(head: str) -> Iterable[list[str]]:
    """Yield the key path after each key seen, tracking object/array nesting."""
    path: list[str] = []
    i = 0
    n = len(head)
    array_index: list[int] = []
    while i < n:
        ch = head[i]
        if ch == '"':
            j = i + 1
            while j < n and not (head[j] == '"' and head[j - 1] != "\\"):
                j += 1
            token = head[i + 1 : j]
            k = j + 1
            while k < n and head[k] in " \t\r\n":
                k += 1
            if k < n and head[k] == ":":
                if path and path[-1].startswith("\0"):
                    path.pop()
                path.append(token)
                yield list(path)
            i = j + 1
            continue
        if ch == "{":
            path.append("\0")
            i += 1
            continue
        if ch == "}":
            while path and path[-1] != "\0":
                path.pop()
            if path:
                path.pop()
            i += 1
            continue
        if ch == "[":
            array_index.append(0)
            i += 1
            continue
        if ch == "]":
            if array_index:
                array_index.pop()
            i += 1
            continue
        i += 1
    return


def _load_json(path: Path, log: ValidationLog, rule: str) -> object | None:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        log.error(path.name, "/", f"{rule}.missing", f"{path.name} not found")
        return None
    except UnicodeDecodeError as exc:
        log.error(path.name, "/", f"{rule}.encoding", f"not valid UTF-8: {exc}")
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        pointer, raw = _json_error_pointer(text, exc)
        log.error(
            path.name,
            pointer,
            f"{rule}.number_parse" if "Expecting" in exc.msg or "delimiter" in exc.msg else f"{rule}.json",
            f"{exc.msg} at line {exc.lineno} column {exc.colno}",
            raw,
        )
        return None


def _load_zones(path: Path, cfg: Config, log: ValidationLog) -> tuple[str, LatLon, list[Zone], Frame]:
    raw = _load_json(path, log, "zones")
    if not isinstance(raw, dict):
        raise DatasetError(f"{path.name} could not be read; see validation issues")

    base_raw = raw.get("base") or {}
    try:
        base = LatLon(lat=float(base_raw["lat"]), lon=float(base_raw["lon"]))
    except (KeyError, TypeError, ValueError) as exc:
        log.error(path.name, "/base", "zones.base", f"base coordinates unusable: {exc}")
        raise DatasetError("zones.json has no usable base") from exc
    base_name = str(base_raw.get("name", "base"))
    frame = Frame.at(base.lat, base.lon)

    zones_raw = raw.get("zones")
    if not isinstance(zones_raw, list):
        log.error(path.name, "/zones", "zones.shape", "`zones` must be a list")
        zones_raw = []
    if len(zones_raw) != EXPECTED_ZONE_COUNT:
        log.error(
            path.name,
            "/zones",
            "zones.count",
            f"expected {EXPECTED_ZONE_COUNT} zones, found {len(zones_raw)}",
        )

    zones: list[Zone] = []
    seen: set[str] = set()
    for index, entry in enumerate(zones_raw):
        pointer = f"/zones/{index}"
        if not isinstance(entry, dict):
            log.error(path.name, pointer, "zones.shape", "zone entry is not an object")
            continue
        name = str(entry.get("name", "")).strip()
        center = entry.get("center")
        if not name:
            log.error(path.name, f"{pointer}/name", "zones.name", "zone has no name")
            continue
        if name.casefold() in seen:
            log.error(path.name, f"{pointer}/name", "zones.unique", f"duplicate zone name {name!r}")
            continue
        seen.add(name.casefold())
        try:
            lat, lon = float(center[0]), float(center[1])  # type: ignore[index]
        except (TypeError, ValueError, IndexError):
            log.error(
                path.name,
                f"{pointer}/center",
                "zones.number_parse",
                "center is not a [lat, lon] pair of numbers",
                raw=str(center),
            )
            continue
        east, north = frame.to_enu(lat, lon)
        distance = (east**2 + north**2) ** 0.5
        if not 500.0 <= distance <= 10_000.0:
            log.warning(
                path.name,
                f"{pointer}/center",
                "zones.distance",
                f"{name} is {distance:.0f} m from base, outside the expected 0.5-10 km",
            )
        zones.append(
            Zone(
                zone_id=f"Z{index + 1:02d}",
                name=name,
                center=LatLon(lat=lat, lon=lon),
                center_enu=ENU(e_m=east, n_m=north),
                radius_m=cfg.zones.radius_for(name),
                buffer_m=cfg.zones.buffer_for(name),
            )
        )
    return base_name, base, zones, frame


def _load_image_meta(
    path: Path,
    images_dir: Path,
    cfg: Config,
    frame: Frame,
    timeline: Timeline,
    version: DatasetVersion,
    log: ValidationLog,
) -> tuple[dict[str, ImageMeta], dict[str, Footprint]]:
    raw = _load_json(path, log, "image_meta")
    if not isinstance(raw, dict):
        raise DatasetError(f"{path.name} could not be read; see validation issues")

    metas: dict[str, ImageMeta] = {}
    footprints: dict[str, Footprint] = {}
    on_disk = {p.stem for p in images_dir.glob("*.jpg")} if images_dir.exists() else set()

    for image_id, entry in raw.items():
        pointer = f"/{image_id}"
        if not isinstance(entry, dict):
            log.error(path.name, pointer, "image_meta.shape", "entry is not an object")
            continue
        try:
            width = int(entry["width_px"])
            height = int(entry["height_px"])
        except (KeyError, TypeError, ValueError):
            log.error(path.name, pointer, "image_meta.dimensions", "width_px/height_px missing or not integers")
            continue
        if width <= 0 or height <= 0:
            log.error(path.name, pointer, "image_meta.dimensions", f"non-positive size {width}x{height}")
            continue
        capture_time = str(entry.get("capture_time", ""))
        if not HHMM_RE.match(capture_time):
            log.error(
                path.name,
                f"{pointer}/capture_time",
                "image_meta.capture_time",
                "capture_time is not a strict HH:MM",
                raw=capture_time,
            )
            continue
        corners_raw = entry.get("corner_coordinates") or {}
        needed = ("top_left", "top_right", "bottom_left", "bottom_right")
        if not all(k in corners_raw for k in needed):
            log.error(
                path.name,
                f"{pointer}/corner_coordinates",
                "image_meta.corners",
                f"expected all four corners, found {sorted(corners_raw)}",
            )
            continue
        try:
            corner_pairs = {k: (float(corners_raw[k][0]), float(corners_raw[k][1])) for k in needed}
        except (TypeError, ValueError, IndexError):
            log.error(
                path.name,
                f"{pointer}/corner_coordinates",
                "image_meta.number_parse",
                "a corner is not a [lat, lon] pair of numbers",
            )
            continue

        footprint = Footprint(
            image_id=image_id,
            width_px=width,
            height_px=height,
            top_left=corner_pairs["top_left"],
            top_right=corner_pairs["top_right"],
            bottom_left=corner_pairs["bottom_left"],
            bottom_right=corner_pairs["bottom_right"],
        )
        problems = footprint.geometry_problems()
        blocking = [p for p in problems if "GSD" not in p]
        for problem in blocking:
            log.error(path.name, f"{pointer}/corner_coordinates", "image_meta.quad", problem)
        for problem in (p for p in problems if "GSD" in p):
            log.warning(path.name, f"{pointer}/corner_coordinates", "image_meta.gsd_ratio", problem)
        if blocking:
            continue

        centre_lat = (footprint.lat_top + footprint.lat_bottom) / 2.0
        centre_lon = (footprint.lon_left + footprint.lon_right) / 2.0
        if frame.range_m(centre_lat, centre_lon) > MAX_BASE_DISTANCE_M:
            log.warning(
                path.name,
                pointer,
                "image_meta.base_distance",
                f"footprint centre is {frame.range_m(centre_lat, centre_lon) / 1000:.1f} km from base",
            )
        if image_id not in on_disk:
            log.error(path.name, pointer, "image_meta.image_file", f"no image file for {image_id}")
        if footprint.requires_area_filter_review(cfg.detection.legacy_min_bbox_area_px):
            log.warning(
                path.name,
                pointer,
                "image_meta.legacy_area_filter",
                f"at GSD {footprint.gsd_x_m:.4f} m/px the legacy "
                f"{cfg.detection.legacy_min_bbox_area_px:.0f} px^2 rule sits at passenger-car size; "
                "the ground-area filter is used instead",
            )

        corner_enu = footprint.corners_enu(frame)
        metas[image_id] = ImageMeta(
            image_id=image_id,
            width_px=width,
            height_px=height,
            capture_ts=timeline.at(capture_time),
            corners=Corners(
                tl=LatLon(lat=corner_pairs["top_left"][0], lon=corner_pairs["top_left"][1]),
                tr=LatLon(lat=corner_pairs["top_right"][0], lon=corner_pairs["top_right"][1]),
                bl=LatLon(lat=corner_pairs["bottom_left"][0], lon=corner_pairs["bottom_left"][1]),
                br=LatLon(lat=corner_pairs["bottom_right"][0], lon=corner_pairs["bottom_right"][1]),
            ),
            footprint_enu=[ENU(e_m=e, n_m=n) for e, n in corner_enu],
            gsd_x_m=footprint.gsd_x_m,
            gsd_y_m=footprint.gsd_y_m,
            source_ref=SourceRefModel(**version.ref(path.name, image_id).as_dict()),
        )
        footprints[image_id] = footprint

    for stem in sorted(on_disk - set(metas)):
        log.error(path.name, f"/{stem}", "image_meta.orphan_image", f"{stem}.jpg has no metadata entry")

    capture_times = [m.capture_ts for m in metas.values()]
    if len(set(capture_times)) != len(capture_times):
        log.warning(path.name, "/", "image_meta.capture_unique", "two images share a capture time")
    return metas, footprints


def _load_boxes(
    path: Path,
    images: Mapping[str, ImageMeta],
    log: ValidationLog,
) -> dict[str, list[RawBox]]:
    if not path.exists():
        log.error(path.name, "/", "boxes.missing", f"{path.name} not found")
        return {}
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["image_id", "PredictionString"]:
            log.error(
                path.name,
                "/header",
                "boxes.header",
                "header must be exactly image_id,PredictionString",
                raw=",".join(reader.fieldnames or []),
            )
            return {}
        per_image: dict[str, list[RawBox]] = {}
        for row_no, row in enumerate(reader, start=2):
            image_id = (row.get("image_id") or "").strip()
            pointer = f"/{image_id or f'row{row_no}'}"
            if image_id not in images:
                log.error(
                    path.name,
                    pointer,
                    "boxes.image_xref",
                    f"image_id {image_id!r} has no entry in image_meta.json",
                )
                continue
            try:
                boxes = parse_prediction_string(row.get("PredictionString") or "")
            except PredictionStringError as exc:
                log.error(
                    path.name,
                    f"{pointer}/boxes/{exc.index if exc.index is not None else 0}",
                    exc.rule,
                    str(exc),
                    raw=(row.get("PredictionString") or "")[:200],
                )
                continue
            meta = images[image_id]
            for index, box in enumerate(boxes):
                if box.x + box.w > meta.width_px + 1 or box.y + box.h > meta.height_px + 1:
                    log.error(
                        path.name,
                        f"{pointer}/boxes/{index}",
                        "boxes.bounds",
                        f"box exceeds {meta.width_px}x{meta.height_px}: "
                        f"x+w={box.x + box.w:.1f}, y+h={box.y + box.h:.1f}",
                    )
            per_image[image_id] = boxes
    for image_id in sorted(set(images) - set(per_image)):
        log.error(path.name, f"/{image_id}", "boxes.meta_xref", f"no CSV row for image {image_id}")
    return per_image


def _load_tracks(
    path: Path,
    frame: Frame,
    timeline: Timeline,
    images: Mapping[str, ImageMeta],
    cfg: Config,
    version: DatasetVersion,
    log: ValidationLog,
) -> dict[str, list[TrackPoint]]:
    if not path.exists():
        log.error(path.name, "/", "tracks.missing", f"{path.name} not found")
        return {}
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["track_id", "time", "lat", "lon"]:
            log.error(
                path.name,
                "/header",
                "tracks.header",
                "header must be exactly track_id,time,lat,lon",
                raw=",".join(reader.fieldnames or []),
            )
            return {}
        rows: list[tuple[int, str, str, float, float]] = []
        seen_keys: set[tuple[str, str]] = set()
        for row_no, row in enumerate(reader, start=2):
            track_id = (row.get("track_id") or "").strip()
            hhmm = (row.get("time") or "").strip()
            if not track_id:
                log.error(path.name, f"/row/{row_no}", "tracks.track_id", "empty track_id")
                continue
            if not HHMM_RE.match(hhmm):
                log.error(path.name, f"/row/{row_no}/time", "tracks.time", "time is not a strict HH:MM", raw=hhmm)
                continue
            if (track_id, hhmm) in seen_keys:
                log.error(
                    path.name,
                    f"/row/{row_no}",
                    "tracks.duplicate",
                    f"duplicate (track_id, time) = ({track_id}, {hhmm})",
                )
                continue
            seen_keys.add((track_id, hhmm))
            try:
                lat, lon = float(row["lat"]), float(row["lon"])
            except (KeyError, TypeError, ValueError):
                log.error(path.name, f"/row/{row_no}", "tracks.number_parse", "lat/lon are not numbers")
                continue
            rows.append((row_no, track_id, hhmm, lat, lon))

    grouped: dict[str, list[tuple[int, str, float, float]]] = {}
    for row_no, track_id, hhmm, lat, lon in rows:
        grouped.setdefault(track_id, []).append((row_no, hhmm, lat, lon))

    capture_times = {m.capture_ts for m in images.values()}
    tracks: dict[str, list[TrackPoint]] = {}
    for track_id, entries in grouped.items():
        entries.sort(key=lambda e: e[1])
        points: list[TrackPoint] = []
        previous_ts: datetime | None = None
        for row_no, hhmm, lat, lon in entries:
            ts = timeline.at(hhmm) if previous_ts is None else timeline.advance_past(hhmm, previous_ts)
            if previous_ts is not None:
                gap_min = (ts - previous_ts).total_seconds() / 60.0
                if gap_min != TRACK_STEP_MIN:
                    log.warning(
                        path.name,
                        f"/{track_id}/row/{row_no}",
                        "tracks.step",
                        f"step is {gap_min:.0f} min, expected {TRACK_STEP_MIN}",
                    )
                if ts > previous_ts + timedelta(days=0, minutes=0) and hhmm < timeline.hhmm(previous_ts):
                    log.warning(
                        path.name,
                        f"/{track_id}/row/{row_no}",
                        "tracks.rollover",
                        "time decreased within the track; interpreted as the next day",
                    )
            east, north = frame.to_enu(lat, lon)
            if points:
                step_m = ((east - points[-1].e_m) ** 2 + (north - points[-1].n_m) ** 2) ** 0.5
                step_s = (ts - points[-1].ts).total_seconds()
                if step_s > 0 and step_m / step_s > cfg.kinematics.max_step_speed_mps:
                    log.warning(
                        path.name,
                        f"/{track_id}/row/{row_no}",
                        "tracks.step_speed",
                        f"step implies {step_m / step_s:.1f} m/s, above "
                        f"{cfg.kinematics.max_step_speed_mps:.0f} m/s; point flagged as an outlier",
                    )
            points.append(
                TrackPoint(
                    track_id=track_id,
                    ts=ts,
                    lat=lat,
                    lon=lon,
                    e_m=east,
                    n_m=north,
                    source_ref=SourceRefModel(**version.ref(path.name, f"{track_id}@{hhmm}").as_dict()),
                )
            )
            previous_ts = ts
        if not 24 <= len(points) <= 25:
            log.warning(
                path.name,
                f"/{track_id}",
                "tracks.point_count",
                f"{len(points)} points, expected 24-25",
            )
        if points and points[-1].ts not in capture_times:
            log.warning(
                path.name,
                f"/{track_id}",
                "tracks.capture_alignment",
                f"last fix {timeline.hhmm(points[-1].ts)} matches no image capture time (A11 guard)",
            )
        tracks[track_id] = points
    return tracks


def _load_reports(
    path: Path,
    timeline: Timeline,
    frame: Frame,
    zones: Sequence[Zone],
    version: DatasetVersion,
    log: ValidationLog,
) -> list[FieldReport]:
    from app.fusion.reports import parse_report_text  # local import: avoids a cycle

    raw = _load_json(path, log, "field_reports")
    if not isinstance(raw, list):
        log.error(path.name, "/", "field_reports.shape", "file must contain a list of reports")
        return []

    reports: list[FieldReport] = []
    for index, entry in enumerate(raw):
        pointer = f"/{index}"
        report_id = f"R{index + 1:03d}"  # the file carries no id of its own
        if not isinstance(entry, dict):
            log.error(path.name, pointer, "field_reports.shape", "report is not an object")
            continue
        hhmm = str(entry.get("time", ""))
        source = str(entry.get("source", ""))
        text = str(entry.get("text", ""))
        if not HHMM_RE.match(hhmm):
            log.error(path.name, f"{pointer}/time", "field_reports.time", "time is not a strict HH:MM", raw=hhmm)
            continue
        if source not in {"official", "third_party"}:
            log.error(
                path.name,
                f"{pointer}/source",
                "field_reports.source",
                "source must be official or third_party",
                raw=source,
            )
            continue
        if not 1 <= len(text) <= 2000:
            log.error(
                path.name,
                f"{pointer}/text",
                "field_reports.text",
                f"text length {len(text)} outside 1-2000",
            )
            continue
        parsed = parse_report_text(text, zones)
        if parsed.geo is not None and frame.range_m(parsed.geo.lat, parsed.geo.lon) > MAX_BASE_DISTANCE_M:
            log.warning(
                path.name,
                f"{pointer}/text",
                "field_reports.geo_distance",
                f"parsed coordinates are "
                f"{frame.range_m(parsed.geo.lat, parsed.geo.lon) / 1000:.1f} km from base",
            )
        reports.append(
            FieldReport(
                report_id=report_id,
                ts=timeline.at(hhmm),
                source=source,  # type: ignore[arg-type]
                text=text,
                parsed=parsed,
                parser="regex",
                parse_conf=1.0 if parsed.kind != "unknown" else 0.3,
                source_ref=SourceRefModel(**version.ref(path.name, str(index)).as_dict()),
            )
        )
    return reports


def load_dataset(cfg: Config) -> Dataset:
    """Load and validate all six sources. Findings live on `Dataset.issues`."""
    stage2 = cfg.stage2_dir
    paths = {
        "zones.json": stage2 / "zones.json",
        "image_meta.json": stage2 / "image_meta.json",
        "tracks.csv": stage2 / "tracks.csv",
        "field_reports.json": stage2 / "field_reports.json",
        "bounding_boxes.csv": cfg.boxes_csv,
    }
    missing = [name for name, p in paths.items() if not p.exists()]
    if missing:
        raise DatasetError(f"missing source file(s): {', '.join(missing)}")

    version = DatasetVersion.of(paths.values())
    log = ValidationLog()
    timeline = Timeline.from_config(cfg)

    base_name, base, zones, frame = _load_zones(paths["zones.json"], cfg, log)
    images, footprints = _load_image_meta(
        paths["image_meta.json"], stage2 / "images", cfg, frame, timeline, version, log
    )
    raw_boxes = _load_boxes(paths["bounding_boxes.csv"], images, log)
    tracks = _load_tracks(paths["tracks.csv"], frame, timeline, images, cfg, version, log)
    reports = _load_reports(paths["field_reports.json"], timeline, frame, zones, version, log)

    return Dataset(
        version=version,
        frame=frame,
        timeline=timeline,
        base_name=base_name,
        base=base,
        images=images,
        footprints=footprints,
        raw_boxes=raw_boxes,
        tracks=tracks,
        zones=zones,
        reports=reports,
        issues=log.issues,
    )
