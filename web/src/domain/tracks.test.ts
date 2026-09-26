import { describe, expect, it } from 'vitest';
import { covers, sampleAt, stopsOf, stopTotal, trailAt, trendOf } from './tracks';
import type { TrackHistory } from './types';

/** A track heading straight at the base from the east, 5 minutes per fix. */
function inbound(): TrackHistory {
  return {
    track_id: 'T0001',
    cls: 'truck',
    image_id: 'img_0001',
    t: [100, 105, 110, 115, 120],
    e: [5000, 4000, 3000, 2000, 1000],
    n: [0, 0, 0, 0, 0],
  };
}

/** Parked for 20 minutes, then leaves. */
function parked(): TrackHistory {
  return {
    track_id: 'T0002',
    cls: 'car',
    image_id: null,
    t: [0, 5, 10, 15, 20, 25, 30],
    e: [3000, 3002, 2998, 3001, 3000, 2500, 2000],
    n: [0, 1, -2, 0, 3, 0, 0],
  };
}

describe('sampleAt', () => {
  it('returns nothing before the track has been recorded', () => {
    // The no-future-leakage rule, on the display side: a track whose history has
    // not started yet must not appear on the map at a guessed position.
    expect(sampleAt(inbound(), 99)).toBeNull();
    expect(covers(inbound(), 99)).toBe(false);
  });

  it('returns nothing after the track ends', () => {
    expect(sampleAt(inbound(), 121)).toBeNull();
  });

  it('interpolates between two fixes', () => {
    const sample = sampleAt(inbound(), 107.5);
    expect(sample).not.toBeNull();
    // Halfway between 4000 m and 3000 m east.
    expect(sample!.enu.e_m).toBeCloseTo(3500, 6);
    expect(sample!.range_m).toBeCloseTo(3500, 6);
  });

  it('lands exactly on a fix', () => {
    const sample = sampleAt(inbound(), 110);
    expect(sample!.enu.e_m).toBeCloseTo(3000, 6);
    expect(sample!.index).toBe(2);
  });

  it('derives speed from the surrounding fixes', () => {
    // 1000 m over 5 minutes is 3.33 m/s.
    const sample = sampleAt(inbound(), 107);
    expect(sample!.speed_mps).toBeCloseTo(1000 / 300, 6);
  });

  it('reports a negative closing rate while approaching the base', () => {
    const sample = sampleAt(inbound(), 107);
    expect(sample!.closing_mps).toBeLessThan(0);
    expect(trendOf(sample!)).toBe('approaching');
  });

  it('reports receding when the range grows', () => {
    const outbound = { ...inbound(), e: [1000, 2000, 3000, 4000, 5000] };
    const sample = sampleAt(outbound, 107);
    expect(sample!.closing_mps).toBeGreaterThan(0);
    expect(trendOf(sample!)).toBe('receding');
  });
});

describe('stopsOf', () => {
  it('finds a spell spent inside the stationary radius', () => {
    const stops = stopsOf(parked(), 25);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.fromMin).toBe(0);
    expect(stops[0]!.toMin).toBe(20);
    expect(stops[0]!.durationMin).toBe(20);
    expect(stopTotal(stops)).toBe(20);
  });

  it('ignores a single quiet fix', () => {
    // One fix that happens not to move is noise in a velocity fit, not a stop.
    const jittery: TrackHistory = {
      track_id: 'T0003',
      cls: 'car',
      image_id: null,
      t: [0, 5, 10, 15],
      e: [0, 1, 900, 1800],
      n: [0, 0, 0, 0],
    };
    expect(stopsOf(jittery, 25)).toHaveLength(0);
  });

  it('finds nothing in a track that never stops', () => {
    expect(stopsOf(inbound(), 25)).toHaveLength(0);
  });
});

describe('trailAt', () => {
  it('covers only the requested window and ends at the present position', () => {
    const trail = trailAt(inbound(), 112.5, 10);
    // Fixes at 105 and 110, plus the interpolated point at 112.5.
    expect(trail).toHaveLength(3);
    expect(trail[trail.length - 1]!.e_m).toBeCloseTo(2500, 6);
  });

  it('is empty outside the track window', () => {
    expect(trailAt(inbound(), 50, 10)).toEqual([]);
  });
});
