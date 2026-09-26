"""Tests for the Cloud Run FastAPI REST server (app.api.rest)."""

from __future__ import annotations

import asyncio
import json
from fastapi.testclient import TestClient

from app.api.rest import app

client = TestClient(app)


def test_healthz():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root():
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "goru-sentinel"
    assert data["status"] == "ok"


def test_dataset():
    response = client.get("/dataset")
    assert response.status_code == 200
    data = response.json()
    assert "base" in data
    assert "zones" in data
    assert "counts" in data
    assert len(data["zones"]) == 8


def test_tracks():
    response = client.get("/tracks?history=full")
    assert response.status_code == 200
    data = response.json()
    assert "tracks" in data
    assert len(data["tracks"]) == 226


def test_reports():
    response = client.get("/reports")
    assert response.status_code == 200
    data = response.json()
    assert "reports" in data
    assert len(data["reports"]) == 137


def test_alerts():
    response = client.get("/alerts")
    assert response.status_code == 200
    data = response.json()
    assert "alerts" in data
    assert len(data["alerts"]) > 0


def test_frame_detail():
    response = client.get("/frames/img_000860")
    assert response.status_code == 200
    data = response.json()
    assert data["image_id"] == "img_000860"
    assert "detections" in data
    assert "brief" in data


def test_image_serving():
    response = client.get("/images/img_000860")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert len(response.content) > 1000


def test_budget():
    response = client.get("/agents/budget")
    assert response.status_code == 200
    data = response.json()
    assert "spend_usd" in data
    assert "cap_usd" in data
    assert data["cap_usd"] == 15.0


def test_ask_copilot():
    response = client.post("/agents/ask", json={"question": "why is T0187 red?"})
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    assert len(data["answer"]) > 0


def test_assess_stream(monkeypatch):
    from app.api import rest
    from app.agents.jev import JevOutcome
    from app.agents.threat_decisions import resolve_answers

    class FakeJev:
        def run(self, bundle):
            return JevOutcome(resolve_answers(bundle, None), fallback_reason="test")

    monkeypatch.setattr(rest, "get_jev_service", lambda cfg: FakeJev())
    monkeypatch.setattr(
        rest,
        "run_situational_report",
        lambda bundle, cfg: {"source": "rules", "image_summary": "Test report", "assessments": []},
    )
    response = client.post("/agents/assess/img_000860")
    assert response.status_code == 200
    assert "application/x-ndjson" in response.headers["content-type"]

    lines = [json.loads(line) for line in response.text.strip().split("\n") if line.strip()]
    types = [line["type"] for line in lines]
    assert "step" in types
    assert "brief" in types
    assert "done" in types


def test_live_assess_stream_keeps_jev_raise_and_chat_report_separate(monkeypatch, tmp_path):
    from app.api import rest
    from app.agents.jev import JevOutcome
    from app.agents.threat_decisions import resolve_answers

    class FakeJev:
        def run(self, bundle):
            decisions = resolve_answers(
                bundle,
                {
                    "T0009": {
                        "type": "choice",
                        "choice": "ALERT",
                        "probabilities": {"CLEAR": 0.05, "WATCH": 0.05, "ALERT": 0.9},
                        "confidence": 0.8,
                    }
                },
            )
            return JevOutcome(decisions)

    monkeypatch.setattr(rest, "get_jev_service", lambda cfg: FakeJev(), raising=False)
    monkeypatch.setattr(rest, "FIXTURES_DIR", tmp_path)
    async def run_inline(func, *args):
        return func(*args)

    monkeypatch.setattr(rest, "_run_blocking", run_inline)
    monkeypatch.setattr(
        rest,
        "run_situational_report",
        lambda bundle, cfg: {"source": "llm", "image_summary": "Detailed report", "assessments": []},
        raising=False,
    )

    async def collect():
        response = await rest.assess_frame("img_002256")
        return [json.loads(chunk) async for chunk in response.body_iterator]

    events = asyncio.run(collect())
    frame = next(event["frame"] for event in events if event["type"] == "decision")
    brief = next(event["brief"] for event in events if event["type"] == "brief")

    assert next(a for a in frame["alerts"] if a["track_id"] == "T0009")["level"] == "ALERT"
    assert next(a for a in frame["alerts"] if a["track_id"] == "T0009")["jev_confidence"] == 0.8
    assert brief["image_summary"] == "Detailed report"


def test_decisions_workflow():
    payload = {
        "image_id": "img_000860",
        "status": "ack",
        "rationale": "Verified threat by operator",
        "decided_by": "operator-1",
    }
    post_res = client.post("/frames/img_000860/decision", json=payload)
    assert post_res.status_code == 200
    saved = post_res.json()
    assert saved["status"] == "ack"
    assert saved["image_id"] == "img_000860"

    list_res = client.get("/decisions")
    assert list_res.status_code == 200
    decisions = list_res.json()["decisions"]
    assert any(d["image_id"] == "img_000860" and d["status"] == "ack" for d in decisions)
