/* The polar grid: roads and range rings. The north mark stays fixed in Radar.
 *
 * Memoised on the scale alone, because none of it moves with the clock. That is
 * the single biggest thing keeping the map cheap during playback: roughly 40
 * static nodes are built once per scale change.
 */

import { memo } from 'react';
import { MAJOR_BEARINGS, ringsFor, VIEW, type Projection } from '@/domain/polar';

/** Ring labels sit off the 022.5 bearing so they never collide with a spoke. */
const LABEL_BEARING = 22.5;

export const GridLayer = memo(function GridLayer({ projection, extentKm = projection.scaleKm }: {
  projection: Projection;
  extentKm?: number;
}) {
  const rings = ringsFor(projection.scaleKm, extentKm);
  const roadEdge = Math.max(projection.scaleKm, extentKm) * 1.02;

  return (
    <g aria-hidden="true">
      {/* The eight approach roads, drawn as broad pale bands rather than lines:
          the zones sit on them, so they read as terrain, not as graticule. */}
      {MAJOR_BEARINGS.map((bearing) => {
        const [x, y] = projection.polar(bearing, roadEdge);
        return (
          <line
            key={`road-${bearing}`}
            x1={VIEW.cx}
            y1={VIEW.cy}
            x2={x}
            y2={y}
            stroke="#e5e9ef"
            strokeWidth={bearing % 90 === 0 ? 10 : 6}
          />
        );
      })}

      {rings.map((k) => {
        const [lx, ly] = projection.polar(LABEL_BEARING, k);
        return (
          <g key={`ring-${k}`}>
            <circle
              cx={VIEW.cx}
              cy={VIEW.cy}
              r={projection.radius(k * 1000)}
              fill="none"
              stroke="var(--hairline)"
              strokeWidth={1}
              strokeDasharray="3 5"
            />
            <text x={lx + 3} y={ly - 3} fontSize={9} fill="var(--ink-muted)">
              {k} km
            </text>
          </g>
        );
      })}

    </g>
  );
});
