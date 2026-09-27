/* The city under the radar: OpenStreetMap, baked offline (see domain/basemap.ts).
 *
 * Three pieces, drawn at three depths of the radar's stack:
 *
 *   BasemapLayer     land use, water, roads and rail -- the bottom of the map
 *   OperationArea    the box every position in the dataset falls inside, with
 *                    the ground outside it washed back
 *   BasemapLabels    district, street and place names, above the heat field so
 *                    a name is never lost under it, below zones and vehicles
 *
 * The geometry is metre-space path data under a single `scale()`, so a zoom
 * frame rewrites a transform and a few stroke widths, not 14 000 roads. Tiles
 * off screen are not rendered at all. Everything here is scenery: no pointer
 * events, hidden from the screen reader (the radar's own label names what is
 * on it).
 */

import { memo, useMemo } from 'react';
import {
  AREA_ORDER,
  detailFor,
  intersects,
  labelScale,
  layoutLabels,
  lineVisible,
  RAIL_LINES,
  ROAD_ORDER,
  roadCased,
  roadVisible,
  roadWidth,
  WATER_LINES,
  type Box,
  type MapLabel,
  type PreparedBasemap,
  type Rect,
  type Tile,
} from '@/domain/basemap';
import { labelSide, VIEW, type Projection } from '@/domain/polar';
import * as fmt from '@/domain/format';
import { T } from '@/domain/strings';
import type { Zone } from '@/domain/types';

export interface BasemapLayerProps {
  map: PreparedBasemap;
  projection: Projection;
  /** Ground the view can show, ENU metres. Tiles outside it are skipped. */
  view: Box;
}

/** Extra width of a road's outline over its fill, in SVG units. */
const CASING = 1.5;

export const BasemapLayer = memo(function BasemapLayer({ map, projection, view }: BasemapLayerProps) {
  const scaleKm = projection.scaleKm;
  const k = projection.unitsPerKm / 1000; // SVG units per metre
  const metres = (units: number) => units / k;
  const tiles = map.tiles.filter((tile) => intersects(tile.box, view));
  const detail = detailFor(scaleKm);

  const each = (layer: keyof Tile['paths']) =>
    tiles.map((tile) => {
      const d = tile[detail][layer];
      return d ? <path key={tile.key} d={d} /> : null;
    });

  const roads = ROAD_ORDER.filter((cls) => roadVisible(cls, scaleKm));

  return (
    <g
      className="basemap"
      aria-hidden="true"
      transform={`translate(${VIEW.cx} ${VIEW.cy}) scale(${k})`}
    >
      {AREA_ORDER.map((kind) => (
        <g key={kind} fill={`var(--map-${kind})`} fillRule="evenodd">
          {each(`area:${kind}`)}
        </g>
      ))}

      {WATER_LINES.filter((kind) => lineVisible(kind, scaleKm)).map((kind) => (
        <g
          key={kind}
          fill="none"
          stroke="var(--map-water)"
          strokeWidth={metres(kind === 'river' ? 2.4 : 1.2)}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {each(`line:${kind}`)}
        </g>
      ))}

      {/* Tunnels and underpasses: faint and dashed, beneath everything that is
          at ground level -- Kizilay is full of them. */}
      <g
        fill="none"
        stroke="var(--map-tunnel)"
        strokeDasharray={`${metres(4)} ${metres(3)}`}
        strokeLinejoin="round"
      >
        {roads.map((cls) => (
          <g key={cls} strokeWidth={metres(roadWidth(cls, scaleKm) * 0.8)}>
            {each(`tunnel:${cls}`)}
          </g>
        ))}
      </g>

      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {roads.filter((cls) => roadCased(cls, scaleKm)).map((cls) => (
          <g
            key={`casing-${cls}`}
            stroke={cls === 'highway' ? 'var(--map-casing-strong)' : 'var(--map-casing)'}
            strokeWidth={metres(roadWidth(cls, scaleKm) + CASING)}
          >
            {each(`road:${cls}`)}
          </g>
        ))}
        {roads.map((cls) => (
          <g
            key={`fill-${cls}`}
            stroke={cls === 'highway' ? 'var(--map-highway)' : 'var(--map-road)'}
            strokeWidth={metres(roadWidth(cls, scaleKm))}
          >
            {each(`road:${cls}`)}
          </g>
        ))}
      </g>

      {RAIL_LINES.filter((kind) => lineVisible(kind, scaleKm)).map((kind) => (
        <g
          key={kind}
          fill="none"
          stroke={kind === 'subway' ? 'var(--map-subway)' : 'var(--map-rail)'}
          strokeWidth={metres(kind === 'subway' ? 1.4 : 1.8)}
          strokeDasharray={kind === 'subway' ? `${metres(5)} ${metres(3)}` : undefined}
          strokeLinejoin="round"
        >
          {each(`line:${kind}`)}
        </g>
      ))}
    </g>
  );
});

// --------------------------------------------------------------------------- //

export interface OperationAreaProps {
  area: Box;
  projection: Projection;
}

/**
 * The operation area: the bounding box of every track fix, image corner and
 * zone in the dataset. Everything outside it is washed back, so the eye stays
 * on the ground the exercise covers, and the box carries its own size.
 */
