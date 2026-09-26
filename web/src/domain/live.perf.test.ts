/* The per-tick cost of the map, measured on the real dataset.
 *
 * PLAN F3.5 asks for no frame drops during playback, and the thing that decides
 * that is how long `liveVehiclesAt` takes: the clock writes ~15 times a second,
 * and every write re-derives the live set from all 226 track histories. This test
 * measures that against the shipped fixtures and fails if it regresses past a
 * budget with real headroom.
 *
 * The budget is deliberately loose (3 ms against a 66 ms tick) so this does not
 * fail on a slow CI box; it is a guard against an accidental O(n^2), not a
 * benchmark. Measured numbers are printed either way and quoted in the step log.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveVehiclesAt } from './live';
import type { Alert, DatasetInfo, TrackHistory } from './types';

const DIR = join(__dirname, '..', '..', 'public', 'fixtures');
const present = existsSync(join(DIR, 'dataset.json'));
const suite = present ? describe : describe.skip;

/* Budgets for one clock tick's derivation, in milliseconds.
 *
 * Measured at the p90 rather than the maximum. A single slow tick is the garbage
 * collector or the OS scheduler, not a dropped frame, and asserting on the
 * maximum made this fail only when the rest of the suite ran beside it -- a flaky
 * test that says nothing about the code. The p90 still catches an accidental
 * O(n^2), which is what this is for. */
const TICK_P90_BUDGET_MS = 3;
const TICK_MEDIAN_BUDGET_MS = 1;

suite('liveVehiclesAt on the real dataset', () => {
  const dataset = present
    ? (JSON.parse(readFileSync(join(DIR, 'dataset.json'), 'utf-8')) as DatasetInfo)
    : ({} as DatasetInfo);
  const tracks = present
    ? (JSON.parse(readFileSync(join(DIR, 'tracks.json'), 'utf-8')) as { tracks: TrackHistory[] })
        .tracks
    : [];
  const alerts = present
    ? (JSON.parse(readFileSync(join(DIR, 'alerts.json'), 'utf-8')) as { alerts: Alert[] }).alerts
    : [];

  const alertsByFrame = new Map<string, Alert[]>();
  for (const alert of alerts) {
    if (!alert.image_id) continue;
    const bucket = alertsByFrame.get(alert.image_id);
    if (bucket) bucket.push(alert);
    else alertsByFrame.set(alert.image_id, [alert]);
  }

  function derive(tMin: number) {
    return liveVehiclesAt({
      tMin,
      tracks,
      frames: dataset.frames,
      alertsByFrame,
      stationaryDispM: dataset.thresholds.stationary_disp_m,
      classFilter: 'all',
      zoneFilter: 'all',
    });
  }

  it('stays inside the tick budget across the whole exercise window', () => {
    const end = dataset.sim.end_min;

    // Warm up, so the first measured tick is not paying for JIT compilation.
    for (let tMin = 0; tMin <= end; tMin += 20) derive(tMin);

    const samples: number[] = [];
    let busiest = 0;
    let busiestAt = 0;

    // Walk the day at 5-minute steps, which is the track fix interval, so every
    // sampling branch gets exercised.
    for (let tMin = 0; tMin <= end; tMin += 5) {
      const started = performance.now();
      const vehicles = derive(tMin);
      samples.push(performance.now() - started);
      if (vehicles.length > busiest) {
        busiest = vehicles.length;
        busiestAt = tMin;
      }
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const worst = sorted[sorted.length - 1] ?? 0;

    // eslint-disable-next-line no-console
    console.log(
      `liveVehiclesAt over ${samples.length} ticks: median ${median.toFixed(3)} ms, ` +
        `p90 ${p90.toFixed(3)} ms, worst ${worst.toFixed(3)} ms; ` +
        `busiest clock ${busiestAt} min with ${busiest} vehicles`,
    );

    expect(p90).toBeLessThan(TICK_P90_BUDGET_MS);
    expect(median).toBeLessThan(TICK_MEDIAN_BUDGET_MS);
  });

  it('never puts more vehicles on screen than there are tracks', () => {
    const busiest = Math.max(
      ...Array.from({ length: 93 }, (_, i) => derive(i * 5).length),
    );
    expect(busiest).toBeLessThanOrEqual(tracks.length);
    expect(busiest).toBeGreaterThan(0);
  });
});
