"""The speech-to-text service (stt.md phases 4, 10 and 11).

One object owns the recogniser, the transcript boundary and the measurements. It
is what the HTTP layer calls and what the CLI calls, so both get identical
behaviour including identical failures.

**One worker, on purpose.** stt.md phase 4.2 says not to run inference on the
caller's thread and offers a queue, a process or a service. This is the queue
version, with a single worker, and the single part matters more than the queue
part: there is one model in one block of VRAM, and two concurrent transcriptions
on a 6 GB card is how you turn a working demo into an out-of-memory error. The
lock serialises them instead, and a caller that arrives mid-transcription waits
rather than failing. Whisper on this hardware takes well under a second for a
command, so the wait is not something an operator notices.

**Failure is a value.** Every path returns either a `Transcript` or a
`TranscriptRejected`; nothing here raises at the caller. That is phase 10's
requirement restated as a type - the display cannot forget to handle "speech
recognition is unavailable" if the only way to get a transcript is to check which
of the two it received.

**Everything is measured.** Phase 11 lists audio duration, inference duration,
real-time factor, transcript length, VRAM and errors. All of them are recorded per
utterance to a JSONL file, appended, one object per line, so a run can be read
back with the same tools as `agent_runs.jsonl`.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from goru_core.config import Config

from app.stt.audio import AudioError, DecodedAudio, decode_wav
from app.stt.model import vram_used_mb
from app.stt.provider import SttProvider, SttProviderError, build_provider
from app.stt.schemas import (
    SttErrorCode,
    SttMetrics,
    SttStatus,
    Transcript,
    TranscriptRejected,
    Utterance,
)
from app.stt.transcripts import TranscriptManager

__all__ = ["SpeechToTextService"]


class SpeechToTextService:
    """Audio in, a `Transcript` or a `TranscriptRejected` out."""

    def __init__(
        self,
        cfg: Config,
        *,
        provider: Optional[SttProvider] = None,
    ) -> None:
        self._cfg = cfg
        self._stt = cfg.stt
        self._provider = provider if provider is not None else build_provider(cfg.stt)
        self._manager = TranscriptManager(stt=cfg.stt, voice=cfg.voice)
        self._lock = threading.Lock()
        self._ready = False
        self._error: Optional[SttErrorCode] = None
        self._detail: Optional[str] = None
        self._load_ms: Optional[int] = None
        self._metrics_path = cfg.resolve(cfg.stt.metrics_file)

    # --- lifecycle -------------------------------------------------------- #

    @property
    def provider(self) -> SttProvider:
        return self._provider

    def warm(self) -> SttStatus:
        """Load the model now (stt.md phase 1: once, at startup, never per request).

        Never raises. A failure here is the normal state of a machine without a
        GPU or without the weights cached, and the display has to be able to boot
        against it and say why the microphone is disabled.
        """
        if not self._stt.enabled:
            self._ready = False
            self._error = SttErrorCode.STT_DISABLED
            self._detail = "stt.enabled is false in goru.yaml"
            return self.status()

        started = time.perf_counter()
        try:
            self._provider.warm()
        except SttProviderError as exc:
            self._ready = False
            self._error = exc.code
            self._detail = exc.detail
            return self.status()

        self._ready = True
        self._error = None
        self._detail = None
        self._load_ms = int((time.perf_counter() - started) * 1000)
        return self.status()

    def status(self) -> SttStatus:
        """What the display shows before anyone presses the microphone."""
        placement = None
        try:
            placement = self._provider.placement
        except Exception as exc:  # a placement probe can fail on a broken CUDA install
            if self._error is None:
                self._error = SttErrorCode.CUDA_UNAVAILABLE
                self._detail = str(exc)

        handle = getattr(self._provider, "handle", None)
        return SttStatus(
            ready=self._ready,
            provider=self._provider.name,
            model=self._stt.model,
            device=placement.device if placement else "unknown",
            compute_type=placement.compute_type if placement else "unknown",
            language=self._stt.language,
            error=self._error,
            detail=self._detail or (placement.note or None if placement else None),
            model_load_ms=handle.load_ms if handle is not None else self._load_ms,
            vram_used_mb=handle.vram_after_mb if handle is not None else None,
            max_utterance_s=self._stt.max_utterance_s,
        )

    # --- the one entry point ---------------------------------------------- #

    def transcribe_wav(
        self, data: bytes, *, source: str = "browser"
    ) -> Transcript | TranscriptRejected:
        """Decode a WAV payload and transcribe it. The HTTP layer calls only this."""
        if not self._stt.enabled:
            return TranscriptRejected(
                code=SttErrorCode.STT_DISABLED,
                detail="speech recognition is switched off in goru.yaml",
            )
        try:
            audio = decode_wav(data, target_rate=self._stt.sample_rate)
        except AudioError as exc:
            return TranscriptRejected(code=exc.code, detail=exc.detail)
        return self.transcribe(audio, source=source)

    def transcribe(
        self, audio: DecodedAudio, *, source: str = "browser"
    ) -> Transcript | TranscriptRejected:
        """Transcribe decoded audio. Serialised against the resident model."""
        rejection = self._check_duration(audio)
        if rejection is not None:
            self._record_metrics(audio, None, rejection)
            return rejection

        utterance = Utterance(
            utterance_id=f"utt_{uuid.uuid4().hex[:12]}",
            duration_s=audio.duration_s,
            sample_rate=audio.sample_rate,
            rms=round(audio.rms, 6),
            peak=round(audio.peak, 6),
            captured_at=datetime.now(timezone.utc),
            source=source if source in {"browser", "file", "microphone"} else "browser",
        )

        if not self._ready:
            status = self.warm()
            if not status.ready:
                rejected = TranscriptRejected(
                    code=status.error or SttErrorCode.STT_UNAVAILABLE,
                    detail=status.detail or "speech recognition is unavailable",
                    duration=audio.duration_s,
                )
                self._record_metrics(audio, None, rejected)
                return rejected

        started = time.perf_counter()
        with self._lock:  # one model, one block of VRAM, one transcription at a time
            try:
                raw = self._provider.transcribe(audio)
            except SttProviderError as exc:
                rejected = TranscriptRejected(
                    code=exc.code, detail=exc.detail, duration=audio.duration_s
                )
                self._record_metrics(audio, None, rejected)
                if exc.code in {SttErrorCode.GPU_OUT_OF_MEMORY, SttErrorCode.CUDA_UNAVAILABLE}:
                    # The model may be in an unusable state; make the next call
                    # reload rather than compounding the failure.
                    self._ready = False
                    self._error = exc.code
                    self._detail = exc.detail
                return rejected
            except Exception as exc:  # a provider that raised something unexpected
                rejected = TranscriptRejected(
                    code=SttErrorCode.WORKER_CRASHED,
                    detail=f"the transcription worker failed: {exc}",
                    duration=audio.duration_s,
                )
                self._record_metrics(audio, None, rejected)
                return rejected
        latency_ms = int((time.perf_counter() - started) * 1000)

        metrics = SttMetrics(
            audio_duration_ms=int(round(audio.duration_s * 1000)),
            stt_latency_ms=latency_ms,
            real_time_factor=(
                round(latency_ms / 1000.0 / audio.duration_s, 4) if audio.duration_s > 0 else 0.0
            ),
            transcript_chars=len(raw.text.strip()),
            vram_used_mb=vram_used_mb() if self._provider.placement.device == "cuda" else None,
            speech_ratio=raw.speech_ratio,
            from_vad_gate=self._stt.vad_filter,
        )

        result = self._manager.finalise(
            raw_text=raw.text,
            utterance=utterance,
            language=raw.language,
            no_speech_prob=raw.no_speech_prob,
            confidence=raw.confidence,
            metrics=metrics,
        )
        self._record_metrics(audio, metrics, result)
        return result

    # --- the guards ------------------------------------------------------- #

    def _check_duration(self, audio: DecodedAudio) -> Optional[TranscriptRejected]:
        """Phase 8's 15-second cap and the too-short floor.

        Long audio is refused rather than truncated. Truncating would hand the
        agent the first two thirds of a sentence, which reads as a complete
        instruction and is the most dangerous possible failure mode for a system
        where speech can record a decision.
        """
        duration = audio.duration_s
        if duration > self._stt.max_utterance_s:
            return TranscriptRejected(
                code=SttErrorCode.AUDIO_TOO_LONG,
                detail=(
                    f"{duration:.1f} s of audio exceeds the {self._stt.max_utterance_s:.0f} s "
                    f"limit for one command; say it again more briefly"
                ),
                duration=duration,
            )
        if duration < self._stt.min_utterance_s:
            return TranscriptRejected(
                code=SttErrorCode.AUDIO_TOO_SHORT,
                detail=f"{duration:.2f} s is too short to be a command",
                duration=duration,
            )
        return None

    # --- phase 11 --------------------------------------------------------- #

    def _record_metrics(
        self,
        audio: DecodedAudio,
        metrics: Optional[SttMetrics],
        outcome: Transcript | TranscriptRejected,
    ) -> None:
        """Append one measurement row. Never raises: telemetry is not the job."""
        row: dict[str, object] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "provider": self._provider.name,
            "audio_duration_ms": int(round(audio.duration_s * 1000)),
            "rms": round(audio.rms, 6),
        }
        if isinstance(outcome, Transcript):
            row.update(
                {
                    "id": outcome.id,
                    "ok": True,
                    "transcript_chars": len(outcome.text),
                    "normalisations": len(outcome.normalised),
                    "confidence": outcome.confidence,
                    "no_speech_prob": outcome.no_speech_prob,
                }
            )
        else:
            row.update({"ok": False, "code": outcome.code.value, "detail": outcome.detail})
        if metrics is not None:
            row.update(
                {
                    "stt_latency_ms": metrics.stt_latency_ms,
                    "real_time_factor": metrics.real_time_factor,
                    "vram_used_mb": metrics.vram_used_mb,
                    "speech_ratio": metrics.speech_ratio,
                }
            )

        try:
            path = Path(self._metrics_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        except OSError:
            pass
