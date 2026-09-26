"""Bytes on the wire to what Whisper wants (stt.md phase 2).

Whisper takes 16 kHz mono float32 in [-1, 1]. The browser sends a RIFF/WAVE
container of 16-bit PCM at that rate, because a WAV header is eleven fields and
resampling in an AudioWorklet is cheaper than making this module guess.

Decoded here with the standard library's `wave` plus numpy, deliberately: it means
the service has no dependency on an ffmpeg binary being on PATH, which is the
single most common way an audio pipeline works on the developer's machine and not
on the demo laptop. The cost is that only PCM WAV is accepted - and since we own
the only client, that is a contract rather than a limitation.

Every refusal here is an `AudioError` carrying an `SttErrorCode`, so the display
can say which of "that was not audio", "that was 40 seconds" and "that was a
click" actually happened.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import numpy as np

from app.stt.schemas import SttErrorCode

__all__ = ["AudioError", "DecodedAudio", "decode_wav", "encode_wav", "rms_of", "resample_to"]

_INT16_FULL_SCALE = 32768.0


class AudioError(ValueError):
    """The audio could not be used, with the code the display should show."""

    def __init__(self, code: SttErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class DecodedAudio:
    """Mono float32 samples plus the measurements phase 11 wants."""

    samples: np.ndarray
    sample_rate: int

    @property
    def duration_s(self) -> float:
        return len(self.samples) / float(self.sample_rate) if self.sample_rate else 0.0

    @property
    def rms(self) -> float:
        return rms_of(self.samples)

    @property
    def peak(self) -> float:
        return float(np.abs(self.samples).max()) if self.samples.size else 0.0


def rms_of(samples: np.ndarray) -> float:
    """Root-mean-square level, the number the browser's level bars also show."""
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


def decode_wav(data: bytes, *, target_rate: int = 16000) -> DecodedAudio:
    """Decode a PCM WAV to mono float32 at `target_rate`.

    Accepts 8/16/32-bit integer PCM at any rate and channel count, because a
    browser that was handed a device it could not reconfigure will send whatever
    the device gave it. Everything is folded to mono and resampled here rather
    than being refused, since refusing would put the operator in a position they
    cannot fix from the UI.
    """
    if not data:
        raise AudioError(SttErrorCode.AUDIO_INVALID, "audio payload was empty")

    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioError(
            SttErrorCode.AUDIO_INVALID, f"not a readable PCM WAV: {exc}"
        ) from exc

    if not frames:
        raise AudioError(SttErrorCode.AUDIO_INVALID, "WAV contained no frames")

    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
    if dtype is None:
        raise AudioError(
            SttErrorCode.AUDIO_INVALID, f"unsupported sample width: {width * 8}-bit"
        )

    raw = np.frombuffer(frames, dtype=dtype)
    if width == 1:
        # 8-bit WAV is unsigned, centred on 128; the others are signed.
        samples = (raw.astype(np.float32) - 128.0) / 128.0
    else:
        samples = raw.astype(np.float32) / float(np.iinfo(dtype).max + 1)

    if channels > 1:
        usable = (samples.size // channels) * channels
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)

    samples = np.ascontiguousarray(samples, dtype=np.float32)
    if rate != target_rate:
        samples = resample_to(samples, rate, target_rate)

    return DecodedAudio(samples=samples, sample_rate=target_rate)


def resample_to(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Linear resample.

    Linear interpolation and not a windowed sinc, on purpose. The input is
    already band-limited by the capture device, the content is speech well inside
    8 kHz, and Whisper's own front end is a 80-bin mel filterbank that discards
    far more detail than the interpolator loses. A polyphase filter here would
    add scipy.signal to the hot path to improve a number no downstream stage can
    see.
    """
    if source_rate == target_rate or samples.size == 0:
        return np.ascontiguousarray(samples, dtype=np.float32)

    duration = samples.size / float(source_rate)
    target_count = max(1, int(round(duration * target_rate)))
    source_positions = np.arange(samples.size, dtype=np.float64)
    target_positions = np.linspace(0.0, samples.size - 1, target_count, dtype=np.float64)
    resampled = np.interp(target_positions, source_positions, samples.astype(np.float64))
    return np.ascontiguousarray(resampled, dtype=np.float32)


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Mono float32 back to a 16-bit PCM WAV. Used by the tests and the CLI."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = np.round(clipped * (_INT16_FULL_SCALE - 1)).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()
