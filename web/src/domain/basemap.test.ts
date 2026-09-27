import { describe, expect, it } from 'vitest';
import {
  decode,
  labelWidth,
  layoutLabels,
  LABEL_STYLE,
  operationArea,
  prepareBasemap,
  ringArea,
  roadAnchors,
  ROAD_ORDER,
  roadVisible,
  roadWidth,
  simplifyFlat,
  visibleBox,
  type BasemapFile,
  type MapLabel,
  type PreparedBasemap,
} from './basemap';
import { projectionFor, VIEW } from './polar';
import { basemapFile } from '@/test/fake-api';
import type { TrackHistory } from './types';

describe('decode', () => {
  it('turns the file\'s delta encoding back into absolute ENU metres', () => {
    expect(decode([100, -50, 10, 0, 0, 20, -5, -5])).toEqual([100, -50, 110, -50, 110, -30, 105, -35]);
  });
});

describe('prepareBasemap', () => {
  const map = prepareBasemap(basemapFile);
  const layers = new Set(map.tiles.flatMap((tile) => Object.keys(tile.paths)));

  it('puts every feature into a tile, one path per layer', () => {
    expect(layers).toEqual(new Set(['road:primary', 'road:minor', 'tunnel:secondary', 'line:rail', 'area:park']));
  });

  it('draws in metre space with north negated, from the deltas as they are', () => {
    const park = map.tiles.map((tile) => tile.paths['area:park']).find(Boolean);
    expect(park).toBe('M1000 -1000l800 0 0 -600 -800 0 z');
  });

  it('gives a tile the union box of its contents, so a long road is not culled early', () => {
    const road = map.tiles.find((tile) => tile.paths['road:primary'])!;
    expect(road.box.w).toBeLessThanOrEqual(-8000);
    expect(road.box.e).toBeGreaterThanOrEqual(8000);
  });

  it('has no coarse copy of what a wide view never draws', () => {
    const coarse = new Set(map.tiles.flatMap((tile) => Object.keys(tile.coarse)));
    expect(coarse.has('road:minor')).toBe(false);
    expect(coarse.has('road:primary')).toBe(true);
    expect(coarse.has('area:park')).toBe(true);
  });

  it('drops areas under a hectare from the coarse level only', () => {
    const tiny: BasemapFile = { ...basemapFile, areas: [['park', null, [0, 0, 50, 0, 0, 50, -50, 0]]] };
    const tile = prepareBasemap(tiny).tiles.find((t) => t.paths['area:park']);
    expect(tile?.paths['area:park']).toBeTruthy();
    expect(tile?.coarse['area:park']).toBeUndefined();
  });

  it('keeps named ground-level roads as label candidates, and every point feature', () => {
    expect(map.roads.map((r) => r.name)).toEqual(['Dogu Bulvari']);
    expect(map.points.map((p) => p.name)).toEqual(['Cankaya', 'Kizilay', 'Kizilay', 'Test Parki']);
  });
});

describe('road hierarchy', () => {
  it('orders widths by class at every scale, and narrows as the view widens', () => {
    for (const scale of [1, 2.25, 4, 8, 12]) {
      const widths = ROAD_ORDER.map((cls) => roadWidth(cls, scale));
      expect([...widths].sort((a, b) => a - b)).toEqual(widths);
    }
    expect(roadWidth('primary', 8)).toBeLessThan(roadWidth('primary', 2));
  });

  it('draws residential streets only when zoomed in', () => {
    expect(roadVisible('minor', 8)).toBe(false);
    expect(roadVisible('minor', 2.25)).toBe(true);
    expect(roadVisible('highway', 12)).toBe(true);
  });
});

describe('simplifyFlat and ringArea', () => {
  it('keeps the endpoints and drops points on the line', () => {
    expect(simplifyFlat([0, 0, 50, 1, 100, 0, 150, -1, 200, 0], 5)).toEqual([0, 0, 200, 0]);
    expect(simplifyFlat([0, 0, 50, 40, 100, 0], 5)).toEqual([0, 0, 50, 40, 100, 0]);
  });

  it('measures a ring in square metres', () => {
    expect(ringArea([0, 0, 100, 0, 100, 50, 0, 50])).toBe(5000);
  });
});

