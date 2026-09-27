/* The city under the radar.
 *
 * `web/scripts/export_basemap.py` bakes OpenStreetMap over the operation area
 * into one file of integer ENU metres, through the same transform the engine
 * uses for tracks -- so a road and the vehicle on it land on the same metre.
 * This module turns that file into what the layers draw: path data grouped by
 * tile and class, the zoom rules for what shows when, the label set for a
 * scale, and the operation area the whole dataset spans.
 *
 * Geometry is kept in *metre space* -- x = east, y = -north, so SVG's y-down
 * axis reads north-up -- and the layer draws it under one `scale()` transform.
 * A zoom then changes one attribute instead of re-projecting 14 000 roads, which
 * is what keeps a wheel flight smooth. Labels are the exception: text must stay
 * one size on screen, so they are projected point by point, like every other
 * layer's symbols.
 *
 * Colour stays out of this module on purpose. The basemap is drawn in neutrals
 * and soft terrain (tokens.css `--map-*`), because the three risk hues are the
 * only colours on this screen that mean anything, and a vehicle sits *on* a
 * road: a yellow highway, as Google draws one, would hide every WATCH glyph
 * driving along it.
 */

import { VIEW, type Projection } from './polar';
import type { Enu, TrackHistory } from './types';

export type RoadClass = 'highway' | 'primary' | 'secondary' | 'tertiary' | 'minor' | 'path';
export type LineKind = 'rail' | 'light_rail' | 'subway' | 'river' | 'stream' | 'cable_car';
export type AreaKind = 'water' | 'park' | 'forest' | 'grass' | 'cemetery' | 'urban' | 'campus';
export type PlaceKind = 'district' | 'semt' | 'mahalle';
export type StationKind = 'subway' | 'light_rail' | 'train';
export type PoiKind =
  | 'hospital'
  | 'bus_station'
  | 'museum'
  | 'attraction'
  | 'park'
  | 'campus'
  | 'cemetery'
  | 'water';

/** ENU metres from the base: west, south, east, north edges. */
export interface Box {
  w: number;
  s: number;
  e: number;
  n: number;
}

/** The baked file, exactly as `export_basemap.py` writes it. */
export interface BasemapFile {
  version: 1;
  attribution: string;
  license: string;
  baked_at: string;
  osm_timestamp: string | null;
  origin: { lat: number; lon: number };
  crop_enu: Box;
  /** [class, name, tunnel, coords]; coords are [e0, n0, de1, dn1, ...]. */
  roads: [RoadClass, string | null, 0 | 1, number[]][];
  lines: [LineKind, string | null, number[]][];
  /** [kind, name, ring, ring, ...], drawn even-odd so inner rings are holes. */
  areas: [AreaKind, string | null, ...number[][]][];
  places: [PlaceKind, string, number, number][];
  stations: [StationKind, string, number, number][];
  /** [kind, name, e, n, area m² (0 for a point feature)]. */
  pois: [PoiKind, string, number, number, number][];
}

/** Draw order, bottom first. Casings all go under all fills, so junctions merge. */
export const AREA_ORDER: readonly AreaKind[] = [
  'urban',
  'campus',
  'grass',
  'cemetery',
  'forest',
  'park',
  'water',
];
export const ROAD_ORDER: readonly RoadClass[] = [
  'path',
  'minor',
  'tertiary',
  'secondary',
  'primary',
  'highway',
];
export const WATER_LINES: readonly LineKind[] = ['river', 'stream'];
export const RAIL_LINES: readonly LineKind[] = ['subway', 'rail', 'light_rail', 'cable_car'];

export type LayerId =
  | `area:${AreaKind}`
  | `line:${LineKind}`
  | `road:${RoadClass}`
  | `tunnel:${RoadClass}`;

export interface Tile {
  key: string;
  /** Union of everything assigned to the tile, so a long road is never culled early. */
  box: Box;
  /** SVG path data in metre space, one string per layer, at full detail. */
  paths: Partial<Record<LayerId, string>>;
  /**
   * The same layers for a wide view: geometry simplified to what a screen
   * pixel can show at that scale, and areas under a hectare dropped. Measured
   * on the shipped file, full detail at 8 km cost ~110 ms a frame during a
   * wheel flight in headless Chrome; this is what keeps a zoom a glide.
   */
  coarse: Partial<Record<LayerId, string>>;
}

