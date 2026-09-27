import { describe, expect, it } from 'vitest';
import {
  blobsOf,
  densestZone,
  normalise,
  peakOf,
  pressureAt,
  referenceClocks,
  referenceOf,
  SIGMA_M,
  weightOf,
  zoneCatchmentOf,
  zonePressures,
  type Blob,
} from './pressure';
import type { LiveVehicle } from './live';
import type { Enu, Level, Zone } from './types';

const at = (e_m: number, n_m: number): Enu => ({ e_m, n_m });

function vehicle(trackId: string, enu: Enu, level: Level | null): LiveVehicle {
  return {
    trackId,
    cls: 'car',
    sample: { enu, range_m: Math.hypot(enu.e_m, enu.n_m), speed_mps: 0, closing_mps: 0, index: 0 },
    trend: 'steady',
    level,
    score: 0,
    alert: null,
    imageId: level === null ? null : 'img_0001',
    stops: { count: 0, totalMin: 0 },
  };
}

function zone(zone_id: string, name: string, enu: Enu): Zone {
  return {
    zone_id,
    name,
    enu,
    lat: 0,
    lon: 0,
    range_m: Math.hypot(enu.e_m, enu.n_m),
    bearing_deg: 0,
    radius_m: 300,
    buffer_m: 200,
  };
}

const blob = (id: string, enu: Enu, weight: number): Blob => ({ id, enu, weight });

describe('weightOf', () => {
  it('weights the levels so one threat outweighs two safe vehicles', () => {
    // The whole point of a risk-weighted field: a convoy of parked cars must not
    // read as hot as a vehicle closing on a zone.
    expect(weightOf('ALERT')).toBeGreaterThan(weightOf('WATCH'));
    expect(weightOf('WATCH')).toBeGreaterThan(weightOf('CLEAR'));
    expect(weightOf('ALERT')).toBeGreaterThan(2 * weightOf('CLEAR'));
  });

  it('counts a not-yet-assessed vehicle as present, never as absent', () => {
    // A vehicle whose own frame has not been captured has no level (live.ts).
    // Dropping it would make the early clocks look emptier than the data is.
    expect(weightOf(null)).toBeGreaterThan(0);
  });
});

describe('pressureAt', () => {
  it('is zero with nothing on screen', () => {
    expect(pressureAt(at(0, 0), [])).toBe(0);
  });

  it('peaks at the vehicle and falls away from it', () => {
    const blobs = [blob('T1', at(0, 0), 1)];
    expect(pressureAt(at(0, 0), blobs)).toBeCloseTo(1, 10);
    expect(pressureAt(at(SIGMA_M, 0), blobs)).toBeLessThan(pressureAt(at(0, 0), blobs));
  });

  it('keeps the kernel inside a zone: under 15 % of the peak at two sigma', () => {
    // Bounds the smear. A wider kernel would leak across the 45-degree spokes and
    // light up a zone that has nothing near it.
    const blobs = [blob('T1', at(0, 0), 1)];
    const ratio = pressureAt(at(2 * SIGMA_M, 0), blobs) / pressureAt(at(0, 0), blobs);
    expect(ratio).toBeLessThan(0.15);
  });

  it('adds contributions where vehicles overlap', () => {
    const one = [blob('T1', at(0, 0), 1)];
    const two = [...one, blob('T2', at(50, 0), 1)];
    expect(pressureAt(at(25, 0), two)).toBeGreaterThan(pressureAt(at(25, 0), one));
  });

  it('puts one ALERT above two CLEARs at the same point', () => {
    const alert = blobsOf([vehicle('T1', at(0, 0), 'ALERT')]);
    const clears = blobsOf([
      vehicle('T2', at(0, 0), 'CLEAR'),
      vehicle('T3', at(0, 0), 'CLEAR'),
    ]);
    expect(pressureAt(at(0, 0), alert)).toBeGreaterThan(pressureAt(at(0, 0), clears));
  });
});

describe('referenceOf', () => {
  it('is the busiest clock, not the last one', () => {
    const quiet = blobsOf([vehicle('T1', at(0, 0), 'CLEAR')]);
    const busy = blobsOf([
      vehicle('T1', at(0, 0), 'ALERT'),
      vehicle('T2', at(100, 0), 'ALERT'),
      vehicle('T3', at(200, 0), 'WATCH'),
    ]);
    expect(referenceOf([busy, quiet])).toBe(referenceOf([quiet, busy]));
    expect(referenceOf([quiet, busy])).toBe(peakOf(busy));
  });

  it('is stable across ticks, so a quiet clock stays quiet', () => {
    // The failure this guards is a per-tick renormalisation: it looks entirely
    // plausible on screen while making 08:10 as hot as 13:50. Invisible by eye,
    // so it is pinned here instead.
    const quiet = blobsOf([vehicle('T1', at(0, 0), 'CLEAR')]);
    const busy = blobsOf([
      vehicle('T1', at(0, 0), 'ALERT'),
      vehicle('T2', at(80, 0), 'ALERT'),
    ]);
    const reference = referenceOf([quiet, busy]);

    const quietPeak = normalise(peakOf(quiet), reference);
    const busyPeak = normalise(peakOf(busy), reference);
    expect(quietPeak).toBeLessThan(busyPeak);
    expect(busyPeak).toBe(1);
  });

  it('is zero for an exercise with nothing in it', () => {
    expect(referenceOf([[], []])).toBe(0);
  });
});

