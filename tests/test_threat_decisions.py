"""JEV scores the assessor's decision; only rules and GLM set threat levels."""

import json

from goru_core.schemas import AgentAssessment, Level, ImageAssessment

from app.agents.jev import JevService
from app.agents.threat_decisions import apply_threat_decisions, build_request, resolve_answers


def _score(value):
    return {"type": "score", "score": value, "probabilities": {"0": 1 - value, "1": value}}


def test_request_contains_full_bundle_and_effective_assessor_decision(pipeline):
    bundle = pipeline.bundle_for("img_002256")
    assessment = ImageAssessment(assessments=[AgentAssessment(
        track_id="T0009", level=Level.ALERT, needs_attention=True,
    )])
    request = build_request(bundle, model="jev-latest", assessment=assessment)
    assert request.state["assessor_decision"] == assessment.model_dump(mode="json")
    assert set(request.questions) == {v.track_id for v in bundle.vehicles}
    assert all(q.type == "score" and len(q.criteria) == 2 for q in request.questions.values())
    assert "ALERT decision" in request.questions["T0009"].instructions
    assert all(track_id in q.instructions for track_id, q in request.questions.items())


def _roles(bundle):
    """Pick vehicles by their rule baseline, not by id: the tests are about the merge,
    and which track sits at which level is the rule engine's business."""
    watch = next(v.track_id for v in bundle.vehicles if v.baseline_level is Level.WATCH)
    clear = [v.track_id for v in bundle.vehicles if v.baseline_level is Level.CLEAR]
    assert len(clear) >= 2, "img_002256 needs two CLEAR vehicles for these tests"
    return watch, clear[0], clear[1]


def test_scores_cannot_change_levels_and_mark_disagreement(pipeline, cfg):
    analysis = pipeline.analyse_image("img_002256")
    bundle = pipeline.bundle_of(analysis)
    watch, clear_track, _ = _roles(bundle)
    decisions = resolve_answers(bundle, {watch: _score(0.2), clear_track: _score(0.9)})
    assert decisions[watch].level is Level.WATCH
    assert decisions[watch].jev_confidence == 0.2
    assert decisions[clear_track].level is Level.CLEAR
    alerts = apply_threat_decisions(
        analysis.alerts, bundle, decisions, ts=analysis.as_of, rules_version=cfg.rules_version
    )
    assert not any(alert.track_id == clear_track for alert in alerts)
    alert = next(alert for alert in alerts if alert.track_id == watch)
    assert alert.level is Level.WATCH
    assert alert.agent_dissent == "modeller ayrışıyor"
    assert alert.jev_confidence == 0.2


def test_invalid_score_falls_back_per_track(pipeline):
    bundle = pipeline.bundle_for("img_002256")
    decisions = resolve_answers(bundle, {
        "T0088": {"type": "score", "score": 1.4, "probabilities": {"0": 0, "1": 1}},
        "T0009": _score(0.7),
    })
    assert decisions["T0088"].jev_confidence is None
    assert decisions["T0009"].jev_confidence == 0.7


def test_jev_cache_replay_costs_nothing(pipeline, tmp_path):
    class Gateway:
        calls = 0

        def evaluate(self, request):
            self.calls += 1
            return {"answers": {"T0009": _score(0.75)}, "usage": {"input_tokens": 500}}

    gateway = Gateway()
    service = JevService(gateway, cache_dir=tmp_path / "cache", budget_path=tmp_path / "budget.json")
    bundle = pipeline.bundle_for("img_002256")
    first = service.run(bundle)
    spend = json.loads((tmp_path / "budget.json").read_text())["local_spend_usd"]
    second = service.run(bundle)
    assert first.decisions["T0009"].jev_confidence == 0.75
    assert second.from_cache and gateway.calls == 1
    assert json.loads((tmp_path / "budget.json").read_text())["local_spend_usd"] == spend


def test_jev_failure_preserves_rule_level(pipeline, tmp_path):
    class Gateway:
        def evaluate(self, request):
            raise TimeoutError("provider unavailable")

    service = JevService(Gateway(), cache_dir=tmp_path / "cache", budget_path=tmp_path / "budget.json")
    result = service.run(pipeline.bundle_for("img_002256"))
    assert result.decisions["T0088"].level is Level.WATCH
    assert result.decisions["T0088"].jev_confidence is None
    assert result.fallback_reason == "TimeoutError"


def test_jev_budget_prevents_call(pipeline, tmp_path):
    class Gateway:
        def evaluate(self, request):
            raise AssertionError("paid call must not start")

    service = JevService(Gateway(), cache_dir=tmp_path / "cache", budget_path=tmp_path / "budget.json", cap_usd=0.000001)
    result = service.run(pipeline.bundle_for("img_002256"))
    assert result.fallback_reason == "budget_exceeded"


def test_jev_rehearsal_cache_miss_spends_nothing(pipeline, tmp_path):
    class Gateway:
        def evaluate(self, request):
            raise AssertionError("rehearsal must not call provider")

    service = JevService(Gateway(), cache_dir=tmp_path / "cache",
                         budget_path=tmp_path / "budget.json", cache_only=True)
    result = service.run(pipeline.bundle_for("img_002256"))
    assert result.fallback_reason == "cache_miss"
    assert result.decisions["T0088"].jev_confidence is None
    assert not (tmp_path / "budget.json").exists()
