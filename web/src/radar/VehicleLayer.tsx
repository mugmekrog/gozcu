/* Vehicles on the map: trails, symbols, labels.
 *
 * Three passes in a fixed order -- trails, then symbols, then labels -- so a
 * label is never painted under a symbol and a symbol is never painted under a
 * trail. SVG has no z-index, so paint order *is* the layering, and doing it in
 * three passes rather than one group per vehicle is what makes that reliable.
 *
 * Shape identifies vehicle class; colour identifies warning level. Labelling is
 * rationed on purpose. At the busiest clock the shipped data puts
 * dozens of vehicles on screen, and labelling all of them would bury the display
 * in text; so a label appears only for a vehicle that is selected, pinned, or at
 * threat level. Everything else is identified on hover and in the tables.
 */

import { memo } from 'react';
import { VehicleSymbol } from './VehicleSymbol';
import { bandOf } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import { trailAt } from '@/domain/tracks';
import type { Projection } from '@/domain/polar';
import type { LiveVehicle } from '@/domain/live';
import type { TrackHistory } from '@/domain/types';

/** Identity colours for pinned vehicles. Six, matching PIN_LIMIT. */
export const PIN_COLOURS = [
  'var(--pin-1)',
  'var(--pin-2)',
  'var(--pin-3)',
  'var(--pin-4)',
  'var(--pin-5)',
  'var(--pin-6)',
] as const;

/** Pin labels need legible text on their own identity colour. */
const PIN_TEXT = ['#ffffff', '#1e293b', '#ffffff', '#ffffff', '#1e293b', '#1e293b'] as const;

/** Minutes of history drawn behind a moving symbol. */
const TRAIL_MINUTES = 20;
const PIN_TRAIL_MINUTES = 60;

export interface VehicleLayerProps {
  vehicles: readonly LiveVehicle[];
  histories: ReadonlyMap<string, TrackHistory>;
  projection: Projection;
  tMin: number;
  selectedId: string | null;
  hoveredId: string | null;
  pins: readonly string[];
  onSelect: (trackId: string | null) => void;
  onHover: (trackId: string | null) => void;
}

export const VehicleLayer = memo(function VehicleLayer({
  vehicles,
  histories,
  projection,
  tMin,
  selectedId,
  hoveredId,
  pins,
  onSelect,
  onHover,
}: VehicleLayerProps) {
  const pinIndex = new Map(pins.map((id, i) => [id, i]));
  const focusing = selectedId !== null;

  const trails: React.ReactNode[] = [];
  const symbols: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];

  for (const vehicle of vehicles) {
    const [x, y] = projection.project(vehicle.sample.enu);
    const pin = pinIndex.get(vehicle.trackId);
    const selected = vehicle.trackId === selectedId;
    const hovered = vehicle.trackId === hoveredId;
    const pinned = pin !== undefined;
    // Pins are capped at six by the store, so a colour always exists; the fallback
    // is here so a future cap change degrades to ink rather than to undefined.
    const pinColour = pin === undefined ? 'var(--ink)' : PIN_COLOURS[pin] ?? 'var(--ink)';
    const pinInk = pin === undefined ? 'var(--ink)' : PIN_TEXT[pin] ?? 'var(--ink)';

    // Focus mode: the selected vehicle keeps full contrast, everything else
    // drops back far enough to read as context but not as a peer.
    const dimmed = focusing && !selected && !pinned;
    const history = histories.get(vehicle.trackId);

    if (history && (selected || pinned)) {
      const minutes = pinned || selected ? PIN_TRAIL_MINUTES : TRAIL_MINUTES;
      const points = trailAt(history, tMin, minutes);
      if (points.length > 1) {
        trails.push(
          <polyline
            key={`trail-${vehicle.trackId}`}
            points={points.map((p) => projection.project(p).join(',')).join(' ')}
            fill="none"
            stroke={pinned ? pinColour : 'var(--ink)'}
            strokeWidth={selected ? 3.5 : pinned ? 2.5 : 1.5}
            strokeOpacity={selected ? 0.85 : pinned ? 0.8 : 0.4}
            strokeDasharray={selected ? '9 6' : undefined}
            strokeLinejoin="round"
          />,
        );
      }
    }

    if (selected || hovered) {
      symbols.push(
        <circle
          key={`halo-${vehicle.trackId}`}
          cx={x}
          cy={y}
          r={14}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />,
      );
    }
    if (pinned) {
      symbols.push(
        <circle
          key={`pin-${vehicle.trackId}`}
          cx={x}
          cy={y}
          r={11}
          fill="var(--surface)"
          stroke={pinColour}
          strokeWidth={3}
        />,
      );
    }

    symbols.push(
      <g
        key={`veh-${vehicle.trackId}`}
        className="radar-vehicle"
        role="button"
        tabIndex={dimmed ? -1 : 0}
        aria-label={`${vehicle.trackId}, ${classLabel(vehicle.cls)}, ${T.band[bandOf(vehicle.level, vehicle.score)]}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(selected ? null : vehicle.trackId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(selected ? null : vehicle.trackId);
          }
        }}
        onPointerEnter={() => onHover(vehicle.trackId)}
        onPointerLeave={() => onHover(null)}
      >
        {/* A generous invisible hit area: the symbols are 9-14 px and the
            pointer target has to be comfortable without enlarging the mark. */}
        <circle cx={x} cy={y} r={11} fill="transparent" />
        <VehicleSymbol
          x={x}
          y={y}
          cls={vehicle.cls}
          level={vehicle.level}
          size={selected ? 7 : vehicle.level === 'CLEAR' || vehicle.level === null ? 4.5 : 5.5}
          opacity={dimmed ? 0.2 : 1}
        />
      </g>,
    );

    const labelled = selected || pinned || (vehicle.level === 'ALERT' && !dimmed);
    if (labelled) {
      labels.push(
        <Chip
          key={`label-${vehicle.trackId}`}
          x={x + 12}
          y={y - (pinned ? 22 : 10)}
          text={vehicle.trackId}
          background={pinned ? pinColour : 'var(--surface)'}
          border={
            pinned ? pinColour : vehicle.level === 'ALERT' ? 'var(--risk-threat)' : 'var(--ink)'
          }
          colour={pinned ? pinInk : 'var(--ink)'}
        />,
      );
    }
  }

  return (
    <>
      <g>{trails}</g>
      <g>{symbols}</g>
      <g aria-hidden="true">{labels}</g>
    </>
  );
});

/** A flat label plate. Sized from the text length, since SVG cannot shrink-wrap. */
function Chip({
  x,
  y,
  text,
  background,
  border,
  colour,
}: {
  x: number;
  y: number;
  text: string;
  background: string;
  border: string;
  colour: string;
}) {
  const width = text.length * 5.9 + 10;
  return (
    <g>
      <rect x={x} y={y} width={width} height={14} fill={background} stroke={border} strokeWidth={1} />
      <text x={x + 5} y={y + 10} fontSize={9.5} fontWeight={700} fill={colour}>
        {text}
      </text>
    </g>
  );
}
