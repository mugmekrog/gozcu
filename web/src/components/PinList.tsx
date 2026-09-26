/* The pinned-vehicle list, top-left of the map.
 *
 * Pinning is how an operator watches several vehicles at once without losing
 * which is which. The identity colour it assigns paints the trail and the label
 * only -- the *shape* keeps carrying the risk level, so a pinned vehicle never
 * stops telling you how dangerous it is. The footnote in the panel says exactly
 * that, because it is the one place in the interface where colour means something
 * other than risk.
 */

import { memo } from 'react';
import { GlyphChip } from '@/radar/Glyph';
import { bandOf } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import { PIN_COLOURS } from '@/radar/VehicleLayer';
import { PIN_LIMIT } from '@/store/useAppStore';
import type { LiveVehicle } from '@/domain/live';
import './pin-list.css';

export interface PinListProps {
  pins: readonly string[];
  vehicles: readonly LiveVehicle[];
  onUnpin: (trackId: string) => void;
  onSelect: (trackId: string) => void;
}

export const PinList = memo(function PinList({
  pins,
  vehicles,
  onUnpin,
  onSelect,
}: PinListProps) {
  if (pins.length === 0) return null;
  const byId = new Map(vehicles.map((v) => [v.trackId, v]));

  return (
    <aside className="pin-list" aria-label={T.vehicle.pinned}>
      <div className="pin-list__head">
        {T.vehicle.pinned}
        <div className="spacer" />
        <span className="panel__head-note">
          {pins.length} / {PIN_LIMIT}
        </span>
      </div>

      <ul>
        {pins.map((trackId, index) => {
          const vehicle = byId.get(trackId);
          return (
            <li key={trackId} className="pin-list__row">
              <span
                className="pin-list__swatch"
                style={{ background: PIN_COLOURS[index] }}
                aria-hidden="true"
              />
              <button type="button" className="pin-list__id" onClick={() => onSelect(trackId)}>
                {trackId}
              </button>
              {vehicle ? (
                <>
                  <GlyphChip band={bandOf(vehicle.level, vehicle.score)} size={10} />
                  <span className="muted">{classLabel(vehicle.cls)}</span>
                </>
              ) : (
                <span className="muted">bu saatte yok</span>
              )}
              <div className="spacer" />
              <button
                type="button"
                className="pin-list__remove"
                onClick={() => onUnpin(trackId)}
                aria-label={`${trackId} ${T.vehicle.unpin}`}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <p className="pin-list__note">{T.vehicle.pinNote}</p>
    </aside>
  );
});
