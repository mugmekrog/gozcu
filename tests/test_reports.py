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
from app.fusion.reports import (
    NearbyDetection,
    evaluate_consistency,
    parse_report_text,
    report_evidence_cap,
)


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
# Consistency: the brief's core ask
# --------------------------------------------------------------------------- #


def test_negative_claim_contradicted_by_a_detected_truck():
    report = _report("agir arac hareketi yok", kind="negative_claim", vehicle_type="heavy")
    consistency, note = evaluate_consistency(
        report, [NearbyDetection(det_id="img_x#001", cls="truck", distance_m=40.0)]
    )
    assert consistency == "contradicts"
    assert "kamyon" in note


def test_negative_claim_agrees_when_only_cars_are_seen():
    report = _report("agir arac hareketi yok", kind="negative_claim", vehicle_type="heavy")
    consistency, note = evaluate_consistency(
        report, [NearbyDetection(det_id="img_x#002", cls="car", distance_m=30.0)]
    )
    assert consistency == "agrees"
    assert note == "Burada ağır araç tespit edilmedi; 1 hafif araç görüldü"


def test_sighting_agrees_with_a_matching_class():
    report = _report("1 kamyon goruldu", vehicle_type="truck", count=1)
    consistency, note = evaluate_consistency(
        report,
        [
            NearbyDetection(det_id="img_x#003", cls="car", distance_m=10.0),
            NearbyDetection(det_id="img_x#004", cls="truck", distance_m=60.0),
        ],
    )
    assert consistency == "agrees"
    assert "img_x#004" in note


def test_sighting_contradicts_when_no_such_class_is_near():
    report = _report("1 kamyon goruldu", vehicle_type="truck", count=1)
    consistency, note = evaluate_consistency(
        report, [NearbyDetection(det_id="img_x#005", cls="car", distance_m=12.0)]
    )
    assert consistency == "contradicts"
    assert "otomobil" in note


def test_report_with_nothing_detected_is_unrelated():
    report = _report("1 kamyon goruldu", vehicle_type="truck", count=1)
    consistency, note = evaluate_consistency(report, [])
    assert consistency == "unrelated"
    assert note == "Eşleşen zaman aralığında bu raporun yakınında tespit yok"


def test_weather_report_makes_no_testable_claim():
    report = _report("Hava acik", kind="irrelevant")
    consistency, note = evaluate_consistency(report, [])
    assert consistency is None and note is None


def test_real_dataset_contains_a_genuine_contradiction(analyses):
    """PLAN task M3.4: at least one real report contradicts our own detection."""
    contradictions = {
        report.report_id: report.consistency_note
        for analysis in analyses
        for report in analysis.reports
        if report.consistency == "contradicts"
    }
    assert contradictions, "no contradiction found in the shipped data"
    assert all(note for note in contradictions.values())


# --------------------------------------------------------------------------- #
# Trust policy
# --------------------------------------------------------------------------- #


def test_official_located_sighting_may_raise_alert():
    report = _report("1 kamyon goruldu", source="official", geo=LatLon(lat=39.94, lon=32.86))
    assert report_evidence_cap(report, corroborated=True) is Level.ALERT


def test_third_party_caps_at_watch_and_needs_corroboration():
    report = _report("1 kamyon goruldu", source="third_party", geo=LatLon(lat=39.94, lon=32.86))
    assert report_evidence_cap(report, corroborated=True) is Level.WATCH
    assert report_evidence_cap(report, corroborated=False) is Level.CLEAR


def test_identified_friendly_cannot_lower_or_raise_anything():
    """The most tempting report in the dataset: it is a hint for the human only."""
    report = _report(
        "planli ikmal aracidir, kimlik teyidi yapilmistir",
        kind="identified_friendly",
        geo=LatLon(lat=39.94, lon=32.86),
    )
    assert report_evidence_cap(report, corroborated=True) is Level.CLEAR


@pytest.mark.parametrize("kind", ["area_wide", "unverified", "irrelevant", "degraded_coverage", "zone_status"])
def test_context_reports_raise_nothing(kind):
    report = _report("context", kind=kind, geo=LatLon(lat=39.94, lon=32.86))
    assert report_evidence_cap(report, corroborated=True) is Level.CLEAR


def test_unlocated_report_raises_nothing():
    report = _report("1 kamyon goruldu")  # no geo, no zone
    assert report_evidence_cap(report, corroborated=True) is Level.CLEAR


def test_trust_notes_reach_the_bundle(pipeline, dataset):
    """The reviewer and the agent see the same policy sentence."""
    for meta in list(dataset.images.values())[:8]:
        bundle = pipeline.bundle_for(meta.image_id)
        for report in bundle.reports_in_window:
            assert report.trust_note
            if report.kind == "identified_friendly":
                assert "never lower" in report.trust_note
