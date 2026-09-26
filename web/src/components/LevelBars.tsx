/* The listening animation.
 *
 * It draws the microphone's actual RMS, not a decorative loop, because the one
 * question an operator has while holding a button is whether the thing is hearing
 * them. A spinner answers that identically for a live microphone and a dead one.
 *
 * Two constraints from `tokens.css`, both obeyed rather than worked around:
 *
 *   "colour means risk. Nothing else in the interface is allowed to be coloured,
 *    so a red pixel anywhere is always a threat."
 *
 * so the bars are ink, never the amber or red they would naturally reach for. And
 * `--radius: 0`, so they are square columns on the monospace grid rather than the
 * rounded pills this kind of meter usually gets.
 *
 * The bars form a history, oldest at the left, so a glance shows the shape of the
 * last second and a half of speech rather than a single instantaneous value. The
 * history is kept in a ref and drawn through a CSS custom property per bar, which
 * is what keeps ~20 updates a second from costing 20 React reconciliations of a
 * 28-node subtree.
 *
 * Reduced motion gets a static readout instead: the frontend log's rule is that
 * motion which carries information degrades to the information, not to nothing.
 */

import { memo, useEffect, useRef } from 'react';
import { T } from '@/domain/strings';
import './level-bars.css';

export interface LevelBarsProps {
  /** 0-1, relative to the measured room noise. */
  level: number;
  /** False when the microphone is closed: the bars must not freeze mid-reading. */
  active: boolean;
  /** How many columns of history. 28 at 50 ms is about 1.4 s. */
  bars?: number;
  label?: string;
}

const DEFAULT_BARS = 28;

export const LevelBars = memo(function LevelBars({
  level,
  active,
  bars = DEFAULT_BARS,
  label,
}: LevelBarsProps) {
  const track = useRef<HTMLDivElement>(null);
  const history = useRef<number[]>(new Array(bars).fill(0));

  useEffect(() => {
    const element = track.current;
    if (!element) return;

    if (!active) {
      history.current = new Array(bars).fill(0);
    } else {
      history.current = [...history.current.slice(1), Math.min(1, Math.max(0, level))];
    }

    // Written straight to the DOM as custom properties. React re-rendering 28
    // children twenty times a second to animate a meter would be the most
    // expensive thing on the page, and the bars carry no state worth
    // reconciling.
    const columns = element.children;
    for (let i = 0; i < columns.length; i += 1) {
      const value = history.current[i] ?? 0;
      (columns[i] as HTMLElement).style.setProperty('--fill', value.toFixed(3));
    }
  }, [level, active, bars]);

  return (
    <div className="levels" data-active={active}>
      {label && <span className="levels__label">{label}</span>}
      <div
        className="levels__track"
        ref={track}
        role="meter"
        aria-label={T.voice.level}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        aria-valuetext={`${Math.round(level * 100)}%`}
      >
        {Array.from({ length: bars }, (_, index) => (
          <span className="levels__bar" key={index} aria-hidden="true" />
        ))}
      </div>

      {/* The reduced-motion and screen-reader path: the same information, in
          figures, so nothing is conveyed by movement alone. */}
      <span className="levels__readout" aria-hidden="true">
        {Math.round(level * 100)}
      </span>
    </div>
  );
});
