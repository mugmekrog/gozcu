/* The density field, drawn (PLAN 6.12, F5.2).
 *
 * One radial-gradient blob per vehicle, in a single group under the zones. The
 * choice of a continuous field over per-zone fills is the feature's point: a
 * convoy stacking up just outside a zone boundary is exactly the case a per-zone
 * number hides, and that convoy is the demo's story.
 *
 * ## How colour gets onto accumulated density
 *
 * The blobs are drawn as black-with-alpha, each alpha linear in its vehicle's
 * weight, and SVG's normal blending accumulates them where vehicles cluster --
 * the same shape as the sum `pressure.ts` computes. A filter on the group then
 * reads that accumulated alpha and looks it up in a table: `feColorMatrix`
 * copies alpha into the colour channels, and `feComponentTransfer` maps each
 * through the lookup. So the colour comes from the *total* density at a pixel,
 * not from any one vehicle. Colouring each blob separately cannot do that:
 * overlapping blobs of one colour only darken, never change hue.
 *
 * ## Why the lookup is curved, and what was wrong before
 *
 * Most of the map sits at low density -- a lone vehicle accumulates to a
 * quarter of the range at best -- and on a near-white background the low end of
 * a linear lookup is invisible. So the lookup front-loads both colour and
 * coverage: faint density already reads as a clear violet, and the ramp tops
 * out well before the table does. Because the curve is applied to the
 * *accumulated* value, it is an honest compression of the field itself.
 *
 * Two earlier cuts, recorded because both looked right in review:
 *
 * - Each blob's weight was quantised to six legend steps against the field's
 *   reference. One vehicle is worth at most 3 against ~21, so every blob landed
 *   on the bottom step: a flat 8 % wash with no variation at all.
 * - A square root was then applied per blob, because without a lookup there was
 *   no way to compress the sum. It lifted the field but was not the root of the
 *   sum, and the palest ramp stop it fed was close to white. Rejected on the real
 *   map as too faint.
 *
 * The kernel gradient was also steeper than the Gaussian it claims to draw: 0.36
 * at one sigma, where the Gaussian is 0.61. The stops below are sampled from
 * `exp(-r^2 / 2 sigma^2)` directly.
 *
 * ## Why violet into magenta
 *
 * A neutral slate with opacity carrying density was the first choice, to keep
 * `tokens.css`'s rule that colour means risk; on the real map it read as grey
 * smudge. The ramp is instead picked to stay clear of every hue that already
 * means something here -- ALERT red, WATCH amber, CLEAR blue, terrain green --
 * and `heat-ramp.test.ts` pins that, along with its darkening monotonically.
 */

import { memo } from 'react';
import { KERNEL_CUTOFF_SIGMAS, normalise, SIGMA_M, type Blob } from '@/domain/pressure';
import type { Projection } from '@/domain/polar';

/**
 * Density a vehicle adds at its own centre, per unit of weight over the
 * reference. Linear, so an ALERT adds three times a CLEAR; set so a lone ALERT
 * lands about a quarter of the way up and the day's busiest clock saturates.
 */
const DENSITY_GAIN = 1.75;

/** Below this a blob is a rounding error on screen; skip the node entirely. */
const MIN_ALPHA = 0.01;

/**
 * The density ramp, faintest to hottest.
 *
 * Starts at a violet that already reads on white -- the near-white lavender an
 * earlier cut began with vanished on the map -- and darkens into deep magenta.
 * Exported for the legend and for the test that keeps it off the risk hues.
 */
export const HEAT_RAMP = ['#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#86198f', '#701a75'] as const;

/** Entries in each lookup table. Enough that the curves interpolate smoothly. */
export const LUT_SIZE = 33;

/** Accumulated density at which the colour ramp tops out. */
const RAMP_TOP = 0.7;
/** Under 1 front-loads the ramp, so low density already reaches the violets. */
const RAMP_CURVE = 0.6;

/** Coverage at the hottest pixel. Short of opaque, so the roads stay legible. */
const MAX_COVER = 0.85;
/** Accumulated density at which coverage tops out. */
const COVER_TOP = 0.6;
/** Under 1 makes faint density visible on a near-white map. */
const COVER_CURVE = 0.55;

