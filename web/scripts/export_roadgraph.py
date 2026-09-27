"""Bake the OSM routing graph: nodes, edges and their connectivity.

The basemap (`export_basemap.py`) bakes road *geometry* -- simplified, delta
encoded, drawn and forgotten. That is enough to snap a fix to the nearest road
and no more: it has no node identity, so it cannot say whether two roads meet.

Map matching needs the connectivity. Newson & Krumm's transition term compares
the distance a vehicle would have had to *drive* between two candidates against
the straight-line distance between the two fixes, and the driving distance needs
a graph to route on. Without one the matcher falls back to straight-line
distance, which cannot tell a pair of candidates separated by a motorway from a
pair on the same street.

So this fetches the same roads again, with node references this time, and bakes
the graph the matcher routes on:

    nodes   [e, n]                     ENU metres, indexed by position
    edges   [u, v, way, length_m]      u/v index into nodes
    ways    [name|null, class, oneway] indexed by `way`

Nothing here is simplified: a node dropped for being visually redundant is a
junction lost, and a lost junction is a route the matcher cannot find.

    venv/bin/python web/scripts/export_roadgraph.py            # fetch (cached) + bake
    venv/bin/python web/scripts/export_roadgraph.py --refresh  # re-download

Output: data/processed/roadgraph.json. The engine reads it when it is there and
falls back to geometry-only matching when it is not, so a deployment without it
still works -- just less well (app/roads/mapmatch.py).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO_ROOT / "libs"), str(REPO_ROOT / "web" / "scripts")]

from goru_core.geo import Frame  # noqa: E402

from export_basemap import (  # noqa: E402
    CACHE_DIR,
    MARGIN_M,
    MIRRORS,
    crop_of,
    operation_area,
)

OUT_FILE = REPO_ROOT / "data" / "processed" / "roadgraph.json"

#: Ways a vehicle can drive on. Narrower than the basemap's list, which carries
#: footways and steps for drawing: routing a car down a staircase is worse than
#: not routing it at all.
DRIVABLE = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|service|motorway_link|trunk_link|primary_link|secondary_link|"
    "tertiary_link"
)


def query(crop: dict[str, float]) -> str:
    bbox = f"{crop['s']:.5f},{crop['w']:.5f},{crop['n']:.5f},{crop['e']:.5f}"
    # `out body` gives each way its node refs; `>` then `out skel qt` gives those
    # nodes their coordinates. That pairing is what carries the topology.
    return (
        f"[out:json][timeout:180][bbox:{bbox}];"
        f'way["highway"~"^({DRIVABLE})$"];'
        "out body;>;out skel qt;"
    )


def fetch(text: str, refresh: bool) -> dict[str, Any]:
    cache = CACHE_DIR / "roadgraph.json"
    if cache.exists() and not refresh:
        print(f"  using cached {cache.relative_to(REPO_ROOT)}")
        return json.loads(cache.read_text(encoding="utf-8"))

    body = urllib.parse.urlencode({"data": text}).encode()
    last_error: Exception | None = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                print(f"  fetching graph from {url.split('/')[2]} ...", flush=True)
                request = urllib.request.Request(
                    url, data=body, headers={"User-Agent": "goru-hackathon-roadgraph/1.0"}
                )
                with urllib.request.urlopen(request, timeout=300) as response:
                    raw = response.read()
                data = json.loads(raw)
                if "elements" not in data:
                    raise ValueError(f"no elements in response: {raw[:200]!r}")
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(raw)
                return data
            except Exception as error:  # noqa: BLE001 -- any mirror failure: try the next
                last_error = error
                print(f"    failed ({error.__class__.__name__}: {str(error)[:140]})")
                time.sleep(3 * (attempt + 1))
    raise SystemExit(f"Every Overpass mirror failed: {last_error}")


def build(payload: dict[str, Any], frame: Frame) -> dict[str, Any]:
    """Elements to graph, keeping only nodes a drivable way actually uses."""
    coords: dict[int, tuple[float, float]] = {}
    ways: list[dict[str, Any]] = []

    for element in payload["elements"]:
        if element["type"] == "node":
            coords[element["id"]] = frame.to_enu(element["lat"], element["lon"])
        elif element["type"] == "way" and element.get("nodes"):
            tags = element.get("tags", {})
            oneway = tags.get("oneway", "no")
            ways.append(
                {
                    "nodes": element["nodes"],
                    "name": tags.get("name"),
                    "class": tags.get("highway", "unclassified"),
                    # -1 means the way is drivable against its drawn direction.
                    "oneway": -1 if oneway == "-1" else 1 if oneway in ("yes", "true", "1") else 0,
                }
            )

    used: dict[int, int] = {}
    nodes: list[tuple[float, float]] = []

    def index_of(osm_id: int) -> int | None:
        if osm_id not in coords:
            return None
        if osm_id not in used:
            used[osm_id] = len(nodes)
            nodes.append(coords[osm_id])
        return used[osm_id]

    edges: list[list[Any]] = []
    way_rows: list[list[Any]] = []
    for way in ways:
        way_index = len(way_rows)
        way_rows.append([way["name"], way["class"], way["oneway"]])
        chain = [index_of(n) for n in way["nodes"]]
        for a, b in zip(chain, chain[1:]):
            if a is None or b is None or a == b:
                continue
            (ax, ay), (bx, by) = nodes[a], nodes[b]
            edges.append([a, b, way_index, round(math.hypot(bx - ax, by - ay), 1)])

    return {
        "version": 1,
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL 1.0 (https://opendatacommons.org/licenses/odbl/)",
        "origin": {"lat": frame.origin_lat, "lon": frame.origin_lon},
        "nodes": [[round(e, 1), round(n, 1)] for e, n in nodes],
        "edges": edges,
        "ways": way_rows,
    }


def report(graph: dict[str, Any]) -> None:
    degree: dict[int, int] = defaultdict(int)
    for u, v, _way, _length in graph["edges"]:
        degree[u] += 1
        degree[v] += 1
    junctions = sum(1 for d in degree.values() if d > 2)
    total_km = sum(e[3] for e in graph["edges"]) / 1000
    print(f"  nodes     {len(graph['nodes']):,}")
    print(f"  edges     {len(graph['edges']):,}  ({total_km:,.0f} km of road)")
    print(f"  ways      {len(graph['ways']):,}")
    print(f"  junctions {junctions:,}  (nodes where three or more edges meet)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-download from Overpass")
    args = parser.parse_args()

    area = operation_area()
    crop = crop_of(area["overall"], MARGIN_M)
    frame = Frame.at(area["base"]["lat"], area["base"]["lon"])

    payload = fetch(query(crop), args.refresh)
    graph = build(payload, frame)
    report(graph)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(graph, separators=(",", ":")), encoding="utf-8")
    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"  -> {OUT_FILE.relative_to(REPO_ROOT)}  ({size_kb:,.0f} KB)")


if __name__ == "__main__":
    main()