/** Wider than this visible radius (km), tiles draw their coarse geometry. */
export const COARSE_FROM_KM = 3.2;
/** Simplification tolerance for the coarse level, in metres. */
const COARSE_TOLERANCE_M = 14;
/** Smallest area kept in the coarse level, in m². */
const COARSE_MIN_AREA_M2 = 10_000;

export const detailFor = (scaleKm: number): 'paths' | 'coarse' =>
  scaleKm > COARSE_FROM_KM ? 'coarse' : 'paths';

export interface NamedRoad {
  cls: RoadClass;
  name: string;
  /** Absolute ENU metres, [e0, n0, e1, n1, ...]. */
  pts: number[];
}

export type PointKind = PlaceKind | StationKind | PoiKind;

export interface PointFeature {
  group: 'place' | 'station' | 'poi';
  kind: PointKind;
  name: string;
  e: number;
  n: number;
  /** Area in m² for a labelled polygon, 0 for a point. Larger labels win ties. */
  weight: number;
}

export interface PreparedBasemap {
  attribution: string;
  osmTimestamp: string | null;
  crop: Box;
  tiles: Tile[];
  roads: NamedRoad[];
  points: PointFeature[];
  counts: { roads: number; areas: number; lines: number; labels: number };
}

/** Tile edge in metres. Small enough to cull a street-level view, large enough to stay few. */
export const TILE_M = 2000;

// --------------------------------------------------------------------------- //
// Zoom rules
// --------------------------------------------------------------------------- //

/** The widest visible radius, in km, at which each class is still drawn. */
export const ROAD_UNTIL_KM: Record<RoadClass, number> = {
  highway: Infinity,
  primary: Infinity,
  secondary: 12,
  tertiary: 6,
  minor: 3,
  path: 1.6,
};

export const LINE_UNTIL_KM: Record<LineKind, number> = {
  rail: Infinity,
  light_rail: Infinity,
  subway: 4,
  river: Infinity,
  stream: 3,
  cable_car: 6,
};

/** Road width in SVG units at 1 km; it narrows on a gentle power curve past that. */
const ROAD_WIDTH_1KM: Record<RoadClass, number> = {
  highway: 12,
  primary: 10,
  secondary: 8,
  tertiary: 6.5,
  minor: 4.5,
  path: 2.5,
};

/**
 * On-screen road width in SVG units.
 *
 * Wider when zoomed in, as on any street map, but on a power of -0.62 rather
 * than linearly: a road drawn to true scale would be a hairline at 8 km and a
 * river at 1 km.
 */
export function roadWidth(cls: RoadClass, scaleKm: number): number {
  return Math.max(0.6, ROAD_WIDTH_1KM[cls] * scaleKm ** -0.62);
}

/** Whether a road class gets a darker outline at this scale. */
export function roadCased(cls: RoadClass, scaleKm: number): boolean {
  if (cls === 'path') return false;
  if (cls === 'minor') return scaleKm <= 2;
  // Past 6 km a secondary road is two pixels wide; an outline would only blur it.
  if (cls === 'secondary' || cls === 'tertiary') return scaleKm <= 6;
  return true;
}

export const roadVisible = (cls: RoadClass, scaleKm: number) => scaleKm <= ROAD_UNTIL_KM[cls];
export const lineVisible = (kind: LineKind, scaleKm: number) => scaleKm <= LINE_UNTIL_KM[kind];

// --------------------------------------------------------------------------- //
// Preparing the file
// --------------------------------------------------------------------------- //

/** Delta-encoded coords to absolute ENU metres. */
export function decode(coords: readonly number[]): number[] {
  const out = new Array<number>(coords.length);
  let e = 0;
  let n = 0;
  for (let i = 0; i + 1 < coords.length; i += 2) {
    e += coords[i] as number;
    n += coords[i + 1] as number;
    out[i] = e;
    out[i + 1] = n;
  }
  return out;
}

