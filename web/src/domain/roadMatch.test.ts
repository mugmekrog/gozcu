import { describe, expect, it } from 'vitest';
import { matchedTrace } from './roadMatch';
import type { TrackHistory } from './types';

const track = (over: Partial<TrackHistory>): TrackHistory => ({
  track_id: 'T0001',
  cls: 'car',
  image_id: null,
  t: [0, 5, 10, 15],
  e: [0, 10, 20, 30],
  n: [0, 0, 0, 0],
  ...over,
});

describe('matchedTrace', () => {
  it('breaks the trace at an unmatched fix rather than bridging it', () => {
    // Bridging would draw the vehicle along a road nothing placed it on.
    const trace = matchedTrace(track({ me: [1, null, 21, 31], mn: [1, null, 1, 1] }));
    expect(trace).not.toBeNull();
    expect(trace!.runs.map((run) => run.from)).toEqual([0, 2]);
    expect(trace!.runs[1]!.points).toHaveLength(2);
    expect(trace!.unmatched).toEqual([{ e_m: 10, n_m: 0 }]);
  });

  it('keeps the raw position of an unmatched fix, not a guess at one', () => {
    const trace = matchedTrace(track({ me: [null, null, null, null], mn: [null, null, null, null] }));
    expect(trace!.runs).toEqual([]);
    expect(trace!.unmatched).toHaveLength(4);
  });

  it('stops at the clock, so the trace never runs ahead of the map', () => {
    const trace = matchedTrace(track({ me: [1, 11, 21, 31], mn: [1, 1, 1, 1] }), 5);
    expect(trace!.runs[0]!.points).toHaveLength(2);
  });

  it('carries the match rate and roads through for the caller to qualify with', () => {
    const trace = matchedTrace(
      track({ me: [1, null, 21, 31], mn: [1, null, 1, 1], roads: ['Vatan Caddesi'], matched_fraction: 0.75, median_offset_m: 9.4 }),
    );
    expect(trace!.matchedFraction).toBe(0.75);
    expect(trace!.roads).toEqual(['Vatan Caddesi']);
    expect(trace!.medianOffsetM).toBe(9.4);
  });

  it('is null when the fixtures were baked without a road network', () => {
    expect(matchedTrace(track({}))).toBeNull();
  });
});
