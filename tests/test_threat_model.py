"""The base-centred threat model on the real data (team decision, 2026-09-27).

Merkez Us is the protected asset; the eight zones are observation sectors. These
tests read the pipeline's verdicts for the dataset's clearest cases of each
behaviour, found by an independent probe over tracks.csv (session log, 2026-09-27).
"""

from __future__ import annotations

import pytest

from goru_core.schemas import Level


@pytest.fixture(scope="module")
def verdicts(analyses):
    return {track_id: v for a in analyses for track_id, v in a.verdicts.items()}


def _kinds(verdict):
    return [s.kind for s in verdict.signals]


def test_t0192_running_at_the_base_is_no_longer_clear(verdicts):
    """7.6 km to 1.6 km in half an hour; the zone rules called it CLEAR."""
    verdict = verdicts["T0192"]
    assert verdict.level is not Level.CLEAR
    assert verdict.category == "approach"
    assert "sustained_approach" in _kinds(verdict)


def test_t0146_circling_the_base_is_surveillance(verdicts):
    verdict = verdicts["T0146"]
    assert verdict.level is not Level.CLEAR
    assert "circling" in _kinds(verdict)
    assert "surveillance" in {s.category for s in verdict.signals}


def test_t0130_parked_out_in_an_observation_sector_raises_nothing(verdicts):
    """Parked 3.44 km out in Kuzeydogu Kavsagi: the zone buffer rule made this WATCH."""
    assert verdicts["T0130"].level is Level.CLEAR


def test_t0009_leaving_from_near_the_base_is_not_a_probe(verdicts):
    assert "probe" not in _kinds(verdicts["T0009"])


def test_no_zone_is_treated_as_a_protected_area(analyses):
    for analysis in analyses:
        for verdict in analysis.verdicts.values():
            assert not any("buffer of" in why or "inside " in why for why in verdict.reasons)


def test_every_verdict_names_its_observation_sector_and_explains_a_raise(analyses, dataset):
    sectors = {zone.zone_id for zone in dataset.zones}
    for analysis in analyses:
        for track_id, verdict in analysis.verdicts.items():
            assert verdict.zone_id in sectors
            if verdict.level is not Level.CLEAR:
                assert verdict.signals or any("rapor" in why or "report" in why for why in verdict.reasons), track_id
                assert verdict.likelihood == ("high" if verdict.level is Level.ALERT else "possible")


# --------------------------------------------------------------------------- #
# The agent's input: the bundle carries the base, the record and the sector
# --------------------------------------------------------------------------- #


def test_the_bundle_gives_the_agent_the_base_the_record_and_the_sector(pipeline):
    vehicle = next(v for v in pipeline.bundle_for("img_002900").vehicles if v.track_id == "T0069")
    assert vehicle.sector_name == "Bati Yerlesimi"
    assert vehicle.base.range_m == pytest.approx(1560, abs=20)
    assert vehicle.base.ring == "warning"
    assert vehicle.behaviour.closing_60_m == pytest.approx(5270, abs=20)
    assert (vehicle.category, vehicle.likelihood) == ("approach", "high")
    assert "imminent_entry" in vehicle.signals


def test_guardrails_admit_the_new_figures_and_still_catch_invented_ones(pipeline):
    from app.agents.guardrails import check_numeric_drift, vehicle_numbers

    bundle = pipeline.bundle_for("img_002900")
    allowed = vehicle_numbers(bundle, "T0069")
    assert check_numeric_drift(["Son 60 dk'da üsse 5.27 km yaklaştı; şimdi 1.56 km"], allowed) == []
    assert check_numeric_drift(["Üsse 900 m kaldı"], allowed)


# --------------------------------------------------------------------------- #
# The display payload: what the operator reads beside the level
# --------------------------------------------------------------------------- #


def _display_alert(pipeline, cfg, image_id, track_id):
    from zoneinfo import ZoneInfo

    from web.scripts import export_fixtures
    from app.agents.assessor import ImageAssessorPolicy

    export_fixtures._TZ = ZoneInfo(cfg.tz)
    payload = export_fixtures.build_frame_payload(
        pipeline.analyse_image(image_id),
        pipeline,
        cfg,
        ImageAssessorPolicy(cfg),
        {zone.zone_id: zone.name for zone in pipeline.dataset.zones},
    )
    return next(alert for alert in payload["alerts"] if alert["track_id"] == track_id)


def test_the_display_quotes_the_base_not_a_zone(pipeline, cfg):
    alert = _display_alert(pipeline, cfg, "img_002900", "T0069")
    assert alert["zone_name"] == "Bati Yerlesimi"  # the sector it is in
    assert alert["dist_now_m"] == pytest.approx(1560, abs=20)  # range to the base
    assert (alert["category"], alert["likelihood"]) == ("approach", "high")
    assert "imminent_entry" in alert["signals"]


def test_the_score_breakdown_explains_the_engine_score_against_the_base(pipeline, cfg):
    alert = _display_alert(pipeline, cfg, "img_002900", "T0069")
    labels = " ".join(term["label"] for term in alert["breakdown"]["terms"])
    assert "Kritik halka" in labels
    assert "Bölgeye" not in labels
    assert sum(term["points"] for term in alert["breakdown"]["terms"]) == alert["breakdown"]["score"]