/**
 * SVG path data for delta coords, in metre space.
 *
 * The file's delta encoding *is* SVG's relative `l` command, so a path is the
 * first point and then the deltas with north negated -- nothing is decoded.
 */
function pathOf(coords: readonly number[], close: boolean): string {
  let d = `M${coords[0]} ${-(coords[1] as number)}l`;
  for (let i = 2; i + 1 < coords.length; i += 2) {
    d += `${coords[i]} ${-(coords[i + 1] as number)} `;
  }
  return close ? `${d}z` : d;
}

function boxOf(coords: readonly number[]): Box {
  let e = coords[0] as number;
  let n = coords[1] as number;
  const box = { w: e, s: n, e, n };
  for (let i = 2; i + 1 < coords.length; i += 2) {
    e += coords[i] as number;
    n += coords[i + 1] as number;
    if (e < box.w) box.w = e;
    if (e > box.e) box.e = e;
    if (n < box.s) box.s = n;
    if (n > box.n) box.n = n;
  }
  return box;
}

/** Douglas-Peucker over absolute [e0, n0, e1, n1, ...]. Endpoints always survive. */
export function simplifyFlat(pts: readonly number[], tolerance: number): number[] {
  const count = pts.length / 2;
  if (count < 3) return [...pts];
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const ax = pts[2 * a] as number;
    const ay = pts[2 * a + 1] as number;
    const dx = (pts[2 * b] as number) - ax;
    const dy = (pts[2 * b + 1] as number) - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i += 1) {
      const px = (pts[2 * i] as number) - ax;
      const py = (pts[2 * i + 1] as number) - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d2 > worstD2) {
        worst = i;
        worstD2 = d2;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (keep[i]) out.push(pts[2 * i] as number, pts[2 * i + 1] as number);
  }
  return out;
}

/** Shoelace area of a ring of absolute coords, m². */
export function ringArea(pts: readonly number[]): number {
  let sum = 0;
  const count = pts.length / 2;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    sum += (pts[2 * i] as number) * (pts[2 * j + 1] as number)
      - (pts[2 * j] as number) * (pts[2 * i + 1] as number);
  }
  return Math.abs(sum) / 2;
}

/** SVG path data for absolute coords, in metre space. */
function absolutePath(pts: readonly number[], close: boolean): string {
  let d = `M${pts[0]} ${-(pts[1] as number)}L`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += `${pts[i]} ${-(pts[i + 1] as number)} `;
  return close ? `${d}z` : d;
}

/** Layers that are never drawn wider than COARSE_FROM_KM need no coarse copy. */
const FINE_ONLY: ReadonlySet<LayerId> = new Set<LayerId>([
  'road:minor',
  'road:path',
  'tunnel:minor',
  'tunnel:path',
  'line:stream',
]);

export function unionBox(a: Box, b: Box): Box {
  return { w: Math.min(a.w, b.w), s: Math.min(a.s, b.s), e: Math.max(a.e, b.e), n: Math.max(a.n, b.n) };
}

export function intersects(a: Box, b: Box): boolean {
  return a.w <= b.e && a.e >= b.w && a.s <= b.n && a.n >= b.s;
}

/**
 * Turn the baked file into drawable tiles and label candidates. Runs once, off
 * the render path, when the file arrives.
 */
