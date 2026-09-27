/* Application state.
 *
 * One store, because almost every piece of state here is read by two or more of
 * the map, the timeline, the agent column and the modal -- the clock drives all
 * four, and a selection made on the map must highlight a chart line and a table
 * row at the same time (wireframe 1a's interaction note). Splitting that across
 * stores would just move the synchronisation problem.
 *
 * The boot payloads are held as loaded and never mutated; only the UI slice
 * changes. Zustand selectors keep the map from re-rendering when a table row is
 * hovered.
 */

import { create } from 'zustand';
import { api } from '@/api';
import type { AgentStep } from '@/api';
import { DEFAULT_SCALE } from '@/domain/polar';
import { prepareBasemap, type PreparedBasemap } from '@/domain/basemap';
import { minutesOf } from '@/domain/format';
import type { LevelFilter } from '@/domain/live';
import { DEFAULT_LAYERS, type MapLayerId, type MapLayers } from '@/domain/mapLayers';
import type {
  Alert,
  Brief,
  DatasetInfo,
  Decision,
  Enu,
  FieldReport,
  FrameDetail,
  TrackHistory,
  VehicleClass,
} from '@/domain/types';

/* `voice` is the fourth view, added for the speech assistant. The wireframes have
 * no screen for it -- that divergence is recorded as S3 in
 * logs/step_stt_development_logs.md, the same way the frontend log records the
 * screens it declined to invent. */
export type ViewName = 'map' | 'motion' | 'logs' | 'voice';
export type ModalKind = 'threat' | 'review';
export type AssessPhase = 'idle' | 'running' | 'done' | 'error';

/** The longest a pin list may get. Beyond six, identity colours stop reading. */
export const PIN_LIMIT = 6;

export const SPEED_OPTIONS = [1, 30, 120, 300] as const;
export type SimSpeed = (typeof SPEED_OPTIONS)[number];

export interface Toast {
  message: string;
  detail?: string;
  actionLabel?: string;
  action?: () => void;
}

interface State {
  // --- boot data ----------------------------------------------------------- //
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  dataset: DatasetInfo | null;
  tracks: TrackHistory[];
  trackIndex: ReadonlyMap<string, TrackHistory>;
  reports: FieldReport[];
  alerts: Alert[];
  /** Every alert, keyed by the frame it was raised in. */
  alertsByFrame: ReadonlyMap<string, Alert[]>;
  /**
   * The OpenStreetMap city under the radar. Loaded after boot, never before
   * it: the map is usable on its plain ground while ~460 KB of streets arrive.
   * Null until then, and for good if the file was never baked.
   */
  basemap: PreparedBasemap | null;

  // --- clock --------------------------------------------------------------- //
  /** Minutes from the exercise origin. */
  tMin: number;
  playing: boolean;
  speed: SimSpeed;

  // --- navigation ---------------------------------------------------------- //
  view: ViewName;
  menuOpen: boolean;

  // --- selection ----------------------------------------------------------- //
  selectedTrackId: string | null;
  hoveredTrackId: string | null;
  pins: string[];
  selectedFrameId: string | null;

  // --- filters ------------------------------------------------------------- //
  zoneFilter: string | 'all';
  classFilter: VehicleClass | 'all';
  /** Set from the map legend: show one warning level on its own. */
  levelFilter: LevelFilter;
  /** Visible map radius in kilometres; set continuously by the mouse wheel. */
  scaleKm: number;
  showSuppressed: boolean;
  showAllInMotion: boolean;
  /**
   * Which map layers are drawn (see domain/mapLayers.ts).
   *
   * Map controls rather than views: the reviewer is not leaving the map, they
   * are changing how the same clock is drawn. So they live here beside
   * `scaleKm` instead of in `view`, which also puts the density field within
   * reach of the timeline, the filters and a voice command without a new code
   * path -- `setHeat`/`toggleHeat` are `layers.heat` under another name.
   */
  layers: MapLayers;

  // --- the opened frame and its evaluation --------------------------------- //
  frame: FrameDetail | null;
  evaluatedFrames: ReadonlyMap<string, FrameDetail>;
  frameLoading: boolean;
  steps: AgentStep[];
  brief: Brief | null;
  assessPhase: AssessPhase;
  assessElapsedMs: number;
  assessToolCalls: number;
  assessError: string | null;
  stepsExpanded: boolean;

  // --- modal --------------------------------------------------------------- //
  modal: ModalKind | null;
  modalInfoOpen: boolean;
  modalTargetDetId: string | null;
  /**
   * A request for the map to centre on a ground point. `seq` makes a repeat
   * request for the same point still move a map the operator has panned since.
   */
  mapFocus: { enu: Enu; seq: number } | null;

