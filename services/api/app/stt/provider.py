"""The STT provider seam (stt.md phase 7).

stt.md asks for this abstraction so the application never depends permanently on
one recogniser, and names Deepgram, Google, Azure and OpenAI as the implementations
that might follow. That is the right reason, but it is not sufficient on its own:
one adapter behind an interface is a hypothetical seam, and this repository's own
rule - stated in both step logs, applied to `LlmGateway` and to `GoruApi` - is
that a seam is only real once two adapters satisfy it.

So there are two. `LocalWhisperProvider` runs the Turkish fine-tune on the GPU.
`ScriptedSttProvider` returns prepared answers with no model, no GPU and no
network, and it is what every test uses. That second adapter is not a mock of the
first: it satisfies the same contract, including the refusals, which is how the
failure paths of phase 10 get tested at all. A cloud provider added later
implements this protocol and changes nothing above it.

A provider's job stops at words. It does not clean them, does not normalise ids,
and does not decide what they mean - those are `transcripts.py` and `app.voice`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Protocol, Sequence, runtime_checkable

import numpy as np

from goru_core.config import SttConfig

from app.stt.audio import DecodedAudio
from app.stt.model import ModelHandle, ModelLoadError, Placement, load_model, vram_used_mb
from app.stt.schemas import SttErrorCode

__all__ = [
    "RawTranscription",
    "SttProvider",
    "SttProviderError",
    "LocalWhisperProvider",
    "ScriptedSttProvider",
    "build_provider",
]


class SttProviderError(RuntimeError):
    """The provider could not transcribe, with the code the display should show."""

    def __init__(self, code: SttErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class RawTranscription:
    """What a recogniser returns, before anything has been done to it."""

    text: str
    language: str
    duration_s: float
    no_speech_prob: Optional[float] = None
    avg_logprob: Optional[float] = None
    speech_ratio: Optional[float] = None
    segments: int = 0

    @property
    def confidence(self) -> Optional[float]:
        """A 0-1 reading derived from the mean token log-probability.

        Whisper does not report a calibrated confidence, and presenting one as if
        it were would be dishonest. This is a monotone transform of `avg_logprob`
        only - useful for "the model was unsure about this one", not for a
        threshold anyone should trust. The display labels it as such.
        """
        if self.avg_logprob is None:
            return None
        return round(float(np.exp(self.avg_logprob)), 4)


@runtime_checkable
class SttProvider(Protocol):
    """Everything the service needs from a recogniser."""

    @property
    def name(self) -> str: ...

    @property
    def placement(self) -> Placement: ...

    def warm(self) -> None:
        """Load whatever is needed now, so the first utterance is not the slowest."""
        ...

    def transcribe(self, audio: DecodedAudio) -> RawTranscription:
        """Words for this audio, or raise `SttProviderError`."""
        ...


class LocalWhisperProvider:
    """The Turkish fine-tune of large-v3, on this machine's GPU.

    Configured for the command case that stt.md phase 8 describes, and the
    settings are not arbitrary:

    * ``language`` is pinned. The model is a Turkish fine-tune; letting Whisper
      detect the language costs an extra pass and can only pick something worse.
    * ``beam_size: 1``. Commands are short and the vocabulary is narrow; a wider
      beam buys accuracy we cannot measure and latency the operator can feel.
    * ``condition_on_previous_text: False``. Each command is independent, and
      carrying context across them is how Whisper starts repeating the last
      transcript when it hears a half-second of noise.
    * ``vad_filter``. faster-whisper bundles Silero, so the phase-3 gate runs here
      on the server as well as in the browser. The browser's copy decides when to
      stop recording; this one decides whether what arrived was speech at all.
    """

    def __init__(self, cfg: SttConfig) -> None:
        self._cfg = cfg
        self._handle: Optional[ModelHandle] = None

    @property
    def name(self) -> str:
        return "local_whisper"

    @property
    def placement(self) -> Placement:
        if self._handle is not None:
            return self._handle.placement
        from app.stt.model import resolve_placement

        return resolve_placement(self._cfg)

    @property
    def handle(self) -> Optional[ModelHandle]:
        return self._handle

    def warm(self) -> None:
        """Load the model. Raises `SttProviderError` with an actionable code."""
        try:
            self._handle = load_model(self._cfg)
        except ModelLoadError as exc:
            raise SttProviderError(exc.code, exc.detail) from exc

    def transcribe(self, audio: DecodedAudio) -> RawTranscription:
        if self._handle is None:
            self.warm()
        assert self._handle is not None  # warm() either sets it or raises

        cfg = self._cfg
        vad_parameters = (
            {
                "min_silence_duration_ms": cfg.vad_min_silence_ms,
                "speech_pad_ms": cfg.vad_speech_pad_ms,
            }
            if cfg.vad_filter
            else None
        )

        try:
            segments, info = self._handle.model.transcribe(
                audio.samples,
                language=cfg.language,
                beam_size=cfg.beam_size,
                condition_on_previous_text=cfg.condition_on_previous_text,
                vad_filter=cfg.vad_filter,
                vad_parameters=vad_parameters,
                word_timestamps=False,
            )
            collected = list(segments)  # faster-whisper is lazy; this runs the model
        except Exception as exc:
            raise _classify_runtime_failure(exc) from exc

        text = " ".join(segment.text.strip() for segment in collected if segment.text)
        logprobs = [
            segment.avg_logprob
            for segment in collected
            if getattr(segment, "avg_logprob", None) is not None
        ]
        no_speech = [
            segment.no_speech_prob
            for segment in collected
            if getattr(segment, "no_speech_prob", None) is not None
        ]

        # `info.duration` is the audio's length; `duration_after_vad` is what was
        # left once Silero dropped the silence. Their ratio is the cheapest
        # available signal for "the operator was further from the microphone than
        # they thought", so phase 11 records it.
        duration = float(getattr(info, "duration", audio.duration_s) or audio.duration_s)
        after_vad = getattr(info, "duration_after_vad", None)
        speech_ratio = (
            round(float(after_vad) / duration, 4)
            if after_vad is not None and duration > 0
            else None
        )

        return RawTranscription(
            text=text,
            language=str(getattr(info, "language", cfg.language) or cfg.language),
            duration_s=duration,
            no_speech_prob=float(np.mean(no_speech)) if no_speech else None,
            avg_logprob=float(np.mean(logprobs)) if logprobs else None,
            speech_ratio=speech_ratio,
            segments=len(collected),
        )


def _classify_runtime_failure(exc: Exception) -> SttProviderError:
    """Turn an inference exception into a code the operator can act on."""
    message = str(exc)
    lowered = message.lower()
    if "out of memory" in lowered:
        return SttProviderError(
            SttErrorCode.GPU_OUT_OF_MEMORY,
            f"the GPU ran out of memory during transcription. Set "
            f"stt.compute_type: int8_float16 or close other GPU applications. ({message})",
        )
    if "cudnn" in lowered or "cublas" in lowered:
        return SttProviderError(SttErrorCode.CUDA_UNAVAILABLE, message)
    return SttProviderError(SttErrorCode.STT_UNAVAILABLE, message)


@dataclass
class ScriptedSttProvider:
    """Prepared answers, no model. The offline half of the seam.

    Every test in the suite runs against this, which is why the tests need no GPU,
    no 3 GB download and no network. Hand it `RawTranscription` values to return
    in order, or `SttProviderError` instances to raise, and the failure paths of
    phase 10 become as testable as the happy one.
    """

    answers: Sequence[RawTranscription | SttProviderError] = field(default_factory=tuple)
    placement_value: Placement = field(default_factory=lambda: Placement("cpu", "scripted"))
    calls: list[float] = field(default_factory=list)
    warmed: bool = False
    _index: int = field(default=0, repr=False)

    @property
    def name(self) -> str:
        return "scripted"

    @property
    def placement(self) -> Placement:
        return self.placement_value

    def warm(self) -> None:
        self.warmed = True

    def transcribe(self, audio: DecodedAudio) -> RawTranscription:
        self.calls.append(audio.duration_s)
        if self._index >= len(self.answers):
            raise SttProviderError(
                SttErrorCode.STT_UNAVAILABLE, "the scripted provider ran out of answers"
            )
        answer = self.answers[self._index]
        self._index += 1
        if isinstance(answer, SttProviderError):
            raise answer
        return answer


def build_provider(cfg: SttConfig) -> SttProvider:
    """The provider this config asks for. The one place the choice is made."""
    if cfg.provider == "scripted":
        return ScriptedSttProvider()
    return LocalWhisperProvider(cfg)
