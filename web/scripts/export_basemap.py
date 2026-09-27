"""Bake the basemap: OpenStreetMap features over the exercise area, in the ENU frame.

The radar used to be drawn on a blank ground with eight painted "approach roads"
that did not exist. This script replaces that ground with the real city: roads,
parks, water, rail, district and street names, stations -- fetched once from
OpenStreetMap over the Overpass API and baked into one compact file the web app
ships in `public/`, so the demo still runs with the network off (PLAN F4.3).

Why OSM and not Google: Google Maps needs a billed API key and a live network
at the venue, and downloading its tiles into our own renderer is against its
terms. OSM is ODbL -- free to bake and redraw, with attribution, which the map
carries in its corner.

The crop is the operation area -- the bounding box of every track fix
(`tracks.csv`), every image corner (`image_meta.json`) and every zone centre
(`zones.json`) -- plus a margin, so the map does not end exactly where the data
does.

Every coordinate goes through `goru_core.geo.Frame`, the same transform the
engine uses for tracks and detections, so a road and a vehicle on it land on the
same metre. Output geometry is integer ENU metres, simplified (Douglas-Peucker,
lossless at the closest zoom), clipped to the crop and delta-encoded.

    .venv/Scripts/python web/scripts/export_basemap.py          # fetch (cached) + bake
    .venv/Scripts/python web/scripts/export_basemap.py --refresh   # re-download from Overpass

Output shape (`web/public/basemap/ankara.json`), arrays rather than objects to
keep it small:

    roads     [class, name|null, tunnel 0|1, coords]
    lines     [kind, name|null, coords]                 rail, water, cable car
    areas     [kind, name|null, ring, ring, ...]        even-odd fill
    places    [kind, name, e, n]                        district / quarter labels
    stations  [kind, name, e, n]
    pois      [kind, name, e, n]

`coords` / `ring` is [e0, n0, de1, dn1, ...] -- first point absolute, the rest
deltas, in whole metres from the base.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(REPO_ROOT / "libs")]

from goru_core.geo import Frame, m_per_deg  # noqa: E402

STAGE2 = REPO_ROOT / "stage2"
CACHE_DIR = REPO_ROOT / "data" / "processed" / "osm"
OUT_FILE = REPO_ROOT / "web" / "public" / "basemap" / "ankara.json"

#: The map runs this far past the operation area, so its edge is not the data's.
MARGIN_M = 1200.0

#: Tried in order. The main instance is often saturated; the mirrors carry the same data.
MIRRORS = (
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

#: Douglas-Peucker tolerances in metres. At the closest zoom (1 km radius) one
#: metre is about a third of a screen pixel, so 2 m is invisible.
SIMPLIFY_ROAD_M = 2.0
SIMPLIFY_AREA_M = 3.0

#: Smallest area kept, in square metres. Pocket parks below this are noise.
MIN_AREA_M2 = 400.0
#: A named area this large also gets a label (Genclik Parki, a campus, ...).
LABEL_AREA_M2 = 40_000.0

ROAD_CLASS = {
    "motorway": "highway",
    "trunk": "highway",
    "motorway_link": "primary",
    "trunk_link": "primary",
    "primary": "primary",
    "primary_link": "secondary",
    "secondary": "secondary",
    "secondary_link": "tertiary",
    "tertiary": "tertiary",
    "tertiary_link": "minor",
    "residential": "minor",
    "unclassified": "minor",
    "living_street": "minor",
    "pedestrian": "path",
}


# --------------------------------------------------------------------------- #
# The operation area
# --------------------------------------------------------------------------- #


def operation_area() -> dict[str, Any]:
    """Bounding box of every position in the dataset, per source and overall."""
    lats: dict[str, list[float]] = defaultdict(list)
    lons: dict[str, list[float]] = defaultdict(list)

    with (STAGE2 / "tracks.csv").open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            lats["tracks"].append(float(row["lat"]))
            lons["tracks"].append(float(row["lon"]))

    meta = json.loads((STAGE2 / "image_meta.json").read_text(encoding="utf-8"))
    for entry in meta.values():
        for lat, lon in entry["corner_coordinates"].values():
            lats["images"].append(lat)
            lons["images"].append(lon)

    zones = json.loads((STAGE2 / "zones.json").read_text(encoding="utf-8"))
    for zone in zones["zones"]:
        lats["zones"].append(zone["center"][0])
        lons["zones"].append(zone["center"][1])
    lats["zones"].append(zones["base"]["lat"])
    lons["zones"].append(zones["base"]["lon"])

    def box(la: Iterable[float], lo: Iterable[float]) -> dict[str, float]:
        la, lo = list(la), list(lo)
        return {"s": min(la), "n": max(la), "w": min(lo), "e": max(lo)}

    every_lat = [v for vs in lats.values() for v in vs]
    every_lon = [v for vs in lons.values() for v in vs]
    return {
        "base": {"lat": zones["base"]["lat"], "lon": zones["base"]["lon"]},
        "by_source": {k: box(lats[k], lons[k]) for k in lats},
        "overall": box(every_lat, every_lon),
    }


def crop_of(overall: dict[str, float], margin_m: float) -> dict[str, float]:
    m_lat, m_lon = m_per_deg((overall["s"] + overall["n"]) / 2)
    return {
        "s": overall["s"] - margin_m / m_lat,
        "n": overall["n"] + margin_m / m_lat,
        "w": overall["w"] - margin_m / m_lon,
        "e": overall["e"] + margin_m / m_lon,
    }


# --------------------------------------------------------------------------- #
# Overpass
# --------------------------------------------------------------------------- #


def queries(crop: dict[str, float]) -> dict[str, str]:
    bbox = f"{crop['s']:.5f},{crop['w']:.5f},{crop['n']:.5f},{crop['e']:.5f}"
    head = f"[out:json][timeout:180][bbox:{bbox}];"
    return {
        "roads": head
        + 'way["highway"~"^(' + "|".join(ROAD_CLASS) + ')$"];out tags geom;',
        "features": head
        + "("
        + 'way["leisure"~"^(park|garden|golf_course|nature_reserve|stadium)$"];'
        + 'relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"];'
        + 'way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|cemetery|'
        + 'commercial|retail|farmland|orchard|allotments)$"];'
        + 'relation["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery|commercial|'
        + 'retail|farmland)$"];'
        + 'way["natural"~"^(wood|scrub|grassland|water)$"];'
        + 'relation["natural"~"^(wood|scrub|grassland|water)$"];'
        + 'way["amenity"~"^(university|college|hospital|grave_yard)$"];'
        + 'relation["amenity"~"^(university|college|hospital)$"];'
        + 'way["waterway"~"^(river|canal|stream)$"];'
        + 'way["railway"~"^(rail|light_rail|subway|narrow_gauge)$"];'
        + 'way["aerialway"="cable_car"];'
        + ");out geom;",
        "points": head
        + "("
        + 'node["place"~"^(city|town|suburb|quarter|neighbourhood)$"];'
        + 'node["railway"~"^(station|halt)$"];'
        + 'nwr["amenity"~"^(hospital|university|bus_station)$"]["name"];'
        + 'nwr["tourism"~"^(museum|attraction)$"]["name"];'
        + ");out center tags;",
    }


def fetch(name: str, query: str, refresh: bool) -> dict[str, Any]:
    cache = CACHE_DIR / f"{name}.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))

    body = urllib.parse.urlencode({"data": query}).encode()
    last_error: Exception | None = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                print(f"  fetching {name} from {url.split('/')[2]} ...", flush=True)
                request = urllib.request.Request(
                    url, data=body, headers={"User-Agent": "goru-hackathon-basemap/1.0"}
                )
                with urllib.request.urlopen(request, timeout=240) as response:
                    raw = response.read()
                data = json.loads(raw)
                if "elements" not in data:
                    raise ValueError(f"no elements in response: {raw[:200]!r}")
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(raw)
                return data
            except Exception as error:  # noqa: BLE001 -- any mirror failure: try the next
                last_error = error
                print(f"    failed ({error.__class__.__name__}: {str(error)[:120]})")
                time.sleep(3 * (attempt + 1))
    raise SystemExit(f"Every Overpass mirror failed for {name}: {last_error}")


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #

Point = tuple[float, float]


def simplify(points: list[Point], tolerance: float) -> list[Point]:
    """Douglas-Peucker, iterative. Endpoints always survive."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance * tolerance
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        worst, worst_d2 = -1, tol2
        for i in range(a + 1, b):
            px, py = points[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > worst_d2:
                worst, worst_d2 = i, d2
        if worst >= 0:
            keep[worst] = True
            stack.append((a, worst))
            stack.append((worst, b))
    return [p for p, k in zip(points, keep) if k]


def clip_polygon(ring: list[Point], box: tuple[float, float, float, float]) -> list[Point]:
    """Sutherland-Hodgman against an axis-aligned box (w, s, e, n)."""
    w, s, e, n = box

    def clip(pts: list[Point], inside, cross) -> list[Point]:
        out: list[Point] = []
        for i, cur in enumerate(pts):
            prev = pts[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        return out

    def at_x(x: float):
        return lambda p, q: (x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]))

    def at_y(y: float):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y)

    pts = ring
    for inside, cross in (
        (lambda p: p[0] >= w, at_x(w)),
        (lambda p: p[0] <= e, at_x(e)),
        (lambda p: p[1] >= s, at_y(s)),
        (lambda p: p[1] <= n, at_y(n)),
    ):
        if not pts:
            break
        pts = clip(pts, inside, cross)
    return pts


