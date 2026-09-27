#!/usr/bin/env python3
"""Per-trajectory distance / speed / acceleration distributions -> one JSON per track.

    python traj_json.py              # all tracks -> out/T0001.json ...
    python traj_json.py T0098        # print one to stdout
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

CSV = Path(__file__).resolve().parent.parent / "stage2" / "tracks.csv"
OUT = Path(__file__).resolve().parent / "out"
R_EARTH = 6_371_008.8
STEP_S = 300.0          # samples are 5 minutes apart
BINS = 10


def load() -> pl.DataFrame:
    """Step distance, speed and acceleration for every sample of every track."""
    prev_lat = pl.col("lat").shift(1).over("track_id")
    prev_lon = pl.col("lon").shift(1).over("track_id")
    a = (((pl.col("lat") - prev_lat).radians() / 2).sin() ** 2
         + prev_lat.radians().cos() * pl.col("lat").radians().cos()
         * (((pl.col("lon") - prev_lon).radians() / 2).sin() ** 2))

    return (
        pl.read_csv(CSV)
        .sort("track_id", "time")
        .with_columns((2 * R_EARTH * a.sqrt().arcsin()).alias("distance_m"))
        .with_columns((pl.col("distance_m") / STEP_S).alias("speed_ms"))
        .with_columns(((pl.col("speed_ms") - pl.col("speed_ms").shift(1).over("track_id"))
                       / STEP_S).alias("acceleration_ms2"))
    )


def block(values: list, times: list[str]) -> dict:
    """One quantity: its series, summary statistics and a histogram."""
    v = np.asarray(values, dtype=float)
    counts, edges = np.histogram(v, bins=BINS)
    return {
        "times": times,
        "values": [round(x, 4) for x in v],
        "stats": {
            "count": int(v.size),
            "min": round(float(v.min()), 4),
            "max": round(float(v.max()), 4),
            "mean": round(float(v.mean()), 4),
            "std": round(float(v.std()), 4),
            **{f"p{p}": round(float(np.percentile(v, p)), 4)
               for p in (25, 50, 75, 95)},
        },
        "histogram": {
            "bin_edges": [round(float(e), 4) for e in edges],
            "counts": [int(c) for c in counts],
        },
    }


def trajectory(g: pl.DataFrame) -> dict:
    """g is one track, sorted by time. Leading samples with no value are dropped."""
    t = g["time"].to_list()
    return {
        "track_id": g["track_id"][0],
        "n_points": len(g),
        "start": t[0],
        "end": t[-1],
        "sample_interval_s": STEP_S,
        "total_distance_m": round(float(g["distance_m"].sum()), 2),
        # the first sample has no step, the first two have no acceleration
        "distance_m": block(g["distance_m"].to_list()[1:], t[1:]),
        "speed_ms": block(g["speed_ms"].to_list()[1:], t[1:]),
        "acceleration_ms2": block(g["acceleration_ms2"].to_list()[2:], t[2:]),
    }


def main():
    pts = load()

    if len(sys.argv) > 1:
        tid = sys.argv[1]
        g = pts.filter(pl.col("track_id") == tid)
        if not len(g):
            sys.exit(f"no such track: {tid}")
        print(json.dumps(trajectory(g), indent=2))
        return

    OUT.mkdir(exist_ok=True)
    n = 0
    for (tid,), g in pts.group_by(["track_id"], maintain_order=True):
        (OUT / f"{tid}.json").write_text(
            json.dumps(trajectory(g), indent=2) + "\n", encoding="utf-8")
        n += 1
    kb = sum(p.stat().st_size for p in OUT.glob("*.json")) / 1024
    print(f"{n} trajectories -> {OUT}  ({kb:.0f} KB, {kb/n:.1f} KB each)")


if __name__ == "__main__":
    main()
