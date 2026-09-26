"""Local Turkish speech-to-text (stt.md).

The package is split the way stt.md asks for, and for the reason it gives: the
microphone, the model and the transcript's meaning are three different concerns
and coupling them is what makes a speech pipeline impossible to test.

    audio.py        bytes on the wire -> 16 kHz mono float32, or a refusal
    schemas.py      the contracts that cross the seam
    model.py        the resident model. Loaded once, never per request.
    provider.py     the Phase 7 seam: SttProvider, and two adapters
    transcripts.py  the Phase 5 transcript manager and the domain normaliser
    service.py      the Phase 4 service: one queue, one worker, the metrics

Nothing here imports FastAPI, React or the agent layer. The service returns a
`Transcript`; deciding what a transcript *means* is `app.voice`'s job, and
deciding what to *do* about it is the display's.
"""

from app.stt.schemas import SttStatus, Transcript, TranscriptRejected, Utterance
from app.stt.provider import SttProvider

__all__ = ["SttStatus", "Transcript", "TranscriptRejected", "Utterance", "SttProvider"]
