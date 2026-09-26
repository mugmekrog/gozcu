"""HTTP surfaces.

Two services live here and they are deliberately separate.

`rest.py` is the FastAPI REST API that serves the whole display.

`stt_server.py` is the speech service: loopback, two endpoints, its own port. It
holds a microphone stream and a resident Whisper model, which is why it is not
folded into the REST API - a speech service that must not listen on a LAN
interface and an API that must do so have no business sharing a bind address.
"""