def clip_line(points: list[Point], box: tuple[float, float, float, float]) -> list[list[Point]]:
    """Split a polyline into the runs that fall inside the box, one point of overhang each side."""
    w, s, e, n = box
    inside = [w <= x <= e and s <= y <= n for x, y in points]
    runs: list[list[Point]] = []
    current: list[Point] = []
    for i, p in enumerate(points):
        near = inside[i] or (i > 0 and inside[i - 1]) or (i + 1 < len(points) and inside[i + 1])
        if near:
            current.append(p)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return [r for r in runs if len(r) >= 2]


def ring_area(ring: list[Point]) -> float:
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]))) / 2


def centroid(ring: list[Point]) -> Point:
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-9:
        xs, ys = zip(*ring)
        return sum(xs) / len(xs), sum(ys) / len(ys)
    return cx / (3 * a), cy / (3 * a)


def stitch(segments: list[list[Point]]) -> list[list[Point]]:
    """Join multipolygon member ways end to end into closed rings."""
    rings: list[list[Point]] = []
    pool = [list(s) for s in segments if len(s) >= 2]
    while pool:
        ring = pool.pop()
        grown = True
        while ring[0] != ring[-1] and grown:
            grown = False
            for i, seg in enumerate(pool):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[-2::-1]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = seg[:0:-1] + ring
                else:
                    continue
                pool.pop(i)
                grown = True
                break
        rings.append(ring)
    return rings


