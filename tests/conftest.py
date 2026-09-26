"""Shared fixtures. The dataset is loaded once per session: it is the slow part."""

from __future__ import annotations

from pathlib import Path

import pytest

from goru_core.config import Config, load_config
from app.evidence.bundle import ImageAnalysis
from app.ingest.loaders import Dataset, load_dataset
from app.pipeline import Pipeline

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def cfg() -> Config:
    return load_config(ROOT / "goru.yaml")


@pytest.fixture(scope="session")
def dataset(cfg: Config) -> Dataset:
    return load_dataset(cfg)


@pytest.fixture(scope="session")
def pipeline(dataset: Dataset, cfg: Config) -> Pipeline:
    return Pipeline(dataset, cfg)


@pytest.fixture(scope="session")
def analyses(pipeline: Pipeline) -> list[ImageAnalysis]:
    return pipeline.analyse_all()


@pytest.fixture
def offline_cfg(cfg: Config, tmp_path: Path) -> Config:
    """A config whose cache, ledger and run log live in a temporary directory.

    Tests must never touch the real budget ledger or the real response cache, and
    must never reach the gateway.
    """
    agents = cfg.agents.model_copy(
        update={
            "cache_dir": str(tmp_path / "cache"),
            "budget_file": str(tmp_path / "budget.json"),
            "runs_file": str(tmp_path / "runs.jsonl"),
        }
    )
    return cfg.model_copy(update={"agents": agents})
