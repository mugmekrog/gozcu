"""Tests for the Cloud Run FastAPI REST server (app.api.rest)."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.api.rest import app

client = TestClient(app)

# Every POST the display makes carries this; a page on another origin cannot add it
# without a CORS preflight, which the allowlist refuses.
CLIENT = {"X-Goru-Client": "goru-web"}


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


FABRICATED = "doğrulanmıştır"  # the old fallback claimed everything had been verified


def _scripted_stack(monkeypatch, cfg, gateway):
    """Route the endpoint's agent stack through an offline gateway and temp ledgers."""
    from app.api import rest
    from app.agents.factory import build_agent_stack

    monkeypatch.setattr(rest, "get_cfg", lambda: cfg)
    monkeypatch.setattr(
        rest, "build_agent_stack", lambda c, **kw: build_agent_stack(c, gateway=gateway, **kw)
    )


def test_ask_answers_through_the_copilot_and_its_tools(monkeypatch, offline_cfg):
    """The endpoint must reach the real engine: the tool sees T0104 in the analyses."""
    from app.llm.port import ChatResult, ToolCall
    from app.llm.stub import ScriptedGateway

    tool_turn = ChatResult(
        text="",
        tool_calls=(ToolCall(call_id="c1", name="get_track_state", arguments='{"track_id": "T0104"}'),),
        prompt_tokens=10,
        completion_tokens=5,
    )
    gateway = ScriptedGateway([tool_turn, "T0104 hareket halinde; ayrinti izde."])
    _scripted_stack(monkeypatch, offline_cfg, gateway)

    response = client.post("/agents/ask", json={"question": "T0104 neden kirmizi?"}, headers=CLIENT)

    assert response.status_code == 200
    assert response.json()["answer"] == "T0104 hareket halinde; ayrinti izde."
    tool_reply = gateway.requests[1].messages[-1]
    assert tool_reply["role"] == "tool"
    assert '"T0104"' in tool_reply["content"]


def test_ask_is_honest_when_the_model_is_unreachable(monkeypatch, offline_cfg):
    from app.llm.stub import ScriptedGateway

    _scripted_stack(monkeypatch, offline_cfg, ScriptedGateway([]))

    response = client.post("/agents/ask", json={"question": "T0104 neden kirmizi?"}, headers=CLIENT)

    answer = response.json()["answer"]
    assert "could not reach the assessment model" in answer
    assert FABRICATED not in answer


def test_ask_copilot(monkeypatch):
    from types import SimpleNamespace
    from app.api import rest
    from app.agents.copilot import ReviewerCopilot

    monkeypatch.setattr(ReviewerCopilot, "ask", lambda self, question: SimpleNamespace(
        text="Bir kare seçildi.", assessment_image_ids=["img_000860"]
    ))
    data = rest.ask_copilot(rest.AskRequest(question="img_000860 karesini değerlendir"))
    assert "answer" in data
    assert len(data["answer"]) > 0
    assert data["assessment_image_ids"] == ["img_000860"]


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
    response = client.post("/agents/assess/img_000860", headers=CLIENT)
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
    post_res = client.post("/frames/img_000860/decision", json=payload, headers=CLIENT)
    assert post_res.status_code == 200
    saved = post_res.json()
    assert saved["status"] == "ack"
    assert saved["image_id"] == "img_000860"

    list_res = client.get("/decisions")
    assert list_res.status_code == 200
    decisions = list_res.json()["decisions"]
    assert any(d["image_id"] == "img_000860" and d["status"] == "ack" for d in decisions)


# --------------------------------------------------------------------------- #
# Budget protection: the endpoints that spend the $15 or write a decision
# --------------------------------------------------------------------------- #


def _preflight(origin: str):
    return client.options(
        "/agents/assess/img_000860",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-goru-client",
        },
    )


def test_a_foreign_origin_is_not_granted_cors():
    assert "access-control-allow-origin" not in _preflight("https://evil.example").headers


def test_the_dev_display_origin_is_granted_cors_and_the_client_header():
    headers = _preflight("http://localhost:5173").headers
    assert headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "x-goru-client" in headers["access-control-allow-headers"].lower()


@pytest.mark.parametrize(
    "path, body",
    [
        ("/agents/assess/img_000860", None),
        ("/agents/ask", {"question": "T0104 neden kirmizi?"}),
        ("/frames/img_000860/decision", {"image_id": "img_000860", "status": "ack"}),
    ],
)
def test_spending_and_writing_posts_need_the_client_header(monkeypatch, path, body):
    from app.api import rest

    def forbidden(*args, **kwargs):
        raise AssertionError("work started without the client header")

    monkeypatch.setattr(rest, "load_dataset", forbidden)
    monkeypatch.setattr(rest, "build_agent_stack", forbidden)
    before = len(client.get("/decisions").json()["decisions"])

    response = client.post(path, json=body)

    assert response.status_code == 403
    assert len(client.get("/decisions").json()["decisions"]) == before
