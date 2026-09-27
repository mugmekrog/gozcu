"""Field report parsing, trust policy and consistency (PLAN.md 6.8, 2.7).

The brief's central ask is here: compare reports against our own detections and
rely on the detection where they conflict. These tests pin the policy that
implements it - including the part that must never happen, a report lowering a
level.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from goru_core.schemas import FieldReport, LatLon, Level, ParsedReport, SourceRefModel
from app.fusion.reports import parse_report_text


def _report(
    text: str,
    *,
    source: str = "official",
    kind: str = "sighting",
    vehicle_type: str | None = None,
    count: int | None = None,
    geo: LatLon | None = None,
    zone_ref: str | None = None,
    area_wide: bool = False,
) -> FieldReport:
    return FieldReport(
        report_id="R999",
        ts=datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc),
        source=source,  # type: ignore[arg-type]
        text=text,
        parsed=ParsedReport(
            geo=geo,
            zone_ref=zone_ref,
            vehicle_type=vehicle_type,
            count=count,
            kind=kind,  # type: ignore[arg-type]
            area_wide=area_wide,
        ),
        source_ref=SourceRefModel(file_name="field_reports.json", file_sha256="0" * 64, record_key="999"),
    )


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #


def test_parses_coordinates_count_and_type(dataset):
    parsed = parse_report_text(
        "39.9374N 32.8483E civarinda 1 kamyon goruldu, yukleri tespit edilemedi.", dataset.zones
    )
    assert parsed.geo is not None
    assert (round(parsed.geo.lat, 4), round(parsed.geo.lon, 4)) == (39.9374, 32.8483)
    assert parsed.vehicle_type == "truck"
    assert parsed.count == 1
    assert parsed.kind == "sighting"


def test_parses_a_zone_name_with_no_coordinates(dataset):
    parsed = parse_report_text(
        "Kuzeybati Yolu bolgesinde trafik akisi normal seyrediyor.", dataset.zones
    )
    assert parsed.geo is None
    assert parsed.zone_ref is not None
    zone = dataset.zone_by_id(parsed.zone_ref)
    assert zone is not None and zone.name == "Kuzeybati Yolu"
    assert parsed.kind == "zone_status"


def test_negative_claim_is_recognised(dataset):
    parsed = parse_report_text(
        "Dogu Yolu bolgesinde agir arac hareketi yok, yalnizca binek araclar goruluyor.",
        dataset.zones,
    )
    assert parsed.kind == "negative_claim"
    assert parsed.zone_ref is not None


def test_identified_friendly_is_recognised(dataset):
    parsed = parse_report_text(
        "39.9401N 32.8600E konumundan usse dogru ilerleyen otomobil planli ikmal aracidir, "
        "kimlik teyidi yapilmistir.",
        dataset.zones,
    )
    assert parsed.kind == "identified_friendly"
    assert parsed.geo is not None


def test_degraded_coverage_is_recognised(dataset):
    parsed = parse_report_text(
        "Kuzey Yolu bolgesindeki devriyeyle telsiz baglantisi 40 dakikadir kurulamiyor.",
        dataset.zones,
    )
    assert parsed.kind == "degraded_coverage"


def test_area_wide_drill_report(dataset):
    parsed = parse_report_text(
        "Planli tatbikat nedeniyle bolgede dost unsurlar bulunacak.", dataset.zones
    )
    assert parsed.kind == "area_wide"
    assert parsed.area_wide is True
    assert parsed.geo is None and parsed.zone_ref is None


def test_weather_report_is_irrelevant(dataset):
    parsed = parse_report_text("Hava acik, gorus mesafesi iyi.", dataset.zones)
    assert parsed.kind == "irrelevant"
    assert parsed.geo is None and parsed.zone_ref is None


def test_unverified_tipoff(dataset):
    parsed = parse_report_text(
        "Dun gece Bati Yerlesimi cevresinde arac hareketliligi oldugu yonunde dogrulanmamis "
        "bir ihbar var.",
        dataset.zones,
    )
    assert parsed.kind == "unverified"


def test_vehicle_word_longest_match_wins(dataset):
    """'kamyonet' is a van and must not be read as 'kamyon'."""
    parsed = parse_report_text("3 kamyonet goruldu.", dataset.zones)
    assert parsed.vehicle_type == "van"
    assert parsed.count == 3


def test_turkish_suffixes_do_not_break_the_count(dataset):
    parsed = parse_report_text("39.9283N 32.8120E yakininda 5 kamyonun durdugu bildirildi.", dataset.zones)
    assert parsed.count == 5
    assert parsed.vehicle_type == "truck"


# --------------------------------------------------------------------------- #
# Every template in the data becomes a testable claim (Faz 1, 2026-09-27)
# --------------------------------------------------------------------------- #


def test_every_report_in_the_data_is_classified(dataset):
    """137 reports, 32 templates: none may be left for a model to guess at."""
    assert [r.report_id for r in dataset.reports if r.parsed.kind == "unknown"] == []


@pytest.mark.parametrize(
    "report_id, expected",
    [
        # "1 agir arac (kamyon/otobus) gozlendi" - an observation the old verbs missed
        ("R130", dict(kind="sighting", vehicle_type="heavy", count=1)),
        # "3 kamyon bulundugu yonunde ihbar alindi" - a located tip, not yesterday's rumour
        ("R005", dict(kind="sighting", vehicle_type="truck", count=3, tip=True)),
        # "genellikle 4 arac civari gorulur" - the usual count, not a sighting of four
        ("R020", dict(kind="density", usual_count=4, count=None)),
        ("R117", dict(kind="density", usual_count=4, count=None)),
        # "usse gelen otomobil bize bagli unsurdur" - a friendly claim about a base-bound car
        ("R007", dict(kind="identified_friendly", vehicle_type="car", motion="toward_base", friendly=True)),
        ("R046", dict(kind="identified_friendly", vehicle_type="vehicle", friendly=True)),
        ("R015", dict(kind="sighting", vehicle_type="car", count=1, motion="stopped", still_for_min=30)),
        ("R053", dict(kind="sighting", vehicle_type="truck", count=1, motion="stopped", still_for_min=60)),
        ("R095", dict(kind="sighting", vehicle_type="van", count=1, motion="stopped")),
        ("R022", dict(kind="sighting", vehicle_type="truck", count=1, motion="receding")),
        ("R009", dict(kind="sighting", vehicle_type="truck", count=1, motion="moving")),
        ("R023", dict(kind="sighting", vehicle_type="car", count=1, motion="stopped")),
        ("R087", dict(kind="sighting", vehicle_type="truck", count=3, motion="moving")),
        ("R010", dict(kind="sighting", vehicle_type="truck", count=5, motion="stopped")),
        ("R042", dict(kind="zone_status")),
        ("R027", dict(kind="area_wide")),
    ],
)
def test_report_templates_become_testable_claims(dataset, report_id, expected):
    parsed = next(r for r in dataset.reports if r.report_id == report_id).parsed
    assert {key: getattr(parsed, key) for key in expected} == expected
