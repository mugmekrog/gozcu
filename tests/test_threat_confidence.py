"""Threat candidates with an evidence-built confidence (Faz 2, 2026-09-27).

The level says how urgent; the category says what kind of threat; the confidence
says how much evidence stands behind it - built from labelled terms, so the
operator can see exactly why a figure is what it is.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from goru_core.schemas import Level
from app.risk.threat import assess_threat


@pytest.fixture(scope="module")
def frame(analyses):
    return next(a for a in analyses if a.image.image_id == "img_002900")


def test_every_raised_vehicle_is_a_threat_candidate_and_no_clear_one_is(analyses):
    for analysis in analyses:
        for track_id, verdict in analysis.verdicts.items():
            threat = analysis.threats.get(track_id)
            if verdict.level is Level.CLEAR:
                assert threat is None
            else:
                assert (threat.category, threat.likelihood) == (verdict.category, verdict.likelihood)


def test_the_confidence_is_exactly_its_labelled_terms(analyses):
    for analysis in analyses:
        for threat in analysis.threats.values():
            assert 0.0 < threat.confidence <= 1.0
            assert sum(points for _, points in threat.terms) == pytest.approx(threat.confidence)
            assert all(label for label, _ in threat.terms)


def test_a_verified_report_never_lowers_the_confidence(frame):
    verdict = frame.verdicts["T0069"]
    base = assess_threat("T0069", verdict, frame, reports=[])
    report = next(r for a in [frame] for r in a.reports)
    verified = report.model_copy(update={"verdict": "verified", "matched_track_ids": ["T0069"]})
    with_report = assess_threat("T0069", verdict, frame, reports=[verified])
    assert with_report.confidence >= base.confidence


def test_a_contradicted_friendly_claim_raises_attention(frame):
    verdict = frame.verdicts["T0069"]
    base = assess_threat("T0069", verdict, frame, reports=[])
    report = next(r for r in frame.reports)
    parsed = report.parsed.model_copy(update={"friendly": True, "kind": "identified_friendly"})
    friendly = report.model_copy(
        update={"parsed": parsed, "verdict": "contradicted", "matched_track_ids": ["T0069"],
                "needs_identity_check": True}
    )
    flagged = assess_threat("T0069", verdict, frame, reports=[friendly])
    assert flagged.confidence > base.confidence
    assert "contradicted_friendly_claim" in flagged.flags


def test_a_strong_signal_outweighs_a_single_ordinary_one(frame, analyses):
    strong = frame.threats["T0069"]  # about to cross the critical ring
    ordinary = next(
        t for a in analyses for t in a.threats.values()
        if t.likelihood == "possible" and not any(s.strong for s in a.verdicts[t.track_id].signals)
    )
    assert dict(strong.terms)["Güçlü sinyal"] > dict(ordinary.terms).get("Sinyal", 0)
