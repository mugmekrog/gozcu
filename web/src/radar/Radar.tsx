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
 * selects a vehicle or a zone. Recentring (the button, or a double-click) flies
 * to the zone in the zone filter, or to the base when none is chosen, and
 * settles at RECENTRE_KM.
 *
 * The mouse wheel zooms continuously and keeps the ground point under the
 * cursor fixed. The toolbar shows the current radius and offers step controls.
 * Wheel zooms, recentring and timeline jumps are animated: each wheel notch
 * retargets a short ease-out flight rather than jumping, so a run of notches
 * reads as one glide. Scale is interpolated on a log curve, which makes a zoom
 * feel even across the whole range.
 *
 * Under everything is the real city (BasemapLayer: OpenStreetMap, baked
 * offline), framed by the operation area every position in the dataset falls
 * inside. The selected vehicle draws its whole route so far (RouteLayer), the
 * map-side half of the route report.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { GridLayer } from './GridLayer';
import { Attribution, BasemapLabels, BasemapLayer, OperationArea } from './BasemapLayer';
import { RouteLayer } from './RouteLayer';
import { HeatLayer } from './HeatLayer';
import { BaseLayer, ZoneLayer } from './ZoneLayer';
import { FrameLayer } from './FrameLayer';
import { VehicleLayer } from './VehicleLayer';
import { framesOverZone, framesUpTo, liveVehiclesAt, nearestZoneId, type LiveVehicle } from '@/domain/live';
import { MAX_SCALE, MIN_SCALE, projectionFor, VIEW } from '@/domain/polar';
import { operationArea, visibleBox } from '@/domain/basemap';
import { activityOf } from '@/domain/activity';
import {
  blobsOf,
  densestZone,
  referenceClocks,
  referencesOf,
  zonePressures,
} from '@/domain/pressure';
import { T } from '@/domain/strings';
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

/** The radius the recentre button settles at, in kilometres. */
const RECENTRE_KM = 2.25;

/**
 * How long the map counts as still moving after its last frame, in ms. While
 * it moves, the basemap draws without anti-aliasing (`data-moving`, radar.css):
 * measured in headless Chrome, that is the difference between a 104 ms and a
 * 7 ms median frame at 8 km, and the eye does not see jagged edges on a map in
 * motion. It snaps back to smooth edges the moment the view settles.
 */
const SETTLE_MS = 160;

/** Flight lengths: short for a wheel notch, longer for a jump across the map. */
const WHEEL_FLIGHT_MS = 260;
const JUMP_FLIGHT_MS = 480;

