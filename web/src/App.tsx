import { useEffect, useMemo, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { MapToolbar } from '@/components/MapToolbar';
import { Timeline } from '@/components/Timeline';
import { VehicleInfobox } from '@/components/VehicleInfobox';
import { PinList } from '@/components/PinList';
import { AlertModal } from '@/components/AlertModal';
import { CameraFrame } from '@/components/CameraFrame';
import { Toast } from '@/components/Toast';
import { Radar } from '@/radar/Radar';
import { LogsView } from '@/views/LogsView';
import { api } from '@/api';
import { assembleBrief } from '@/domain/brief';
import { framesOverZone, liveVehiclesAt, nearestZoneId, zoneAssessmentFor } from '@/domain/live';
import { T } from '@/domain/strings';
import { useAppStore } from '@/store/useAppStore';
import './app.css';

export function App() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const boot = useAppStore((s) => s.boot);
  useEffect(() => { void boot(); }, [boot]);

  if (status === 'loading') return <div className="app-gate" role="status"><b>{T.app.loading}</b></div>;
  if (status === 'error') return (
    <div className="app-gate" role="alert">
      <b>{T.app.loadFailed}</b>
      <p className="muted">{error}</p>
      <p className="muted app-gate__hint">{T.app.loadFailedHint}</p>
      <button type="button" className="btn" onClick={() => void boot()}>{T.app.retry}</button>
    </div>
  );
  return <Workspace />;
}