export const OperationArea = memo(function OperationArea({ area, projection }: OperationAreaProps) {
  const [x0, y0] = projection.project({ e_m: area.w, n_m: area.n });
  const [x1, y1] = projection.project({ e_m: area.e, n_m: area.s });
  // Far enough out to cover the widest letterboxed stage at the widest zoom.
  const far = 20 * VIEW.w;
  const label = T.map.area(fmt.km(area.e - area.w, 1), fmt.km(area.n - area.s, 1));

  return (
    <g className="operation-area" aria-hidden="true">
      <path
        d={`M${-far} ${-far}H${far}V${far}H${-far}Z M${x0} ${y0}V${y1}H${x1}V${y0}Z`}
        fill="var(--surface)"
        fillOpacity={0.55}
        fillRule="evenodd"
      />
      <rect
        x={x0}
        y={y0}
        width={x1 - x0}
        height={y1 - y0}
        fill="none"
        stroke="var(--ink-muted)"
        strokeWidth={1.25}
        strokeDasharray="7 4"
      />
      <text
        className="map-label"
        x={x0 + 6}
        y={y0 + 13}
        fontSize={9}
        fontWeight={700}
        letterSpacing="0.12em"
        fill="var(--ink-muted)"
      >
        {label}
      </text>
    </g>
  );
});

// --------------------------------------------------------------------------- //

export interface BasemapLabelsProps {
  map: PreparedBasemap;
  projection: Projection;
  view: Box;
  /** Zone names are drawn on top; map labels keep out of their way. */
  zones: readonly Zone[];
  baseName: string;
}

const LABEL_FILL: Record<MapLabel['style'], string> = {
  district: 'var(--map-label-district)',
  semt: 'var(--map-label-district)',
  mahalle: 'var(--map-label-muted)',
  road: 'var(--map-label)',
  'road-minor': 'var(--map-label-muted)',
  station: 'var(--map-label)',
  poi: 'var(--map-label)',
  park: 'var(--map-label-park)',
  water: 'var(--map-label-water)',
};

/** Rectangles, in base-relative SVG units at `scaleKm`, that map labels must not cover. */
function obstaclesFor(zones: readonly Zone[], baseName: string, scaleKm: number): Rect[] {
  const upm = (VIEW.h / 2 - 20) / scaleKm / 1000;
  const out: Rect[] = [];
  for (const zone of zones) {
    const x = zone.enu.e_m * upm;
    const y = -zone.enu.n_m * upm;
    const core = Math.max(zone.radius_m * upm, 4);
    const buffer = Math.max((zone.radius_m + zone.buffer_m) * upm, core + 3);
    const width = zone.name.length * 6.2 + 6;
    const side = labelSide(zone.bearing_deg);
    const lx = side === 'end' ? x - buffer - 6 - width : x + buffer + 6;
    out.push({ x0: lx, y0: y - 9, x1: lx + width, y1: y + 7 });
    out.push({ x0: x - core, y0: y - core, x1: x + core, y1: y + core });
  }
  // The base mark and its caps label.
  const baseWidth = Math.max(60, baseName.length * 7.5);
  out.push({ x0: -baseWidth / 2, y0: -42, x1: baseWidth / 2, y1: 36 });
  return out;
}

export const BasemapLabels = memo(function BasemapLabels({
  map,
  projection,
  view,
  zones,
  baseName,
}: BasemapLabelsProps) {
  const step = labelScale(projection.scaleKm);
  const labels = useMemo(
    () => layoutLabels(map, step, obstaclesFor(zones, baseName, step)),
    [map, step, zones, baseName],
  );

  return (
    <g className="basemap-labels" aria-hidden="true">
      {labels.map((label) => {
        if (label.e < view.w || label.e > view.e || label.n < view.s || label.n > view.n) return null;
        const [x, y] = projection.project({ e_m: label.e, n_m: label.n });
        const caps = label.style === 'district' || label.style === 'semt';
        return (
          <g key={label.key} transform={`translate(${x} ${y}) rotate(${label.angle})`}>
            {label.icon && <LabelIcon kind={label.icon} x={-labelHalf(label)} />}
            <text
              className="map-label"
              x={label.icon ? 6 : 0}
              y={label.size * 0.35}
              fontSize={label.size}
              fontWeight={caps || label.style === 'road' ? 700 : 400}
              letterSpacing={caps ? `${label.style === 'district' ? 0.2 : 0.12}em` : undefined}
              textAnchor="middle"
              fill={LABEL_FILL[label.style]}
            >
              {label.text}
            </text>
          </g>
        );
      })}
    </g>
  );
});

function labelHalf(label: MapLabel): number {
  return (label.text.length * label.size * 0.6) / 2 + 3;
}

/**
 * A small neutral badge: M for a metro or Ankaray station, T for a train
 * station, H for a hospital, and a dot for anything else. Neutral on purpose --
 * transit blue and hospital red are both risk colours on this screen.
 */
function LabelIcon({ kind, x }: { kind: NonNullable<MapLabel['icon']>; x: number }) {
  const letter =
    kind === 'subway' || kind === 'light_rail' ? 'M'
      : kind === 'train' ? 'T'
        : kind === 'hospital' ? 'H'
          : kind === 'bus_station' ? 'O'
            : null;
  if (!letter) {
    return <circle cx={x} cy={0} r={2.6} fill="var(--map-label)" stroke="var(--surface)" strokeWidth={1} />;
  }
  return (
    <g>
      <rect x={x - 5} y={-5} width={10} height={10} rx={2.5} fill="var(--map-icon)" />
      <text
        x={x}
        y={3}
        fontSize={7.5}
        fontWeight={700}
        textAnchor="middle"
        fill="var(--ink-inverse)"
      >
        {letter}
      </text>
    </g>
  );
}

/** The ODbL attribution the map owes OpenStreetMap, in the corner it is expected. */
export function Attribution({ text }: { text: string }) {
  return (
    <text
      className="map-label map-attribution"
      x={12}
      y={VIEW.h - 8}
      fontSize={8}
      fill="var(--ink-muted)"
    >
      {text}
    </text>
  );
}
