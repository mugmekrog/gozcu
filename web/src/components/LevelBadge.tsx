/* The level badge: glyph, word, and optionally the score.
 *
 * Filled for the band that demands action now, outlined for the rest. The glyph
 * is always present, so the badge survives being read in greyscale -- which is
 * the state a projector at the back of a room effectively renders it in.
 */

import { memo } from 'react';
import { riskStyle, type RiskBand } from '@/domain/risk';
import { T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import './level-badge.css';

export interface LevelBadgeProps {
  band: RiskBand;
  score?: number | null;
  size?: 'small' | 'default';
}

const WORD: Record<RiskBand, string> = {
  critical: T.band.critical,
  high: T.band.high,
  review: T.band.review,
  low: T.band.low,
  unassessed: T.band.unassessed,
  empty: T.band.empty,
};

export const LevelBadge = memo(function LevelBadge({
  band,
  score = null,
  size = 'default',
}: LevelBadgeProps) {
  const style = riskStyle(band);
  const dashed = band === 'unassessed';
  const quiet = band === 'unassessed' || band === 'empty';

  // Amber is too light to carry white text; the filled review badge takes the
  // deep amber ink instead, which holds 7:1 against its own fill.
  const ink = style.filled
    ? band === 'review'
      ? 'var(--risk-review-deep)'
      : 'var(--ink-inverse)'
    : quiet
      ? 'var(--ink-muted)'
      : 'var(--ink)';

  return (
    <span
      className={`level-badge level-badge--${size}${style.filled ? ' level-badge--filled' : ''}`}
      style={{
        background: style.filled ? style.color : 'var(--surface)',
        borderStyle: dashed ? 'dashed' : 'solid',
        borderColor: quiet ? 'var(--control-border)' : style.color,
        color: ink,
      }}
    >
      {style.shape !== 'none' && (
        <span
          className="level-badge__glyph"
          aria-hidden="true"
          style={{ color: style.filled ? 'currentColor' : style.color }}
        >
          {style.glyph}
        </span>
      )}
      {WORD[band]}
      {score != null && band !== 'unassessed' && band !== 'empty' && (
        <>
          {' · '}
          {fmt.count(score)}
        </>
      )}
    </span>
  );
});
