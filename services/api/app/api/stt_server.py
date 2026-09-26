"""The speech service the browser talks to.

This is the repository's first HTTP service, and it is deliberately not the REST
API of PLAN 5.4. That one serves the whole display and does not exist yet; this one
does a single job - take audio, return a command - and standing it up must not
require the other to be finished first. `web/src/api/http.ts` remains the written
specification for the big one, untouched.

**Loopback only.** The default bind is 127.0.0.1. A service that holds a
microphone stream and can route a command that records an operator decision has no
business listening on a LAN interface, and `stt.host` is where someone who
disagrees has to say so explicitly.

**Two endpoints and a status.**

    GET  /stt/status        can speech be used, and if not why (phase 10)
    POST /stt/transcribe    audio -> transcript, nothing more
    POST /voice/utterance   audio -> transcript -> routed command (the normal path)
    POST /voice/route       text  -> routed command (typed input, and the tests)

`/voice/utterance` is one round trip on purpose. The browser has just finished
recording and the operator is waiting; splitting transcription and routing across
two requests would add a network hop to the latency budget stt.md caps at 1-2
seconds for no gain, since nothing between them is useful to the display on its own.

**The model is loaded at startup, once.** stt.md phase 1. A first request that had
to wait twelve seconds for a 3 GB load would look like a hang, so the lifespan hook
pays that cost before the port opens and `/stt/status` reports the outcome.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from goru_core.config import Config, load_config

from app.agents.factory import AgentStack, build_agent_stack
from app.stt.schemas import SttErrorCode, Transcript, TranscriptRejected
from app.stt.service import SpeechToTextService
from app.voice.registry import load_registry
from app.voice.router import RoutedCommand, RouteFailure, VoiceRouter

__all__ = ["create_app"]

log = logging.getLogger("goru.stt")

# The browser will not send more than a few hundred kilobytes: 15 s of 16 kHz
# 16-bit mono PCM is 480 KB. Anything an order of magnitude past that is not our
# client and is refused before it is read into memory.
MAX_AUDIO_BYTES = 4 * 1024 * 1024


class RouteRequest(BaseModel):
    """A transcript that was typed, or one being re-routed after a confirmation."""

    text: str = Field(min_length=1)
    transcript_id: str = "typed_00000"


def _rejection_response(rejected: TranscriptRejected, status: int = 200) -> JSONResponse:
    """A refusal, as the display reads it.

    HTTP 200 with an explicit code rather than a 4xx, because none of these are
    protocol errors - "I heard nothing" is a normal outcome of pressing a
    microphone - and a 4xx would send the frontend's error path down a route meant
    for a broken request. The one exception is a payload we would not read at all.
    """
    return JSONResponse(
        status_code=status,
        content={
            "ok": False,
            "code": rejected.code.value,
            "detail": rejected.detail,
            "heard": rejected.heard,
            "duration": rejected.duration,
        },
    )


def _outcome_payload(
    transcript: Transcript, routed: RoutedCommand | RouteFailure | None
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": True,
        "transcript": transcript.model_dump(mode="json"),
    }
    payload["route"] = routed.to_payload() if routed is not None else None
    return payload


def create_app(cfg: Optional[Config] = None, *, stack: Optional[AgentStack] = None) -> FastAPI:
    """Build the service. `cfg` and `stack` are injectable so the tests need no GPU."""
    configuration = cfg if cfg is not None else load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Phase 1: load once, before the first request can arrive.
        if configuration.stt.warm_on_start:
            status = app.state.stt.warm()
            if status.ready:
                log.info(
                    "speech ready: %s on %s/%s, loaded in %s ms",
                    status.model,
                    status.device,
                    status.compute_type,
                    status.model_load_ms,
                )
            else:
                log.warning(
                    "speech unavailable (%s): %s",
                    status.error.value if status.error else "unknown",
                    status.detail,
                )
        yield

    app = FastAPI(
        title="Gözcü speech service",
        version="1",
        description=__doc__,
        lifespan=lifespan,
    )

    app.state.cfg = configuration
    app.state.stt = SpeechToTextService(configuration)
    app.state.stack = stack if stack is not None else build_agent_stack(
        configuration, interactive=True
    )
    app.state.registry = load_registry(configuration)
    app.state.router = VoiceRouter(app.state.stack.runner, configuration, app.state.registry)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(configuration.stt.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    # --- status ----------------------------------------------------------- #

    @app.get("/stt/status")
    def stt_status(request: Request) -> dict[str, Any]:
        """Everything the display needs to decide whether to enable the microphone."""
        status = request.app.state.stt.status()
        cfg_local: Config = request.app.state.cfg
        return {
            "stt": status.model_dump(mode="json"),
            "voice": {
                "enabled": cfg_local.voice.enabled,
                "admin": cfg_local.voice.admin,
                "confirm_audit_commands": cfg_local.voice.confirm_audit_commands,
                "confirm_timeout_s": cfg_local.voice.confirm_timeout_s,
                "router": cfg_local.voice.router,
                "registry_version": request.app.state.registry.version,
                "commands": list(request.app.state.registry.names),
            },
            "agent": {
                "live": request.app.state.stack.live,
                "mode": request.app.state.stack.mode,
                "reason": request.app.state.stack.reason,
            },
            "audio": {
                "sample_rate": cfg_local.stt.sample_rate,
                "max_utterance_s": cfg_local.stt.max_utterance_s,
                "min_utterance_s": cfg_local.stt.min_utterance_s,
                "silence_ms": cfg_local.stt.vad_min_silence_ms,
            },
        }

    # --- transcription ---------------------------------------------------- #

    async def _read_audio(audio: UploadFile) -> bytes | JSONResponse:
        data = await audio.read()
        if len(data) > MAX_AUDIO_BYTES:
            return _rejection_response(
                TranscriptRejected(
                    code=SttErrorCode.AUDIO_TOO_LONG,
                    detail=f"{len(data)} bytes is larger than this service accepts",
                ),
                status=413,
            )
        return data

    @app.post("/stt/transcribe")
    async def transcribe(request: Request, audio: UploadFile = File(...)) -> Any:
        """Audio to words. No routing, no side effects. Used by the CLI and tests."""
        data = await _read_audio(audio)
        if isinstance(data, JSONResponse):
            return data
        result = request.app.state.stt.transcribe_wav(data)
        if isinstance(result, TranscriptRejected):
            return _rejection_response(result)
        return _outcome_payload(result, None)

    @app.post("/voice/utterance")
    async def utterance(request: Request, audio: UploadFile = File(...)) -> Any:
        """The normal path: audio in, a command for the display out."""
        data = await _read_audio(audio)
        if isinstance(data, JSONResponse):
            return data

        result = request.app.state.stt.transcribe_wav(data)
        if isinstance(result, TranscriptRejected):
            return _rejection_response(result)

        routed = request.app.state.router.route(result)
        return _outcome_payload(result, routed)

    @app.post("/voice/route")
    def route(request: Request, body: RouteRequest) -> Any:
        """Route text that did not come from the microphone.

        Two callers: the typed copilot field, and the display re-submitting an
        utterance the operator has just confirmed. The second is why routing is
        reachable without audio at all - a confirmation must not require the
        operator to say the whole command again.
        """
        cfg_local: Config = request.app.state.cfg
        text = body.text.strip()[: cfg_local.voice.max_transcript_chars]
        from datetime import datetime, timezone

        transcript = Transcript(
            id=body.transcript_id,
            text=text,
            raw_text=body.text,
            language=cfg_local.stt.language,
            duration=0.0,
            timestamp=datetime.now(timezone.utc),
        )
        routed = request.app.state.router.route(transcript)
        return _outcome_payload(transcript, routed)

    return app
