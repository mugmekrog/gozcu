"""Tests for the Cloud Run FastAPI REST server (app.api.rest)."""

from __future__ import annotations

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


def test_assess_stream():
    response = client.post("/agents/assess/img_000860")
    assert response.status_code == 200
    assert "application/x-ndjson" in response.headers["content-type"]

    lines = [json.loads(line) for line in response.text.strip().split("\n") if line.strip()]
    types = [line["type"] for line in lines]
    assert "step" in types
    assert "brief" in types
    assert "done" in types


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
