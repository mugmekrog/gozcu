/* The polar grid: range rings over the map. The north mark stays fixed in Radar.
 *
 * Memoised on the scale alone, because none of it moves with the clock.
 *
 * This layer used to paint eight broad pale bands down the zone bearings as
 * "approach roads". With the real city underneath (BasemapLayer) those bands
 * would lie across actual streets, so they are gone; the rings stay, faint, as
 * the tactical reading of range from the base.
 */

import { memo } from 'react';
import { ringsFor, VIEW, type Projection } from '@/domain/polar';

/** Ring labels sit off the 022.5 bearing so they never collide with a spoke. */
const LABEL_BEARING = 22.5;

export const GridLayer = memo(function GridLayer({ projection, extentKm = projection.scaleKm }: {
  projection: Projection;
  extentKm?: number;
}) {
  const rings = [...new Set([
    ...ringsFor(projection.scaleKm, extentKm),
    ...[1, 2, 3.2].filter((km) => km <= extentKm),
  ])].sort((a, b) => a - b);

  return (
    <g aria-hidden="true">
      {rings.map((k) => {
        const [lx, ly] = projection.polar(LABEL_BEARING, k);
        return (
          <g key={`ring-${k}`}>
            <circle
              cx={VIEW.cx}
              cy={VIEW.cy}
              r={projection.radius(k * 1000)}
              fill="none"
              stroke="var(--map-ring)"
              strokeWidth={1}
              strokeDasharray="3 5"
            />
            <text className="map-label" x={lx + 3} y={ly - 3} fontSize={9} fill="var(--ink-muted)">
              {k} km
            </text>
          </g>
        );
      })}
    </g>
  );
});
