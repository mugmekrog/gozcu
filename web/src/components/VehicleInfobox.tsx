/* The selected vehicle's card, over the bottom-right of the map.
 *
 * Six figures and three actions. The figures are the ones that decide whether to
 * act -- class, what it is doing, range, speed, time to the zone, and how long it
 * has been sitting still -- and each is the engine's own number, not a derived
 * summary of several.
 *
 * "Kareyi seç" loads the frame that assessed this vehicle, which is the bridge
 * from a symbol on the map to the evidence behind its level.
 */

import { memo } from 'react';
import { bandOf } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { LevelBadge } from './LevelBadge';
import type { LiveVehicle } from '@/domain/live';
import type { Zone, ZoneAssessmentRow } from '@/domain/types';
import './vehicle-infobox.css';

export interface VehicleInfoboxProps {
  vehicle: LiveVehicle;
  zone: Zone | null;
  assessment: ZoneAssessmentRow | null;
  pinned: boolean;
  onSelectFrame: (imageId: string) => void;
  onOpenMotion: () => void;
  onTogglePin: () => void;
  onClose: () => void;
}

const TREND_WORD = {
  approaching: T.vehicle.approaching,
  receding: T.vehicle.receding,
  steady: T.vehicle.steady,
  stopped: T.vehicle.stopped,
} as const;

export const VehicleInfobox = memo(function VehicleInfobox({
  vehicle,
  zone,
  assessment,
  pinned,
  onSelectFrame,
  onOpenMotion,
  onTogglePin,
  onClose,
}: VehicleInfoboxProps) {
  const band = bandOf(vehicle.level, vehicle.score);

  return (
    <aside className="infobox" aria-label={`${vehicle.trackId} ayrıntıları`}>
      <div className="infobox__head">
        <b className="infobox__id">{vehicle.trackId}</b>
        <div className="spacer" />
        <LevelBadge band={band} size="small" />
        <button
          type="button"
          className="infobox__close"
          onClick={onClose}
          aria-label="Seçimi kaldır"
        >
          ✕
        </button>
      </div>

      <dl className="infobox__grid">
        <div>
          <dt className="label">{T.vehicle.class}</dt>
          <dd>{classLabel(vehicle.cls)}</dd>
        </div>
        <div>
          <dt className="label">{T.vehicle.status}</dt>
          <dd>{TREND_WORD[vehicle.trend]}</dd>
        </div>
        <div>
          <dt className="label">{T.vehicle.distToBase}</dt>
          <dd className="figure">{fmt.distance(vehicle.sample.range_m)}</dd>
        </div>
        <div>
          <dt className="label">{T.vehicle.speed10}</dt>
          <dd className="figure">{fmt.speed(vehicle.sample.speed_mps)}</dd>
        </div>
        <div>
          <dt className="label">{zone ? `${zone.name} · ETA` : T.vehicle.eta}</dt>
          <dd className="figure">{fmt.eta(assessment?.eta_entry_s ?? null)}</dd>
        </div>
        <div>
          <dt className="label">{T.vehicle.stops}</dt>
          <dd>
            <span className="figure">{fmt.count(vehicle.stops.count)}</span>
            {vehicle.stops.count > 0 && ` · ${fmt.minutes(vehicle.stops.totalMin)}`}
          </dd>
        </div>
      </dl>

      {vehicle.level === null && (
        <p className="infobox__note">
          Bu araç henüz bir drone karesinde değerlendirilmedi; konum iz kaydından geliyor.
        </p>
      )}

      <div className="infobox__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={!vehicle.imageId}
          onClick={() => vehicle.imageId && onSelectFrame(vehicle.imageId)}
        >
          {T.vehicle.selectFrame}
        </button>
        <button type="button" className="btn btn--small" onClick={onOpenMotion}>
          {T.vehicle.toMotion}
        </button>
        <button
          type="button"
          className={pinned ? 'btn btn--small' : 'btn btn--small btn--primary'}
          onClick={onTogglePin}
          aria-pressed={pinned}
        >
          {pinned ? T.vehicle.unpin : T.vehicle.pin}
        </button>
      </div>
    </aside>
  );
});