function Workspace() {
  const dataset = useAppStore((s) => s.dataset)!;
  const tracks = useAppStore((s) => s.tracks);
  const trackIndex = useAppStore((s) => s.trackIndex);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const tMin = useAppStore((s) => s.tMin);
  const view = useAppStore((s) => s.view);
  const zoneFilter = useAppStore((s) => s.zoneFilter);
  const classFilter = useAppStore((s) => s.classFilter);
  const scaleKm = useAppStore((s) => s.scaleKm);
  const selectedTrackId = useAppStore((s) => s.selectedTrackId);
  const pins = useAppStore((s) => s.pins);
  const selectedFrameId = useAppStore((s) => s.selectedFrameId);
  const frame = useAppStore((s) => s.frame);
  const modal = useAppStore((s) => s.modal);
  const modalInfoOpen = useAppStore((s) => s.modalInfoOpen);
  const modalTargetDetId = useAppStore((s) => s.modalTargetDetId);
  const showSuppressed = useAppStore((s) => s.showSuppressed);
  const toast = useAppStore((s) => s.toast);

  const setTime = useAppStore((s) => s.setTime);
  const setView = useAppStore((s) => s.setView);
  const setZoneFilter = useAppStore((s) => s.setZoneFilter);
  const setClassFilter = useAppStore((s) => s.setClassFilter);
  const setScale = useAppStore((s) => s.setZoom);
  const selectTrack = useAppStore((s) => s.selectTrack);
  const togglePin = useAppStore((s) => s.togglePin);
  const openFrame = useAppStore((s) => s.openFrame);
  const assess = useAppStore((s) => s.assess);
  const focusMap = useAppStore((s) => s.focusMap);
  const openModal = useAppStore((s) => s.openModal);
  const closeModal = useAppStore((s) => s.closeModal);
  const setModalInfoOpen = useAppStore((s) => s.setModalInfoOpen);
  const setModalTarget = useAppStore((s) => s.setModalTarget);
  const setShowSuppressed = useAppStore((s) => s.setShowSuppressed);
  const record = useAppStore((s) => s.record);
  const showToast = useAppStore((s) => s.showToast);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraSelectedDetId, setCameraSelectedDetId] = useState<string | null>(null);
  const client = api();

  const vehicles = useMemo(() => {
    const all = liveVehiclesAt({
      tMin, tracks, frames: dataset.frames, alertsByFrame,
      stationaryDispM: dataset.thresholds.stationary_disp_m, classFilter, zoneFilter: 'all',
    });
    return zoneFilter === 'all' ? all
      : all.filter((vehicle) => nearestZoneId(vehicle.sample.enu, dataset.zones) === zoneFilter);
  }, [tMin, tracks, dataset, alertsByFrame, classFilter, zoneFilter]);
  const timelineFrames = useMemo(() => zoneFilter === 'all' ? dataset.frames
    : framesOverZone(dataset.frames, dataset.zones, zoneFilter), [dataset.frames, dataset.zones, zoneFilter]);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.trackId === selectedTrackId) ?? null;
  const selectedSummary = dataset.frames.find((item) => item.image_id === selectedFrameId) ?? null;
  const brief = useMemo(() => frame ? assembleBrief(frame, {
    zones: dataset.zones, histories: trackIndex,
    stationaryDispM: dataset.thresholds.stationary_disp_m, originIso: dataset.origin_ts,
  }) : null, [frame, dataset, trackIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') setTime(useAppStore.getState().tMin + (event.shiftKey ? 30 : 5));
      if (event.key === 'ArrowLeft') setTime(useAppStore.getState().tMin - (event.shiftKey ? 30 : 5));
      if (event.key === 'Escape') {
        if (useAppStore.getState().modal) closeModal();
        else if (cameraOpen) setCameraOpen(false);
        else selectTrack(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTime, closeModal, selectTrack, cameraOpen]);

  const inspectVehicle = async () => {
    if (!selectedVehicle?.imageId || !selectedVehicle.alert) return;
    await openFrame(selectedVehicle.imageId);
    try {
      await assess(selectedVehicle.imageId);
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : String(error) });
    }
    const alert = useAppStore.getState().frame?.alerts.find(
      (item) => item.track_id === selectedVehicle.trackId,
    ) ?? selectedVehicle.alert;
    openModal(alert.level === 'ALERT' ? 'threat' : 'review');
  };
  const openCamera = () => {
    setCameraSelectedDetId(frame?.matches.find((match) => match.track_id === selectedTrackId)?.det_id ?? null);
    setCameraOpen(true);
    if (!frame && selectedFrameId) void openFrame(selectedFrameId, { seek: false });
  };

  return (
    <div className="app">
      <AppHeader />
      <div className="app__body">
        <main className="app__map panel">
          <MapToolbar view={view === 'logs' ? 'logs' : 'map'} onView={setView}
            zones={dataset.zones} zoneFilter={zoneFilter} classFilter={classFilter}
            scaleKm={scaleKm} selectedFrame={selectedSummary}
            onZoneFilter={setZoneFilter} onClassFilter={setClassFilter}
            onScale={setScale} onCamera={openCamera} />
          <div className="app__stage">
            {view !== 'logs' ? <>
              <Radar />
              <PinList pins={pins} vehicles={vehicles} onUnpin={togglePin} onSelect={selectTrack} />
              {selectedVehicle && <VehicleInfobox
                vehicle={selectedVehicle}
                zone={dataset.zones.find((zone) => zone.zone_id === selectedVehicle.alert?.zone_id) ?? null}
                assessment={frame?.image_id === selectedVehicle.imageId
                  ? zoneAssessmentFor(frame.zone_assessments, selectedVehicle.trackId, selectedVehicle.alert?.zone_id ?? null)
                  : null}
                pinned={pins.includes(selectedVehicle.trackId)}
                onSelectFrame={(imageId) => void openFrame(imageId)}
                onInspect={() => void inspectVehicle()}
                onTogglePin={() => togglePin(selectedVehicle.trackId)}
                onClose={() => selectTrack(null)}
              />}
            </> : <LogsView />}
            {cameraOpen && frame && <div className="app__camera">
              <div className="app__camera-head">
                <b>{frame.image_id}</b>
                <span className="muted">{frame.capture_hhmm} · {frame.width_px}×{frame.height_px}</span>
                <div className="spacer" />
                <button type="button" className="btn btn--small" onClick={() => setCameraOpen(false)}>Görüntüyü kapat ✕</button>
              </div>
              <div className="app__camera-body">
                <CameraFrame frame={frame} imageUrl={client.imageUrl(frame.image_id)} evaluated
                  selectedDetId={cameraSelectedDetId} showSuppressed={showSuppressed}
                  onShowSuppressed={setShowSuppressed} onSelectDetection={setCameraSelectedDetId} />
              </div>
            </div>}
          </div>
          <Timeline originIso={dataset.origin_ts} startMin={dataset.sim.start_min} endMin={dataset.sim.end_min}
            tMin={tMin} frames={timelineFrames} selectedFrameId={selectedFrameId}
            onSeek={setTime} onSelectFrame={(imageId) => {
              const summary = dataset.frames.find((item) => item.image_id === imageId);
              if (summary) focusMap(summary.centre_enu);
              void openFrame(imageId);
            }} />
        </main>
      </div>
      {modal && frame && brief && <AlertModal kind={modal} frame={frame} brief={brief}
        imageUrl={client.imageUrl(frame.image_id)} histories={trackIndex} originIso={dataset.origin_ts}
        stationaryDispM={dataset.thresholds.stationary_disp_m} infoOpen={modalInfoOpen}
        targetDetId={modalTargetDetId} showSuppressed={showSuppressed}
        onInfoOpen={setModalInfoOpen} onTarget={setModalTarget} onShowSuppressed={setShowSuppressed}
        onDecide={(verdict, note) => void record(verdict, note)} onClose={closeModal} />}
      {toast && <Toast toast={toast} onDismiss={() => showToast(null)} />}
      {selectedSummary && <p className="sr-only" aria-live="polite">Seçili kare {selectedSummary.image_id}, {selectedSummary.capture_hhmm}, {selectedSummary.vehicle_count} araç.</p>}
    </div>
  );
}
