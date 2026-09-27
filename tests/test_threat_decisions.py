"""A typed decision may raise a warning, but cannot suppress the rule baseline."""

from __future__ import annotations

import json

from goru_core.schemas import Level


def test_one_jev_request_asks_about_each_track_with_the_full_bundle(pipeline):
    from app.agents.threat_decisions import build_request

    bundle = pipeline.bundle_for("img_002256")
    request = build_request(bundle, model="jev-latest")

    assert request.state == bundle.model_dump(mode="json")
    assert set(request.questions) == {v.track_id for v in bundle.vehicles}
    assert all(q.criteria.keys() == {"CLEAR", "WATCH", "ALERT"} for q in request.questions.values())
    assert all(track_id in q.instructions for track_id, q in request.questions.items())


def _roles(bundle):
    """Pick vehicles by their rule baseline, not by id: the tests are about the merge,
    and which track sits at which level is the rule engine's business."""
    watch = next(v.track_id for v in bundle.vehicles if v.baseline_level is Level.WATCH)
    clear = [v.track_id for v in bundle.vehicles if v.baseline_level is Level.CLEAR]
    assert len(clear) >= 2, "img_002256 needs two CLEAR vehicles for these tests"
    return watch, clear[0], clear[1]


def test_rule_floor_keeps_warning_and_exposes_jev_confidence(pipeline):
    from app.agents.threat_decisions import resolve_answers

    bundle = pipeline.bundle_for("img_002256")
    watch, raised, silent = _roles(bundle)
    answers = {
        watch: {
            "type": "choice",
            "choice": "CLEAR",
            "probabilities": {"CLEAR": 0.8, "WATCH": 0.1, "ALERT": 0.1},
            "confidence": 0.7,
        },
        raised: {
            "type": "choice",
            "choice": "ALERT",
            "probabilities": {"CLEAR": 0.1, "WATCH": 0.1, "ALERT": 0.8},
            "confidence": 0.6,
        },
    }

    decisions = resolve_answers(bundle, answers)

    assert decisions[watch].level is Level.WATCH
    assert decisions[watch].jev_level is Level.CLEAR
    assert decisions[watch].jev_confidence == 0.7
    assert decisions[watch].source == "rules_floor"
    assert decisions[raised].level is Level.ALERT
    assert decisions[raised].jev_confidence == 0.6
    assert decisions[raised].source == "jev"
    assert decisions[silent].level is Level.CLEAR
    assert decisions[silent].jev_confidence is None
    assert decisions[silent].source == "rules_fallback"


def test_invalid_jev_answer_falls_back_only_for_its_track(pipeline):
    from app.agents.threat_decisions import resolve_answers

    bundle = pipeline.bundle_for("img_002256")
    answers = {
        "T0088": {
            "type": "choice",
            "choice": "ALERT",
            "probabilities": {"CLEAR": 0.1, "WATCH": 0.1, "ALERT": 0.8},
            "confidence": 1.4,
        },
        "T0009": {
            "type": "choice",
            "choice": "WATCH",
            "probabilities": {"CLEAR": 0.2, "WATCH": 0.7, "ALERT": 0.1},
            "confidence": 0.5,
        },
    }

    decisions = resolve_answers(bundle, answers)

    assert decisions["T0088"].level is Level.WATCH
    assert decisions["T0088"].jev_confidence is None
    assert decisions["T0009"].level is Level.WATCH
    assert decisions["T0009"].jev_confidence == 0.5


def test_jev_service_caches_a_valid_frame_decision(pipeline, tmp_path):
    from app.agents.jev import JevService

    bundle = pipeline.bundle_for("img_002256")

    class Gateway:
        calls = 0

        def evaluate(self, request):
            self.calls += 1
            return {
                "model": "jev-latest",
                "answers": {
                    "T0009": {
                        "type": "choice",
                        "choice": "WATCH",
                        "probabilities": {"CLEAR": 0.1, "WATCH": 0.8, "ALERT": 0.1},
                        "confidence": 0.75,
                    }
                },
                "usage": {"input_tokens": 500, "output_tokens": 30},
            }

    gateway = Gateway()
    service = JevService(gateway, cache_dir=tmp_path / "cache", budget_path=tmp_path / "jev_budget.json")

    first = service.run(bundle)
    second = service.run(bundle)

    assert first.decisions["T0009"].level is Level.WATCH
    assert second.decisions["T0009"].jev_confidence == 0.75
    assert gateway.calls == 1
    assert second.from_cache
    runs = (tmp_path / "jev_runs.jsonl").read_text().splitlines()
    assert len(runs) == 2
    assert json.loads(runs[0])["decisions"]["T0009"]["jev_confidence"] == 0.75
    assert json.loads(runs[1])["from_cache"] is True


