/* Risk presentation: level -> shape, colour and badge.
 *
 * This is the one place that decides how a risk level looks. Every screen -- map
 * symbol, table glyph, badge, timeline diamond, modal frame -- reads from here,
 * so the promise that "colour means risk" is enforced by construction rather
 * than by remembering.
 *
 * Accessibility (PLAN 7.3.1): level is carried by *shape as well as colour*.
 * The glyph is never decoration -- it is the redundant encoding, so the display
 * survives a colour-blind reviewer and a badly calibrated projector.
 */

import type { Level } from './types';

/** How the interface bands risk. Four bands over three engine levels. */
export type RiskBand = 'critical' | 'high' | 'review' | 'low' | 'unassessed' | 'empty';

export type RiskShape = 'triangle' | 'circle' | 'square' | 'none';

export interface RiskStyle {
  band: RiskBand;
  shape: RiskShape;
  /** The text glyph, for tables and badges where an SVG would be overkill. */
  glyph: string;
  /** CSS custom-property reference for the risk hue. */
  color: string;
  /** A hue dark enough for body text on white. */
  textColor: string;
  /** True when the badge is a filled field rather than an outline. */
  filled: boolean;
}

/**
 * The score at which an ALERT reads as critical rather than high.
 *
 * 70 is the wireframe's own boundary: it shows 78/100 as KRITIK and treats the
 * rules-only 73 the same way. It splits ALERT for *display density* only -- both
 * bands are the same engine level and both raise the same modal, so nothing
 * about the warning depends on this number.
 */
export const CRITICAL_SCORE = 70;

const STYLES: Record<RiskBand, RiskStyle> = {
  critical: {
    band: 'critical',
    shape: 'triangle',
    glyph: '▲',
    color: 'var(--risk-threat)',
    textColor: 'var(--risk-threat-ink)',
    filled: true,
  },
  high: {
    band: 'high',
    shape: 'triangle',
    glyph: '▲',
    color: 'var(--risk-threat)',
    textColor: 'var(--risk-threat-ink)',
    filled: false,
  },
  review: {
    band: 'review',
    shape: 'circle',
    glyph: '●',
    color: 'var(--risk-review)',
    textColor: 'var(--risk-review-ink)',
    filled: true,
  },
  low: {
    band: 'low',
    shape: 'square',
    glyph: '■',
    color: 'var(--risk-safe)',
    textColor: 'var(--risk-safe-ink)',
    filled: false,
  },
  unassessed: {
    band: 'unassessed',
    shape: 'none',
    glyph: '·',
    color: 'var(--ink-faint)',
    textColor: 'var(--ink-muted)',
    filled: false,
  },
  empty: {
    band: 'empty',
    shape: 'none',
    glyph: '—',
    color: 'var(--ink-faint)',
    textColor: 'var(--ink-muted)',
    filled: false,
  },
};

/** The band for an engine level plus its 0-100 score. */
export function bandOf(level: Level | null, score = 0): RiskBand {
  if (level === null) return 'unassessed';
  if (level === 'ALERT') return score >= CRITICAL_SCORE ? 'critical' : 'high';
  if (level === 'WATCH') return 'review';
  return 'low';
}

export function riskStyle(band: RiskBand): RiskStyle {
  return STYLES[band];
}

export function styleOf(level: Level | null, score = 0): RiskStyle {
  return STYLES[bandOf(level, score)];
}

/** Sort key: worst first, then by score. Used by the queue and every table. */
export function riskRank(level: Level | null): number {
  switch (level) {
    case 'ALERT':
      return 3;
    case 'WATCH':
      return 2;
    case 'CLEAR':
      return 1;
    default:
      return 0;
  }
}

/** The map symbol a level draws, as a shape only. Deliberately not a colour. */
export function shapeOf(level: Level | null): RiskShape {
  switch (level) {
    case 'ALERT':
      return 'triangle';
    case 'WATCH':
      return 'circle';
    case 'CLEAR':
      return 'square';
    default:
      return 'none';
  }
}

/**
 * Which modal a finished evaluation opens, if any.
 *
 * ALERT opens the red decision modal. A WATCH whose agent and baseline disagree
 * opens the amber "human review" modal, because that is precisely the case the
 * wireframe reserves it for: the agent could not settle the question and is
 * asking. A WATCH the rules and agent agree on stays in the queue.
 */
export function modalFor(
  level: Level,
  opts: { agentDisagrees: boolean } = { agentDisagrees: false },
): 'threat' | 'review' | null {
  if (level === 'ALERT') return 'threat';
  if (level === 'WATCH' && opts.agentDisagrees) return 'review';
  return null;
}
