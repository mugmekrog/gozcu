/* The zone pressure field: the density view's arithmetic (PLAN 6.12).
 *
 * The map answers "where is each vehicle". It never answered "which zone is
 * under pressure right now", and counting glyphs around eight rings by eye is
 * exactly the judgement a reviewer gets wrong under time pressure.
 *
 * This is a second reading of the same live set the glyph layer draws -- it
 * takes `LiveVehicle[]` and never re-reads tracks, so the heat and the symbols
 * cannot disagree about who is on screen. Pure, like the rest of `domain/`: no
 * React, and the projection is the caller's business.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * 1. The field is *risk-weighted*, so one approaching threat outweighs three
 *    parked cars. A vehicle whose own frame has not been captured yet has no
 *    level at all, and counts as present-but-unjudged rather than as zero:
 *    dropping it would make the early clocks look emptier than the ground truth.
 *
 * 2. Normalisation is against the whole exercise, not the current tick. This is
 *    the one mistake in the feature that looks plausible while lying -- dividing
 *    by the current clock's peak makes every minute of the day equally hot, so a
 *    single parked car at 08:10 renders as deep as a seven-vehicle build-up at
 *    13:50. `referenceOf` is computed once, over the window, and every tick is
 *    drawn against it. `I_ref is stable across ticks` is a test for that reason.
 */

import type { LiveVehicle } from './live';
import type { Enu, Level, Zone } from './types';

/**
 * Kernel width, in metres.
 *
 * The scale at which two vehicles read as one cluster rather than two. This is
 * a *drawing* scale and nothing else: the zone readout below does not use it.
 *
 * An earlier version of this file claimed the zone geometry bounded it, on a
 * misreading -- the shipped thresholds are a 250 m radius with a 750 m buffer, so
 * a zone's catchment is a full kilometre across, and at sigma = 350 m a vehicle
 * sitting on the buffer edge contributes 1.7 % at the centre. Sampling the
 * Gaussian at zone centres therefore measured almost nothing, which is why the
 * readout is a catchment count instead.
 */
export const SIGMA_M = 350;

/** Beyond this many sigmas a blob contributes under 2 % and is not drawn. */
export const KERNEL_CUTOFF_SIGMAS = 2.5;

/** Risk weights. The feature, not decoration -- see decision 1 above. */
export const WEIGHTS: Record<Level, number> = { ALERT: 3, WATCH: 2, CLEAR: 1 };

/** A vehicle whose frame has not been captured yet: present, but unjudged. */
export const UNJUDGED_WEIGHT = 1;

export function weightOf(level: Level | null): number {
  return level === null ? UNJUDGED_WEIGHT : WEIGHTS[level];
}

/** One weighted vehicle position. The only input the field needs. */
export interface Blob {
  /** The track id, so the layer can key on identity rather than on an index. */
  id: string;
  enu: Enu;
  weight: number;
}

export function blobsOf(vehicles: readonly LiveVehicle[]): Blob[] {
  return vehicles.map((vehicle) => ({
    id: vehicle.trackId,
    enu: vehicle.sample.enu,
    weight: weightOf(vehicle.level),
  }));
}

/** The field at one ground point: a sum of weighted Gaussians. */
export function pressureAt(point: Enu, blobs: readonly Blob[], sigmaM = SIGMA_M): number {
  const denom = 2 * sigmaM * sigmaM;
  let sum = 0;
  for (const blob of blobs) {
    const de = point.e_m - blob.enu.e_m;
    const dn = point.n_m - blob.enu.n_m;
    sum += blob.weight * Math.exp(-(de * de + dn * dn) / denom);
  }
  return sum;
}

/**
 * The peak of one clock's field.
 *
 * Evaluated at the blob centres rather than over a grid: the maximum of a sum of
 * Gaussians always sits near a data point, so this is cheap, deterministic, and
 * within a few percent of the true peak -- which is all a normalisation
 * reference has to be. A grid sweep would cost the boot pass a hundredfold for
 * no visible difference.
 */
export function peakOf(blobs: readonly Blob[], sigmaM = SIGMA_M): number {
  let peak = 0;
  for (const blob of blobs) {
    const here = pressureAt(blob.enu, blobs, sigmaM);
    if (here > peak) peak = here;
  }
  return peak;
}

/**
 * Minutes between the clocks the reference is sampled at.
 *
 * Five, not the frame cadence. Sampling only the 40 capture minutes would miss
 * every clock between them -- and a track carries two hours of history, so
 * vehicles are live at clocks no image was taken at. A reference blind to those
 * clocks makes them saturate at the top of the ramp, which reads as "as busy as
 * the day ever got" on a minute that was not.
 */
export const REFERENCE_STEP_MIN = 5;

/** The clocks the boot pass walks. Inclusive of both ends of the window. */
export function referenceClocks(
  startMin: number,
  endMin: number,
  stepMin = REFERENCE_STEP_MIN,
): number[] {
  const out: number[] = [];
  for (let t = startMin; t <= endMin; t += stepMin) out.push(t);
  return out;
}

