import { describe, expect, it } from 'vitest';
import { activityOf, headlineOf, positionAt, SPLIT_MIN } from './activity';
import type { TrackHistory, Zone } from './types';

const STATIONARY_M = 25;

function track(t: number[], e: number[], n: number[] = e.map(() => 0)): TrackHistory {
  return { track_id: 'T0001', cls: 'truck', image_id: 'img_0001', t, e, n };
}

/** Five-minute fixes, east at 300 m per minute (5 m/s) from the base. */
const eastbound = track([0, 5, 10, 15, 20], [0, 1500, 3000, 4500, 6000]);

const zone: Zone = {
  zone_id: 'Z03',
  name: 'Dogu Yolu',
  enu: { e_m: 3204, n_m: 0 },
  lat: 0,
  lon: 0,
  range_m: 3204,
  bearing_deg: 90,
  radius_m: 250,
  buffer_m: 750,
};

const opts = (toMin: number, zones: Zone[] = []) => ({ toMin, zones, stationaryDispM: STATIONARY_M });

describe('activityOf: nothing after the clock', () => {
  it('has no activity before the track\'s first fix', () => {
    expect(activityOf(track([100, 105], [0, 10]), opts(50))).toBeNull();
  });

  it('clips the route at the clock and interpolates the last point there', () => {
    const a = activityOf(eastbound, opts(12.5))!;
    expect(a.route.every((p) => p.tMin <= 12.5)).toBe(true);
    expect(a.route[a.route.length - 1]).toEqual({ tMin: 12.5, e: 3750, n: 0 });
    expect(a.complete).toBe(false);
    expect(a.fixCount).toBe(3);
    expect(a.distanceM).toBeCloseTo(3750, 6);
    expect(a.elapsedMin).toBe(12.5);
  });

  it('is complete once the clock passes the last fix', () => {
    const a = activityOf(eastbound, opts(300))!;
    expect(a.complete).toBe(true);
    expect(a.toMin).toBe(20);
    expect(a.events[a.events.length - 1]).toMatchObject({ kind: 'end', complete: true });
  });
});

describe('activityOf: movement', () => {
  it('does not count a parked vehicle\'s GPS jitter as distance', () => {
    const parked = track(
      [0, 5, 10, 15, 20, 25, 30, 35, 40],
      [0, 5, -4, 6, 0, 3, -2, 4, 1],
      [0, 3, -2, 4, 1, -3, 2, 0, -1],
    );
    const a = activityOf(parked, opts(40))!;
    expect(a.distanceM).toBe(0);
    expect(a.movingMin).toBe(0);
    expect(a.stops).toHaveLength(1);
    expect(a.stoppedMin).toBe(40);
    expect(a.headingDeg).toBeNull();
    expect(headlineOf(a)).toEqual({ kind: 'parked', minutes: 40 });
  });

  it('reads speed, moving time and heading off the fixes', () => {
    const a = activityOf(eastbound, opts(20))!;
    expect(a.distanceM).toBeCloseTo(6000, 6);
    expect(a.movingMin).toBe(20);
    expect(a.avgMovingSpeedMps).toBeCloseTo(5, 6);
    expect(a.maxSpeedMps).toBeCloseTo(5, 6);
    expect(a.headingDeg).toBeCloseTo(90, 6);
  });

  it('keeps a GPS outlier out of the maximum and out of the distance', () => {
    // 15 km in five minutes is 50 m/s: no road vehicle, a bad fix.
    const a = activityOf(track([0, 5, 10], [0, 1500, 16500]), opts(10))!;
    expect(a.outlierSteps).toBe(1);
    expect(a.maxSpeedMps).toBeCloseTo(5, 6);
    expect(a.distanceM).toBeCloseTo(1500, 6);
  });

  it('does not let the interpolated step to the clock set the maximum', () => {
    const a = activityOf(track([0, 5, 10], [0, 300, 6300]), opts(6))!;
    expect(a.maxSpeedMps).toBeCloseTo(1, 6);
    expect(a.maxSpeedAtMin).toBe(5);
  });
});

describe('activityOf: zones', () => {
  const a = activityOf(eastbound, opts(20, [zone]))!;
  const pass = a.zones[0]!;

  it('solves the closest approach on the segment, not at a fix', () => {
    expect(pass.closestM).toBeCloseTo(0, 6);
    expect(pass.closestAtMin).toBeCloseTo(3204 / 300, 6);
  });

  it('times the buffer and zone entries exactly', () => {
    // Radius + buffer is 1000 m, crossed at e = 2204; the zone at e = 2954.
    expect(pass.bufferEnteredAtMin).toBeCloseTo(2204 / 300, 6);
    expect(pass.zoneEnteredAtMin).toBeCloseTo(2954 / 300, 6);
    expect(pass.insideBufferMin).toBeCloseTo(2000 / 300, 6);
  });

  it('lists the entries as events, in time order', () => {
    const kinds = a.events.map((event) => event.kind);
    expect(kinds).toEqual(['start', 'buffer', 'zone', 'end']);
    const times = a.events.map((event) => event.tMin);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('leads the headline with the zone it entered', () => {
    expect(headlineOf(a)).toMatchObject({ kind: 'zone', name: 'Dogu Yolu' });
  });

  it('knows nothing of an entry after the clock', () => {
    const early = activityOf(eastbound, opts(7, [zone]))!;
    expect(early.zones[0]!.bufferEnteredAtMin).toBeNull();
    expect(early.events.some((event) => event.kind === 'buffer')).toBe(false);
  });
});

describe('activityOf: splits and range to base', () => {
  const inbound = track(
    Array.from({ length: 13 }, (_, i) => i * 5),
    Array.from({ length: 13 }, () => 0),
    Array.from({ length: 13 }, (_, i) => 6000 - i * 400),
  );
  const a = activityOf(inbound, opts(60))!;

  it('cuts half-hour splits whose distances add up to the whole', () => {
    expect(a.splits.map((s) => [s.fromMin, s.toMin])).toEqual([[0, SPLIT_MIN], [SPLIT_MIN, 60]]);
    const total = a.splits.reduce((sum, s) => sum + s.distanceM, 0);
    expect(total).toBeCloseTo(a.distanceM, 6);
    expect(a.splits[0]!.rangeDeltaM).toBeCloseTo(-2400, 6);
  });

  it('reports the net approach and closest range to the base', () => {
    expect(a.netApproachM).toBeCloseTo(4800, 6);
    expect(a.closestBaseM).toBeCloseTo(1200, 6);
    expect(headlineOf(a)).toEqual({ kind: 'approaching', metres: a.netApproachM });
  });
});

describe('positionAt', () => {
  it('interpolates between route points and clamps at the ends', () => {
    const route = [{ tMin: 0, e: 0, n: 0 }, { tMin: 10, e: 100, n: -50 }];
    expect(positionAt(route, 5)).toEqual({ tMin: 5, e: 50, n: -25 });
    expect(positionAt(route, -3)).toEqual(route[0]);
    expect(positionAt(route, 99)).toEqual(route[1]);
  });
});