describe('referenceClocks', () => {
  it('covers both ends of the window', () => {
    const clocks = referenceClocks(0, 20, 5);
    expect(clocks[0]).toBe(0);
    expect(clocks[clocks.length - 1]).toBe(20);
  });

  it('walks the whole exercise rather than only the capture minutes', () => {
    // Sampling the 40 frames alone would leave every clock between them
    // unsampled, and a track carries two hours of history -- vehicles are live
    // there too. A reference blind to those clocks lets them saturate at the top
    // of the ramp on a minute that was not busy.
    expect(referenceClocks(0, 460).length).toBeGreaterThan(40);
  });
});

describe('the boot pass', () => {
  it('stays cheap at the busiest shape the shipped data can take', () => {
    // 101 vehicles is the measured busiest clock (live.perf.test.ts) and the
    // window is 93 samples. `peakOf` is quadratic in vehicles on purpose, so
    // this guards against an accidental third factor rather than against
    // absolute speed -- hence the generous bound.
    const clocks = referenceClocks(0, 460).map(() =>
      Array.from({ length: 101 }, (_, i) =>
        blob(`T${i}`, at((i % 11) * 300, Math.floor(i / 11) * 300), 1 + (i % 3)),
      ),
    );
    const started = performance.now();
    const reference = referenceOf(clocks);
    const elapsed = performance.now() - started;
    expect(reference).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('normalise', () => {
  it('saturates rather than exceeding the scale', () => {
    expect(normalise(20, 4)).toBe(1);
  });

  it('treats a zero reference as no heat instead of dividing by it', () => {
    expect(normalise(5, 0)).toBe(0);
    expect(Number.isFinite(normalise(5, 0))).toBe(true);
  });
});

describe('zoneCatchmentOf', () => {
  const z = zone('Z01', 'Kuzey Kavsagi', at(0, 3200)); // radius 300 + buffer 200

  it('counts what is inside the radius and buffer, by weight', () => {
    // The readout is a catchment count rather than a Gaussian sample at the
    // centre: at the drawing kernel's 350 m a vehicle on the buffer edge scored
    // under 2 %, so five of eight real zones printed 0.000 at the busiest clock
    // of the day. This is also the geometry the rule engine warns on.
    expect(zoneCatchmentOf(z, blobsOf([vehicle('T1', at(0, 3200), 'ALERT')]))).toBe(3);
    expect(zoneCatchmentOf(z, blobsOf([vehicle('T1', at(0, 3200), 'CLEAR')]))).toBe(1);
  });

  it('counts a vehicle sitting on the buffer edge', () => {
    // The vehicle about to enter is the one the reviewer is watching; it must not
    // fall out of the number that claims to describe the zone.
    const edge = blobsOf([vehicle('T1', at(0, 3200 - 500), 'WATCH')]);
    expect(zoneCatchmentOf(z, edge)).toBe(2);
  });

  it('ignores a vehicle beyond the buffer', () => {
    const outside = blobsOf([vehicle('T1', at(0, 3200 - 501), 'ALERT')]);
    expect(zoneCatchmentOf(z, outside)).toBe(0);
  });
});

describe('zonePressures', () => {
  const zones = [
    zone('Z01', 'Kuzey Kavsagi', at(0, 3200)),
    zone('Z02', 'Dogu Yolu', at(3200, 0)),
  ];

  it('ranks the zone the vehicles are on above the empty one', () => {
    const blobs = blobsOf([
      vehicle('T1', at(0, 3200), 'ALERT'),
      vehicle('T2', at(0, 3100), 'WATCH'),
    ]);
    const rows = zonePressures(zones, blobs, referenceOf([blobs]));
    expect(rows[0]?.zoneId).toBe('Z01');
    // Countable, so the caption and the screen reader can say a figure rather
    // than only point at a colour.
    expect(rows[0]!.weight).toBe(weightOf('ALERT') + weightOf('WATCH'));
    expect(rows[0]!.value).toBeGreaterThan(rows[1]!.value);
    expect(densestZone(rows)?.name).toBe('Kuzey Kavsagi');
  });

  it('reports no densest zone when nothing is live', () => {
    // An empty clock must say "nothing", not name an arbitrary zone.
    const rows = zonePressures(zones, [], 0);
    expect(densestZone(rows)).toBeNull();
  });

  it('follows the filters, because it reads the live set the glyphs read', () => {
    // Heat and symbols must never describe different fleets: the caller filters
    // the live set, and the field is derived from whatever survives.
    const all = blobsOf([
      vehicle('T1', at(0, 3200), 'ALERT'),
      vehicle('T2', at(3200, 0), 'ALERT'),
    ]);
    const reference = referenceOf([all]);
    const filtered = blobsOf([vehicle('T1', at(0, 3200), 'ALERT')]);

    const before = zonePressures(zones, all, reference);
    const after = zonePressures(zones, filtered, reference);
    const dogu = (rows: ReturnType<typeof zonePressures>) =>
      rows.find((row) => row.zoneId === 'Z02')!.value;
    expect(dogu(after)).toBeLessThan(dogu(before));
  });

  it('keeps a filtered view on the same scale instead of rescaling it', () => {
    // Filtering to one zone shows that zone's share of the day's worst moment.
    // If it rescaled, the quietest corner would look as hot as the convoy.
    const busy = blobsOf([
      vehicle('T1', at(0, 3200), 'ALERT'),
      vehicle('T2', at(0, 3150), 'ALERT'),
      vehicle('T3', at(0, 3100), 'ALERT'),
    ]);
    const reference = referenceOf([busy]);
    const lone = blobsOf([vehicle('T9', at(3200, 0), 'CLEAR')]);
    expect(zonePressures(zones, lone, reference)[0]!.value).toBeLessThan(1);
  });
});
