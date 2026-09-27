"""Field report parsing (PLAN.md 6.8 step 1, 2.7).

The 137 shipped reports are written in 32 templates (measured, 2026-09-27). This
module turns each into a testable claim - location, vehicle type, count, what the
vehicle is said to be doing, whether it is claimed as friendly - and nothing more.
Testing those claims against our own data is `report_resolver`'s job, and no report
ever moves a level on its own say-so.

Text is Turkish, ASCII-folded in the data.
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
    "VEHICLE_WORDS",
    "HEAVY_CLASSES",
]

COORD_RE = re.compile(
    r"(?P<lat>\d{1,2}\.\d+)\s*(?P<ns>[NS])[\s,]+(?P<lon>\d{1,3}\.\d+)\s*(?P<ew>[EW])",
    re.IGNORECASE,
)

COUNT_TYPE_RE = re.compile(
    r"(?P<count>\d+)\s+(?:agir\s+)?(?P<word>kamyonet|kamyon|minibus|otobus|otomobil|panelvan|van|arac)",
    re.IGNORECASE,
)

# Longest first: "kamyonet" must not be read as "kamyon".
VEHICLE_WORDS: dict[str, str] = {
    "kamyonet": "van",
    "panelvan": "van",
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

# The 32 templates the 137 reports are written in (measured, 2026-09-27), as an
# ordered table: the first rule whose pattern matches sets the kind. Order matters
# where templates share words - "ihbar" is both a verified-yesterday rumour
# ("dogrulanmamis bir ihbar") and a located tip ("ihbar alindi"), and a friendly
# claim contains a movement verb. Each entry is (kind, pattern, area_wide).
_TEMPLATE_RULES: tuple[tuple[ReportKind, re.Pattern[str], bool], ...] = (
    ("degraded_coverage", re.compile(r"telsiz\s+baglantisi.*kurulam", re.I), False),
    (
        "identified_friendly",
        re.compile(r"kimlik\s+teyidi\s+yapilmis|planli\s+ikmal|bize\s+bagli|dost\s+devriye|teyitlidir", re.I),
        False,
    ),
    ("area_wide", re.compile(r"tatbikat|dost\s+unsurlar|lojistik\s+konvoyu", re.I), True),
    ("unverified", re.compile(r"dogrulanmamis|dogrulanamad", re.I), False),
    ("irrelevant", re.compile(r"hava\s+(acik|kapali|bulutlu)|gorus\s+mesafesi|sis\b|yagis", re.I), False),
    ("negative_claim", re.compile(r"(hareket(i|liligi)?|arac)\s+yok|yalnizca\s+binek", re.I), False),
    (
        "zone_status",
        re.compile(
            r"trafik\s+akisi\s+normal|olagandisi\s+bir\s+durum\s+bildirmedi|"
            r"kayda\s+deger\s+bir\s+hareketlilik\s+bulunmuyor|sakin",
            re.I,
        ),
        False,
    ),
    ("density", re.compile(r"(genellikle|olagan\s+trafik)\s+\d+\s+arac", re.I), False),
)

_USUAL_COUNT_RE = re.compile(r"(?:genellikle|olagan\s+trafik)\s+(\d+)\s+arac", re.I)
_HEAVY_RE = re.compile(r"agir\s+(?:bir\s+)?arac|\(kamyon/otobus\)", re.I)
_TIP_RE = re.compile(r"ihbar\s+alindi|bir\s+ihbara\s+gore|bir\s+kaynak", re.I)
# A singular vehicle noun ("bir kamyon", "konumundaki otomobil") is one vehicle; a
# plural ("araclar") is not a count.
_SINGULAR_RE = re.compile(r"\b(kamyonet|kamyon|minibus|otobus|otomobil|panelvan|van|arac)(?!lar|ler)\w*", re.I)
# Most specific first: "usse dogru ilerleyen" is a direction, not just movement.
_MOTION_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("toward_base", re.compile(r"usse\s+(dogru\s+ilerleyen|gelen)", re.I)),
    ("receding", re.compile(r"bolgeden\s+uzaklasiyor", re.I)),
    ("moving", re.compile(r"transit\s+geciyor|ilerliyor", re.I)),
    (
        "stopped",
        re.compile(r"durdugu|beklemede|bekliyor|hareketsiz|park\s+halinde|yerinden\s+ayrilmadi", re.I),
    ),
)
_STILL_FOR_RULES: tuple[tuple[int, re.Pattern[str]], ...] = (
    (60, re.compile(r"bir\s+saatten\s+uzun", re.I)),
    (30, re.compile(r"uzun\s+suredir", re.I)),
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
    # Boundary at the start only: Turkish case endings follow the noun, so
    # "kamyonun" and "aracin" are still a truck and a vehicle.
    for word in VEHICLE_WORDS:  # dict preserves the longest-first order above
        if re.search(rf"\b{re.escape(word)}", folded):
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
    located = geo is not None or zone is not None

    kind: ReportKind = "unknown"
    area_wide = False
    for candidate, pattern, is_area_wide in _TEMPLATE_RULES:
        if pattern.search(folded):
            kind, area_wide = candidate, is_area_wide
            break
    # The remaining templates in the data are located reports about vehicles. A text
    # that names neither a vehicle nor a count stays unknown - new wording the rules
    # were not written for, which is what the model-backed parser is for.
    if kind == "unknown":
        if not located:
            kind = "irrelevant"
        elif _find_vehicle_word(folded) or COUNT_TYPE_RE.search(folded):
            kind = "sighting"

    count: int | None = None
    vehicle_type: str | None = None
    usual_count: int | None = None
    if kind == "density":
        usual = _USUAL_COUNT_RE.search(folded)
        usual_count = int(usual.group(1)) if usual else None
    else:
        count_match = COUNT_TYPE_RE.search(folded)
        if count_match:
            count = int(count_match.group("count"))
            vehicle_type = VEHICLE_WORDS[count_match.group("word").lower()]
            if vehicle_type == "vehicle":
                # "3 araclik bir kamyon konvoyu": the count counts vehicles, the noun
                # says what they are.
                word = _find_vehicle_word(folded)
                if word and VEHICLE_WORDS[word] != "vehicle":
                    vehicle_type = VEHICLE_WORDS[word]
        else:
            word = _find_vehicle_word(folded)
            if word:
                vehicle_type = VEHICLE_WORDS[word]
    if kind == "sighting":
        if _HEAVY_RE.search(folded):
            vehicle_type = "heavy"
        if count is None and _SINGULAR_RE.search(folded):
            count = 1

    motion = next((name for name, pattern in _MOTION_RULES if pattern.search(folded)), None)
    still_for = next((minutes for minutes, pattern in _STILL_FOR_RULES if pattern.search(folded)), None)
    vehicle_claim = kind in {"sighting", "identified_friendly"}

    return ParsedReport(
        geo=geo,
        zone_ref=zone.zone_id if zone else None,
        vehicle_type=vehicle_type,
        count=count,
        kind=kind,
        area_wide=area_wide or geo is None and zone is None and kind == "area_wide",
        motion=motion if vehicle_claim else None,  # type: ignore[arg-type]
        still_for_min=still_for if vehicle_claim and motion == "stopped" else None,
        friendly=kind == "identified_friendly",
        usual_count=usual_count,
        tip=kind == "sighting" and bool(_TIP_RE.search(folded)),
    )
