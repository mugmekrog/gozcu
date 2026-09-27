"""A track's CSV order is its time order; sorting HH:MM hides midnight."""

from datetime import timedelta

from app.ingest.loaders import ValidationLog, _load_tracks
from goru_core.geo import Frame
from goru_core.provenance import DatasetVersion
from goru_core.timeline import Timeline


def test_track_rollover_and_nonfinite_coordinates(tmp_path, cfg):
    path = tmp_path / "tracks.csv"
    path.write_text(
        "track_id,time,lat,lon\n"
        "T1,23:55,39.9,32.8\n"
        "T1,00:00,39.9,32.8\n"
        "T1,00:05,nan,32.8\n",
        encoding="utf-8",
    )
    log = ValidationLog()
    tracks = _load_tracks(
        path, Frame.at(39.9, 32.8), Timeline.from_config(cfg),
        {}, cfg, DatasetVersion.of([path]), log,
    )
    assert [p.ts for p in tracks["T1"]] == sorted(p.ts for p in tracks["T1"])
    assert tracks["T1"][1].ts - tracks["T1"][0].ts == timedelta(minutes=5)
    assert any(issue.rule == "tracks.rollover" for issue in log.issues)
    assert any(issue.rule == "tracks.number_parse" for issue in log.issues)