describe('roadAnchors', () => {
  it('centres a label on a straight road, horizontal for an east-west one', () => {
    const [anchor] = roadAnchors([0, 0, 1000, 0], 200, 1000, 5);
    expect(anchor).toEqual({ e: 500, n: 0, angle: 0 });
  });

  it('keeps text upright whichever way the road was drawn', () => {
    for (const pts of [[0, 0, 0, 1000], [0, 1000, 0, 0], [1000, 0, 0, 0], [0, 0, 700, 700]]) {
      const angle = roadAnchors(pts, 200, 1000, 5)[0]?.angle ?? NaN;
      expect(angle).toBeGreaterThan(-90);
      expect(angle).toBeLessThanOrEqual(90);
    }
    // A road heading north-east rises to the right; screen y runs down, so that is negative.
    expect(roadAnchors([0, 0, 700, 700], 200, 1000, 5)[0]?.angle).toBeCloseTo(-45, 6);
  });

  it('finds no place on a road shorter than its name, or on a tight bend', () => {
    expect(roadAnchors([0, 0, 100, 0], 200, 1000, 5)).toEqual([]);
    expect(roadAnchors([0, 0, 100, 0, 100, 100], 180, 1000, 5)).toEqual([]);
  });

  it('repeats a label along a long road', () => {
    expect(roadAnchors([0, 0, 5000, 0], 200, 1000, 5).length).toBeGreaterThan(3);
  });
});

/** Axis-aligned box of a placed label, as the collision check sees it. */
function boxOf(label: MapLabel, scaleKm: number) {
  const upm = (VIEW.h / 2 - 20) / scaleKm / 1000;
  const w = labelWidth(label.text, label.style);
  const h = LABEL_STYLE[label.style].size * 1.25;
  const a = (label.angle * Math.PI) / 180;
  const hw = (w * Math.abs(Math.cos(a)) + h * Math.abs(Math.sin(a))) / 2;
  const hh = (w * Math.abs(Math.sin(a)) + h * Math.abs(Math.cos(a))) / 2;
  return { x0: label.e * upm - hw, x1: label.e * upm + hw, y0: -label.n * upm - hh, y1: -label.n * upm + hh };
}

describe('layoutLabels', () => {
  const crowded: PreparedBasemap = prepareBasemap({
    ...basemapFile,
    // A district, a semt and a station piled onto one spot.
    places: [['district', 'Cankaya', 0, 0], ['semt', 'Kizilay', 10, 10]],
    stations: [['subway', 'Kizilay', 20, -10]],
    pois: [],
    roads: [['primary', 'Ataturk Bulvari', 0, [-4000, 0, 8000, 0]]],
  });

  it('never places two labels on top of each other', () => {
    for (const scale of [1, 2.25, 4, 8]) {
      const boxes = layoutLabels(crowded, scale).map((label) => boxOf(label, scale));
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          expect(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0).toBe(false);
        }
      }
    }
  });

  it('lets the district win a collision', () => {
    const placed = layoutLabels(crowded, 4);
    expect(placed.find((label) => label.style === 'district')?.text).toBe('CANKAYA');
    expect(placed.some((label) => label.style === 'semt' || label.style === 'station')).toBe(false);
  });

  it('keeps clear of obstacles such as a zone name', () => {
    const blocked = layoutLabels(crowded, 4, [{ x0: -80, y0: -20, x1: 80, y1: 20 }]);
    expect(blocked.some((label) => label.style === 'district')).toBe(false);
  });

  it('names small places only when zoomed in', () => {
    const map = prepareBasemap({ ...basemapFile, places: [['mahalle', 'Kocatepe', 0, 0]], stations: [], pois: [], roads: [] });
    expect(layoutLabels(map, 8)).toEqual([]);
    expect(layoutLabels(map, 1.5).map((label) => label.text)).toEqual(['Kocatepe']);
  });
});

describe('operationArea', () => {
  const track = (e: number[], n: number[]): TrackHistory => ({
    track_id: 'T', cls: null, image_id: null, t: e.map((_, i) => i * 5), e, n,
  });

  it('is the box around every fix of every track', () => {
    expect(operationArea([track([0, 100], [-50, 20]), track([-300, 10], [400, 0])])).toEqual({
      w: -300, s: -50, e: 100, n: 400,
    });
  });

  it('grows to take in extra points, and is null with nothing to bound', () => {
    expect(operationArea([track([0], [0])], [{ e_m: 900, n_m: -900 }])).toEqual({ w: 0, s: -900, e: 900, n: 0 });
    expect(operationArea([])).toBeNull();
  });
});

describe('visibleBox', () => {
  it('is centred on the pan and grows as the view widens', () => {
    const near = visibleBox(projectionFor(2), { eKm: 1, nKm: -2 });
    const far = visibleBox(projectionFor(8), { eKm: 1, nKm: -2 });
    expect((near.w + near.e) / 2).toBeCloseTo(1000, 6);
    expect((near.s + near.n) / 2).toBeCloseTo(-2000, 6);
    expect(far.e - far.w).toBeCloseTo((near.e - near.w) * 4, 6);
  });
});
