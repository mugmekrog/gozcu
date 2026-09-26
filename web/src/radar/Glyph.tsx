/* The risk symbol.
 *
 * Compact risk glyph used by badges and modal rows. Map vehicle symbols are
 * drawn separately, with shape for class and colour for warning level.
 */

import { memo } from 'react';
import { riskStyle, type RiskBand, type RiskShape } from '@/domain/risk';

export interface GlyphProps {
  x: number;
  y: number;
  band: RiskBand;
  /** Nominal half-size in SVG units. Shapes are matched for visual weight. */
  size?: number;
  /** Override the fill, for the greyed-out and pinned treatments. */
  fill?: string;
  opacity?: number;
  strokeWidth?: number;
  stroke?: string;
}

/** Shape geometry, tuned so a triangle and a square read as the same weight. */
function path(shape: RiskShape, x: number, y: number, s: number) {
  switch (shape) {
    case 'triangle':
      return (
        <polygon points={`${x},${y - s * 1.3} ${x + s * 1.2},${y + s * 0.9} ${x - s * 1.2},${y + s * 0.9}`} />
      );
    case 'circle':
      return <circle cx={x} cy={y} r={s} />;
    case 'square':
      return <rect x={x - s * 0.8} y={y - s * 0.8} width={s * 1.6} height={s * 1.6} />;
    case 'none':
      // An unassessed track: a small hollow dot. Deliberately not one of the
      // three risk shapes, so "not yet judged" never reads as "judged safe".
      return <circle cx={x} cy={y} r={s * 0.55} fill="none" />;
  }
}

export const Glyph = memo(function Glyph({
  x,
  y,
  band,
  size = 5,
  fill,
  opacity = 1,
  strokeWidth = 1,
  stroke = '#ffffff',
}: GlyphProps) {
  const style = riskStyle(band);
  const shape = style.shape;
  const colour = fill ?? style.color;

  if (shape === 'none') {
    return (
      <g opacity={opacity}>
        <circle cx={x} cy={y} r={size * 0.55} fill="none" stroke={colour} strokeWidth={1} />
      </g>
    );
  }

  return (
    <g fill={colour} stroke={stroke} strokeWidth={strokeWidth} opacity={opacity}>
      {path(shape, x, y, size)}
    </g>
  );
});

/** The same symbol at a fixed size, for legends, tables and badges. */
export const GlyphChip = memo(function GlyphChip({
  band,
  size = 11,
}: {
  band: RiskBand;
  size?: number;
}) {
  const style = riskStyle(band);
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <Glyph x={6} y={6} band={style.band} size={4.6} strokeWidth={0} stroke="none" />
    </svg>
  );
});
