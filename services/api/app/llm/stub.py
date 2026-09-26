"""An offline gateway adapter, for tests and for rehearsing without spending.

The port exists so the agents can be exercised without a network, a key or a
budget. `ScriptedGateway` returns queued answers in order and records the requests
it was given, which is how the guardrail and budget tests assert on prompts and
on failure handling without touching the real gateway.

Its presence is also what makes the gateway seam real rather than hypothetical:
two adapters satisfy `LlmGateway`, so nothing above it can quietly depend on
provider specifics.
"""

from __future__ import annotations

from typing import Iterator, Sequence

from app.llm.port import ChatRequest, ChatResult, GatewayError, KeyInfo

__all__ = ["ScriptedGateway"]


class ScriptedGateway:
    """Returns prepared responses in order. Raises when the script runs out.

    A script entry may be a `str` (answer text), a `ChatResult` (full control) or
    an `Exception` instance (raised, to exercise retry and fallback paths).
    """

    def __init__(
        self,
        script: Sequence[str | ChatResult | Exception] = (),
        *,
        model: str = "scripted-model",
        key_info: KeyInfo | None = None,
        prompt_tokens: int = 1000,
        completion_tokens: int = 200,
    ) -> None:
        self._script = list(script)
        self._model = model
        self._key_info = key_info
        self._prompt_tokens = prompt_tokens
        self._completion_tokens = completion_tokens
        self.requests: list[ChatRequest] = []

    @property
    def model(self) -> str:
        return self._model

    @property
    def remaining(self) -> int:
        return len(self._script)

    def queue(self, *entries: str | ChatResult | Exception) -> None:
        self._script.extend(entries)

    def chat(self, request: ChatRequest) -> ChatResult:
        self.requests.append(request)
        if not self._script:
            raise GatewayError("ScriptedGateway: no more scripted responses")
        entry = self._script.pop(0)
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, ChatResult):
            return entry
        return ChatResult(
            text=entry,
            prompt_tokens=self._prompt_tokens,
            completion_tokens=self._completion_tokens,
            latency_ms=1,
            model=self._model,
            schema_mode="json_schema" if request.response_schema else "none",
        )

    def stream(self, request: ChatRequest) -> Iterator[str]:
        result = self.chat(request)
        for word in result.text.split(" "):
            yield word + " "

    def key_info(self) -> KeyInfo | None:
        return self._key_info