/**
 * The fixed reference: the busiest clock's peak across the whole exercise.
 *
 * Computed once at boot from one blob set per sampled clock. Deliberately
 * independent of the filters -- narrowing to one zone should *reduce* the heat
 * on screen, showing that zone's share of the day's worst moment, not rescale
 * itself so the quietest corner looks as hot as the convoy.
 *
 * Returns 0 for an empty exercise, and callers treat a 0 reference as "no heat"
 * rather than dividing by it.
 */
export function referenceOf(clocks: readonly (readonly Blob[])[], sigmaM = SIGMA_M): number {
  let ref = 0;
  for (const blobs of clocks) {
    const peak = peakOf(blobs, sigmaM);
    if (peak > ref) ref = peak;
  }
  return ref;
}

/**
 * The weighted pressure on one zone: everything inside its own catchment.
 *
 * Not a Gaussian sample at the zone centre. That was the first cut, and running
 * it over the real export showed why it cannot work: the zones' catchment is a
 * kilometre across (250 m radius, 750 m buffer) while the drawing kernel is
 * 350 m, so a vehicle sitting right on the buffer edge -- exactly the vehicle a
 * reviewer is watching -- registered under 2 % at the centre. Five of the eight
 * zones printed 0.000 at the busiest clock of the day.
 *
 * A catchment count is also the honest meaning of the question. "Pressure on
 * this zone" is *how much is inside the ring that raises a warning*, and radius
 * plus buffer is the same geometry the rule engine already uses (PLAN 6.6, 6.7),
 * so the readout and the warnings cannot tell different stories. Per zone, since
 * a zone carries its own radius and buffer.
 */
export function zoneCatchmentOf(zone: Zone, blobs: readonly Blob[]): number {
  const reach = zone.radius_m + zone.buffer_m;
  let sum = 0;
  for (const blob of blobs) {
    const de = zone.enu.e_m - blob.enu.e_m;
    const dn = zone.enu.n_m - blob.enu.n_m;
    if (Math.hypot(de, dn) <= reach) sum += blob.weight;
  }
  return sum;
}

/** The most pressed zone's catchment at one clock. */
export function zonePeakOf(zones: readonly Zone[], blobs: readonly Blob[]): number {
  let peak = 0;
  for (const zone of zones) {
    const here = zoneCatchmentOf(zone, blobs);
    if (here > peak) peak = here;
  }
  return peak;
}

/**
 * The two references, from one walk of the window.
 *
 * They have to be separate, and this was found by running the thing on the real
 * export rather than reasoned out in advance. The field peaks where vehicles
 * cluster -- on the roads between the zones -- while the zones sit on a 3.2 km
 * ring, and at sigma = 350 m a vehicle a kilometre away contributes under 2 %.
 * Measured on the shipped data: the busiest clock's field peak is 20.9 while the
 * most-pressed zone centre reads 2.3, so scaling the zone readout by the field's
 * peak buries every zone in the bottom tenth of the scale and prints 0.000 for
 * five of the eight. The ranking is then correct and useless, which is the worst
 * kind of number to put on a control that claims to explain itself.
 *
 * So the field keeps the map's scale, and the readout gets its own: the worst
 * any zone centre got, all day.
 */
export interface References {
  /** For drawing the field: the busiest clock's peak anywhere on the map. */
  field: number;
  /** For the per-zone readout: the worst any zone centre got, all day. */
  zone: number;
}

export function referencesOf(
  zones: readonly Zone[],
  clocks: readonly (readonly Blob[])[],
  sigmaM = SIGMA_M,
): References {
  let field = 0;
  let zone = 0;
  for (const blobs of clocks) {
    const f = peakOf(blobs, sigmaM);
    if (f > field) field = f;
    const z = zonePeakOf(zones, blobs);
    if (z > zone) zone = z;
  }
  return { field, zone };
}

/** A value in 0..1 against the reference. Saturates rather than overflowing. */
export function normalise(value: number, reference: number): number {
  if (!(reference > 0)) return 0;
  return Math.min(1, value / reference);
}

export interface ZonePressure {
  zoneId: string;
  name: string;
  /** Weighted vehicles inside the zone's radius + buffer. Countable, not scaled. */
  weight: number;
  /** That catchment against the worst any zone carried all day, 0..1. */
  value: number;
}

/**
 * The per-zone readout, most pressed first.
 *
 * This -- not the picture -- is what the toggle's caption and the screen-reader
 * text say out loud. A reviewer who cannot read a gradient still gets the
 * ranking, and `weight` gives it in vehicles rather than in a fraction.
 */
export function zonePressures(
  zones: readonly Zone[],
  blobs: readonly Blob[],
  reference: number,
): ZonePressure[] {
  return zones
    .map((zone) => ({
      zoneId: zone.zone_id,
      name: zone.name,
      weight: zoneCatchmentOf(zone, blobs),
      value: normalise(zoneCatchmentOf(zone, blobs), reference),
    }))
    .sort((a, b) => b.value - a.value);
}

/** The zone under the most pressure, or null when nothing is on screen. */
export function densestZone(rows: readonly ZonePressure[]): ZonePressure | null {
  const top = rows[0];
  return top && top.value > 0 ? top : null;
}
