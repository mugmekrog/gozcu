"""The resident model (stt.md phase 1).

One job: hand back a loaded `WhisperModel`, and make sure it was loaded exactly
once. stt.md is emphatic about this and it is the difference between a usable
system and an unusable one - large-v3 takes seconds to load and 1.6-3.1 GB of
VRAM to hold, so loading it per utterance would cost more than the transcription.

The other job is refusing intelligibly. `resolve_placement` picks a device and a
compute type against what CTranslate2 actually reports on this machine rather than
against what the plan assumed, because the two differ here: stt.md is written for
a 12 GB RTX 4070 and this box has a 6 GB RTX 2060. A configuration that cannot
work is reported as a `MODEL_UNAVAILABLE` or `CUDA_UNAVAILABLE` at startup, where
someone can act on it, instead of as an out-of-memory error mid-demo.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from goru_core.config import SttConfig

from app.stt.schemas import SttErrorCode

__all__ = [
    "ModelHandle",
    "ModelLoadError",
    "Placement",
    "resolve_placement",
    "load_model",
    "reset_model_cache",
    "vram_used_mb",
    "total_vram_mb",
]

# Measured from the published weights: model.bin is 3.09 GB of float16. int8
# quantises the weights to roughly half that. Peak usage adds activations for one
# 30 s window on top of whichever figure applies.
_VRAM_NEED_MB = {
    "float32": 7000.0,
    "float16": 4700.0,
    "int8_float16": 3000.0,
    "int8_float32": 3400.0,
    "int8": 3000.0,
}

_QUANTISED_FIRST = ("int8_float16", "float16", "int8_float32", "int8", "float32")


class ModelLoadError(RuntimeError):
    """The model could not be loaded, with the code the display should show."""

    def __init__(self, code: SttErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Placement:
    """Where the model will run and in what precision, and why."""

    device: str
    compute_type: str
    note: str = ""


@dataclass
class ModelHandle:
    """A loaded model plus what loading it cost."""

    model: Any
    placement: Placement
    load_ms: int
    vram_after_mb: Optional[float] = None


def _cuda_device_count() -> int:
    try:
        import ctranslate2
    except ImportError:
        return 0
    try:
        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def _supported_compute_types(device: str) -> set[str]:
    try:
        import ctranslate2
    except ImportError:
        return set()
    try:
        return set(ctranslate2.get_supported_compute_types(device))
    except Exception:
        return set()


def _query_gpu(field: str) -> Optional[float]:
    """One nvidia-smi scalar for device 0, or None when it cannot be read.

    Read out of process because CTranslate2 exposes no allocator statistics, and
    a number the operator can cross-check against Task Manager is worth more than
    an estimate we computed ourselves.
    """
    binary = shutil.which("nvidia-smi")
    if not binary:
        return None
    try:
        completed = subprocess.run(
            [binary, f"--query-gpu={field}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    lines = [line for line in completed.stdout.strip().splitlines() if line.strip()]
    if not lines:
        return None
    try:
        return float(lines[0].strip())
    except ValueError:
        return None


def vram_used_mb() -> Optional[float]:
    """Used VRAM on device 0, in MiB."""
    return _query_gpu("memory.used")


def total_vram_mb() -> Optional[float]:
    """Total VRAM on device 0, in MiB. Used for the headroom check."""
    return _query_gpu("memory.total")


def resolve_placement(cfg: SttConfig) -> Placement:
    """Decide device and precision against this machine, not against the plan.

    `device: auto` prefers CUDA and falls back to CPU with a note rather than
    failing, because a CPU transcription of a five-second command is slow but not
    useless, and a demo that degrades beats a demo that stops.
    """
    cuda_count = _cuda_device_count()

    if cfg.device == "cuda" and cuda_count == 0:
        raise ModelLoadError(
            SttErrorCode.CUDA_UNAVAILABLE,
            "stt.device is 'cuda' but CTranslate2 reports no CUDA device. Either the "
            "driver or the CUDA/cuDNN runtime is missing; set stt.device: cpu to run "
            "without the GPU.",
        )

    device = "cuda" if (cfg.device in {"auto", "cuda"} and cuda_count > 0) else "cpu"
    supported = _supported_compute_types(device)
    notes: list[str] = []

    if device == "cpu" and cfg.device == "auto":
        notes.append("no CUDA device found; running on CPU, which is several times slower")

    compute = cfg.compute_type
    if compute == "auto":
        compute = next((c for c in _QUANTISED_FIRST if c in supported), "float32")
        notes.append(f"compute_type auto-selected {compute}")

    if supported and compute not in supported:
        fallback = next((c for c in _QUANTISED_FIRST if c in supported), "float32")
        notes.append(
            f"{compute} is not supported by this {device} build; using {fallback} instead"
        )
        compute = fallback

    if device == "cuda":
        total = total_vram_mb()
        needed = _VRAM_NEED_MB.get(compute)
        if total is not None and needed is not None and needed > total:
            cheaper = next(
                (c for c in ("int8_float16", "int8") if c in supported), compute
            )
            if cheaper != compute:
                notes.append(
                    f"{compute} needs about {needed:.0f} MB and this GPU has "
                    f"{total:.0f} MB; using {cheaper}"
                )
                compute = cheaper

    return Placement(device=device, compute_type=compute, note="; ".join(notes))


def _classify_load_failure(exc: Exception, placement: Placement) -> ModelLoadError:
    """Turn a loader exception into a code the operator can act on."""
    message = str(exc)
    lowered = message.lower()
    if "out of memory" in lowered or "cuda_error_out_of_memory" in lowered:
        return ModelLoadError(
            SttErrorCode.GPU_OUT_OF_MEMORY,
            f"the GPU could not fit the model at {placement.compute_type}. Set "
            f"stt.compute_type: int8_float16, or close other GPU applications. ({message})",
        )
    if "cudnn" in lowered or "cublas" in lowered or "libcu" in lowered:
        return ModelLoadError(
            SttErrorCode.CUDA_UNAVAILABLE,
            f"the CUDA runtime libraries could not be loaded: {message}",
        )
    if any(s in lowered for s in ("not a local folder", "repository not found", "404")):
        return ModelLoadError(
            SttErrorCode.MODEL_UNAVAILABLE,
            f"the model could not be fetched. With the network off it must already be in "
            f"the Hugging Face cache. ({message})",
        )
    return ModelLoadError(SttErrorCode.MODEL_UNAVAILABLE, message)


class _Loader:
    """Loads the model once, under a lock, and keeps it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._handle: Optional[ModelHandle] = None
        self._key: Optional[tuple[str, str, str]] = None

    def get(self, cfg: SttConfig) -> ModelHandle:
        key = (cfg.model, cfg.device, cfg.compute_type)
        with self._lock:
            if self._handle is not None and self._key == key:
                return self._handle
            handle = self._load(cfg)
            self._handle = handle
            self._key = key
            return handle

    def _load(self, cfg: SttConfig) -> ModelHandle:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise ModelLoadError(
                SttErrorCode.MODEL_UNAVAILABLE,
                "faster-whisper is not installed. Install the speech extra: "
                "pip install -r requirements-stt.txt",
            ) from exc

        placement = resolve_placement(cfg)
        before = vram_used_mb() if placement.device == "cuda" else None
        started = time.perf_counter()
        try:
            model = WhisperModel(
                cfg.model,
                device=placement.device,
                compute_type=placement.compute_type,
            )
        except Exception as exc:  # the loader raises library-specific types
            raise _classify_load_failure(exc, placement) from exc
        load_ms = int((time.perf_counter() - started) * 1000)

        after = vram_used_mb() if placement.device == "cuda" else None
        used: Optional[float] = None
        if after is not None:
            used = after - before if before is not None else after

        return ModelHandle(model=model, placement=placement, load_ms=load_ms, vram_after_mb=used)

    def reset(self) -> None:
        with self._lock:
            self._handle = None
            self._key = None


_LOADER = _Loader()


def load_model(cfg: SttConfig) -> ModelHandle:
    """The resident model for this config. Loads on first call only."""
    return _LOADER.get(cfg)


def reset_model_cache() -> None:
    """Forget the resident model. For the tests and an explicit reload."""
    _LOADER.reset()
