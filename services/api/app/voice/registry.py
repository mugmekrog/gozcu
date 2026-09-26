"""The voice command registry.

`contracts/voice_commands.json` is the authority for what speech may do. This
module reads it, validates it, and turns it into the two things the rest of the
system needs: the tool schemas the router offers the model, and the confirm policy
the display enforces.

**Why a file and not a Python dict.** The browser has to execute these commands and
the router has to name them, and those are two different languages. A registry
written twice drifts, and the failure mode is silent: the model happily emits a
command nothing performs, and the operator watches a transcript scroll past with
no action. So the names live in a JSON file that both sides read, and each side has
a test asserting its own half covers exactly the names in it. A command added to
the file fails on whichever side forgot it.

**On admin level.** Every command in the file is reachable by speech, including
`record_decision`, which writes an operator decision into the record. That is a
team decision, taken against the recommendation in this module's own log entry
(S6). What survives of the objection is `requires_confirmation`: an audit-writing
command comes back marked, the display asks, and only a spoken yes performs it.
`voice.confirm_audit_commands: false` removes even that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from goru_core.config import Config, VoiceConfig

__all__ = [
    "VoiceCommandSpec",
    "VoiceRegistry",
    "RegistryError",
    "load_registry",
]

_EFFECTS = frozenset({"view", "compute", "audit"})
_ARG_TYPES = frozenset({"string", "integer", "number", "boolean"})


class RegistryError(ValueError):
    """The registry file is missing, malformed, or disagrees with itself."""


@dataclass(frozen=True)
class VoiceCommandSpec:
    """One command speech may invoke."""

    name: str
    effect: str
    confirm: bool
    summary: str
    args: Mapping[str, Mapping[str, Any]]
    utterances: tuple[str, ...]

    @property
    def writes_audit(self) -> bool:
        return self.effect == "audit"

    def json_schema(self) -> dict[str, Any]:
        """This command's arguments as a JSON schema for the gateway."""
        properties: dict[str, Any] = {}
        required: list[str] = []
        for arg_name, spec in self.args.items():
            prop: dict[str, Any] = {"type": spec["type"]}
            if "enum" in spec:
                prop["enum"] = list(spec["enum"])
            if "pattern" in spec:
                prop["pattern"] = spec["pattern"]
            prop["description"] = spec.get("description", arg_name)
            properties[arg_name] = prop
            if spec.get("required"):
                required.append(arg_name)
        return {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        }

    def tool_schema(self) -> dict[str, Any]:
        """OpenAI-style tool definition, the shape `LlmGateway` already takes."""
        examples = " / ".join(self.utterances[:3])
        description = self.summary
        if examples:
            description = f"{description} Örnek: {examples}"
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": description,
                "parameters": self.json_schema(),
            },
        }

    def validate_args(self, values: Mapping[str, Any]) -> dict[str, Any]:
        """Keep the arguments this command declares, drop and report the rest.

        Dropping rather than failing, deliberately. A model that adds a plausible
        extra field should still get its command executed; a model that omits a
        required one should not, because that is the case where executing it would
        do something other than what was asked.
        """
        cleaned: dict[str, Any] = {}
        for arg_name, spec in self.args.items():
            if arg_name not in values or values[arg_name] is None:
                continue
            raw = values[arg_name]
            declared = spec["type"]

            if declared == "boolean":
                # A gateway may send a real JSON boolean or the string "true";
                # both mean the same thing and neither may reach the browser as
                # the string "True", which is truthy in JavaScript either way.
                value = (
                    raw
                    if isinstance(raw, bool)
                    else str(raw).strip().casefold() in {"true", "1", "yes", "evet"}
                )
            elif declared in {"integer", "number"}:
                try:
                    value = int(raw) if declared == "integer" else float(raw)
                except (TypeError, ValueError):
                    continue
            else:
                value = str(raw).strip()
                if not value:
                    continue
            if "enum" in spec and value not in spec["enum"]:
                continue
            cleaned[arg_name] = value

        missing = [
            arg_name
            for arg_name, spec in self.args.items()
            if spec.get("required") and arg_name not in cleaned
        ]
        if missing:
            raise RegistryError(
                f"{self.name} needs {', '.join(missing)} and the router did not supply it"
            )
        return cleaned