  /** The vehicle whose route report is open (the Strava reading), if any. */
  reportTrackId: string | null;

  // --- record -------------------------------------------------------------- //
  decisions: Decision[];
  toast: Toast | null;
}

interface Actions {
  boot(): Promise<void>;
  loadBasemap(): Promise<void>;

  setTime(tMin: number): void;
  play(): void;
  pause(): void;
  togglePlay(): void;
  setSpeed(speed: SimSpeed): void;
  advance(deltaMin: number): void;

  setView(view: ViewName): void;
  setMenuOpen(open: boolean): void;

  selectTrack(trackId: string | null): void;
  hoverTrack(trackId: string | null): void;
  togglePin(trackId: string): void;
  clearPins(): void;

  setZoneFilter(zoneId: string | 'all'): void;
  setClassFilter(cls: VehicleClass | 'all'): void;
  setLevelFilter(level: LevelFilter): void;
  /** Continuous zoom from the mouse wheel. */
  setZoom(scaleKm: number): void;
  setShowSuppressed(show: boolean): void;
  setShowAllInMotion(show: boolean): void;
  setLayer(id: MapLayerId, on: boolean): void;
  toggleLayer(id: MapLayerId): void;
  setHeat(on: boolean): void;
  toggleHeat(): void;

  /** Open a frame: loads its detail and moves the clock to its capture time. */
  openFrame(imageId: string, opts?: { seek?: boolean }): Promise<void>;
  focusMap(enu: Enu): void;
  assess(imageId: string): Promise<void>;
  askAgent(question: string): Promise<string>;
  setStepsExpanded(expanded: boolean): void;

  openModal(kind: ModalKind): void;
  closeModal(): void;
  setModalInfoOpen(open: boolean): void;
  setModalTarget(detId: string | null): void;
  openReport(trackId: string): void;
  closeReport(): void;

  record(verdict: Decision['verdict'], note: string): Promise<void>;
  showToast(toast: Toast | null): void;
}

function indexTracks(tracks: readonly TrackHistory[]): Map<string, TrackHistory> {
  return new Map(tracks.map((t) => [t.track_id, t]));
}

function groupAlerts(alerts: readonly Alert[]): Map<string, Alert[]> {
  const out = new Map<string, Alert[]>();
  for (const alert of alerts) {
    const key = alert.image_id;
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(alert);
    else out.set(key, [alert]);
  }
  return out;
}

