/* Range-to-base against time.
 *
 * The one chart in the system, used twice: full width in the motion view, and
 * narrower inside the threat modal. It answers the question the whole product
 * exists for -- is the gap closing, and how fast -- so its y-axis is deliberately
 * inverted in meaning: the base is at the bottom, and a line falling towards it is
 * the thing to worry about.
 *
 * Lines are labelled at their right-hand end rather than in a legend, because a
 * legend forces the eye to translate colour into identity, and here colour is
 * already spoken for by risk. End labels are pushed apart when they would
 * collide.
 */

import { memo, useMemo } from 'react';
import { bandOf, riskStyle } from '@/domain/risk';
import * as fmt from '@/domain/format';
import { T } from '@/domain/strings';
import { Glyph } from '@/radar/Glyph';
import type { Level } from '@/domain/types';
import './range-chart.css';

export interface ChartLine {
  id: string;
  label: string;
  level: Level | null;
  score: number;
  points: { tMin: number; range_m: number }[];
  /** Selected lines are drawn heavier and labelled bold. */
  emphasis?: boolean;
  /** Overrides the risk colour; used for pinned identity colours. */
  colour?: string;
}

export interface ChartBand {
  fromMin: number;
  toMin: number;
  label: string;
}

export interface RangeChartProps {
  lines: readonly ChartLine[];
  bands?: readonly ChartBand[];
  originIso: string;
  fromMin: number;
  toMin: number;
  /** Top of the y-axis in metres. */
  maxRangeM: number;
  cursorMin?: number | null;
  width?: number;
  height?: number;
  /** Space reserved on the right for the end labels. */
  labelGutter?: number;
  onHoverLine?: (id: string | null) => void;
}

const PAD = { left: 46, top: 18, bottom: 22 };
/** Minimum vertical gap between two end labels, in SVG units. */
const LABEL_PITCH = 13;

export const RangeChart = memo(function RangeChart({
  lines,
  bands = [],
  originIso,
  fromMin,
  toMin,
  maxRangeM,
  cursorMin = null,
  width = 930,
  height = 254,
  labelGutter = 180,
  onHoverLine,
}: RangeChartProps) {
  const plotRight = width - labelGutter;
  const span = Math.max(toMin - fromMin, 1);

  const x = (minute: number) => PAD.left + ((minute - fromMin) / span) * (plotRight - PAD.left);
  const y = (metres: number) =>
    PAD.top + (1 - Math.min(metres, maxRangeM) / maxRangeM) * (height - PAD.top - PAD.bottom);

  /** Grid lines every 2 km, labelled; the zero line is the base itself. */
  const gridKm = useMemo(() => {
    const out: number[] = [];
    const stepKm = maxRangeM > 6000 ? 2 : 1;
    for (let k = 0; k * 1000 <= maxRangeM; k += stepKm) out.push(k);
    return out;
  }, [maxRangeM]);

  const timeTicks = useMemo(() => {
    const out: number[] = [];
    const first = Math.ceil(fromMin / 30) * 30;
    for (let m = first; m <= toMin; m += 30) out.push(m);
    return out;
  }, [fromMin, toMin]);

  /** End labels, spread so they do not overlap. */
  const endLabels = useMemo(() => {
    const placed = lines
      .map((line) => {
        const last = line.points[line.points.length - 1];
        if (!last) return null;
        return { line, x: x(last.tMin), y: y(last.range_m), labelY: y(last.range_m) };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.labelY - b.labelY);

    for (let i = 1; i < placed.length; i += 1) {
      const previous = placed[i - 1];
      const current = placed[i];
      if (previous && current && current.labelY - previous.labelY < LABEL_PITCH) {
        current.labelY = previous.labelY + LABEL_PITCH;
      }
    }
    return placed;
  }, [lines, fromMin, toMin, maxRangeM, width, height, labelGutter]);

  return (
    <svg
      className="range-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${T.motion.chartTitle}, ${lines.length} araç`}
    >
      {bands.map((band, i) => (
        <g key={`band-${i}`}>
          <rect
            x={x(band.fromMin)}
            y={PAD.top}
            width={Math.max(x(band.toMin) - x(band.fromMin), 1)}
            height={height - PAD.top - PAD.bottom}
            fill="var(--risk-review)"
            fillOpacity={0.28}
          />
          <text
            x={x(band.fromMin) + 4}
            y={PAD.top + 12}
            fontSize={10}
            fontWeight={700}
            fill="var(--risk-review-ink)"
          >
            {band.label}
          </text>
        </g>
      ))}

      {gridKm.map((k) => (
        <g key={`grid-${k}`}>
          <line
            x1={PAD.left}
            x2={plotRight}
            y1={y(k * 1000)}
            y2={y(k * 1000)}
            stroke={k === 0 ? 'var(--control-border)' : 'var(--rule)'}
          />
          <text
            x={PAD.left - 6}
            y={y(k * 1000) + 3}
            fontSize={10}
            fill="var(--ink-muted)"
            textAnchor="end"
          >
            {k === 0 ? T.motion.baseAxis : `${k} km`}
          </text>
        </g>
      ))}

      {timeTicks.map((minute) => (
        <text
          key={`t-${minute}`}
          x={x(minute)}
          y={height - 6}
          fontSize={10}
          fill="var(--ink-muted)"
          textAnchor="middle"
        >
          {fmt.clockOf(originIso, minute)}
        </text>
      ))}

      {lines.map((line) => {
        const colour = line.colour ?? riskStyle(bandOf(line.level, line.score)).color;
        return (
          <polyline
            key={line.id}
            className="range-chart__line"
            points={line.points.map((p) => `${x(p.tMin)},${y(p.range_m)}`).join(' ')}
            fill="none"
            stroke={colour}
            strokeWidth={line.emphasis ? 3.5 : 2}
            strokeLinejoin="round"
            strokeOpacity={line.level === null ? 0.45 : 1}
            onPointerEnter={() => onHoverLine?.(line.id)}
            onPointerLeave={() => onHoverLine?.(null)}
          />
        );
      })}

      {endLabels.map(({ line, x: px, labelY }) => (
        <g key={`end-${line.id}`}>
          <Glyph
            x={px}
            y={labelY}
            band={bandOf(line.level, line.score)}
            size={4.5}
            fill={line.colour}
            strokeWidth={0}
            stroke="none"
          />
          <text
            x={px + 10}
            y={labelY + 3.5}
            fontSize={10.5}
            fontWeight={line.emphasis ? 700 : 400}
            fill="var(--ink)"
          >
            {line.label}
          </text>
        </g>
      ))}

      {cursorMin !== null && (
        <g>
          <line
            x1={x(cursorMin)}
            x2={x(cursorMin)}
            y1={PAD.top - 6}
            y2={height - PAD.bottom}
            stroke="var(--ink)"
            strokeDasharray="4 3"
          />
          <text
            x={x(cursorMin)}
            y={PAD.top - 8}
            fontSize={10}
            fontWeight={700}
            fill="var(--ink)"
            textAnchor="middle"
          >
            {fmt.clockOf(originIso, cursorMin)}
          </text>
        </g>
      )}
    </svg>
  );
});
