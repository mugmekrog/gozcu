import { describe, expect, it } from 'vitest';
import { alphaOf, coverAt, HEAT_RAMP, LUT_SIZE, RAMP_TABLES } from './HeatLayer';
import { WEIGHTS } from '@/domain/pressure';

/* The colour rule from tokens.css: colour means risk, and nothing else in the
 * interface may be read as a level. The heat ramp is admissible only because it
 * stays clear of the hues that already carry meaning here -- so that is pinned,
 * not left to whoever next reaches for a warmer palette. */
const TAKEN = {
  threat: '#fc3030',
  review: '#f2c94c',
  safe: '#1981e6',
  terrain: '#3a913f',
} as const;

/**
 * `--map-land`: what the field is drawn over. It was `--surface-map` (#f8f9fa)
 * until the OpenStreetMap basemap went under the radar; the land is darker, so
 * this is the harder floor for a lone vehicle's heat to clear.
 */
const MAP = '#e9ecef';

/** The field reference measured on the shipped export (PLAN 6.12). */
const SHIPPED_REFERENCE = 20.86;

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** What the filter paints at an accumulated density, composited over the map. */
function paintedAt(d: number): Rgb {
  const i = Math.round(d * (LUT_SIZE - 1));
  const channel = (table: string) => Number(table.split(' ')[i]);
  const colour: Rgb = [channel(RAMP_TABLES.r), channel(RAMP_TABLES.g), channel(RAMP_TABLES.b)];
  const cover = channel(RAMP_TABLES.a);
  const ground = rgb(MAP);
  return [0, 1, 2].map((k) => colour[k]! * cover + ground[k]! * (1 - cover)) as Rgb;
}

describe('the heat ramp', () => {
  it('stays clear of every hue that already means something', () => {
    // A blue-yellow-red heat scale fails this on purpose: red would then mean
    // both "threat" and "busy" on the one screen where that must not happen.
    for (const stop of HEAT_RAMP) {
      for (const [name, colour] of Object.entries(TAKEN)) {
        expect(hueGap(hue(stop), hue(colour)), `${stop} against ${name}`).toBeGreaterThan(30);
      }
    }
  });

  it('darkens monotonically as density rises, so it reads as a sequence', () => {
    const l = HEAT_RAMP.map((hex) => luminance(rgb(hex)));
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1]!);
  });
});

describe('the lookup', () => {
  it('has one entry per sample in every table, and zero density stays clear', () => {
    for (const table of Object.values(RAMP_TABLES)) {
      expect(table.split(' ')).toHaveLength(LUT_SIZE);
    }
    // Otherwise the filter paints its whole region and the map disappears
    // under a tint.
    expect(coverAt(0)).toBe(0);
  });

  it('never gets lighter as density rises', () => {
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const here = luminance(paintedAt(i / 20));
      expect(here).toBeLessThanOrEqual(last + 1e-9);
      last = here;
    }
  });

  it('shows a lone CLEAR vehicle on the map, not only a convoy', () => {
    // Reported from the browser: the field was there but did not read on the
    // near-white map. The previous cut painted a lone vehicle at a contrast of
    // about 1.07 against the ground -- present, and invisible. A lone CLEAR is
    // the faintest thing the field ever draws, so it sets the floor.
    const lone = alphaOf(WEIGHTS.CLEAR, SHIPPED_REFERENCE);
    expect(contrast(paintedAt(lone), rgb(MAP))).toBeGreaterThan(1.3);
  });

  it('keeps an ALERT clearly deeper than a CLEAR', () => {
    // The weighting is visible, not merely computed.
    const clear = paintedAt(alphaOf(WEIGHTS.CLEAR, SHIPPED_REFERENCE));
    const alert = paintedAt(alphaOf(WEIGHTS.ALERT, SHIPPED_REFERENCE));
    expect(contrast(alert, clear)).toBeGreaterThan(1.3);
  });
});
