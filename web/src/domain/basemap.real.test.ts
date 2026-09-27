/* The basemap against the shipped files: the baked OpenStreetMap extract and the
 * real pipeline export.
 *
 * `basemap.test.ts` proves the mechanics on a toy city. This proves the claims
 * made about the real one: that the operation area drawn on the map is exactly
 * the box `tracks.csv` spans, that every drone image corner falls inside it (so
 * tracks alone decide it), that the baked crop covers it with room to spare, and
 * that preparing and labelling 14 000 roads stays off the critical path.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutLabels, operationArea, prepareBasemap, type BasemapFile } from './basemap';
import type { DatasetInfo, FrameDetail, TrackHistory } from './types';

const PUBLIC = join(__dirname, '..', '..', 'public');
const FIXTURES = join(PUBLIC, 'fixtures');
const BASEMAP = join(PUBLIC, 'basemap', 'ankara.json');
const present = existsSync(join(FIXTURES, 'dataset.json')) && existsSync(BASEMAP);
const suite = present ? describe : describe.skip;

/**
 * The extremes of `tracks.csv`, read off the raw file (PLAN 2.6 data), and the
 * engine's ENU transform (`goru_core.geo.m_per_deg`) to put them in metres.
 */
const RAW = { s: 39.851244, n: 39.991651, w: 32.76028, e: 32.94581 };

function enuOf(lat: number, lon: number, base: { lat: number; lon: number }) {
  const phi = (base.lat * Math.PI) / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const mLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  return { e: (lon - base.lon) * mLon, n: (lat - base.lat) * mLat };
}

suite('the basemap on the shipped data', () => {
  const read = <T,>(path: string): T => JSON.parse(readFileSync(path, 'utf-8')) as T;
  const dataset = present ? read<DatasetInfo>(join(FIXTURES, 'dataset.json')) : ({} as DatasetInfo);
  const tracks = present ? read<{ tracks: TrackHistory[] }>(join(FIXTURES, 'tracks.json')).tracks : [];
  const file = present ? read<BasemapFile>(BASEMAP) : ({} as BasemapFile);
  const area = present
    ? operationArea(tracks, [...dataset.zones.map((z) => z.enu), ...dataset.frames.map((f) => f.centre_enu)])!
    : { w: 0, s: 0, e: 0, n: 0 };

  it('draws the operation area exactly where tracks.csv reaches', () => {
    const sw = enuOf(RAW.s, RAW.w, dataset.base);
    const ne = enuOf(RAW.n, RAW.e, dataset.base);
    // tracks.json carries ENU to a decimetre.
    expect(area.w).toBeCloseTo(sw.e, 0);
    expect(area.s).toBeCloseTo(sw.n, 0);
    expect(area.e).toBeCloseTo(ne.e, 0);
    expect(area.n).toBeCloseTo(ne.n, 0);
    expect((area.e - area.w) / 1000).toBeCloseTo(15.86, 1);
    expect((area.n - area.s) / 1000).toBeCloseTo(15.59, 1);
  });

  it('has every drone image corner inside it, so the tracks alone decide it', () => {
    const dir = join(FIXTURES, 'frames');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(40);
    for (const name of files) {
      for (const corner of read<FrameDetail>(join(dir, name)).footprint_enu) {
        expect(corner.e_m).toBeGreaterThanOrEqual(area.w);
        expect(corner.e_m).toBeLessThanOrEqual(area.e);
        expect(corner.n_m).toBeGreaterThanOrEqual(area.s);
        expect(corner.n_m).toBeLessThanOrEqual(area.n);
      }
    }
  });

  it('was baked in the same frame, with a kilometre of map past the area on every side', () => {
    expect(file.origin).toEqual({ lat: dataset.base.lat, lon: dataset.base.lon });
    expect(area.w - file.crop_enu.w).toBeGreaterThan(1000);
    expect(file.crop_enu.e - area.e).toBeGreaterThan(1000);
    expect(area.s - file.crop_enu.s).toBeGreaterThan(1000);
    expect(file.crop_enu.n - area.n).toBeGreaterThan(1000);
  });

  it('prepares and labels the real city off the critical path', () => {
    const started = performance.now();
    const map = prepareBasemap(file);
    const prepareMs = performance.now() - started;

    const wide = performance.now();
    const at8 = layoutLabels(map, 8);
    const wideMs = performance.now() - wide;
    const close = performance.now();
    const at1 = layoutLabels(map, 1);
    const closeMs = performance.now() - close;

    console.log(
      `basemap: ${map.tiles.length} tiles, ${map.counts.roads} roads; prepare ${prepareMs.toFixed(0)} ms; ` +
        `labels ${at8.length} at 8 km in ${wideMs.toFixed(0)} ms, ${at1.length} at 1 km in ${closeMs.toFixed(0)} ms`,
    );
    // Loose on purpose: guards against an accidental O(n^2), not a benchmark.
    expect(prepareMs).toBeLessThan(3000);
    expect(wideMs).toBeLessThan(500);
    expect(closeMs).toBeLessThan(1500);

    // The five district names are the wide view's anchor; streets appear up close.
    const wideText = at8.map((label) => label.text);
    for (const district of ['ÇANKAYA', 'KEÇİÖREN', 'MAMAK', 'ALTINDAĞ', 'YENİMAHALLE']) {
      expect(wideText).toContain(district);
    }
    expect(at1.some((label) => label.style === 'road')).toBe(true);
  });
});
