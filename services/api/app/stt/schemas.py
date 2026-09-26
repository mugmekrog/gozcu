"""The contracts that cross the STT seam (stt.md phases 4, 5, 10, 11).

Three things travel: an `Utterance` in, a `Transcript` out, and an `SttStatus`
for when the pipeline cannot answer at all. The error path is a first-class
contract rather than an exception string because stt.md phase 10 is explicit
about it - the display has to say *why* speech is unavailable, and
"Speech recognition is currently unavailable" is a different message from
"I heard nothing".

`Transcript.text` is what reaches the router. It is never the model's raw output:
the transcript manager has already cleaned whitespace, normalised punctuation and
resolved the spoken forms of our own ids. `raw_text` is kept beside it so a
disagreement between what was said and what was understood stays inspectable.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "SttErrorCode",
    "SttStatus",
    "Utterance",
    "Transcript",
    "TranscriptRejected",
    "SttMetrics",
]


class _Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class SttErrorCode(str, Enum):
    """Every way the pipeline can decline, as the display will name it.

    One code per operator-visible cause. `STT_UNAVAILABLE` is the general
    "there is no speech recognition right now"; the rest are specific enough
    that the operator can fix them.
    """

    STT_DISABLED = "STT_DISABLED"
    STT_UNAVAILABLE = "STT_UNAVAILABLE"
    CUDA_UNAVAILABLE = "CUDA_UNAVAILABLE"
    GPU_OUT_OF_MEMORY = "GPU_OUT_OF_MEMORY"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    AUDIO_INVALID = "AUDIO_INVALID"
    AUDIO_TOO_LONG = "AUDIO_TOO_LONG"
    AUDIO_TOO_SHORT = "AUDIO_TOO_SHORT"
    NO_SPEECH = "NO_SPEECH"
    EMPTY_TRANSCRIPT = "EMPTY_TRANSCRIPT"
    WORKER_CRASHED = "WORKER_CRASHED"


class SttStatus(_Model):
    """Whether the pipeline can transcribe at all, and on what.

    Served at boot so the display can disable the microphone with a reason
    instead of accepting speech it cannot process - the same courtesy the
    copilot field already extends when there is no gateway.
    """

    ready: bool
    provider: str
    model: str
    device: str
    compute_type: str
    language: str
    error: Optional[SttErrorCode] = None
    detail: Optional[str] = None
    model_load_ms: Optional[int] = None
    vram_used_mb: Optional[float] = None
    max_utterance_s: float = 15.0


class Utterance(_Model):
    """One finalised stretch of speech, already decoded to what Whisper wants.

    The samples are not carried here - they are large, and a pydantic model is
    the wrong place for a megabyte of float32. This is the metadata that travels
    beside them so every measurement in phase 11 has something to attach to.
    """

    utterance_id: str
    duration_s: float = Field(ge=0)
    sample_rate: int
    rms: float = Field(0.0, ge=0)
    peak: float = Field(0.0, ge=0)
    captured_at: datetime
    source: Literal["browser", "file", "microphone"] = "browser"


class SttMetrics(_Model):
    """What phase 11 asks to be measured, for one transcription."""

    audio_duration_ms: int
    stt_latency_ms: int
    real_time_factor: float
    transcript_chars: int
    vram_used_mb: Optional[float] = None
    speech_ratio: Optional[float] = None
    from_vad_gate: bool = False


class Transcript(_Model):
    """A finalised transcript, ready for the router.

    `final` exists because the contract in stt.md phase 4 has it and because the
    display distinguishes the two states; today the pipeline only ever emits
    final transcripts, and partials are listed in stt.md's future work.
    """

    id: str
    text: str
    raw_text: str
    language: str
    duration: float
    final: bool = True
    confidence: Optional[float] = None
    no_speech_prob: Optional[float] = None
    normalised: list[str] = Field(default_factory=list)
    metrics: Optional[SttMetrics] = None
    timestamp: datetime


class TranscriptRejected(_Model):
    """Why nothing is being forwarded.

    stt.md phase 10: *do not silently forward empty or invalid text to the
    agent*. So the rejection is a value the caller must handle, not a `None`
    that happens to look like a quiet success.
    """

    code: SttErrorCode
    detail: str
    heard: str = ""
    duration: float = 0.0
