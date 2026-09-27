"""Field reports checked against our own data, on the shipped reports.

Team decisions (2026-09-27): no source is trusted, data wins, and a report never
moves a level on its own say-so. Expected verdicts come from an independent probe
of the detections within 50 m of each report at its image's capture (session log).
"""

from __future__ import annotations

import collections
import dataclasses

import pytest

from goru_core.schemas import Level
from app.pipeline import Pipeline


def _report(analyses, image_id, report_id):
    frame = next(a for a in analyses if a.image.image_id == image_id)
    return next(r for r in frame.reports if r.report_id == report_id)


def _result(report, claim):
    return next(c.result for c in report.checks if c.claim == claim)


def test_each_located_report_is_judged_in_the_one_image_it_is_about(analyses, dataset):
    """72 located reports; each lands in exactly one image: its footprint, its two hours."""
    located = {r.report_id for r in dataset.reports if r.parsed.geo is not None}
    seen = collections.Counter(
        r.report_id for a in analyses for r in a.reports if r.parsed.geo is not None
    )
    assert set(seen) == located
    assert set(seen.values()) == {1}


def test_r018_five_stopped_trucks_where_our_image_sees_cars_is_contradicted(analyses):
    report = _report(analyses, "img_005788", "R018")
    assert report.verdict == "contradicted"
    assert _result(report, "type") == "fail"  # five cars and a van within 50 m, no truck
    assert _result(report, "count") == "fail"
    assert report.scenario


def test_r005_a_third_party_tip_our_data_confirms_is_verified(analyses):
    """Three trucks tipped off; three trucks stand within 50 m. The source label is irrelevant."""
    report = _report(analyses, "img_005368", "R005")
    assert report.source == "third_party"
    assert report.verdict == "verified"
    assert (_result(report, "type"), _result(report, "count")) == ("pass", "pass")


def test_r056_a_car_reported_still_for_an_hour_is_verified(analyses):
    report = _report(analyses, "img_007171", "R056")
    assert report.matched_track_ids[0] == "T0130"
    assert report.verdict == "verified"
    assert (_result(report, "type"), _result(report, "motion")) == ("pass", "pass")


def test_r101_seven_trucks_where_three_stand_fails_on_the_count(analyses):
    report = _report(analyses, "img_003464", "R101")
    assert _result(report, "type") == "pass"
    assert _result(report, "count") == "fail"
    assert report.verdict == "contradicted"


def test_r130_a_heavy_vehicle_where_only_cars_stand_is_contradicted(analyses):
    report = next(r for a in analyses for r in a.reports if r.report_id == "R130")
    assert _result(report, "type") == "fail"
    assert report.verdict == "contradicted"


def test_friendly_claims_always_go_to_the_human(analyses):
    friendly = [r for a in analyses for r in a.reports if r.parsed.friendly]
    assert friendly
    for report in friendly:
        assert report.needs_identity_check
        assert _result(report, "identity") == "untestable"
        assert report.scenario and "insan" in report.scenario


def test_no_verdict_rests_on_nothing_and_every_doubt_carries_a_scenario(analyses):
    for analysis in analyses:
        for report in analysis.reports:
            if report.verdict == "verified":
                assert any(c.result == "pass" for c in report.checks), report.report_id
            if report.verdict in {"contradicted", "unverifiable"}:
                assert report.scenario, report.report_id


def test_sector_reports_only_reach_images_in_their_own_sector(analyses):
    for analysis in analyses:
        sectors = {v.zone_id for v in analysis.verdicts.values()}
        for report in analysis.reports:
            if report.parsed.geo is None and report.parsed.zone_ref is not None:
                assert report.parsed.zone_ref in sectors or not sectors, (
                    analysis.image.image_id,
                    report.report_id,
                )


def test_no_report_moves_any_level(dataset, cfg, analyses):
    """Data wins: removing every report changes no vehicle's level."""
    without = Pipeline(dataclasses.replace(dataset, reports=[]), cfg).analyse_all()
    levels = {t: v.level for a in analyses for t, v in a.verdicts.items()}
    assert levels == {t: v.level for a in without for t, v in a.verdicts.items()}


def test_trust_notes_reach_the_bundle(pipeline, dataset):
    """The reviewer and the agent see the same policy sentence."""
    for meta in list(dataset.images.values())[:8]:
        for report in pipeline.bundle_for(meta.image_id).reports_in_window:
            assert report.trust_note
            assert report.verdict
