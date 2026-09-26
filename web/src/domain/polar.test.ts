import { describe, expect, it } from 'vitest';
import { bearingOf, DEFAULT_SCALE, enuAt, projectionFor, rangeOf, ringsFor, VIEW } from './polar';

describe('projectionFor', () => {
  it('puts the base at the centre', () => {
    const [x, y] = projectionFor(8).project({ e_m: 0, n_m: 0 });
    expect(x).toBeCloseTo(VIEW.cx, 6);
    expect(y).toBeCloseTo(VIEW.cy, 6);
  });

  it('puts north up and east right', () => {
    const p = projectionFor(8);
    const north = p.project({ e_m: 0, n_m: 3000 });
    const east = p.project({ e_m: 3000, n_m: 0 });
    expect(north[1]).toBeLessThan(VIEW.cy);
    expect(north[0]).toBeCloseTo(VIEW.cx, 6);
    expect(east[0]).toBeGreaterThan(VIEW.cx);
    expect(east[1]).toBeCloseTo(VIEW.cy, 6);
  });

  it('agrees with the polar helper', () => {
    const p = projectionFor(8);
    // Dogu Yolu sits at bearing 90 degrees, 3204 m out (PLAN 2.4).
    const viaEnu = p.project(enuAt(90, 3204));
    const viaPolar = p.polar(90, 3.204);
    expect(viaEnu[0]).toBeCloseTo(viaPolar[0], 6);
    expect(viaEnu[1]).toBeCloseTo(viaPolar[1], 6);
  });

  it('zooms: the same point moves further out at a smaller scale', () => {
    const near = projectionFor(3).project({ e_m: 2000, n_m: 0 })[0];
    const far = projectionFor(12).project({ e_m: 2000, n_m: 0 })[0];
    expect(near).toBeGreaterThan(far);
  });

  it('keeps the outermost ring inside the viewport', () => {
    for (const scale of [3, 5, 8, 12] as const) {
      const p = projectionFor(scale);
      expect(p.radius(scale * 1000)).toBeLessThanOrEqual(VIEW.h / 2);
    }
  });

  it('knows what is off screen', () => {
    const p = projectionFor(3);
    expect(p.visible({ e_m: 2000, n_m: 0 })).toBe(true);
    expect(p.visible({ e_m: 7990, n_m: 0 })).toBe(false);
    // At the default scale the whole exercise fits: the furthest track fix in the
    // shipped data is 7.99 km from the base.
    expect(projectionFor(DEFAULT_SCALE).visible({ e_m: 7990, n_m: 0 })).toBe(true);
  });
});

describe('bearingOf and rangeOf', () => {
  it('round-trips the eight zone bearings', () => {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const enu = enuAt(bearing, 3200);
      expect(bearingOf(enu)).toBeCloseTo(bearing, 6);
      expect(rangeOf(enu)).toBeCloseTo(3200, 6);
    }
  });
});

describe('ringsFor', () => {
  it('steps by 1 km up to 8 and by 2 beyond', () => {
    expect(ringsFor(3)).toEqual([1, 2, 3]);
    expect(ringsFor(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ringsFor(12)).toEqual([2, 4, 6, 8, 10, 12]);
  });
});
