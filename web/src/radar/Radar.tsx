/* The tactical display.
 *
 * Composes the four layers over one projection. The only work it does itself is
 * deciding what is live at the current clock, which it memoises on the clock and
 * the filters -- so scrubbing the timeline recomputes positions, but hovering a
 * table row does not.
 *
 * Panning is a drag on the map. The offset is kept in kilometres rather than
 * SVG units, so switching scale keeps the same ground point in the middle, and
 * it is applied as one translate on the layer group, so no layer knows about it.
 * A drag only begins after a few pixels of travel, so a plain click still
 * selects a vehicle or a zone. Recentring (the button, or a double-click) goes
 * to the zone in the zone filter, or to the base when none is chosen.
 *
 * The mouse wheel zooms continuously and keeps the ground point under the
 * cursor fixed. The toolbar shows the current radius and offers step controls.
 */

import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { GridLayer } from './GridLayer';
import { BaseLayer, ZoneLayer } from './ZoneLayer';
import { FrameLayer } from './FrameLayer';
import { VehicleLayer } from './VehicleLayer';
import { framesOverZone, framesUpTo, liveVehiclesAt, nearestZoneId, type LiveVehicle } from '@/domain/live';
import { MAX_SCALE, MIN_SCALE, projectionFor, VIEW } from '@/domain/polar';
import { useAppStore } from '@/store/useAppStore';
import './radar.css';

/** Pointer travel, in screen pixels, before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

interface Pan {
  /** Offset of the view centre from the base, east, in kilometres. */
  eKm: number;
  /** Offset of the view centre from the base, north, in kilometres. */
  nKm: number;
}

const NO_PAN: Pan = { eKm: 0, nKm: 0 };

/** Match one ordinary 100 px wheel notch to the toolbar's 15% zoom step. */
const WHEEL_ZOOM_PER_PX = Math.log(1.15) / 100;

export const Radar = memo(function Radar() {
  const dataset = useAppStore((s) => s.dataset);
  const tracks = useAppStore((s) => s.tracks);
  const trackIndex = useAppStore((s) => s.trackIndex);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const tMin = useAppStore((s) => s.tMin);
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
  const setZoom = useAppStore((s) => s.setZoom);
  const mapFocus = useAppStore((s) => s.mapFocus);

  const projection = useMemo(() => projectionFor(scaleKm), [scaleKm]);

  const [pan, setPan] = useState<Pan>(NO_PAN);
  useEffect(() => {
    if (mapFocus) setPan({ eKm: mapFocus.enu.e_m / 1000, nKm: mapFocus.enu.n_m / 1000 });
  }, [mapFocus]);
  const drag = useRef<{ id: number; x: number; y: number; start: Pan; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  /** Set when a drag ends, so the click that follows it does not deselect. */
  const swallowClick = useRef(false);

  const focusZone =
    zoneFilter === 'all' ? null : (dataset?.zones.find((z) => z.zone_id === zoneFilter) ?? null);
  const centre: Pan = focusZone
    ? { eKm: focusZone.enu.e_m / 1000, nKm: focusZone.enu.n_m / 1000 }
    : NO_PAN;
  const offCentre = Math.hypot(pan.eKm - centre.eKm, pan.nKm - centre.nKm) > 1e-6;
  const recentre = () => setPan(centre);

  const svgRef = useRef<SVGSVGElement>(null);
  /** Latest pan and scale for the native wheel listener, which outlives renders. */
  const view = useRef({ pan, scaleKm });
  view.current = { pan, scaleKm };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Registered natively: React's wheel handler is passive and cannot stop
    // the page from scrolling.
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      // Line- and page-mode deltas (Firefox, some mice) to pixels.
      const px = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      const { pan: current, scaleKm: from } = view.current;
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, from * Math.exp(px * WHEEL_ZOOM_PER_PX)),
      );
      if (next === from) return;

      // Keep the ground point under the cursor fixed across the zoom.
      const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
      if (ctm && typeof DOMPoint !== 'undefined') {
        const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
        const before = projectionFor(from).unitsPerKm;
        const after = projectionFor(next).unitsPerKm;
        const dx = p.x - VIEW.cx;
        const dy = p.y - VIEW.cy;
        setPan({
          eKm: current.eKm + dx / before - dx / after,
          nKm: current.nKm - dy / before + dy / after,
        });
      }
      setZoom(next);
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [dataset, setZoom]);

  /** Whole kilometres, so the grid re-renders per ring crossed, not per pixel. */
  const gridExtentKm = scaleKm + Math.ceil(Math.hypot(pan.eKm, pan.nKm));

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: pan,
      moved: false,
    };
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    // Screen pixels to SVG units: the viewBox is uniformly scaled.
    const pxPerUnit = typeof event.currentTarget.getScreenCTM === 'function'
      ? event.currentTarget.getScreenCTM()?.a || 1 : 1;
    const kmPerPx = 1 / (pxPerUnit * projection.unitsPerKm);
    setPan({ eKm: d.start.eKm - dx * kmPerPx, nKm: d.start.nKm + dy * kmPerPx });
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    swallowClick.current = d.moved;
    drag.current = null;
    setDragging(false);
  }

  const vehicles = useMemo<LiveVehicle[]>(() => {
    if (!dataset) return [];
    const all = liveVehiclesAt({
      tMin,
      tracks,
      frames: dataset.frames,
      alertsByFrame,
      stationaryDispM: dataset.thresholds.stationary_disp_m,
      classFilter,
      zoneFilter: 'all',
    });
    return zoneFilter === 'all' ? all
      : all.filter((vehicle) => nearestZoneId(vehicle.sample.enu, dataset.zones) === zoneFilter);
  }, [dataset, tracks, alertsByFrame, tMin, classFilter, zoneFilter]);

  const visibleFrames = useMemo(
    () => {
      if (!dataset) return [];
      const frames = zoneFilter === 'all' ? dataset.frames
        : framesOverZone(dataset.frames, dataset.zones, zoneFilter);
      return framesUpTo(frames, tMin);
    },
    [dataset, tMin, zoneFilter],
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
      ref={svgRef}
      className="radar"
      viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Bölge haritası, ${dataset.base.name} merkezli, ${scaleKm.toFixed(1)} km yarıçap, ${vehicles.length} araç`}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
      }}
      onClick={() => selectTrack(null)}
      onDoubleClick={recentre}
    >
      <rect width={VIEW.w} height={VIEW.h} fill="var(--surface-map)" />
      <g
        transform={`translate(${-pan.eKm * projection.unitsPerKm} ${pan.nKm * projection.unitsPerKm})`}
      >
        <GridLayer projection={projection} extentKm={gridExtentKm} />
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
          onSelect={selectTrack}
          onHover={hoverTrack}
        />
      </g>

      <text
        x={VIEW.w - 20}
        y={26}
        fontSize={13}
        fontWeight={700}
        textAnchor="end"
        fill="var(--ink)"
        aria-hidden="true"
      >
        K ↑
      </text>
      {offCentre && (
        <g
          className="radar-recentre"
          role="button"
          tabIndex={0}
          aria-label={`Haritayı ${focusZone ? focusZone.name : 'üs'} üzerine ortala`}
          onClick={(event) => {
            event.stopPropagation();
            recentre();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              recentre();
            }
          }}
        >
          <rect x={20} y={12} width={72} height={22} rx={3} />
          <text x={56} y={27} fontSize={11} textAnchor="middle">
            ⌖ Ortala
          </text>
        </g>
      )}
    </svg>
  );
});
