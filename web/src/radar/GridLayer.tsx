/* The polar grid: roads, range rings and the sweep.
 *
 * Memoised on the scale and the pan extent, because none of it moves with the clock. That is
 * the single biggest thing keeping the map cheap during playback: roughly 40
 * static nodes are built once per scale change and React skips the whole subtree
 * on every tick after that.
 */

import { memo } from 'react';
import { MAJOR_BEARINGS, ringsFor, VIEW, type Projection } from '@/domain/polar';

/** Ring labels sit off the 022.5 bearing so they never collide with a spoke. */
const LABEL_BEARING = 22.5;

export const GridLayer = memo(function GridLayer({
  projection,
  extentKm = projection.scaleKm,
}: {
  projection: Projection;
  /** How far out roads and rings reach; beyond the scale only while panned. */
  extentKm?: number;
}) {
  const rings = ringsFor(projection.scaleKm, extentKm);
  const edge = projection.scaleKm * 1.02;
  const roadEdge = Math.max(edge, extentKm * 1.02);

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

      {/* The sweep. The one piece of unprompted motion in the interface, and it
          earns its place: it is the only thing that says the display is live
          rather than a still. Suppressed under prefers-reduced-motion. */}
      <g className="radar-sweep">
        <path
          d={sweepPath(projection, edge)}
          fill="var(--terrain)"
          fillOpacity={0.07}
          stroke="var(--terrain)"
          strokeOpacity={0.35}
        />
      </g>
    </g>
  );
});

/** A 30-degree wedge from north, which the CSS animation rotates. */
function sweepPath(projection: Projection, edgeKm: number): string {
  const [x0, y0] = projection.polar(0, edgeKm);
  const [x1, y1] = projection.polar(30, edgeKm);
  const r = projection.radius(edgeKm * 1000);
  return `M${VIEW.cx} ${VIEW.cy} L${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} Z`;
}
