/* The approach corridors: each zone's angular share of the ground.
 *
 * A wedge from the base out to the zone's buffer edge, fading as it goes --
 * strongest against the zone, almost nothing at the base. That gradient is the
 * honest reading of the shape: out at the buffer edge the sector is wide and a
 * vehicle in it really is on that zone's approach, while near the base every
 * sector converges and the bearing says almost nothing about where a vehicle is
 * going. So the wedge states its own confidence rather than claiming the ground
 * near the base as firmly as the ground near the zone.
 *
 * Under the rings, never over them, and deaf to the pointer: the circle
 * ZoneLayer draws on top is still the shape that fires an alert, and it stays
 * the thing you click.
 */

import { memo } from 'react';
import { VIEW, type Projection } from '@/domain/polar';
import { zoneSectors } from '@/domain/zoneSectors';
import type { Zone } from '@/domain/types';

export interface ZoneSectorLayerProps {
  zones: readonly Zone[];
  projection: Projection;
  /** Zone id currently filtered to; the rest fade back. */
  focus: string | 'all';
}

const FADE = 'zone-sector-fade';
const FOCUS_FADE = 'zone-sector-fade--focus';

/* Transparent at the base, full at the buffer edge. The focused zone runs the
 * same curve deeper, so picking a zone in the filter reads as that corridor
 * coming forward rather than as the others going away. */
const FADES = [
  { id: FADE, colour: 'var(--terrain)', stops: [[0, 0], [0.45, 0.05], [1, 0.2]] },
  { id: FOCUS_FADE, colour: 'var(--terrain-deep)', stops: [[0, 0], [0.45, 0.09], [1, 0.34]] },
] as const;

/** A point on the sector's outer arc, in the panned group's coordinates. */
const arcPoint = (bearingDeg: number, r: number) => {
  const a = (bearingDeg * Math.PI) / 180;
  return [VIEW.cx + r * Math.sin(a), VIEW.cy - r * Math.cos(a)] as const;
};

export const ZoneSectorLayer = memo(function ZoneSectorLayer({
  zones,
  projection,
  focus,
}: ZoneSectorLayerProps) {
  const sectors = zoneSectors(zones);
  if (sectors.length === 0) return null;

  // One gradient in user space for every wedge: they all start at the base, so
  // they all fade on the same curve and no seam shows where two sectors meet.
  const reach = Math.max(...sectors.map((sector) => projection.radius(sector.outerM)));

  return (
    <g className="radar-sectors" aria-hidden="true" pointerEvents="none">
      <defs>
        {FADES.map((fade) => (
          <radialGradient
            key={fade.id}
            id={fade.id}
            gradientUnits="userSpaceOnUse"
            cx={VIEW.cx}
            cy={VIEW.cy}
            r={reach}
          >
            {fade.stops.map(([offset, opacity]) => (
              <stop
                key={offset}
                offset={offset}
                stopColor={fade.colour}
                stopOpacity={opacity}
              />
            ))}
          </radialGradient>
        ))}
      </defs>
      {sectors.map((sector) => {
        const r = projection.radius(sector.outerM);
        const [x1, y1] = arcPoint(sector.fromDeg, r);
        const [x2, y2] = arcPoint(sector.toDeg, r);
        const wide = sector.toDeg - sector.fromDeg > 180 ? 1 : 0;
        const selected = focus === sector.zone_id;
        const dimmed = focus !== 'all' && !selected;

        // A lone zone owns every bearing: its arc has no ends to join.
        const full = sector.toDeg - sector.fromDeg >= 359.9;

        return full ? (
          <circle
            key={sector.zone_id}
            className="radar-sector"
            cx={VIEW.cx}
            cy={VIEW.cy}
            r={r}
            fill={`url(#${selected ? FOCUS_FADE : FADE})`}
            opacity={dimmed ? 0.25 : 1}
          />
        ) : (
          <path
            key={sector.zone_id}
            className="radar-sector"
            data-selected={selected || undefined}
            d={`M${VIEW.cx} ${VIEW.cy} L${x1} ${y1} A${r} ${r} 0 ${wide} 1 ${x2} ${y2} Z`}
            fill={`url(#${selected ? FOCUS_FADE : FADE})`}
            opacity={dimmed ? 0.25 : 1}
          />
        );
      })}
    </g>
  );
});