/** Kilometres per SVG unit at a scale. */
const kmPerUnit = (scaleKm: number) => 1 / projectionFor(scaleKm).unitsPerKm;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface Flight {
  fromScale: number;
  toScale: number;
  fromPan: Pan;
  toPan: Pan;
  /**
   * For a wheel zoom: the ground point (km) held under the cursor, and the
   * cursor's offset from the view centre (SVG units). Pan is derived from it
   * every frame so the point stays put all the way through the flight.
   */
  anchor: { eKm: number; nKm: number; dx: number; dy: number } | null;
  start: number;
  ms: number;
}

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
  const heatOn = useAppStore((s) => s.heatOn);
  const basemap = useAppStore((s) => s.basemap);

  const selectTrack = useAppStore((s) => s.selectTrack);
  const hoverTrack = useAppStore((s) => s.hoverTrack);
  const openFrame = useAppStore((s) => s.openFrame);
  const setZoneFilter = useAppStore((s) => s.setZoneFilter);
  const setZoom = useAppStore((s) => s.setZoom);
  const toggleHeat = useAppStore((s) => s.toggleHeat);
  const mapFocus = useAppStore((s) => s.mapFocus);

  const projection = useMemo(() => projectionFor(scaleKm), [scaleKm]);

  const [pan, setPan] = useState<Pan>(NO_PAN);
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

  /**
   * Pan and scale as last drawn. Flights write it every frame, so a flight
   * started mid-flight begins exactly where the view is, not where it was
   * heading.
   */
  const view = useRef({ pan, scaleKm });
  view.current = { pan, scaleKm };
  const flight = useRef<Flight | null>(null);
  const frameReq = useRef(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Mark the map as moving, straight on the element: no React render per frame. */
  const markMoving = useCallback(() => {
    svgRef.current?.setAttribute('data-moving', '');
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => svgRef.current?.removeAttribute('data-moving'), SETTLE_MS);
  }, []);
  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const stopFlight = useCallback(() => {
    cancelAnimationFrame(frameReq.current);
    flight.current = null;
  }, []);

  const fly = useCallback(
    (toPan: Pan, toScale: number, ms: number, anchor: Flight['anchor'] = null) => {
      cancelAnimationFrame(frameReq.current);
      flight.current = {
        fromScale: view.current.scaleKm,
        toScale,
        fromPan: view.current.pan,
        toPan,
        anchor,
        start: performance.now(),
        ms,
      };
      const step = () => {
        const f = flight.current;
        if (!f) return;
        // Time from performance.now(), not the callback's timestamp: jsdom's
        // timestamps run on another clock, and a flight must always finish.
        const t = Math.min(1, Math.max(0, (performance.now() - f.start) / f.ms));
        const e = easeOutCubic(t);
        // The last frame lands exactly on the target, so 2.25 km reads 2.25.
        const s = t === 1 ? f.toScale : f.fromScale * (f.toScale / f.fromScale) ** e;
        const k = kmPerUnit(s);
        const p: Pan = f.anchor
          ? { eKm: f.anchor.eKm - f.anchor.dx * k, nKm: f.anchor.nKm + f.anchor.dy * k }
          : {
              eKm: f.fromPan.eKm + (f.toPan.eKm - f.fromPan.eKm) * e,
              nKm: f.fromPan.nKm + (f.toPan.nKm - f.fromPan.nKm) * e,
            };
        view.current = { pan: p, scaleKm: s };
        markMoving();
        setPan(p);
        setZoom(s);
        if (t < 1) frameReq.current = requestAnimationFrame(step);
        else flight.current = null;
      };
      frameReq.current = requestAnimationFrame(step);
    },
    [setZoom, markMoving],
  );

  useEffect(() => stopFlight, [stopFlight]);

  const recentre = () => fly(centre, RECENTRE_KM, JUMP_FLIGHT_MS);

  useEffect(() => {
    if (!mapFocus) return;
    const to = { eKm: mapFocus.enu.e_m / 1000, nKm: mapFocus.enu.n_m / 1000 };
    fly(to, flight.current?.toScale ?? view.current.scaleKm, JUMP_FLIGHT_MS);
  }, [mapFocus, fly]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Registered natively: React's wheel handler is passive and cannot stop
    // the page from scrolling.
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      // Line- and page-mode deltas (Firefox, some mice) to pixels.
      const px = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      // Notches accumulate on the flight's destination, not the current frame,
      // so a fast spin zooms as far as the notches say.
      const from = flight.current?.toScale ?? view.current.scaleKm;
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, from * Math.exp(px * WHEEL_ZOOM_PER_PX)),
      );
      if (next === from) return;

      // Keep the ground point under the cursor fixed across the zoom. Without
      // screen geometry (jsdom) the zoom still happens, about the view centre.
      const { pan: now, scaleKm: nowScale } = view.current;
      const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
      if (!ctm || typeof DOMPoint === 'undefined') {
        fly(now, next, WHEEL_FLIGHT_MS);
        return;
      }
      const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
      const dx = p.x - VIEW.cx;
      const dy = p.y - VIEW.cy;
      const k = kmPerUnit(nowScale);
      const anchor = { eKm: now.eKm + dx * k, nKm: now.nKm - dy * k, dx, dy };
      const kNext = kmPerUnit(next);
      fly(
        { eKm: anchor.eKm - dx * kNext, nKm: anchor.nKm + dy * kNext },
        next,
        WHEEL_FLIGHT_MS,
        anchor,
      );
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [dataset, fly]);

  /** Whole kilometres, so the grid re-renders per ring crossed, not per pixel. */
  const gridExtentKm = scaleKm + Math.ceil(Math.hypot(pan.eKm, pan.nKm));

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    // Grabbing the map stops any flight where it is.
    stopFlight();
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: view.current.pan,
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
    markMoving();
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

  /** The box every position falls inside: all track fixes, zones and frame centres. */
  const area = useMemo(
    () => (dataset
      ? operationArea(tracks, [...dataset.zones.map((z) => z.enu), ...dataset.frames.map((f) => f.centre_enu)])
      : null),
    [dataset, tracks],
  );

  /**
   * The selected vehicle's route so far. Only while it is on the map, and not
   * under the heat view, which turns trails off for the same reason (F5.4).
   */
  const route = useMemo(() => {
    if (!dataset || heatOn || !selectedTrackId) return null;
    if (!vehicles.some((vehicle) => vehicle.trackId === selectedTrackId)) return null;
    const history = trackIndex.get(selectedTrackId);
    return history
      ? activityOf(history, {
          toMin: tMin,
          zones: dataset.zones,
          stationaryDispM: dataset.thresholds.stationary_disp_m,
        })
      : null;
  }, [dataset, heatOn, selectedTrackId, vehicles, trackIndex, tMin]);

  /** Zones any live ALERT names. Drives the pulse. */
  const alertingZones = useMemo(() => {
    const out = new Set<string>();
    for (const vehicle of vehicles) {
      if (vehicle.level === 'ALERT' && vehicle.alert?.zone_id) out.add(vehicle.alert.zone_id);
    }
    return out;
  }, [vehicles]);

  /* The density field (PLAN 6.12). Three memos, keyed on purpose.
   *
   * `blobs` follows the *filtered* live set, so the field and the glyphs can
   * never describe different fleets. `heatReference` is the exercise-wide peak
   * and is computed over the *unfiltered* fleet, so narrowing to one zone
   * reduces the heat on screen rather than rescaling it -- and normalising
   * against the whole window rather than the current tick is what stops a lone
   * parked car at 08:10 rendering as deep as the 13:50 build-up. Both are keyed
   * off `heatOn`, so a reviewer who never opens the view never pays the pass.
   */
  const blobs = useMemo(() => (heatOn ? blobsOf(vehicles) : []), [heatOn, vehicles]);

  const references = useMemo(() => {
    if (!heatOn || !dataset) return { field: 0, zone: 0 };
    return referencesOf(
      dataset.zones,
      referenceClocks(dataset.sim.start_min, dataset.sim.end_min).map((at) =>
        blobsOf(
          liveVehiclesAt({
            tMin: at,
            tracks,
            frames: dataset.frames,
            alertsByFrame,
            stationaryDispM: dataset.thresholds.stationary_disp_m,
            classFilter: 'all',
            zoneFilter: 'all',
          }),
        ),
      ),
    );
  }, [heatOn, dataset, tracks, alertsByFrame]);

  /** The ranking in words, for the toggle's caption and the screen reader. */
  const densest = useMemo(
    () => (heatOn && dataset
      ? densestZone(zonePressures(dataset.zones, blobs, references.zone))
      : null),
    [heatOn, dataset, blobs, references.zone],
  );

  if (!dataset) return null;

  /** The ground on screen, for culling basemap tiles and labels. */
  const ground = visibleBox(projection, pan);

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
      {/* Wider than the viewBox: a letterboxed stage shows ground past its sides. */}
      <rect
        x={-VIEW.w}
        y={-VIEW.h}
        width={VIEW.w * 3}
        height={VIEW.h * 3}
        fill={basemap ? 'var(--map-land)' : 'var(--surface-map)'}
      />
      <g
        transform={`translate(${-pan.eKm * projection.unitsPerKm} ${pan.nKm * projection.unitsPerKm})`}
      >
        {basemap && <BasemapLayer map={basemap} projection={projection} view={ground} />}
        {area && <OperationArea area={area} projection={projection} />}
        <GridLayer projection={projection} extentKm={gridExtentKm} />
        {heatOn && (
          <HeatLayer blobs={blobs} projection={projection} reference={references.field} />
        )}
        {basemap && (
          <BasemapLabels
            map={basemap}
            projection={projection}
            view={ground}
            zones={dataset.zones}
            baseName={dataset.base.name}
          />
        )}
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
        {route && (
          <RouteLayer
            route={route.route}
            stops={route.stops}
            projection={projection}
            originIso={dataset.origin_ts}
          />
        )}
        <g className={heatOn ? 'radar-vehicles radar-vehicles--dimmed' : 'radar-vehicles'}>
          <VehicleLayer
            vehicles={vehicles}
            histories={trackIndex}
            projection={projection}
            tMin={tMin}
            selectedId={selectedTrackId}
            hoveredId={hoveredTrackId}
            pins={pins}
            trails={!heatOn}
            routedId={route ? selectedTrackId : null}
            onSelect={selectTrack}
            onHover={hoverTrack}
          />
        </g>
      </g>

      {basemap && <Attribution text={basemap.attribution} />}
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
      {/* The density toggle. Small, semi-transparent, bottom-right -- and it
          states which view is on and which zone the field is pointing at, so the
          control explains its own state rather than just holding an icon
          (PLAN F5.3). A map control, not a view: `view` is untouched. */}
      <g
        className="radar-heat-toggle"
        data-on={heatOn || undefined}
        role="button"
        tabIndex={0}
        aria-pressed={heatOn}
        aria-label={heatOn ? T.heat.toOff : T.heat.toOn}
        onClick={(event) => {
          event.stopPropagation();
          toggleHeat();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleHeat();
          }
        }}
      >
        <title>{heatOn ? T.heat.toOff : T.heat.toOn}</title>
        {heatOn && (
          <text
            className="radar-heat-toggle__caption"
            x={VIEW.w - 20}
            y={VIEW.h - 54}
            fontSize={9}
            textAnchor="end"
          >
            {densest
              ? T.heat.densest(densest.name, Math.round(densest.value * 100))
              : T.heat.quiet}
          </text>
        )}
        <rect x={VIEW.w - 82} y={VIEW.h - 46} width={62} height={26} rx={4} />
        {/* Three rings: the kernel the field is made of, at icon size. */}
        <g aria-hidden="true" fill="var(--heat)">
          <circle cx={VIEW.w - 70} cy={VIEW.h - 33} r={6.5} opacity={0.18} />
          <circle cx={VIEW.w - 70} cy={VIEW.h - 33} r={4} opacity={0.42} />
          <circle cx={VIEW.w - 70} cy={VIEW.h - 33} r={1.8} opacity={0.85} />
        </g>
        <text
          className="radar-heat-toggle__label"
          x={VIEW.w - 43}
          y={VIEW.h - 29}
          fontSize={10}
          textAnchor="middle"
        >
          {T.heat.name}
        </text>
      </g>
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
