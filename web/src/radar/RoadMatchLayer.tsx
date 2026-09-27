/* The selected vehicle's track, snapped to the road network.
 *
 * Drawn over the raw route (RouteLayer) rather than instead of it, because the
 * two say different things: the raw trace is the measurement and the matched
 * one is an interpretation of it laid over a street map. Seeing the offset
 * between them is how an operator judges whether to believe the street name --
 * a metre of daylight is a good match, thirty metres is a guess.
 *
 * Runs are stroked separately with the gaps left open. A fix that matched no
 * road gets a hollow tick at its raw position, so "we do not know which road"
 * is visible rather than silently bridged.
 */

import { memo } from 'react';
import type { Projection } from '@/domain/polar';
import type { MatchedTrace } from '@/domain/roadMatch';

export interface RoadMatchLayerProps {
  trace: MatchedTrace;
  projection: Projection;
}

export const RoadMatchLayer = memo(function RoadMatchLayer({
  trace,
  projection,
}: RoadMatchLayerProps) {
  // The legs are the trajectory: a line along the streets the vehicle was
  // matched to. The snapped fixes are drawn as ticks on top of it, small,
  // because once there is a path the individual dots are detail rather than
  // the picture. Without a graph there are no legs and the ticks are all the
  // matcher can honestly offer.
  return (
    <g className="radar-roadmatch" aria-hidden="true" pointerEvents="none">
      {trace.legs.map((leg) => (
        <polyline
          key={`leg${leg.from}`}
          className="radar-roadmatch__leg"
          points={leg.points.map((p) => projection.project(p)).map(([x, y]) => `${x},${y}`).join(' ')}
        />
      ))}
      {trace.runs.map((run) =>
        run.points.map((p, i) => {
          const [x, y] = projection.project(p);
          return (
            <circle
              key={`${run.from}-${i}`}
              className="radar-roadmatch__fix"
              cx={x}
              cy={y}
              r={1.8}
            />
          );
        }),
      )}
      {trace.unmatched.map((p, i) => {
        const [x, y] = projection.project(p);
        return (
          <g key={`u${i}`} className="radar-roadmatch__gap">
            <circle cx={x} cy={y} r={3} />
          </g>
        );
      })}
    </g>
  );
});