def merge_chains(pieces: list[list[Point]]) -> list[list[Point]]:
    """Join polylines that share an endpoint, so a named street is one long run."""
    by_end: dict[Point, list[int]] = defaultdict(list)
    for i, p in enumerate(pieces):
        by_end[p[0]].append(i)
        by_end[p[-1]].append(i)
    used = [False] * len(pieces)
    out: list[list[Point]] = []

    def take(end: Point) -> list[Point] | None:
        for j in by_end[end]:
            if not used[j]:
                used[j] = True
                seg = pieces[j]
                return seg if seg[0] == end else seg[::-1]
        return None

    for i, piece in enumerate(pieces):
        if used[i]:
            continue
        used[i] = True
        chain = list(piece)
        while (nxt := take(chain[-1])) is not None:
            chain += nxt[1:]
        while (prv := take(chain[0])) is not None:
            # `prv` starts at chain[0]; reversed, it ends there.
            chain = prv[::-1][:-1] + chain
        out.append(chain)
    return out


def encode(points: Iterable[Point]) -> list[int]:
    """[e0, n0, de1, dn1, ...] in whole metres; repeated points dropped."""
    out: list[int] = []
    pe = pn = None
    for x, y in points:
        e, n = int(round(x)), int(round(y))
        if pe is None:
            out += [e, n]
        elif (e, n) != (pe, pn):
            out += [e - pe, n - pn]
        else:
            continue
        pe, pn = e, n
    return out