export const useAppStore = create<State & Actions>((set, get) => ({
  status: 'loading',
  error: null,
  dataset: null,
  tracks: [],
  trackIndex: new Map(),
  reports: [],
  alerts: [],
  alertsByFrame: new Map(),
  basemap: null,

  tMin: 0,
  playing: false,
  speed: 120,

  view: 'map',
  menuOpen: false,

  selectedTrackId: null,
  hoveredTrackId: null,
  pins: [],
  selectedFrameId: null,

  zoneFilter: 'all',
  classFilter: 'all',
  levelFilter: 'all',
  scaleKm: DEFAULT_SCALE,
  showSuppressed: false,
  showAllInMotion: false,
  layers: DEFAULT_LAYERS,

  frame: null,
  evaluatedFrames: new Map(),
  frameLoading: false,
  steps: [],
  brief: null,
  assessPhase: 'idle',
  assessElapsedMs: 0,
  assessToolCalls: 0,
  assessError: null,
  stepsExpanded: true,

  modal: null,
  modalInfoOpen: false,
  modalTargetDetId: null,
  mapFocus: null,
  reportTrackId: null,

  decisions: [],
  toast: null,

  async boot() {
    const client = api();
    try {
      const [dataset, tracks, reports, alerts] = await Promise.all([
        client.dataset(),
        client.tracks(),
        client.reports(),
        client.alerts(),
      ]);

      // Open on the first frame's capture time rather than at the window's
      // start: at 08:10 no image has been taken yet, so the map would be a
      // correct but unhelpful field of unassessed dots.
      const firstFrame = dataset.frames[0];
      set({
        status: 'ready',
        dataset,
        tracks,
        trackIndex: indexTracks(tracks),
        reports,
        alerts,
        alertsByFrame: groupAlerts(alerts),
        tMin: firstFrame?.capture_min ?? minutesOf(dataset.origin_ts, dataset.sim.start_hhmm),
        selectedFrameId: firstFrame?.image_id ?? null,
      });
      void get().loadBasemap();
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async loadBasemap() {
    if (get().basemap) return;
    const file = await api().basemap();
    if (file) set({ basemap: prepareBasemap(file) });
  },

  setTime(tMin) {
    const { dataset } = get();
    const end = dataset?.sim.end_min ?? tMin;
    set({ tMin: Math.min(Math.max(tMin, 0), end) });
  },

  play() {
    const { dataset, tMin } = get();
    // Restarting from the end rewinds, rather than appearing to do nothing.
    const end = dataset?.sim.end_min ?? 0;
    set({ playing: true, tMin: tMin >= end ? 0 : tMin });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    get().playing ? get().pause() : get().play();
  },
  setSpeed(speed) {
    set({ speed });
  },
  advance(deltaMin) {
    const { tMin, dataset } = get();
    const end = dataset?.sim.end_min ?? tMin;
    const next = tMin + deltaMin;
    if (next >= end) set({ tMin: end, playing: false });
    else set({ tMin: next });
  },

  setView(view) {
    set({ view, menuOpen: false });
  },
  setMenuOpen(menuOpen) {
    set({ menuOpen });
  },

  selectTrack(selectedTrackId) {
    set({ selectedTrackId });
  },
  hoverTrack(hoveredTrackId) {
    set({ hoveredTrackId });
  },
  togglePin(trackId) {
    const { pins } = get();
    if (pins.includes(trackId)) {
      set({ pins: pins.filter((id) => id !== trackId) });
      return;
    }
    if (pins.length >= PIN_LIMIT) {
      set({ toast: { message: `En fazla ${PIN_LIMIT} araç sabitlenebilir.` } });
      return;
    }
    set({ pins: [...pins, trackId] });
  },
  clearPins() {
    set({ pins: [] });
  },

  setZoneFilter(zoneFilter) {
    set({ zoneFilter });
  },
  setClassFilter(classFilter) {
    set({ classFilter });
  },
  setLevelFilter(levelFilter) {
    set({ levelFilter });
  },
  setZoom(scaleKm) {
    set({ scaleKm });
  },
  setShowSuppressed(showSuppressed) {
    set({ showSuppressed });
  },
  setShowAllInMotion(showAllInMotion) {
    set({ showAllInMotion });
  },
  setLayer(id, on) {
    set({ layers: { ...get().layers, [id]: on } });
  },
  toggleLayer(id) {
    get().setLayer(id, !get().layers[id]);
  },
  setHeat(on) {
    get().setLayer('heat', on);
  },
  toggleHeat() {
    get().toggleLayer('heat');
  },

  async openFrame(imageId, opts = {}) {
    const { dataset, selectedFrameId, frame, evaluatedFrames } = get();
    const summary = dataset?.frames.find((f) => f.image_id === imageId);
    const evaluated = evaluatedFrames.get(imageId);

    // Keep completed evaluations by frame so a region request can be reviewed later.
    const isSame = selectedFrameId === imageId && frame?.image_id === imageId;
    set({
      selectedFrameId: imageId,
      frameLoading: !isSame && !evaluated,
      ...(isSame
        ? {}
        : {
            frame: evaluated ?? null,
            steps: [],
            brief: evaluated?.brief ?? null,
            assessPhase: (evaluated ? 'done' : 'idle') as AssessPhase,
            assessElapsedMs: 0,
            assessToolCalls: 0,
            assessError: null,
          }),
      ...(opts.seek !== false && summary ? { tMin: summary.capture_min, playing: false } : {}),
    });

    if (isSame || evaluated) return;
    try {
      const detail = await api().frame(imageId);
      // A later click may have won the race; only the current frame may land.
      if (get().selectedFrameId !== imageId) return;
      set({ frame: detail, frameLoading: false });
    } catch (error) {
      set({
        frameLoading: false,
        assessError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  focusMap(enu) {
    set({ mapFocus: { enu, seq: (get().mapFocus?.seq ?? 0) + 1 } });
  },

  async assess(imageId) {
    if (get().assessPhase === 'running') return;
    set({
      assessPhase: 'running',
      steps: [],
      brief: null,
      assessError: null,
      assessElapsedMs: 0,
      assessToolCalls: 0,
      stepsExpanded: true,
      selectedFrameId: imageId,
    });

    let hasLiveFrame = false;
    for await (const event of api().assess(imageId)) {
      if (get().selectedFrameId !== imageId) return;

      switch (event.type) {
        case 'step': {
          // A step arrives twice: active, then done. Replace in place so the
          // list stays the length of the plan instead of growing.
          const steps = [...get().steps];
          const at = steps.findIndex((s) => s.id === event.step.id);
          if (at >= 0) steps[at] = event.step;
          else steps.push(event.step);
          set({ steps });
          break;
        }
        case 'brief':
          if (get().frame?.image_id === imageId) {
            const updated = { ...get().frame!, brief: event.brief };
            set({ evaluatedFrames: new Map(get().evaluatedFrames).set(imageId, updated) });
          }
          set({
            brief: event.brief,
            frame: get().frame?.image_id === imageId
              ? { ...get().frame!, brief: event.brief }
              : get().frame,
          });
          break;
        case 'decision':
          hasLiveFrame = true;
          set({
            frame: event.frame,
            frameLoading: false,
            evaluatedFrames: new Map(get().evaluatedFrames).set(imageId, event.frame),
            alertsByFrame: new Map(get().alertsByFrame).set(imageId, event.frame.alerts),
            alerts: [...get().alerts.filter((alert) => alert.image_id !== imageId), ...event.frame.alerts],
          });
          break;
        case 'done': {
          set({
            assessPhase: 'done',
            assessElapsedMs: event.elapsedMs,
            assessToolCalls: event.toolCalls,
            stepsExpanded: false,
          });
          // The frame detail is cached by the adapter, so this is free, and it
          // guarantees the brief and the map agree on which frame is open.
          if (!hasLiveFrame) {
            const detail = await api().frame(imageId);
            if (get().selectedFrameId === imageId) set({
              frame: detail, frameLoading: false,
              evaluatedFrames: new Map(get().evaluatedFrames).set(imageId, detail),
            });
          }
          break;
        }
        case 'error':
          set({
            assessPhase: 'error',
            assessError: event.message,
            steps: event.step
              ? [...get().steps.filter((s) => s.id !== event.step?.id), event.step]
              : get().steps,
          });
          break;
      }
    }
  },

  async askAgent(question) {
    const selected = get().selectedFrameId;
    const prompt = selected ? `${question}\n\nSeçili kare kimliği: ${selected}` : question;
    const reply = await api().ask(prompt);
    let completed = 0;
    for (const imageId of reply.assessment_image_ids) {
      if (!get().dataset?.frames.some((frame) => frame.image_id === imageId)) {
        throw new Error(`Ajan bilinmeyen kare seçti: ${imageId}`);
      }
      await get().openFrame(imageId);
      await get().assess(imageId);
      if (get().assessPhase !== 'done') {
        throw new Error(`${imageId} değerlendirilemedi: ${get().assessError ?? 'bilinmeyen hata'}`);
      }
      completed++;
    }
    return completed ? `${completed} kare değerlendirildi. ${reply.answer}` : reply.answer;
  },

  setStepsExpanded(stepsExpanded) {
    set({ stepsExpanded });
  },

  openModal(modal) {
    set({ modal, modalInfoOpen: false, modalTargetDetId: null });
  },
  closeModal() {
    set({ modal: null, modalInfoOpen: false, modalTargetDetId: null });
  },
  setModalInfoOpen(modalInfoOpen) {
    set({ modalInfoOpen, ...(modalInfoOpen ? {} : { modalTargetDetId: null }) });
  },
  setModalTarget(modalTargetDetId) {
    set({ modalTargetDetId, ...(modalTargetDetId ? { modalInfoOpen: true } : {}) });
  },

  openReport(reportTrackId) {
    set({ reportTrackId });
  },
  closeReport() {
    set({ reportTrackId: null });
  },

  async record(verdict, note) {
    const { frame, dataset } = get();
    if (!frame || !dataset) return;

    const lead = [...frame.alerts].sort((a, b) => b.priority - a.priority)[0];
    const decision: Decision = {
      image_id: frame.image_id,
      hhmm: frame.capture_hhmm,
      verdict,
      note,
      operator: 'nöbetçi-1',
      agent_level: lead?.level ?? 'CLEAR',
      agent_score: lead?.breakdown.score ?? 0,
    };

    const stored = await api().record(decision);
    set({
      decisions: [...get().decisions, stored],
      modal: null,
      modalInfoOpen: false,
      modalTargetDetId: null,
      toast: {
        message: 'Operatör kararı kaydedildi',
        detail: `${frame.image_id} · ${frame.capture_hhmm}`,
        actionLabel: 'Kayda git',
        action: () => set({ view: 'logs', toast: null }),
      },
    });
  },

  showToast(toast) {
    set({ toast });
  },
}));