def test_jev_service_uses_rules_when_gateway_fails(pipeline, tmp_path):
    from app.agents.jev import JevService

    bundle = pipeline.bundle_for("img_002256")

    class Gateway:
        def evaluate(self, request):
            raise TimeoutError("provider unavailable")

    service = JevService(Gateway(), cache_dir=tmp_path / "cache", budget_path=tmp_path / "jev_budget.json")
    result = service.run(bundle)

    assert result.decisions["T0088"].level is Level.WATCH
    assert result.decisions["T0088"].jev_confidence is None
    assert result.fallback_reason == "TimeoutError"


def test_paid_jev_decision_survives_cache_write_failure(pipeline, tmp_path, monkeypatch):
    from app.agents.jev import JevService

    class Gateway:
        def evaluate(self, request):
            return {
                "answers": {"T0009": {
                    "type": "choice", "choice": "ALERT",
                    "probabilities": {"CLEAR": 0.05, "WATCH": 0.05, "ALERT": 0.9},
                    "confidence": 0.81,
                }},
                "usage": {"input_tokens": 500},
            }

    service = JevService(Gateway(), cache_dir=tmp_path / "cache", budget_path=tmp_path / "budget.json")
    monkeypatch.setattr(service, "_write_cache", lambda *args: (_ for _ in ()).throw(OSError("disk full")))

    outcome = service.run(pipeline.bundle_for("img_002256"))

    assert outcome.decisions["T0009"].level is Level.ALERT
    assert outcome.decisions["T0009"].jev_confidence == 0.81
    assert outcome.audit_error == "OSError"


def test_jev_spend_is_reserved_when_usage_is_missing(pipeline, tmp_path):
    from app.agents.jev import JevService

    class Gateway:
        def evaluate(self, request):
            return {"answers": {}}

    service = JevService(Gateway(), cache_dir=tmp_path / "cache", budget_path=tmp_path / "budget.json")
    service.run(pipeline.bundle_for("img_002256"))

    assert json.loads((tmp_path / "budget.json").read_text())["local_spend_usd"] > 0


def test_jev_budget_refuses_call_and_keeps_rule_level(pipeline, tmp_path):
    from app.agents.jev import JevService

    bundle = pipeline.bundle_for("img_002256")

    class Gateway:
        calls = 0

        def evaluate(self, request):
            self.calls += 1
            raise AssertionError("budget guard should prevent this call")

    gateway = Gateway()
    service = JevService(
        gateway,
        cache_dir=tmp_path / "cache",
        budget_path=tmp_path / "jev_budget.json",
        cap_usd=0.000001,
    )

    outcome = service.run(bundle)

    assert outcome.fallback_reason == "budget_exceeded"
    assert outcome.decisions["T0088"].level is Level.WATCH
    assert gateway.calls == 0


def test_jev_raise_creates_alert_without_chat_assessment(pipeline, cfg):
    from app.agents.threat_decisions import apply_threat_decisions, resolve_answers

    analysis = pipeline.analyse_image("img_002256")
    bundle = pipeline.bundle_of(analysis)
    watch, raised_id, _ = _roles(bundle)
    decisions = resolve_answers(
        bundle,
        {
            raised_id: {
                "type": "choice",
                "choice": "ALERT",
                "probabilities": {"CLEAR": 0.05, "WATCH": 0.05, "ALERT": 0.9},
                "confidence": 0.85,
            }
        },
    )

    alerts = apply_threat_decisions(
        analysis.alerts, bundle, decisions, ts=analysis.as_of, rules_version=cfg.rules_version
    )

    raised = next(alert for alert in alerts if alert.track_id == raised_id)
    assert raised.baseline_level is Level.CLEAR
    assert raised.level is Level.ALERT
    assert raised.jev_confidence == 0.85
    assert raised.agent_rationale is None
    assert any(alert.track_id == watch and alert.level is Level.WATCH for alert in alerts)
