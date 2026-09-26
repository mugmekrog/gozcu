"""Field report parsing, matching, trust policy and consistency (PLAN.md 6.8, 2.7).

The brief's rule is the point of the whole exercise: *some reports are correct,
some are wrong or irrelevant, and they are not marked; compare them against your
own findings, and where they conflict, rely on your detection.*

This module therefore does four separable things, each a pure function so each
can be tested on the real 137 reports:

1. `parse_report_text`   - rules-first parse: coordinates, zone names, count and
                           vehicle type, and the template `kind`.
2. `evaluate_consistency`- does the report agree with what we detected?
3. `report_evidence_cap` - the strongest level this report alone may justify.
4. `match_reports_to_tracks` - located reports to nearby tracks in the window.

Text is Turkish, ASCII-folded in the data. No report ever lowers a level; that
invariant lives in `report_evidence_cap` and in the risk engine, never in a prompt.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Mapping, Sequence

from goru_core.geo import Frame
from goru_core.schemas import (
    FieldReport,
    LatLon,
    Level,
    ParsedReport,
    ReportConsistency,
    ReportKind,
    TrackState,
    Zone,
)

__all__ = [
    "parse_report_text",
    "evaluate_consistency",
    "report_evidence_cap",
    "match_reports_to_tracks",
    "NearbyDetection",
    "VEHICLE_WORDS",
    "HEAVY_CLASSES",
]

COORD_RE = re.compile(
    r"(?P<lat>\d{1,2}\.\d+)\s*(?P<ns>[NS])[\s,]+(?P<lon>\d{1,3}\.\d+)\s*(?P<ew>[EW])",
    re.IGNORECASE,
)

COUNT_TYPE_RE = re.compile(
    r"(?P<count>\d+)\s+(?P<word>kamyonet|kamyon|minibus|otobus|otomobil|van|arac)",
    re.IGNORECASE,
)

# Longest first: "kamyonet" must not be read as "kamyon".
VEHICLE_WORDS: dict[str, str] = {
    "kamyonet": "van",
    "minibus": "van",
    "van": "van",
    "kamyon": "truck",
    "otobus": "bus",
    "otomobil": "car",
    "binek arac": "car",
    "agir arac": "heavy",
    "arac": "vehicle",
}

HEAVY_CLASSES = frozenset({"truck", "bus"})
VEHICLE_LABELS = {
    "car": "otomobil",
    "van": "minibüs",
    "truck": "kamyon",
    "bus": "otobüs",
    "heavy": "ağır araç",
    "vehicle": "araç",
}


def _vehicle_label(cls: str) -> str:
    return VEHICLE_LABELS.get(cls, cls)

# Template keyword rules, most specific first (PLAN 2.7). Each entry is
# (kind, pattern, area_wide).
_TEMPLATE_RULES: tuple[tuple[ReportKind, re.Pattern[str], bool], ...] = (
    ("degraded_coverage", re.compile(r"telsiz\s+baglantisi.*kurulam", re.I), False),
    ("identified_friendly", re.compile(r"kimlik\s+teyidi\s+yapilmis|planli\s+ikmal", re.I), False),
    ("area_wide", re.compile(r"tatbikat|dost\s+unsurlar", re.I), True),
    ("unverified", re.compile(r"dogrulanmamis|dogrulanamad|\bihbar\b", re.I), False),
    ("negative_claim", re.compile(r"(hareket(i|liligi)?|arac)\s+yok|yalnizca\s+binek", re.I), False),
    (
        "zone_status",
        re.compile(r"trafik\s+akisi\s+normal|olagandisi\s+bir\s+durum\s+bildirmedi|sakin", re.I),
        False,
    ),
    ("irrelevant", re.compile(r"hava\s+(acik|kapali|bulutlu)|gorus\s+mesafesi|sis\b|yagis", re.I), False),
    ("sighting", re.compile(r"goruldu|tespit\s+edildi|gozlemlendi|ilerleyen|seyreden", re.I), False),
)


def _fold(text: str) -> str:
    """ASCII-fold and lowercase, so a stray accented character still matches."""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return (
        stripped.replace("ı", "i")
        .replace("İ", "I")
        .replace("ğ", "g")
        .replace("ş", "s")
        .lower()
    )


def _find_zone(folded: str, zones: Sequence[Zone]) -> Zone | None:
    """Longest zone name that appears in the text; zone names are ASCII-folded."""
    best: Zone | None = None
    for zone in zones:
        needle = _fold(zone.name)
        if needle and needle in folded:
            if best is None or len(zone.name) > len(best.name):
                best = zone
    return best


def _find_vehicle_word(folded: str) -> str | None:
    for word in VEHICLE_WORDS:  # dict preserves the longest-first order above
        if re.search(rf"\b{re.escape(word)}\b", folded):
            return word
    return None


def parse_report_text(text: str, zones: Sequence[Zone]) -> ParsedReport:
    """Rules-first parse of one report (PLAN 6.8 step 1).

    Handles both location forms the brief describes: explicit coordinates and a
    bare zone name. `kind` is left as ``unknown`` when no template matches, which
    is exactly the set the LLM report parser is asked about later.
    """
    folded = _fold(text)

    geo: LatLon | None = None
    coord = COORD_RE.search(text)
    if coord:
        lat = float(coord.group("lat"))
        lon = float(coord.group("lon"))
        if coord.group("ns").upper() == "S":
            lat = -lat
        if coord.group("ew").upper() == "W":
            lon = -lon
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            geo = LatLon(lat=lat, lon=lon)

    zone = _find_zone(folded, zones)

    count: int | None = None
    vehicle_type: str | None = None
    count_match = COUNT_TYPE_RE.search(folded)
    if count_match:
        count = int(count_match.group("count"))
        vehicle_type = VEHICLE_WORDS[count_match.group("word").lower()]
    else:
        word = _find_vehicle_word(folded)
        if word:
            vehicle_type = VEHICLE_WORDS[word]

    kind: ReportKind = "unknown"
    area_wide = False
    for candidate, pattern, is_area_wide in _TEMPLATE_RULES:
        if pattern.search(folded):
            kind, area_wide = candidate, is_area_wide
            break

    # A located report that names a count and a type is a sighting even when no
    # template verb matched.
    if kind == "unknown" and count is not None and (geo is not None or zone is not None):
        kind = "sighting"
    # No location at all and nothing else matched: context only.
    if kind == "unknown" and geo is None and zone is None:
        kind = "irrelevant"

    return ParsedReport(
        geo=geo,
        zone_ref=zone.zone_id if zone else None,
        vehicle_type=vehicle_type,
        count=count,
        kind=kind,
        area_wide=area_wide or geo is None and zone is None and kind == "area_wide",
    )


@dataclass(frozen=True, slots=True)
class NearbyDetection:
    """A detection close enough in space and time to test a report against."""

    det_id: str
    cls: str
    distance_m: float
    track_id: str | None = None


def evaluate_consistency(
    report: FieldReport,
    nearby: Sequence[NearbyDetection],
) -> tuple[ReportConsistency | None, str | None]:
    """Compare a testable report claim against our own detections (PLAN 6.8.4).

    Returns ``(consistency, note)``. `None` means the report makes no claim this
    system can test - weather, radio outages, yesterday's rumours.
    """
    kind = report.parsed.kind
    claimed = report.parsed.vehicle_type

    if kind == "negative_claim":
        heavy = [d for d in nearby if d.cls in HEAVY_CLASSES]
        if heavy:
            names = ", ".join(sorted({_vehicle_label(d.cls) for d in heavy}))
            ids = ", ".join(d.det_id for d in heavy[:3])
            return (
                "contradicts",
                f"Rapor ağır araç hareketi olmadığını bildiriyor; burada {names} tespit edildi ({ids})",
            )
        if nearby:
            return ("agrees", f"Burada ağır araç tespit edilmedi; {len(nearby)} hafif araç görüldü")
        return ("agrees", "Burada da araç tespit edilmedi")

    if kind in {"sighting", "identified_friendly"}:
        if not nearby:
            return ("unrelated", "Eşleşen zaman aralığında bu raporun yakınında tespit yok")
        if claimed in {None, "vehicle"}:
            return ("agrees", f"Burada araç tespit edildi ({nearby[0].det_id})")
        if claimed == "heavy":
            heavy = [d for d in nearby if d.cls in HEAVY_CLASSES]
            if heavy:
                return ("agrees", f"Ağır araç tespit edildi ({heavy[0].det_id})")
            return (
                "contradicts",
                f"Rapor ağır araç bildiriyor; en yakın tespit {_vehicle_label(nearby[0].cls)} ({nearby[0].det_id})",
            )
        if any(d.cls == claimed for d in nearby):
            match = next(d for d in nearby if d.cls == claimed)
            return ("agrees", f"Tespit edilen {_vehicle_label(claimed)} raporla eşleşiyor ({match.det_id})")
        return (
            "contradicts",
            f"Rapor {_vehicle_label(claimed)} bildiriyor; en yakın tespit {_vehicle_label(nearby[0].cls)} ({nearby[0].det_id})",
        )

    if kind == "zone_status":
        if any(d.cls in HEAVY_CLASSES for d in nearby):
            return ("contradicts", "Rapor bölgeyi normal bildiriyor; burada ağır araç tespit edildi")
        return ("agrees", "Bildirilen durumla çelişen bir tespit yok")

    return (None, None)


def report_evidence_cap(report: FieldReport, *, corroborated: bool) -> Level:
    """The strongest level this report *alone* may justify (PLAN 6.8.5).

    The trust policy in one function:

    * an `official` located sighting may raise WATCH or ALERT;
    * a `third_party` report may raise at most WATCH, and only when a detection
      corroborates it;
    * nothing else raises anything;
    * and no report of any kind ever lowers a level - which is why this function
      returns a cap and never a level to apply.
    """
    parsed = report.parsed
    located = parsed.geo is not None or parsed.zone_ref is not None
    if not located or parsed.area_wide:
        return Level.CLEAR
    if parsed.kind not in {"sighting", "negative_claim"}:
        return Level.CLEAR
    if report.source == "official":
        return Level.ALERT if parsed.kind == "sighting" else Level.WATCH
    return Level.WATCH if corroborated else Level.CLEAR


def match_reports_to_tracks(
    reports: Iterable[FieldReport],
    track_states: Mapping[str, TrackState],
    *,
    frame: Frame,
    gate_m: float,
    window_min: float,
    as_of: datetime,
) -> dict[str, list[str]]:
    """Located reports to nearby tracks (PLAN 6.8.3).

    Coordinate-bearing reports match tracks within `gate_m` and `window_min`
    (150 m, because *civarinda* means approximately). Zone-named reports attach
    to the zone rather than to a vehicle, so they deliberately produce an empty
    match list here.

    Returns report_id -> up to three track ids, nearest first.
    """
    matches: dict[str, list[str]] = {}
    for report in reports:
        if report.parsed.geo is None:
            matches[report.report_id] = []
            continue
        if abs((as_of - report.ts).total_seconds()) > window_min * 60.0:
            continue
        east, north = frame.to_enu(report.parsed.geo.lat, report.parsed.geo.lon)
        hits = [
            (math.hypot(state.pos.e_m - east, state.pos.n_m - north), track_id)
            for track_id, state in track_states.items()
        ]
        matches[report.report_id] = [tid for dist, tid in sorted(hits) if dist <= gate_m][:3]
    return matches
