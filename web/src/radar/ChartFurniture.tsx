/* The fixed marks of a chart: north arrow, scale bar and the base's position.
 *
 * Drawn outside the panned group, so they stay in the corners of the view while
 * the map moves under them. The scale bar picks the longest round distance that
 * fits, so it always reads as a whole number of metres or kilometres. The
 * bottom-left stack sits above the basemap attribution line, which owns the
 * last row; the bottom-right corner belongs to the heat toggle.
 */

import { memo } from 'react';
import { VIEW, type Projection } from '@/domain/polar';

/** Round distances the scale bar may show, in kilometres. */
const NICE_KM = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10] as const;
/** The scale bar never grows past this many SVG units. */
const MAX_BAR = 150;

const INSET = 20;

/** Text readable over the map: a halo in the ground colour behind each glyph. */
const halo = (ground: string) => ({
  stroke: ground,
  strokeWidth: 3,
  strokeLinejoin: 'round' as const,
  paintOrder: 'stroke' as const,
});

function barLabel(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString('tr-TR')} km`;
}

/** Decimal degrees with the Turkish hemisphere letter: K/G latitude, D/B longitude. */
function coord(value: number, positive: string, negative: string): string {
  const text = Math.abs(value).toLocaleString('tr-TR', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  return `${text}° ${value >= 0 ? positive : negative}`;
}

export const ChartFurniture = memo(function ChartFurniture({
  projection,
  base,
  ground = 'var(--surface-map)',
}: {
  projection: Projection;
  base: { name: string; lat: number; lon: number };
  /** The colour under the marks, for the text halo and the hollow bar half. */
  ground?: string;
}) {
  const HALO = halo(ground);
  const km = [...NICE_KM].reverse().find((k) => k * projection.unitsPerKm <= MAX_BAR) ?? NICE_KM[0];
  const bar = km * projection.unitsPerKm;
  const half = bar / 2;
  const bx = INSET;
  // Bottom-left, stacked: scale bar, then the coordinates line, then (owned by
  // the basemap) the attribution on the last row at VIEW.h - 8.
  const coordY = VIEW.h - 22;
  const by = coordY - 16;

  // North arrow, top right: a split needle, dark half pointing north.
  const nx = VIEW.w - INSET - 10;
  const ny = INSET + 18;

  return (
    <g aria-hidden="true" className="radar-furniture">
      <g>
        <path d={`M${nx} ${ny - 16} L${nx + 6} ${ny + 6} L${nx} ${ny + 2} Z`} fill="var(--ink)" />
        <path
          d={`M${nx} ${ny - 16} L${nx - 6} ${ny + 6} L${nx} ${ny + 2} Z`}
          fill={ground}
          stroke="var(--ink)"
          strokeWidth={0.9}
          strokeLinejoin="round"
        />
        <text
          x={nx}
          y={ny - 21}
          textAnchor="middle"
          fontSize={11}
          fontWeight={800}
          fill="var(--ink)"
          {...HALO}
        >
          K
        </text>
      </g>

      <g>
        <rect x={bx} y={by - 4} width={half} height={4} fill="var(--ink)" />
        <rect
          x={bx + half}
          y={by - 4}
          width={half}
          height={4}
          fill={ground}
          stroke="var(--ink)"
          strokeWidth={0.8}
        />
        <rect x={bx} y={by - 4} width={bar} height={4} fill="none" stroke="var(--ink)" strokeWidth={0.8} />
        <text x={bx} y={by - 9} fontSize={8.5} fill="var(--ink-muted)" {...HALO}>
          0
        </text>
        <text
          x={bx + bar}
          y={by - 9}
          textAnchor="end"
          fontSize={8.5}
          fontWeight={700}
          fill="var(--ink-body)"
          {...HALO}
        >
          {barLabel(km)}
        </text>
      </g>

      <text
        x={bx}
        y={coordY}
        fontSize={8.5}
        letterSpacing={0.4}
        fill="var(--ink-muted)"
        {...HALO}
      >
        {`${base.name.toLocaleUpperCase('tr-TR')} · ${coord(base.lat, 'K', 'G')} · ${coord(base.lon, 'D', 'B')}`}
      </text>
    </g>
  );
});
