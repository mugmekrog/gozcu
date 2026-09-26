/* The protected zones and the base.
 *
 * The zones are read from `zones.json` at their measured bearings and ranges --
 * all eight sit on a ring at 3 192-3 204 m at exact 45-degree steps, so the grid
 * and the data agree by construction. Radius and buffer come from config
 * (`zones.default_radius_m` / `default_buffer_m`); the solid ring is the zone
 * itself and the dashed one is the buffer that raises a WATCH.
 *
 * A zone any open ALERT names gets a pulsing outline. That is the only pulsing
 * thing on the map, so it cannot be confused with anything else.
 */

import { memo } from 'react';
import { labelSide, VIEW, type Projection } from '@/domain/polar';
import type { Zone } from '@/domain/types';

export interface ZoneLayerProps {
  zones: readonly Zone[];
  projection: Projection;
  /** Zone ids named by an open ALERT. */
  alerting: ReadonlySet<string>;
  /** Zone id currently filtered to, dimming the rest. */
  focus: string | 'all';
  onSelect?: (zoneId: string) => void;
}

export const ZoneLayer = memo(function ZoneLayer({
  zones,
  projection,
  alerting,
  focus,
  onSelect,
}: ZoneLayerProps) {
  return (
    <g>
      {zones.map((zone) => {
        const [x, y] = projection.project(zone.enu);
        const side = labelSide(zone.bearing_deg);
        const dimmed = focus !== 'all' && focus !== zone.zone_id;
        const pulsing = alerting.has(zone.zone_id);
        const radius = Math.max(projection.radius(zone.radius_m), 4);
        const buffer = Math.max(projection.radius(zone.radius_m + zone.buffer_m), radius + 3);

        return (
          <g
            key={zone.zone_id}
            opacity={dimmed ? 0.35 : 1}
            className={onSelect ? 'radar-zone radar-zone--interactive' : 'radar-zone'}
            {...(onSelect
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${zone.name} bölgesi`,
                  onClick: () => onSelect(zone.zone_id),
                  onKeyDown: (event: React.KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(zone.zone_id);
                    }
                  },
                }
              : {})}
          >
            <circle
              cx={x}
              cy={y}
              r={buffer}
              fill="var(--terrain)"
              fillOpacity={0.05}
              stroke="var(--terrain)"
              strokeOpacity={0.4}
              strokeDasharray="2 3"
            />
            <circle
              cx={x}
              cy={y}
              r={radius}
              fill="var(--terrain)"
              fillOpacity={0.14}
              stroke="var(--terrain)"
              strokeOpacity={0.75}
            />
            {pulsing && (
              <circle
                className="radar-zone__pulse"
                cx={x}
                cy={y}
                r={buffer}
                fill="none"
                stroke="var(--risk-threat)"
                strokeWidth={2}
              />
            )}
            <circle cx={x} cy={y} r={3.5} fill="var(--terrain)" />
            <text
              x={x + (side === 'end' ? -buffer - 6 : buffer + 6)}
              y={y + 3.5}
              fontSize={10}
              fontWeight={700}
              fill="var(--terrain-deep)"
              textAnchor={side}
            >
              {zone.name}
            </text>
          </g>
        );
      })}
    </g>
  );
});

/** The base at the origin: a small flat plan mark, labelled. */
export const BaseLayer = memo(function BaseLayer({ name }: { name: string }) {
  const { cx, cy } = VIEW;
  const w = 22;
  const d = 11;
  const h = 15;

  return (
    <g aria-label={name}>
      <ellipse cx={cx} cy={cy + d + 2} rx={30} ry={9} fill="var(--terrain)" fillOpacity={0.12} />
      <path d={`M${cx - w} ${cy - h} L${cx} ${cy - h + d} L${cx} ${cy + d} L${cx - w} ${cy} Z`} fill="var(--terrain)" />
      <path d={`M${cx + w} ${cy - h} L${cx} ${cy - h + d} L${cx} ${cy + d} L${cx + w} ${cy} Z`} fill="var(--terrain-deep)" />
      <path d={`M${cx} ${cy - h - d} L${cx + w} ${cy - h} L${cx} ${cy - h + d} L${cx - w} ${cy - h} Z`} fill="var(--terrain-light)" />
      <line x1={cx} y1={cy - h} x2={cx} y2={cy - h - 20} stroke="var(--terrain-deep)" strokeWidth={2} />
      <circle cx={cx} cy={cy - h - 21} r={2.5} fill="var(--terrain-deep)" />
      <text
        x={cx}
        y={cy + d + 20}
        fontSize={10}
        fontWeight={700}
        textAnchor="middle"
        fill="var(--ink)"
        letterSpacing={1}
      >
        {name.toLocaleUpperCase('tr-TR')}
      </text>
    </g>
  );
});
