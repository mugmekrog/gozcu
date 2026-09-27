import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSteps, enuToLatLon } from './steps';
import type { DatasetInfo, FrameDetail } from './types';

const DIR = join(__dirname, '..', '..', 'public', 'fixtures');
const present = existsSync(join(DIR, 'frames', 'img_000860.json'));
const suite = present ? describe : describe.skip;

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, name), 'utf-8')) as T;
}

describe('enuToLatLon', () => {
  it('is the base itself at the origin and moves north with n_m', () => {
    const base = { lat: 39.92184, lon: 32.85411 };
    expect(enuToLatLon({ e_m: 0, n_m: 0 }, base)).toEqual([base.lat, base.lon]);
    const [lat, lon] = enuToLatLon({ e_m: 0, n_m: 1000 }, base);
    expect(lat - base.lat).toBeCloseTo(1000 / 111_030, 4);
    expect(lon).toBe(base.lon);
  });
});

suite('describeSteps on img_000860', () => {
  const frame = present ? read<FrameDetail>('frames/img_000860.json') : ({} as FrameDetail);
  const dataset = present ? read<DatasetInfo>('dataset.json') : null;
  const base = dataset?.base ?? null;
  const steps = present ? describeSteps(frame, { base, zones: dataset!.zones }) : null;

  it('writes one sentence and at least one value line for every step', () => {
    for (const text of Object.values(steps!)) {
      expect(text.detail).toMatch(/\.$/);
      expect(text.lines.length).toBeGreaterThan(0);
    }
  });

  it('reports the funnel the engine measured', () => {
    expect(steps!.detect.lines[0]).toContain('474 kutu');
    expect(steps!.detect.lines[0]).toContain('5 tespit');
  });

  it('follows one vehicle from its box to its track and its score', () => {
    const lead = frame.alerts.slice().sort((a, b) => b.priority - a.priority)[0]!;
    expect(steps!.tracks.lines.join('\n')).toContain(lead.track_id);
    expect(steps!.score.lines.join('\n')).toContain(`${lead.breakdown.score} puan`);
  });

  it('shows the georeferenced centre as lat/lon near the base', () => {
    const [lat] = steps!.georef.lines[1]!.split(', ').map(Number);
    expect(Math.abs(lat! - base!.lat)).toBeLessThan(0.1);
  });

  it('reads the footprint corners the image metadata records', () => {
    // image_meta.json top-left for img_000860, to the metre.
    expect(steps!.open.lines.join('\n')).toMatch(/sol üst 39\.92565\d, 32\.87072\d/);
  });

  it('places the vehicle against the zone it scores against', () => {
    const lead = frame.alerts.slice().sort((a, b) => b.priority - a.priority)[0]!;
    const zone = dataset!.zones.find((z) => z.zone_id === lead.zone_id)!;
    expect(steps!.score.lines.join('\n')).toContain(`bölge merkezi ${zone.lat.toFixed(6)}`);
  });
});
