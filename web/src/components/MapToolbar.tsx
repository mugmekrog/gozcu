import { memo } from 'react';
import { T } from '@/domain/strings';
import { MAX_SCALE, MIN_SCALE, zoomScale } from '@/domain/polar';
import type { FrameSummary, VehicleClass, Zone } from '@/domain/types';
import type { ViewName } from '@/store/useAppStore';
import './map-toolbar.css';

const CLASSES: VehicleClass[] = ['car', 'van', 'truck', 'bus'];
const SYMBOLS: Record<VehicleClass, string> = { car: '■', van: '▲', truck: '★', bus: '●' };

export interface MapToolbarProps {
  view: 'map' | 'logs';
  onView: (view: ViewName) => void;
  zones: readonly Zone[];
  zoneFilter: string | 'all';
  classFilter: VehicleClass | 'all';
  scaleKm: number;
  selectedFrame: FrameSummary | null;
  onZoneFilter: (value: string | 'all') => void;
  onClassFilter: (value: VehicleClass | 'all') => void;
  onScale: (value: number) => void;
  onCamera: () => void;
}

export const MapToolbar = memo(function MapToolbar({
  view, onView, zones, zoneFilter, classFilter, scaleKm, selectedFrame,
  onZoneFilter, onClassFilter, onScale, onCamera,
}: MapToolbarProps) {
  const zoneName = zones.find((zone) => zone.zone_id === zoneFilter)?.name ?? T.filter.all;
  const className = classFilter === 'all' ? T.filter.all : T.cls[classFilter];
  const choose = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    action();
    event.currentTarget.closest('details')?.removeAttribute('open');
  };

  return <div className="map-toolbar" data-view={view}>
    <nav className="map-toolbar__nav" aria-label="Görünümler">
      <button type="button" className="map-toolbar__tab" aria-current={view === 'map' ? 'page' : undefined}
        onClick={() => onView('map')}>{T.view.mapName}</button>
      <button type="button" className="map-toolbar__tab" aria-current={view === 'logs' ? 'page' : undefined}
        onClick={() => onView('logs')}>{T.view.logsName}</button>
    </nav>

    <div className="map-toolbar__filters">
      <details className="filter-popover">
        <summary aria-label={`${T.filter.zone}: ${zoneName}`}>
          <span className="filter-popover__caption">{T.filter.zone}</span>
          <strong>{zoneName}</strong><span className="filter-popover__chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="filter-popover__options" role="group" aria-label={T.filter.zone}>
          <button type="button" aria-pressed={zoneFilter === 'all'} onClick={(event) => choose(event, () => onZoneFilter('all'))}>{T.filter.all}</button>
          {zones.map((zone) => <button key={zone.zone_id} type="button" aria-pressed={zoneFilter === zone.zone_id}
            onClick={(event) => choose(event, () => onZoneFilter(zone.zone_id))}>{zone.name}</button>)}
        </div>
      </details>
      <details className="filter-popover">
        <summary aria-label={`${T.filter.class}: ${className}`}>
          <span className="filter-popover__caption">{T.filter.class}</span>
          <strong>{className}</strong><span className="filter-popover__chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="filter-popover__options" role="group" aria-label={T.filter.class}>
          <button type="button" aria-pressed={classFilter === 'all'} onClick={(event) => choose(event, () => onClassFilter('all'))}>{T.filter.all}</button>
          {CLASSES.map((cls) => <button key={cls} type="button" aria-pressed={classFilter === cls}
            onClick={(event) => choose(event, () => onClassFilter(cls))}><span aria-hidden="true">{SYMBOLS[cls]} </span>{T.cls[cls]}</button>)}
        </div>
      </details>
    </div>

    <div className="map-toolbar__spacer" />
    <div className="map-toolbar__legend" aria-label="Araç işaretleri ve uyarı renkleri">
      <span className="map-toolbar__class"><b>■</b> Otomobil</span>
      <span className="map-toolbar__class"><b>▲</b> Minibüs</span>
      <span className="map-toolbar__class"><b>★</b> Kamyon</span>
      <span className="map-toolbar__class"><b>●</b> Otobüs</span>
      <span className="map-toolbar__risk"><i data-risk="safe" />Güvenli</span>
      <span className="map-toolbar__risk"><i data-risk="watch" />Şüpheli</span>
      <span className="map-toolbar__risk"><i data-risk="alert" />Tehlike</span>
    </div>
    <div className="map-toolbar__zoom" role="group" aria-label="Harita ölçeği">
      <button type="button" aria-label="Yakınlaştır" disabled={scaleKm <= MIN_SCALE}
        onClick={() => onScale(zoomScale(scaleKm, -1))}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10M6 1v10" /></svg>
      </button>
      <output>{scaleKm.toFixed(1)} km</output>
      <button type="button" aria-label="Uzaklaştır" disabled={scaleKm >= MAX_SCALE}
        onClick={() => onScale(zoomScale(scaleKm, 1))}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
      </button>
    </div>
    <button type="button" className="map-toolbar__camera" disabled={!selectedFrame} onClick={onCamera}>
      <span aria-hidden="true">▣</span> {selectedFrame?.image_id ?? 'Kare seçin'} · Görüntü
    </button>
  </div>;
});
