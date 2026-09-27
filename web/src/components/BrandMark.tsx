/* The SUYLA mark, in one place so the header and the sign-in screen agree.
 *
 * It prefers the real artwork at /logo-suyla.png. Until that file is in
 * web/public it draws the stand-in below -- an approximation of the mark
 * (shield, spread wings, eagle) simplified to what survives at 24 px in a
 * header. Dropping the real file in replaces it everywhere, with no code
 * change: the <img> stops erroring and wins.
 */

import { memo, useState } from 'react';
import { T } from '@/domain/strings';

export interface BrandMarkProps {
  /** Rendered height in pixels. The mark keeps its own aspect. */
  height: number;
  className?: string;
  /**
   * Set the name beneath the stand-in. Only the stand-in: the real artwork
   * already carries the wordmark, and printing it twice reads as a mistake.
   */
  wordmark?: boolean;
}

/* Four swept feathers, the shield, and the eagle. Angular throughout: the mark
 * is drawn with straight cuts rather than curves, and that is what reads. */
const FEATHERS = [
  'M50 31 L11 7 L20 22 L52 39 Z',
  'M50 40 L7 25 L17 38 L52 48 Z',
  'M50 49 L11 43 L22 54 L52 57 Z',
  'M50 57 L17 60 L28 67 L52 65 Z',
];

const SHIELD = 'M52 28 L80 19 L108 28 L108 56 L94 74 L80 88 L66 74 L52 56 Z';
const CHEVRON = 'M66 47 L80 59 L94 47 L94 58 L80 70 L66 58 Z';
const EAGLE = 'M72 23 L80 11 L90 13 L95 20 L106 24 L95 29 L85 31 L74 29 Z';

export const BrandMark = memo(function BrandMark({
  height,
  className,
  wordmark = false,
}: BrandMarkProps) {
  const [missing, setMissing] = useState(false);

  if (!missing) {
    return (
      <img
        className={className}
        src="/logo-suyla.png"
        alt={T.login.brand}
        style={{ height, width: 'auto' }}
        onError={() => setMissing(true)}
      />
    );
  }

  const drawn = (
    <svg
      className={className}
      viewBox="0 0 160 96"
      height={height}
      width={(height * 160) / 96}
      role="img"
      aria-label={T.login.brand}
      fill="currentColor"
    >
      {FEATHERS.map((d) => <path key={d} d={d} />)}
      {/* The right wing is the left one flipped about the centre line. */}
      <g transform="translate(160 0) scale(-1 1)">
        {FEATHERS.map((d) => <path key={d} d={d} />)}
      </g>
      <path d={SHIELD} fill="none" stroke="currentColor" strokeWidth={4} strokeLinejoin="round" />
      <path d={CHEVRON} opacity={0.55} />
      <path d={EAGLE} />
    </svg>
  );

  if (!wordmark) return drawn;
  return (
    <span className="brand-mark">
      {drawn}
      <span className="brand-mark__wordmark">{T.login.brand}</span>
    </span>
  );
});