# --------------------------------------------------------------------------- #
# Bake
# --------------------------------------------------------------------------- #


def name_of(tags: dict[str, str]) -> str | None:
    return tags.get("name:tr") or tags.get("name") or None


def area_kind(tags: dict[str, str]) -> str | None:
    leisure, landuse = tags.get("leisure"), tags.get("landuse")
    natural, amenity = tags.get("natural"), tags.get("amenity")
    if natural == "water" or landuse == "reservoir":
        return "water"
    if leisure in ("park", "garden", "nature_reserve", "golf_course"):
        return "park"
    if leisure == "stadium":
        return "campus"
    if landuse == "forest" or natural == "wood":
        return "forest"
    if landuse == "cemetery" or amenity == "grave_yard":
        return "cemetery"
    if landuse in ("commercial", "retail"):
        return "urban"
    if amenity in ("university", "college", "hospital"):
        return "campus"
    if landuse in ("grass", "meadow", "village_green", "recreation_ground",
                   "farmland", "orchard", "allotments") or natural in ("scrub", "grassland"):
        return "grass"
    return None


def line_kind(tags: dict[str, str]) -> str | None:
    railway, waterway = tags.get("railway"), tags.get("waterway")
    if railway in ("rail", "narrow_gauge"):
        return "rail"
    if railway == "light_rail":
        return "light_rail"
    if railway == "subway":
        return "subway"
    if waterway in ("river", "canal"):
        return "river"
    if waterway == "stream":
        return "stream"
    if tags.get("aerialway") == "cable_car":
        return "cable_car"
    return None


