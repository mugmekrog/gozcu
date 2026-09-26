"""Provenance: file hashes and record references (PLAN.md 5.1, 7.4.2).

Design principle 5 of the plan is that every number has provenance. That is
enforced structurally: loaders mint a `SourceRef` for each record they produce,
and the `DatasetVersion` - the set of file hashes - is what "which data was this
decision made on" resolves to.

A tampered source file therefore changes the dataset version, and any decision
carrying the old version is visibly stale.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping

__all__ = ["SourceRef", "DatasetVersion", "file_sha256", "payload_sha256"]

_CHUNK = 1 << 20


def file_sha256(path: str | Path) -> str:
    """Streaming SHA-256 of a file; never loads the whole file into memory."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def payload_sha256(payload: object) -> str:
    """SHA-256 over a canonical JSON rendering; used for audit and cache keys."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class SourceRef:
    """Where one record came from: which file, which row or key."""

    file_name: str
    file_sha256: str
    record_key: str

    def as_dict(self) -> dict[str, str]:
        return {
            "file_name": self.file_name,
            "file_sha256": self.file_sha256,
            "record_key": self.record_key,
        }

    def short(self) -> str:
        return f"{self.file_name}#{self.record_key}@{self.file_sha256[:8]}"


@dataclass(frozen=True)
class DatasetVersion:
    """The set of source file hashes that together identify a dataset.

    `version_id` is a hash over that set, so two imports of identical files
    produce the same id and re-import is idempotent (B1.3).
    """

    files: Mapping[str, str]

    @classmethod
    def of(cls, paths: Iterable[str | Path]) -> "DatasetVersion":
        return cls(files={Path(p).name: file_sha256(p) for p in sorted(paths, key=str)})

    @property
    def version_id(self) -> str:
        return payload_sha256(dict(sorted(self.files.items())))[:16]

    def ref(self, file_name: str, record_key: str | int) -> SourceRef:
        """Mint a `SourceRef` for one record of one of these files."""
        try:
            digest = self.files[file_name]
        except KeyError as exc:
            raise KeyError(f"{file_name} is not part of this dataset version") from exc
        return SourceRef(file_name=file_name, file_sha256=digest, record_key=str(record_key))

    def as_dict(self) -> dict[str, object]:
        return {"version_id": self.version_id, "files": dict(sorted(self.files.items()))}
