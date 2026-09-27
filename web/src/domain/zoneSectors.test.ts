import { describe, expect, it } from 'vitest';
import { zoneSectors } from './zoneSectors';
import type { Zone } from './types';

const zoneAt = (bearing: number, id = `Z${bearing}`): Zone => ({
  zone_id: id,
  name: id,
  enu: { e_m: 0, n_m: 0 },
  lat: 0,
  lon: 0,
  range_m: 3200,
  bearing_deg: bearing,
  radius_m: 150,
  buffer_m: 100,
});

const span = (s: { fromDeg: number; toDeg: number }) => s.toDeg - s.fromDeg;

describe('zoneSectors', () => {
  it('tiles the full circle with no gap between the eight shipped zones', () => {
    const sectors = zoneSectors([0, 45, 90, 135, 180, 225, 270, 315].map((b) => zoneAt(b)));
    expect(sectors).toHaveLength(8);
    for (const sector of sectors) expect(span(sector)).toBeCloseTo(45, 6);
    // Every edge is another sector's edge: the gaps the rings left are gone.
    const total = sectors.reduce((sum, sector) => sum + span(sector), 0);
    expect(total).toBeCloseTo(360, 6);
  });

  it('centres each sector on its own zone', () => {
    const sectors = zoneSectors([0, 45, 90, 135, 180, 225, 270, 315].map((b) => zoneAt(b)));
    const east = sectors.find((s) => s.zone_id === 'Z90');
    expect(east?.fromDeg).toBeCloseTo(67.5, 6);
    expect(east?.toDeg).toBeCloseTo(112.5, 6);
  });

  it('wraps the sector that straddles north', () => {
    const sectors = zoneSectors([0, 45, 90, 135, 180, 225, 270, 315].map((b) => zoneAt(b)));
    const north = sectors.find((s) => s.zone_id === 'Z0');
    expect(north?.fromDeg).toBeCloseTo(337.5, 6);
    // Carried past 360 rather than folded back, so the arc still sweeps forward.
    expect(north?.toDeg).toBeCloseTo(382.5, 6);
  });

  it('gives an unevenly placed zone only the ground nearest its own bearing', () => {
    const sectors = zoneSectors([zoneAt(0), zoneAt(90), zoneAt(180)]);
    const east = sectors.find((s) => s.zone_id === 'Z90');
    expect(east?.fromDeg).toBeCloseTo(45, 6);
    expect(east?.toDeg).toBeCloseTo(135, 6);
    expect(sectors.reduce((sum, s) => sum + span(s), 0)).toBeCloseTo(360, 6);
  });

  it('reaches the buffer edge, not the zone centre', () => {
    expect(zoneSectors([zoneAt(0), zoneAt(180)])[0]!.outerM).toBe(3450);
  });

  it('gives a lone zone every bearing', () => {
    expect(zoneSectors([zoneAt(30)])).toEqual([
      { zone_id: 'Z30', fromDeg: 0, toDeg: 360, outerM: 3450 },
    ]);
  });

  it('has nothing to draw with no zones', () => {
    expect(zoneSectors([])).toEqual([]);
  });
});
