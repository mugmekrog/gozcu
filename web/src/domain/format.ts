/* Number, distance and time formatting.
 *
 * The interface is Turkish, so a decimal comma is not a preference here -- "1,57
 * km" is the correct rendering and "1.57 km" reads as a thousands separator to
 * the operator this is built for. Every figure on screen goes through one of
 * these so the whole display agrees on precision and on separator.
 */

const nf = (min: number, max: number) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: min, maximumFractionDigits: max });

const NF_0 = nf(0, 0);
const NF_1 = nf(1, 1);
const NF_2 = nf(2, 2);

/** Metres to the reading the operator wants: km past 1 km, metres below it. */
export function distance(metres: number | null | undefined): string {
  if (metres == null || !Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${NF_0.format(Math.round(metres))} m`;
  return `${NF_2.format(metres / 1000)} km`;
}

/** Always km, for columns that must align. */
export function km(metres: number | null | undefined, digits = 2): string {
  if (metres == null || !Number.isFinite(metres)) return '—';
  return `${nf(digits, digits).format(metres / 1000)} km`;
}

export function speed(mps: number | null | undefined): string {
  if (mps == null || !Number.isFinite(mps)) return '—';
  return `${NF_1.format(mps)} m/s`;
}

export function speedKmh(mps: number | null | undefined): string {
  if (mps == null || !Number.isFinite(mps)) return '—';
  return `${NF_0.format(mps * 3.6)} km/sa`;
}

/**
 * Seconds to an approximate minute count.
 *
 * Deliberately approximate: an ETA derived from a constant-velocity fit over
 * four track points does not support "6,4 dk", and printing it that way would
 * claim precision the geometry does not have.
 */
export function eta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return '<1 dk';
  return `~${NF_0.format(Math.round(seconds / 60))} dk`;
}

export function minutes(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return '—';
  return `${NF_0.format(Math.round(count))} dk`;
}

/** Minutes from the exercise origin to a wall clock. */
export function clockOf(originIso: string, minutesFromOrigin: number): string {
  const ms = Date.parse(originIso) + minutesFromOrigin * 60_000;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** A wall clock back to minutes from the exercise origin. */
export function minutesOf(originIso: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const origin = new Date(Date.parse(originIso));
  const base = origin.getUTCHours() * 60 + origin.getUTCMinutes();
  return (h ?? 0) * 60 + (m ?? 0) - base;
}

export function percent(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `%${NF_0.format(Math.round(fraction * 100))}`;
}

export function confidence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return NF_2.format(value);
}

export function signed(points: number): string {
  return points >= 0 ? `+${NF_0.format(points)}` : NF_0.format(points);
}

export function count(value: number): string {
  return NF_0.format(value);
}

/** Heading in degrees to a compass point plus the figure. */
export function heading(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return '—';
  const points = ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return `${points[idx]} ${NF_0.format(Math.round(deg))}°`;
}
