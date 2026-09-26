/* The app shell.
 *
 * Owns the layout the wireframes fix -- header, then a map card beside a 430 px
 * agent column, with the timeline in the card's footer -- and the wiring between
 * them. Everything substantive is in the panels; this decides what is on screen
 * and passes each panel the slice of store it reads.
 *
 * The modal is raised from here rather than from the agent column, because an
 * evaluation finishing has to interrupt whatever the operator is looking at. That
 * is the whole point of a warning.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { MapToolbar } from '@/components/MapToolbar';
import { ViewMenu } from '@/components/ViewMenu';
import { Timeline } from '@/components/Timeline';
import { VehicleInfobox } from '@/components/VehicleInfobox';
import { PinList } from '@/components/PinList';
import { TargetFrame } from '@/components/TargetFrame';
import { AgentSteps } from '@/components/AgentSteps';
import { BriefCard } from '@/components/BriefCard';
import { AskAgent } from '@/components/AskAgent';
import { AlertModal } from '@/components/AlertModal';
import { CameraFrame } from '@/components/CameraFrame';
import { Toast } from '@/components/Toast';
import { Radar } from '@/radar/Radar';
import { PIN_COLOURS } from '@/radar/VehicleLayer';
import { MotionView } from '@/views/MotionView';
import { LogsView } from '@/views/LogsView';
import { api } from '@/api';
import { assembleBrief } from '@/domain/brief';
import { liveVehiclesAt } from '@/domain/live';
import { modalFor } from '@/domain/risk';
import { windowOf } from '@/domain/tracks';
import { zoneAssessmentFor } from '@/domain/live';
import { T } from '@/domain/strings';
import { useAppStore } from '@/store/useAppStore';
import { useSimClock } from '@/store/useSimClock';
import './app.css';

export function App() {
  useSimClock();

  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const boot = useAppStore((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (status === 'loading') {
    return (
      <div className="app-gate" role="status">
        <b>{T.app.loading}</b>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="app-gate" role="alert">
        <b>{T.app.loadFailed}</b>
        <p className="muted">{error}</p>
        <p className="muted app-gate__hint">{T.app.loadFailedHint}</p>
        <button type="button" className="btn" onClick={() => void boot()}>
          {T.app.retry}
        </button>
      </div>
    );
  }

  return <Workspace />;
}

function Workspace() {
  const dataset = useAppStore((s) => s.dataset)!;
  const tracks = useAppStore((s) => s.tracks);
  const trackIndex = useAppStore((s) => s.trackIndex);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const tMin = useAppStore((s) => s.tMin);
  const playing = useAppStore((s) => s.playing);
  const speed = useAppStore((s) => s.speed);
  const view = useAppStore((s) => s.view);
  const menuOpen = useAppStore((s) => s.menuOpen);
  const zoneFilter = useAppStore((s) => s.zoneFilter);
  const classFilter = useAppStore((s) => s.classFilter);
  const scaleKm = useAppStore((s) => s.scaleKm);
  const selectedTrackId = useAppStore((s) => s.selectedTrackId);
  const pins = useAppStore((s) => s.pins);
  const selectedFrameId = useAppStore((s) => s.selectedFrameId);
  const frame = useAppStore((s) => s.frame);
  const steps = useAppStore((s) => s.steps);
  const assessPhase = useAppStore((s) => s.assessPhase);
  const assessElapsedMs = useAppStore((s) => s.assessElapsedMs);
  const assessToolCalls = useAppStore((s) => s.assessToolCalls);
  const assessError = useAppStore((s) => s.assessError);
  const stepsExpanded = useAppStore((s) => s.stepsExpanded);
  const modal = useAppStore((s) => s.modal);
  const modalInfoOpen = useAppStore((s) => s.modalInfoOpen);
  const modalTargetDetId = useAppStore((s) => s.modalTargetDetId);
  const showSuppressed = useAppStore((s) => s.showSuppressed);
  const toast = useAppStore((s) => s.toast);

  const store = useAppStore.getState;
  const setTime = useAppStore((s) => s.setTime);
  const togglePlay = useAppStore((s) => s.togglePlay);
  const setSpeed = useAppStore((s) => s.setSpeed);
  const setView = useAppStore((s) => s.setView);
  const setMenuOpen = useAppStore((s) => s.setMenuOpen);
  const setZoneFilter = useAppStore((s) => s.setZoneFilter);
  const setClassFilter = useAppStore((s) => s.setClassFilter);
  const selectTrack = useAppStore((s) => s.selectTrack);
  const togglePin = useAppStore((s) => s.togglePin);
  const openFrame = useAppStore((s) => s.openFrame);
  const focusMap = useAppStore((s) => s.focusMap);
  const assess = useAppStore((s) => s.assess);
  const setStepsExpanded = useAppStore((s) => s.setStepsExpanded);
  const openModal = useAppStore((s) => s.openModal);
  const closeModal = useAppStore((s) => s.closeModal);
  const setModalInfoOpen = useAppStore((s) => s.setModalInfoOpen);
  const setModalTarget = useAppStore((s) => s.setModalTarget);
  const setShowSuppressed = useAppStore((s) => s.setShowSuppressed);
  const record = useAppStore((s) => s.record);
  const showToast = useAppStore((s) => s.showToast);

  const [briefEnabled, setBriefEnabled] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const client = api();
  const llmConnected = client.mode === 'http';

  const vehicles = useMemo(
    () =>
      liveVehiclesAt({
        tMin,
        tracks,
        frames: dataset.frames,
        alertsByFrame,
        stationaryDispM: dataset.thresholds.stationary_disp_m,
        classFilter,
        zoneFilter,
      }),
    [tMin, tracks, dataset, alertsByFrame, classFilter, zoneFilter],
  );

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.trackId === selectedTrackId) ?? null,
    [vehicles, selectedTrackId],
  );

  const brief = useMemo(
    () =>
      frame
        ? assembleBrief(frame, {
            zones: dataset.zones,
            histories: trackIndex,
            stationaryDispM: dataset.thresholds.stationary_disp_m,
            originIso: dataset.origin_ts,
          })
        : null,
    [frame, dataset, trackIndex],
  );

  /* Raise the modal when an evaluation lands on something that needs a decision.
   * Tracked by frame id so re-rendering cannot reopen a modal the operator just
   * dismissed. */
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (assessPhase !== 'done' || !brief || !frame) return;
    if (announced.current === frame.image_id) return;
    announced.current = frame.image_id;

    const kind = modalFor(brief.level, { agentDisagrees: brief.dissent !== null });
    if (kind) openModal(kind);
  }, [assessPhase, brief, frame, openModal]);

  useEffect(() => {
    if (assessPhase === 'running') announced.current = null;
  }, [assessPhase]);

  /* Demo hotkeys (PLAN F4.2). Space is play/pause, arrows step the clock, and
   * digits jump to a frame -- one key per demo beat, no mouse hunting on stage. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          event.preventDefault();
          setTime(store().tMin + (event.shiftKey ? 30 : 5));
          break;
        case 'ArrowLeft':
          event.preventDefault();
          setTime(store().tMin - (event.shiftKey ? 30 : 5));
          break;
        case 'm':
          setView('map');
          break;
        case 'h':
          setView('motion');
          break;
        case 'k':
          setView('logs');
          break;
        case 'd':
          if (selectedFrameId) void assess(selectedFrameId);
          break;
        case 'Escape':
          if (store().modal) closeModal();
          else if (cameraOpen) setCameraOpen(false);
          else selectTrack(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    togglePlay,
    setTime,
    setView,
    assess,
    selectedFrameId,
    closeModal,
    selectTrack,
    cameraOpen,
    store,
  ]);

  /** The timeline follows the zone filter: only that zone's frames are marked. */
  const timelineFrames = useMemo(
    () =>
      zoneFilter === 'all'
        ? dataset.frames
        : dataset.frames.filter((frame) => frame.zone_id === zoneFilter),
    [dataset.frames, zoneFilter],
  );

  /** Timeline bands: the selected vehicle's window, then each pinned one's. */
  const bands = useMemo(() => {
    const out: { fromMin: number; toMin: number; colour: string }[] = [];
    if (selectedTrackId) {
      const history = trackIndex.get(selectedTrackId);
      if (history) {
        const [from, to] = windowOf(history);
        out.push({ fromMin: from, toMin: to, colour: 'var(--risk-threat)' });
      }
    }
    pins.forEach((trackId, index) => {
      const history = trackIndex.get(trackId);
      if (!history) return;
      const [from, to] = windowOf(history);
      out.push({ fromMin: from, toMin: to, colour: PIN_COLOURS[index] ?? 'var(--ink)' });
    });
    return out;
  }, [selectedTrackId, pins, trackIndex]);

  const stepsDone = steps.filter((s) => s.state === 'done' && s.index !== null).length;
  const selectedSummary = dataset.frames.find((f) => f.image_id === selectedFrameId) ?? null;

  const onAsk = useCallback((question: string) => client.ask(question), [client]);

  const viewName =
    view === 'motion' ? T.view.motion : view === 'logs' ? T.view.logs : T.view.map;

  return (
    <div className="app">
      <AppHeader
        llmConnected={llmConnected}
        briefEnabled={briefEnabled}
        onBriefEnabledChange={setBriefEnabled}
      />

      <div className="app__body">
        <main className="app__map panel">
          <MapToolbar
            viewName={viewName}
            zones={dataset.zones}
            zoneFilter={zoneFilter}
            classFilter={classFilter}
            scaleKm={scaleKm}
            menuOpen={menuOpen}
            onMenuToggle={() => setMenuOpen(!menuOpen)}
            onZoneFilter={setZoneFilter}
            onClassFilter={setClassFilter}
          />

          <div className="app__stage">
            {view === 'map' && (
              <>
                <Radar />
                <PinList
                  pins={pins}
                  vehicles={vehicles}
                  onUnpin={togglePin}
                  onSelect={selectTrack}
                />
                {selectedVehicle && (
                  <VehicleInfobox
                    vehicle={selectedVehicle}
                    zone={
                      dataset.zones.find((z) => z.zone_id === selectedVehicle.alert?.zone_id) ??
                      null
                    }
                    assessment={
                      frame && frame.image_id === selectedVehicle.imageId
                        ? zoneAssessmentFor(
                            frame.zone_assessments,
                            selectedVehicle.trackId,
                            selectedVehicle.alert?.zone_id ?? null,
                          )
                        : null
                    }
                    pinned={pins.includes(selectedVehicle.trackId)}
                    onSelectFrame={(imageId) => void openFrame(imageId)}
                    onOpenMotion={() => setView('motion')}
                    onTogglePin={() => togglePin(selectedVehicle.trackId)}
                    onClose={() => selectTrack(null)}
                  />
                )}
              </>
            )}

            {view === 'motion' && <MotionView vehicles={vehicles} />}
            {view === 'logs' && <LogsView />}

            {cameraOpen && frame && (
              <div className="app__camera">
                <div className="app__camera-head">
                  <b>{frame.image_id}</b>
                  <span className="muted">
                    {frame.capture_hhmm} · {frame.width_px}×{frame.height_px}
                  </span>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setCameraOpen(false)}
                  >
                    Haritaya dön ✕
                  </button>
                </div>
                <div className="app__camera-body">
                  <CameraFrame
                    frame={frame}
                    imageUrl={client.imageUrl(frame.image_id)}
                    evaluated={assessPhase === 'done'}
                    selectedDetId={null}
                    showSuppressed={showSuppressed}
                    onShowSuppressed={setShowSuppressed}
                    onSelectDetection={() => {}}
                  />
                </div>
              </div>
            )}

            {menuOpen && (
              <ViewMenu current={view} onSelect={setView} onClose={() => setMenuOpen(false)} />
            )}
          </div>

          <Timeline
            originIso={dataset.origin_ts}
            startMin={dataset.sim.start_min}
            endMin={dataset.sim.end_min}
            tMin={tMin}
            playing={playing}
            speed={speed}
            frames={timelineFrames}
            selectedFrameId={selectedFrameId}
            bands={bands}
            onSeek={setTime}
            onTogglePlay={togglePlay}
            onSpeed={setSpeed}
            onSelectFrame={(imageId) => {
              // A timeline marker jumps the clock to the capture and the map to
              // where the drone was looking.
              const summary = dataset.frames.find((f) => f.image_id === imageId);
              if (summary) focusMap(summary.centre_enu);
              void openFrame(imageId);
            }}
          />
        </main>

        <aside className="app__column" aria-label={T.agent.column}>
          <p className="kicker app__column-kicker">{T.agent.column}</p>

          <TargetFrame
            frames={dataset.frames}
            selectedId={selectedFrameId}
            phase={assessPhase}
            stepsDone={stepsDone}
            stepsTotal={9}
            result={
              brief && assessPhase === 'done'
                ? {
                    level: brief.level,
                    score: brief.score,
                    vehicleCount: brief.vehicleCount,
                  }
                : null
            }
            onSelect={(imageId) => void openFrame(imageId)}
            onAssess={() => selectedFrameId && void assess(selectedFrameId)}
            onCamera={() => {
              setCameraOpen(true);
              if (!frame && selectedFrameId) void openFrame(selectedFrameId, { seek: false });
            }}
          />

          <AgentSteps
            steps={steps}
            phase={assessPhase}
            elapsedMs={assessElapsedMs}
            toolCalls={assessToolCalls}
            expanded={stepsExpanded}
            onExpandedChange={setStepsExpanded}
          />

          <BriefCard
            brief={briefEnabled ? brief : null}
            phase={briefEnabled ? assessPhase : 'idle'}
            imageId={selectedFrameId}
            error={assessError}
            stepsDone={stepsDone}
          />

          <AskAgent available={llmConnected} onAsk={onAsk} />
        </aside>
      </div>

      {modal && frame && brief && (
        <AlertModal
          kind={modal}
          frame={frame}
          brief={brief}
          imageUrl={client.imageUrl(frame.image_id)}
          histories={trackIndex}
          originIso={dataset.origin_ts}
          stationaryDispM={dataset.thresholds.stationary_disp_m}
          infoOpen={modalInfoOpen}
          targetDetId={modalTargetDetId}
          showSuppressed={showSuppressed}
          onInfoOpen={setModalInfoOpen}
          onTarget={setModalTarget}
          onShowSuppressed={setShowSuppressed}
          onDecide={(verdict, note) => void record(verdict, note)}
          onClose={closeModal}
        />
      )}

      {toast && <Toast toast={toast} onDismiss={() => showToast(null)} />}

      {selectedSummary && (
        <p className="sr-only" aria-live="polite">
          Seçili kare {selectedSummary.image_id}, {selectedSummary.capture_hhmm},{' '}
          {selectedSummary.vehicle_count} araç.
        </p>
      )}
    </div>
  );
}