/** The kernel, sampled from the Gaussian at fifths of the cutoff radius. */
const KERNEL_STOPS = [0, 0.2, 0.4, 0.6, 0.8].map((f) => {
  const sigmas = f * KERNEL_CUTOFF_SIGMAS;
  return { offset: `${f * 100}%`, opacity: Math.exp(-(sigmas * sigmas) / 2) };
});

/** R = G = B = A = accumulated alpha, so each channel's table is indexed by density. */
const DENSITY_TO_CHANNELS = '0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 0';

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** The ramp at a position in 0..1, interpolated between its stops. */
function colourAt(p: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, p)) * (HEAT_RAMP.length - 1);
  const i = Math.min(HEAT_RAMP.length - 2, Math.floor(x));
  const t = x - i;
  const a = rgbOf(HEAT_RAMP[i]!);
  const b = rgbOf(HEAT_RAMP[i + 1]!);
  return [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * t) as [number, number, number];
}

/** Coverage at an accumulated density: zero at zero, rising fast, capped. */
export function coverAt(d: number): number {
  if (d <= 0) return 0;
  return MAX_COVER * Math.min(1, d / COVER_TOP) ** COVER_CURVE;
}

/**
 * `feComponentTransfer` tables: accumulated density in, colour and coverage out.
 * Evenly spaced over 0..1, which is what `type="table"` expects.
 */
export const RAMP_TABLES = (() => {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const a: number[] = [];
  for (let i = 0; i < LUT_SIZE; i++) {
    const d = i / (LUT_SIZE - 1);
    const [cr, cg, cb] = colourAt(Math.min(1, d / RAMP_TOP) ** RAMP_CURVE);
    r.push(cr);
    g.push(cg);
    b.push(cb);
    a.push(coverAt(d));
  }
  const join = (values: readonly number[]) => values.map((v) => v.toFixed(3)).join(' ');
  return { r: join(r), g: join(g), b: join(b), a: join(a) };
})();

export interface HeatLayerProps {
  blobs: readonly Blob[];
  projection: Projection;
  /** The exercise-wide field peak every tick is drawn against (PLAN 6.12). */
  reference: number;
  sigmaM?: number;
}

export const HeatLayer = memo(function HeatLayer({
  blobs,
  projection,
  reference,
  sigmaM = SIGMA_M,
}: HeatLayerProps) {
  if (!(reference > 0) || blobs.length === 0) return null;
  const radius = projection.radius(sigmaM * KERNEL_CUTOFF_SIGMAS);

  return (
    <g className="radar-heat" aria-hidden="true">
      <defs>
        {/* Black, because the filter below reads only the alpha. */}
        <radialGradient id="radar-heat-kernel">
          {KERNEL_STOPS.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor="#000" stopOpacity={stop.opacity} />
          ))}
          <stop offset="100%" stopColor="#000" stopOpacity={0} />
        </radialGradient>
        {/* sRGB, or the table values are read as linear light and every stop
            comes out washed toward white. */}
        <filter id="radar-heat-ramp" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={DENSITY_TO_CHANNELS} />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={RAMP_TABLES.r} />
            <feFuncG type="table" tableValues={RAMP_TABLES.g} />
            <feFuncB type="table" tableValues={RAMP_TABLES.b} />
            <feFuncA type="table" tableValues={RAMP_TABLES.a} />
          </feComponentTransfer>
        </filter>
      </defs>
      <g filter="url(#radar-heat-ramp)">
        {blobs.map((blob) => {
          const alpha = alphaOf(blob.weight, reference);
          if (alpha < MIN_ALPHA) return null;
          const [x, y] = projection.project(blob.enu);
          return (
            <circle
              key={blob.id}
              cx={x}
              cy={y}
              r={radius}
              fill="url(#radar-heat-kernel)"
              opacity={alpha}
            />
          );
        })}
      </g>
    </g>
  );
});

/** Density one vehicle adds at its own centre: linear in its weight. */
export function alphaOf(weight: number, reference: number): number {
  return Math.min(1, normalise(weight, reference) * DENSITY_GAIN);
}