@dataclass(frozen=True)
class VoiceRegistry:
    """Every command speech may invoke, and the policy around them."""

    commands: tuple[VoiceCommandSpec, ...]
    version: str
    source: Path

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(command.name for command in self.commands)

    def get(self, name: str) -> Optional[VoiceCommandSpec]:
        return next((c for c in self.commands if c.name == name), None)

    def tool_schemas(self) -> list[dict[str, Any]]:
        return [command.tool_schema() for command in self.commands]

    def requires_confirmation(self, name: str, voice: VoiceConfig) -> bool:
        """Whether the display must ask before performing this command.

        The command's own `confirm` flag is the floor; `confirm_audit_commands`
        can only lower it, and only for the audit-writing commands, because those
        are the ones the flag was written for.
        """
        command = self.get(name)
        if command is None:
            return False
        if command.writes_audit:
            return voice.confirm_audit_commands
        return command.confirm

    def describe_for_prompt(self) -> str:
        """The command list as the router's prompt shows it.

        Built from the registry rather than written into the prompt by hand, so a
        command added to the contract is one the model is told about in the same
        commit.
        """
        lines: list[str] = []
        for command in self.commands:
            args = ", ".join(
                f"{n}{'' if s.get('required') else '?'}:{s['type']}"
                + (f"[{'|'.join(str(v) for v in s['enum'])}]" if "enum" in s else "")
                for n, s in command.args.items()
            )
            lines.append(f"- {command.name}({args}) — {command.summary}")
            if command.utterances:
                lines.append(f"    örnek: {'; '.join(command.utterances)}")
        return "\n".join(lines)


def _parse(payload: Any, source: Path) -> VoiceRegistry:
    if not isinstance(payload, dict):
        raise RegistryError(f"{source.name} must contain a JSON object")
    raw_commands = payload.get("commands")
    if not isinstance(raw_commands, list) or not raw_commands:
        raise RegistryError(f"{source.name} must declare a non-empty 'commands' list")

    commands: list[VoiceCommandSpec] = []
    seen: set[str] = set()
    for entry in raw_commands:
        if not isinstance(entry, dict):
            raise RegistryError(f"{source.name}: every command must be an object")
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise RegistryError(f"{source.name}: a command is missing its name")
        if name in seen:
            raise RegistryError(f"{source.name}: {name} is declared twice")
        seen.add(name)

        effect = entry.get("effect")
        if effect not in _EFFECTS:
            raise RegistryError(
                f"{source.name}: {name} has effect {effect!r}; expected one of "
                f"{', '.join(sorted(_EFFECTS))}"
            )

        args = entry.get("args") or {}
        if not isinstance(args, dict):
            raise RegistryError(f"{source.name}: {name}.args must be an object")
        for arg_name, spec in args.items():
            if not isinstance(spec, dict) or spec.get("type") not in _ARG_TYPES:
                raise RegistryError(
                    f"{source.name}: {name}.{arg_name} needs a type in "
                    f"{', '.join(sorted(_ARG_TYPES))}"
                )

        commands.append(
            VoiceCommandSpec(
                name=name,
                effect=effect,
                confirm=bool(entry.get("confirm", False)),
                summary=str(entry.get("summary", "")),
                args=args,
                utterances=tuple(entry.get("utterances", ())),
            )
        )

    # The fall-through has to exist: an utterance that is not a command still has
    # to go somewhere, and an operator who asked a question deserves an answer
    # rather than "anlayamadim".
    if not any(c.name == "ask_copilot" for c in commands):
        raise RegistryError(
            f"{source.name} must declare ask_copilot: it is where an utterance that "
            f"matches no command falls through to"
        )

    return VoiceRegistry(
        commands=tuple(commands),
        version=str(payload.get("version", "0")),
        source=source,
    )


@lru_cache(maxsize=4)
def _load_cached(path: str, mtime: float) -> VoiceRegistry:
    source = Path(path)
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RegistryError(
            f"the voice command registry is missing: {source}. It is part of the "
            f"repository, not generated."
        ) from exc
    except json.JSONDecodeError as exc:
        raise RegistryError(f"{source.name} is not valid JSON: {exc}") from exc
    return _parse(payload, source)


def load_registry(cfg: Config) -> VoiceRegistry:
    """The registry this config points at. Cached on the file's timestamp."""
    path = cfg.resolve(cfg.voice.registry_file)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return _load_cached(str(path), mtime)
