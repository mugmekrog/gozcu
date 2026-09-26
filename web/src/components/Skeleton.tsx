/* The loading placeholder.
 *
 * A shape-of-the-content skeleton rather than a spinner: the brief takes 10-15
 * seconds against a live gateway, and a skeleton tells an operator what is coming
 * and roughly how much of it, which a spinner cannot. `aria-busy` plus the note
 * carry the same information to a screen reader.
 */

import { memo } from 'react';
import './skeleton.css';

export interface SkeletonProps {
  lines?: number;
  note?: string;
}

/** Varied widths, so the block reads as text rather than as a progress bar. */
const WIDTHS = ['88%', '100%', '94%', '62%', '96%', '80%', '72%'];

export const Skeleton = memo(function Skeleton({ lines = 5, note }: SkeletonProps) {
  return (
    <div className="skeleton" aria-busy="true" role="status">
      <div className="skeleton__head">
        <span className="skeleton__badge" />
        <span className="skeleton__score" />
      </div>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="skeleton__line"
          style={{ width: WIDTHS[i % WIDTHS.length] }}
        />
      ))}
      {note && <p className="skeleton__note">{note}</p>}
    </div>
  );
});