export function prepareBasemap(file: BasemapFile): PreparedBasemap {
  interface Bucket {
    box: Box | null;
    parts: Partial<Record<LayerId, string[]>>;
    coarse: Partial<Record<LayerId, string[]>>;
  }
  const buckets = new Map<string, Bucket>();

  function add(layer: LayerId, coords: readonly number[], close: boolean) {
    if (coords.length < 4) return;
    const box = boxOf(coords);
    const cx = Math.floor((box.w + box.e) / 2 / TILE_M);
    const cy = Math.floor((box.s + box.n) / 2 / TILE_M);
    const key = `${cx}:${cy}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { box: null, parts: {}, coarse: {} };
      buckets.set(key, bucket);
    }
    bucket.box = bucket.box ? unionBox(bucket.box, box) : box;
    (bucket.parts[layer] ??= []).push(pathOf(coords, close));

    if (FINE_ONLY.has(layer)) return;
    const pts = decode(coords);
    if (close && ringArea(pts) < COARSE_MIN_AREA_M2) return;
    const simple = simplifyFlat(close ? [...pts, pts[0] as number, pts[1] as number] : pts, COARSE_TOLERANCE_M);
    if (simple.length < (close ? 8 : 4)) return;
    (bucket.coarse[layer] ??= []).push(absolutePath(close ? simple.slice(0, -2) : simple, close));
  }

  let areaCount = 0;
  for (const [kind, , ...rings] of file.areas) {
    areaCount += 1;
    for (const ring of rings) add(`area:${kind}`, ring, true);
  }
  for (const [kind, , coords] of file.lines) add(`line:${kind}`, coords, false);

  const roads: NamedRoad[] = [];
  for (const [cls, name, tunnel, coords] of file.roads) {
    add(tunnel ? `tunnel:${cls}` : `road:${cls}`, coords, false);
    if (name && !tunnel && cls !== 'path') roads.push({ cls, name, pts: decode(coords) });
  }

  const tiles: Tile[] = [];
  for (const [key, bucket] of buckets) {
    if (!bucket.box) continue;
    const join = (from: Bucket['parts']) => {
      const out: Tile['paths'] = {};
      for (const [layer, parts] of Object.entries(from) as [LayerId, string[]][]) out[layer] = parts.join('');
      return out;
    };
    tiles.push({ key, box: bucket.box, paths: join(bucket.parts), coarse: join(bucket.coarse) });
  }

  const points: PointFeature[] = [
    ...file.places.map(([kind, name, e, n]): PointFeature => ({
      group: 'place', kind, name, e, n, weight: 0,
    })),
    ...file.stations.map(([kind, name, e, n]): PointFeature => ({
      group: 'station', kind, name, e, n, weight: 0,
    })),
    ...file.pois.map(([kind, name, e, n, weight]): PointFeature => ({
      group: 'poi', kind, name, e, n, weight,
    })),
  ];

  return {
    attribution: file.attribution,
    osmTimestamp: file.osm_timestamp,
    crop: file.crop_enu,
    tiles,
    roads,
    points,
    counts: {
      roads: file.roads.length,
      areas: areaCount,
      lines: file.lines.length,
      labels: roads.length + points.length,
    },
  };
}

// --------------------------------------------------------------------------- //
// What is on screen
// --------------------------------------------------------------------------- //

/**
 * The ground the view can show, in ENU metres, with room to spare.
 *
 * The SVG letterboxes its 960 x 680 viewBox into whatever the stage is, and a
 * wide stage shows ground past the viewBox's sides. The margin covers a stage
 * up to about 2.5:1 without the edge tiles popping in, and costs nothing when
 * the whole map is on screen anyway.
 */
export function visibleBox(
  projection: Projection,
  pan: { eKm: number; nKm: number },
  margin = { x: 1.9, y: 1.3 },
): Box {
  const halfW = ((VIEW.w / 2) / projection.unitsPerKm) * 1000 * margin.x;
  const halfH = ((VIEW.h / 2) / projection.unitsPerKm) * 1000 * margin.y;
  const e = pan.eKm * 1000;
  const n = pan.nKm * 1000;
  return { w: e - halfW, e: e + halfW, s: n - halfH, n: n + halfH };
}

/**
 * The operation area: the bounding box of every position the dataset holds.
 *
 * Every track fix plus any extra points (zone centres, frame centres). Every
 * image corner in `image_meta.json` falls inside the track fixes' box --
 * measured, and pinned by the integration test -- so tracks alone decide it on
 * the shipped data, and the extras only matter if that ever changes.
 */
export function operationArea(
  tracks: readonly TrackHistory[],
  extra: readonly Enu[] = [],
): Box | null {
  let box: Box | null = null;
  const grow = (e: number, n: number) => {
    box = box
      ? { w: Math.min(box.w, e), s: Math.min(box.s, n), e: Math.max(box.e, e), n: Math.max(box.n, n) }
      : { w: e, s: n, e, n };
  };
  for (const track of tracks) {
    for (let i = 0; i < track.e.length; i += 1) grow(track.e[i] as number, track.n[i] as number);
  }
  for (const point of extra) grow(point.e_m, point.n_m);
  return box;
}

// --------------------------------------------------------------------------- //
// Labels
// --------------------------------------------------------------------------- //

export type LabelStyle =
  | 'district'
  | 'semt'
  | 'mahalle'
  | 'road'
  | 'road-minor'
  | 'station'
  | 'poi'
  | 'park'
  | 'water';

export interface MapLabel {
  key: string;
  text: string;
  style: LabelStyle;
  /** Anchor in ENU metres; the label is centred on it. */
  e: number;
  n: number;
  /** Screen rotation in degrees, always kept upright (-90, 90]. */
  angle: number;
  size: number;
  /** A station or place-of-interest marker drawn beside the text. */
  icon: StationKind | PoiKind | null;
}

/** A screen rectangle, in SVG units relative to the base, for keeping labels off things. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface StyleSpec {
  size: number;
  /** Letter spacing in em, which widens a monospace label predictably. */
  tracking: number;
  caps: boolean;
}

export const LABEL_STYLE: Record<LabelStyle, StyleSpec> = {
  district: { size: 13, tracking: 0.2, caps: true },
  semt: { size: 10, tracking: 0.12, caps: true },
  mahalle: { size: 8.5, tracking: 0, caps: false },
  road: { size: 9, tracking: 0, caps: false },
  'road-minor': { size: 8.5, tracking: 0, caps: false },
  station: { size: 8.5, tracking: 0, caps: false },
  poi: { size: 8.5, tracking: 0, caps: false },
  park: { size: 8.5, tracking: 0, caps: false },
  water: { size: 8.5, tracking: 0, caps: false },
};

/** A monospace advance, as a fraction of the font size. The UI is set in mono throughout. */
const ADVANCE = 0.6;
/** Space kept clear around every label, in SVG units. */
const LABEL_PAD = 3;
/** Icons sit left of their text: width reserved for them, in SVG units. */
const ICON_W = 12;

export function labelText(text: string, style: LabelStyle): string {
  return LABEL_STYLE[style].caps ? text.toLocaleUpperCase('tr-TR') : text;
}

/** Width of a label in SVG units: exact for a monospace face, which is the point. */
export function labelWidth(text: string, style: LabelStyle): number {
  const spec = LABEL_STYLE[style];
  return text.length * spec.size * (ADVANCE + spec.tracking);
}

const ROAD_LABEL_UNTIL_KM: Record<RoadClass, number> = {
  highway: 8,
  primary: 6,
  secondary: 3.5,
  tertiary: 2.2,
  minor: 1.4,
  path: 0,
};

const ROAD_PRIORITY: Record<RoadClass, number> = {
  highway: 70,
  primary: 66,
  secondary: 56,
  tertiary: 46,
  minor: 26,
  path: 0,
};

/**
 * Snap a continuous scale to a step, so labels are laid out once per step of a
 * zoom flight rather than on every frame of it -- and do not flicker while the
 * wheel glides.
 */
export function labelScale(scaleKm: number): number {
  const step = Math.log(1.2);
  return Math.exp(Math.round(Math.log(scaleKm) / step) * step);
}

interface Candidate {
  key: string;
  group: string;
  text: string;
  style: LabelStyle;
  e: number;
  n: number;
  angle: number;
  priority: number;
  icon: MapLabel['icon'];
}

function pointCandidate(p: PointFeature, scaleKm: number): Candidate | null {
  let style: LabelStyle;
  let priority: number;
  let until: number;
  switch (p.kind) {
    case 'district':
      [style, priority, until] = ['district', 100, Infinity];
      break;
    case 'semt':
      [style, priority, until] = ['semt', 82, 9];
      break;
    case 'mahalle':
      [style, priority, until] = ['mahalle', 30, 2.6];
      break;
    case 'subway':
    case 'light_rail':
    case 'train':
      [style, priority, until] = ['station', 60, 4.5];
      break;
    default: {
      const big = p.weight >= 400_000;
      style = p.kind === 'park' ? 'park' : p.kind === 'water' ? 'water' : 'poi';
      // Area labels rank by size: ODTU's forest before a pocket park.
      priority = p.weight > 0 ? 38 + Math.log10(p.weight) * 4 : 36;
      until = big ? 4.5 : p.weight > 0 ? 2.6 : 2;
    }
  }
  if (scaleKm > until) return null;
  const icon = p.group === 'station' || (p.group === 'poi' && p.weight === 0)
    ? (p.kind as StationKind | PoiKind)
    : p.kind === 'hospital' ? 'hospital' : null;
  return {
    key: `${p.group}:${p.kind}:${p.name}:${p.e}:${p.n}`,
    group: `${p.group}:${p.name}`,
    text: labelText(p.name, style),
    style,
    e: p.e,
    n: p.n,
    angle: 0,
    priority,
    icon,
  };
}

/**
 * Where a name fits along a road: straight-enough stretches of the polyline,
 * long enough for the text, spaced along it.
 *
 * The label is set straight and rotated to the stretch's chord, rather than
 * bent along the curve with `textPath` -- a bent monospace label is harder to
 * read than a straight one on a stretch that is nearly straight anyway, and
 * straightness is what the tolerance below demands.
 */
export function roadAnchors(
  pts: readonly number[],
  lengthM: number,
  spacingM: number,
  toleranceM: number,
): { e: number; n: number; angle: number }[] {
  const count = pts.length / 2;
  if (count < 2) return [];
  const arc = new Array<number>(count);
  arc[0] = 0;
  for (let i = 1; i < count; i += 1) {
    arc[i] = (arc[i - 1] as number) + Math.hypot(
      (pts[2 * i] as number) - (pts[2 * i - 2] as number),
      (pts[2 * i + 1] as number) - (pts[2 * i - 1] as number),
    );
  }
  const total = arc[count - 1] as number;
  if (total < lengthM) return [];

  const at = (s: number) => {
    let i = 1;
    while (i < count - 1 && (arc[i] as number) < s) i += 1;
    const s0 = arc[i - 1] as number;
    const s1 = arc[i] as number;
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    return {
      e: (pts[2 * i - 2] as number) + ((pts[2 * i] as number) - (pts[2 * i - 2] as number)) * f,
      n: (pts[2 * i - 1] as number) + ((pts[2 * i + 1] as number) - (pts[2 * i - 1] as number)) * f,
      i,
    };
  };

  // Centres from the middle outwards, so a short road still gets its one label
  // in the middle and a long one repeats along its length.
  const centres: number[] = [total / 2];
  for (let d = spacingM; total / 2 + d <= total - lengthM / 2; d += spacingM) {
    centres.push(total / 2 + d, total / 2 - d);
  }

  const out: { e: number; n: number; angle: number }[] = [];
  for (const c of centres) {
    if (c - lengthM / 2 < 0 || c + lengthM / 2 > total) continue;
    const a = at(c - lengthM / 2);
    const b = at(c + lengthM / 2);
    const de = b.e - a.e;
    const dn = b.n - a.n;
    const chord = Math.hypot(de, dn);
    if (chord < lengthM * 0.92) continue;
    let straight = true;
    for (let k = a.i; k < b.i && straight; k += 1) {
      const pe = (pts[2 * k] as number) - a.e;
      const pn = (pts[2 * k + 1] as number) - a.n;
      if (Math.abs(pe * dn - pn * de) / chord > toleranceM) straight = false;
    }
    if (!straight) continue;
    // Screen y runs down, so north is negative; keep the text upright.
    let angle = (Math.atan2(-dn, de) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    // `+ 0` turns atan2's -0 into 0 for an east-west road.
    out.push({ e: (a.e + b.e) / 2, n: (a.n + b.n) / 2, angle: angle + 0 });
  }
  return out;
}

/** Axis-aligned box of a rotated label, in SVG units relative to the base. */
function rectOf(x: number, y: number, width: number, height: number, angle: number): Rect {
  const a = (angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const hw = (width * c + height * s) / 2 + LABEL_PAD;
  const hh = (width * s + height * c) / 2 + LABEL_PAD;
  return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
}

/**
 * The labels to draw at a scale, collision-free.
 *
 * Greedy by priority: districts, then the semt names a resident would use, then
 * big roads, stations, parks, and so on down. A candidate that overlaps anything
 * already placed -- or an obstacle, such as a zone's own name -- is dropped, and
 * the same name is not repeated closer than a few hundred units. Positions are
 * kept in ENU, so the set laid out for one scale step stays put under pan and
 * only moves as the projection moves it.
 */
export function layoutLabels(
  map: PreparedBasemap,
  scaleKm: number,
  obstacles: readonly Rect[] = [],
): MapLabel[] {
  const unitsPerM = (VIEW.h / 2 - 20) / scaleKm / 1000;
  const candidates: Candidate[] = [];

  for (const p of map.points) {
    const candidate = pointCandidate(p, scaleKm);
    if (candidate) candidates.push(candidate);
  }

  for (const road of map.roads) {
    if (scaleKm > ROAD_LABEL_UNTIL_KM[road.cls] || scaleKm > ROAD_UNTIL_KM[road.cls]) continue;
    const style: LabelStyle = road.cls === 'minor' ? 'road-minor' : 'road';
    const width = labelWidth(road.name, style) + 12;
    const lengthM = width / unitsPerM;
    const anchors = roadAnchors(
      road.pts,
      lengthM,
      Math.max(lengthM * 2.5, 420 / unitsPerM),
      (LABEL_STYLE[style].size * 0.45) / unitsPerM,
    );
    anchors.slice(0, 4).forEach((anchor, i) => {
      candidates.push({
        key: `road:${road.name}:${road.pts[0]}:${road.pts[1]}:${i}`,
        group: `road:${road.name}`,
        text: road.name,
        style,
        e: anchor.e,
        n: anchor.n,
        angle: anchor.angle,
        // A road's first anchor (its middle) outranks its repeats.
        priority: ROAD_PRIORITY[road.cls] - i * 2 + Math.min(road.pts.length / 400, 3),
        icon: null,
      });
    });
  }

  candidates.sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : 1));

  // A coarse grid, so each candidate is tested against its neighbours only.
  const CELL = 64;
  const grid = new Map<string, Rect[]>();
  const cellsOf = (r: Rect) => {
    const keys: string[] = [];
    for (let gx = Math.floor(r.x0 / CELL); gx <= Math.floor(r.x1 / CELL); gx += 1) {
      for (let gy = Math.floor(r.y0 / CELL); gy <= Math.floor(r.y1 / CELL); gy += 1) {
        keys.push(`${gx}:${gy}`);
      }
    }
    return keys;
  };
  const hits = (r: Rect) =>
    cellsOf(r).some((key) =>
      (grid.get(key) ?? []).some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0),
    );
  const occupy = (r: Rect) => {
    for (const key of cellsOf(r)) {
      const bucket = grid.get(key);
      if (bucket) bucket.push(r);
      else grid.set(key, [r]);
    }
  };
  obstacles.forEach(occupy);

  const placedByGroup = new Map<string, { x: number; y: number }[]>();
  const out: MapLabel[] = [];
  for (const c of candidates) {
    const spec = LABEL_STYLE[c.style];
    const x = c.e * unitsPerM;
    const y = -c.n * unitsPerM;
    const width = labelWidth(c.text, c.style) + (c.icon ? ICON_W : 0);
    const rect = rectOf(x, y, width, spec.size * 1.25, c.angle);
    if (hits(rect)) continue;
    const same = placedByGroup.get(c.group);
    if (same?.some((p) => Math.hypot(p.x - x, p.y - y) < 300)) continue;
    occupy(rect);
    if (same) same.push({ x, y });
    else placedByGroup.set(c.group, [{ x, y }]);
    out.push({
      key: c.key,
      text: c.text,
      style: c.style,
      e: c.e,
      n: c.n,
      angle: c.angle,
      size: spec.size,
      icon: c.icon,
    });
  }
  return out;
}
