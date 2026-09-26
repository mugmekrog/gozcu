"""What a finalised transcript is allowed to do.

    registry.py   the command contract, shared with the browser
    router.py     transcript -> one command, via the gateway

The split matters: the registry says what is possible and the router says what was
asked. Neither performs anything. Every command in the registry is a change to the
display, and the display is what performs it - this process has no view to switch
and no vehicle to pin.
"""

from app.voice.registry import VoiceRegistry, load_registry
from app.voice.router import RoutedCommand, RouteFailure, VoiceRouter

__all__ = ["VoiceRegistry", "load_registry", "VoiceRouter", "RoutedCommand", "RouteFailure"]
