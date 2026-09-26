/* The tactical display.
 *
 * Composes the four layers over one projection. The only work it does itself is
 * deciding what is live at the current clock, which it memoises on the clock and
 * the filters -- so scrubbing the timeline recomputes positions, but hovering a
 * table row does not.
 */

import { memo, useMemo } from 'react';
import { GridLayer } from './GridLayer';
import { BaseLayer, ZoneLayer } from './ZoneLayer';
import { FrameLayer } from './FrameLayer';
import { VehicleLayer } from './VehicleLayer';
import { framesUpTo, liveVehiclesAt, type LiveVehicle } from '@/domain/live';
import { projectionFor, VIEW } from '@/domain/polar';
import { useAppStore } from '@/store/useAppStore';
import './radar.css';

export const Radar = memo(function Radar() {
  const dataset = useAppStore((s) => s.dataset);
  const tracks = useAppStore((s) => s.tracks);
  const trackIndex = useAppStore((s) => s.trackIndex);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const tMin = useAppStore((s) => s.tMin);
  const playing = useAppStore((s) => s.playing);
  const scaleKm = useAppStore((s) => s.scaleKm);
  const zoneFilter = useAppStore((s) => s.zoneFilter);
  const classFilter = useAppStore((s) => s.classFilter);
  const selectedTrackId = useAppStore((s) => s.selectedTrackId);
  const hoveredTrackId = useAppStore((s) => s.hoveredTrackId);
  const pins = useAppStore((s) => s.pins);
  const selectedFrameId = useAppStore((s) => s.selectedFrameId);
  const frame = useAppStore((s) => s.frame);

  const selectTrack = useAppStore((s) => s.selectTrack);
  const hoverTrack = useAppStore((s) => s.hoverTrack);
  const openFrame = useAppStore((s) => s.openFrame);
  const setZoneFilter = useAppStore((s) => s.setZoneFilter);

  const projection = useMemo(() => projectionFor(scaleKm), [scaleKm]);

  const vehicles = useMemo<LiveVehicle[]>(() => {
    if (!dataset) return [];
    return liveVehiclesAt({
      tMin,
      tracks,
      frames: dataset.frames,
      alertsByFrame,
      stationaryDispM: dataset.thresholds.stationary_disp_m,
      classFilter,
      zoneFilter,
    });
  }, [dataset, tracks, alertsByFrame, tMin, classFilter, zoneFilter]);

  const visibleFrames = useMemo(
    () => (dataset ? framesUpTo(dataset.frames, tMin) : []),
    [dataset, tMin],
  );

  /** Zones any live ALERT names. Drives the pulse. */
  const alertingZones = useMemo(() => {
    const out = new Set<string>();
    for (const vehicle of vehicles) {
      if (vehicle.level === 'ALERT' && vehicle.alert?.zone_id) out.add(vehicle.alert.zone_id);
    }
    return out;
  }, [vehicles]);

  if (!dataset) return null;

  return (
    <svg
      className="radar"
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Bölge haritası, ${dataset.base.name} merkezli, ${scaleKm} km yarıçap, ${vehicles.length} araç`}
      onClick={() => selectTrack(null)}
    >
      <rect width={VIEW.w} height={VIEW.h} fill="var(--surface-map)" />
      <GridLayer projection={projection} />
      <ZoneLayer
        zones={dataset.zones}
        projection={projection}
        alerting={alertingZones}
        focus={zoneFilter}
        onSelect={(zoneId) => setZoneFilter(zoneFilter === zoneId ? 'all' : zoneId)}
      />
      <BaseLayer name={dataset.base.name} />
      <FrameLayer
        frames={visibleFrames}
        projection={projection}
        selectedId={selectedFrameId}
        footprint={frame?.image_id === selectedFrameId ? frame.footprint_enu : null}
        onSelect={(imageId) => void openFrame(imageId)}
      />
      <VehicleLayer
        vehicles={vehicles}
        histories={trackIndex}
        projection={projection}
        tMin={tMin}
        selectedId={selectedTrackId}
        hoveredId={hoveredTrackId}
        pins={pins}
        playing={playing}
        onSelect={selectTrack}
        onHover={hoverTrack}
      />
    </svg>
  );
});