def bake(refresh: bool) -> None:
    area = operation_area()
    base = area["base"]
    frame = Frame.at(base["lat"], base["lon"])
    crop = crop_of(area["overall"], MARGIN_M)

    def enu(lat: float, lon: float) -> Point:
        return frame.to_enu(lat, lon)

    cw, cs = enu(crop["s"], crop["w"])
    ce, cn = enu(crop["n"], crop["e"])
    box = (cw, cs, ce, cn)
    # Lines keep a little overhang so a road does not stop dead at the edge.
    line_box = (cw - 200, cs - 200, ce + 200, cn + 200)

    ov = area["overall"]
    print("Operation area (tracks + image corners + zones):")
    for src, b in area["by_source"].items():
        print(f"  {src:7s} lat {b['s']:.6f}..{b['n']:.6f}  lon {b['w']:.6f}..{b['e']:.6f}")
    aw, as_ = enu(ov["s"], ov["w"])
    ae, an = enu(ov["n"], ov["e"])
    print(f"  overall  {(ae - aw) / 1000:.2f} km E-W x {(an - as_) / 1000:.2f} km N-S")
    print(f"  crop     +{MARGIN_M:.0f} m margin")

    q = queries(crop)
    raw = {name: fetch(name, query, refresh) for name, query in q.items()}

    # --- roads ------------------------------------------------------------- #
    grouped: dict[tuple[str, str | None, int], list[list[Point]]] = defaultdict(list)
    for el in raw["roads"]["elements"]:
        tags = el.get("tags", {})
        cls = ROAD_CLASS.get(tags.get("highway", ""))
        geom = el.get("geometry")
        if not cls or not geom:
            continue
        tunnel = 1 if tags.get("tunnel") in ("yes", "building_passage") or tags.get("covered") == "yes" else 0
        pts = [enu(g["lat"], g["lon"]) for g in geom if g]
        for run in clip_line(pts, line_box):
            grouped[(cls, name_of(tags), tunnel)].append([(round(x, 1), round(y, 1)) for x, y in run])

    roads: list[list[Any]] = []
    for (cls, name, tunnel), pieces in grouped.items():
        for chain in merge_chains(pieces):
            coords = encode(simplify(chain, SIMPLIFY_ROAD_M))
            if len(coords) >= 4:
                roads.append([cls, name, tunnel, coords])

    # --- areas and lines ---------------------------------------------------- #
    areas: list[list[Any]] = []
    lines: list[list[Any]] = []
    area_labels: list[list[Any]] = []
    for el in raw["features"]["elements"]:
        tags = el.get("tags", {})
        kind = line_kind(tags)
        if kind and el["type"] == "way" and el.get("geometry"):
            pts = [enu(g["lat"], g["lon"]) for g in el["geometry"] if g]
            for run in clip_line(pts, line_box):
                coords = encode(simplify(run, SIMPLIFY_ROAD_M))
                if len(coords) >= 4:
                    lines.append([kind, name_of(tags), coords])
            continue

        kind = area_kind(tags)
        if not kind:
            continue
        if el["type"] == "way" and el.get("geometry"):
            segs = [[enu(g["lat"], g["lon"]) for g in el["geometry"] if g]]
        elif el["type"] == "relation":
            segs = [
                [enu(g["lat"], g["lon"]) for g in m["geometry"] if g]
                for m in el.get("members", [])
                if m.get("type") == "way" and m.get("geometry") and m.get("role") in ("outer", "inner", "")
            ]
        else:
            continue

        rings = []
        total = 0.0
        biggest: list[Point] | None = None
        for ring in stitch(segs):
            if ring[0] == ring[-1]:
                ring = ring[:-1]
            ring = clip_polygon(ring, box)
            if len(ring) < 3:
                continue
            a = ring_area(ring)
            if a < MIN_AREA_M2:
                continue
            simple = simplify(ring + ring[:1], SIMPLIFY_AREA_M)[:-1]
            if len(simple) < 3:
                continue
            rings.append(encode(simple))
            total += a
            if biggest is None or a > ring_area(biggest):
                biggest = ring
        if not rings:
            continue
        name = name_of(tags)
        areas.append([kind, name, *rings])
        if name and total >= LABEL_AREA_M2 and biggest and kind in ("park", "forest", "campus", "cemetery", "water"):
            cx, cy = centroid(biggest)
            area_labels.append([kind, name, int(round(cx)), int(round(cy)), int(total)])

    # --- points ------------------------------------------------------------- #
    # Ankara's OSM place hierarchy, read off the data rather than assumed:
    # `town` carries the five district (ilce) names, `quarter` the 48 names a
    # resident would give -- Kizilay, Ulus, Tunali -- and `suburb` the 241
    # official mahalle. `city` is one node at Kizilay reading "Ankara", which
    # would sit on the base mark and says nothing on a map of Ankara.
    PLACE_KIND = {"town": "district", "quarter": "semt", "suburb": "mahalle", "neighbourhood": "mahalle"}

    places: list[list[Any]] = []
    stations: list[list[Any]] = []
    pois: list[list[Any]] = []
    seen_station: set[str] = set()
    w, s, e, n = box
    for el in raw["points"]["elements"]:
        tags = el.get("tags", {})
        name = name_of(tags)
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if not name or lat is None:
            continue
        x, y = enu(lat, lon)
        if not (w <= x <= e and s <= y <= n):
            continue
        pt = [int(round(x)), int(round(y))]
        place = tags.get("place")
        if place:
            if place in PLACE_KIND:
                places.append([PLACE_KIND[place], name, *pt])
        elif tags.get("railway") in ("station", "halt"):
            station = tags.get("station")
            kind = "subway" if station == "subway" else "light_rail" if station == "light_rail" else "train"
            key = f"{kind}:{name}"
            if key in seen_station:
                continue
            seen_station.add(key)
            stations.append([kind, name, *pt])
        else:
            amenity, tourism = tags.get("amenity"), tags.get("tourism")
            # Faculty buildings are tagged amenity=university too ("T Binasi",
            # "NA"); campuses are labelled from their polygons below instead.
            # Private clinics are tagged hospital; only real hospitals are kept.
            if amenity == "university":
                continue
            if amenity == "hospital" and "hastane" not in name.casefold():
                continue
            if amenity == "bus_station" and not any(k in name for k in ("Terminal", "AŞTİ")):
                continue
            kind = (
                "hospital" if amenity == "hospital"
                else "bus_station" if amenity == "bus_station"
                else "museum" if tourism == "museum"
                else "attraction"
            )
            pois.append([kind, name, *pt, 0])

    # Big named parks and campuses read as places on a city map. Largest first,
    # one label per name (ODTU Ormani is mapped as several polygons).
    area_labels.sort(key=lambda row: -row[4])
    labelled: set[str] = set()
    for kind, name, x, y, size in area_labels:
        if name in labelled:
            continue
        labelled.add(name)
        if kind in ("park", "forest"):
            kind = "park"
        elif kind == "campus" and "hastane" in name.casefold():
            kind = "hospital"
        pois.append([kind, name, x, y, size])

    # Two nodes for one place (the terminal and its "(ASTI)" twin) collapse to one.
    deduped: list[list[Any]] = []
    for poi in pois:
        if any(
            p[0] == poi[0] and math.hypot(p[2] - poi[2], p[3] - poi[3]) < 300 for p in deduped
        ) or any(p[1] == poi[1] for p in deduped):
            continue
        deduped.append(poi)
    pois = deduped

    order = {"highway": 5, "primary": 4, "secondary": 3, "tertiary": 2, "minor": 1, "path": 0}
    roads.sort(key=lambda r: (r[2] == 0, order[r[0]]))

    osm_ts = raw["roads"].get("osm3s", {}).get("timestamp_osm_base")
    out = {
        "version": 1,
        "attribution": "© OpenStreetMap katkıda bulunanlar",
        "license": "ODbL 1.0 — https://www.openstreetmap.org/copyright",
        "baked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "osm_timestamp": osm_ts,
        "origin": base,
        "crop_enu": {"w": round(cw), "s": round(cs), "e": round(ce), "n": round(cn)},
        "roads": roads,
        "lines": lines,
        "areas": areas,
        "places": places,
        "stations": stations,
        "pois": pois,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    OUT_FILE.write_text(text, encoding="utf-8")

    by_class: dict[str, int] = defaultdict(int)
    for r in roads:
        by_class[r[0]] += 1
    by_area: dict[str, int] = defaultdict(int)
    for a in areas:
        by_area[a[0]] += 1
    print(f"Wrote {OUT_FILE.relative_to(REPO_ROOT)}  ({len(text.encode()) / 1024:.0f} KB)")
    print(f"  roads    {len(roads)} chains  {dict(by_class)}")
    print(f"  areas    {len(areas)}  {dict(by_area)}")
    print(f"  lines    {len(lines)}   places {len(places)}   stations {len(stations)}   pois {len(pois)}")
    print(f"  OSM data as of {osm_ts}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--refresh", action="store_true", help="re-download from Overpass")
    args = parser.parse_args()
    bake(args.refresh)


if __name__ == "__main__":
    main()
