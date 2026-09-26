/* The map card's toolbar: view menu, filters, legend, scale.
 *
 * The legend sits here rather than floating over the map because it has to be
 * readable from across a room during the demo (PLAN F3.4) and because a legend
 * that overlaps the display competes with the thing it explains.
 */

import { memo } from 'react';
import { GlyphChip } from '@/radar/Glyph';
import { SCALE_OPTIONS, type ScaleKm } from '@/domain/polar';
import { T } from '@/domain/strings';
import type { VehicleClass, Zone } from '@/domain/types';
import './map-toolbar.css';

const CLASSES: VehicleClass[] = ['car', 'van', 'truck', 'bus'];

export interface MapToolbarProps {
  viewName: string;
  zones: readonly Zone[];
  zoneFilter: string | 'all';
  classFilter: VehicleClass | 'all';
  /** The highlighted scale option; null while the wheel zoom is off-preset. */
  scalePreset: ScaleKm | null;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onZoneFilter: (value: string | 'all') => void;
  onClassFilter: (value: VehicleClass | 'all') => void;
  onScale: (value: ScaleKm) => void;
}

export const MapToolbar = memo(function MapToolbar({
  viewName,
  zones,
  zoneFilter,
  classFilter,
  scalePreset,
  menuOpen,
  onMenuToggle,
  onZoneFilter,
  onClassFilter,
  onScale,
}: MapToolbarProps) {
  return (
    <div className="map-toolbar">
      <button
        type="button"
        className={menuOpen ? 'btn btn--icon btn--primary' : 'btn btn--icon'}
        aria-label={T.view.openMenu}
        aria-expanded={menuOpen}
        onClick={onMenuToggle}
      >
        ☰
      </button>

      <label className="chip-select" data-active={zoneFilter !== 'all'}>
        <span className="chip-select__label">{T.filter.zone}</span>
        <select
          value={zoneFilter}
          onChange={(event) => onZoneFilter(event.target.value)}
          aria-label={T.filter.zone}
        >
          <option value="all">{T.filter.all}</option>
          {zones.map((zone) => (
            <option key={zone.zone_id} value={zone.zone_id}>
              {zone.name}
            </option>
          ))}
        </select>
      </label>

      <label className="chip-select" data-active={classFilter !== 'all'}>
        <span className="chip-select__label">{T.filter.class}</span>
        <select
          value={classFilter}
          onChange={(event) => onClassFilter(event.target.value as VehicleClass | 'all')}
          aria-label={T.filter.class}
        >
          <option value="all">{T.filter.all}</option>
          {CLASSES.map((cls) => (
            <option key={cls} value={cls}>
              {T.cls[cls]}
            </option>
          ))}
        </select>
      </label>

      <p className="map-toolbar__view">
        <span className="label">{T.view.kicker}</span>
        <span className="map-toolbar__view-name">{viewName}</span>
      </p>

      <div className="spacer" />

      <ul className="map-toolbar__legend">
        <li>
          <GlyphChip band="low" /> {T.legend.safe}
        </li>
        <li>
          <GlyphChip band="review" /> {T.legend.review}
        </li>
        <li>
          <GlyphChip band="critical" /> {T.legend.threat}
        </li>
        <li>
          <span className="map-toolbar__swatch" aria-hidden="true" /> {T.legend.zones}
        </li>
      </ul>

      <div className="map-toolbar__scale">
        <span className="label">{T.filter.scale}</span>
        <div className="seg" role="group" aria-label={T.filter.scale}>
          {SCALE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className="seg__opt"
              aria-pressed={option === scalePreset}
              onClick={() => onScale(option)}
            >
              {option}
              {option === SCALE_OPTIONS[SCALE_OPTIONS.length - 1] ? ` ${T.filter.scaleUnit}` : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});
