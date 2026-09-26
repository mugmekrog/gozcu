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
import { DEFAULT_SCALE, type ScaleKm } from '@/domain/polar';
import { minutesOf } from '@/domain/format';
import type {
  Alert,
  Brief,
  DatasetInfo,
  Decision,
  FieldReport,
  FrameDetail,
  TrackHistory,
  VehicleClass,
} from '@/domain/types';

export type ViewName = 'map' | 'motion' | 'logs';
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
  scaleKm: ScaleKm;
  showSuppressed: boolean;
  showAllInMotion: boolean;

  // --- the opened frame and its evaluation --------------------------------- //
  frame: FrameDetail | null;
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

  // --- record -------------------------------------------------------------- //
  decisions: Decision[];
  toast: Toast | null;
}

interface Actions {
  boot(): Promise<void>;

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
  setScale(scaleKm: ScaleKm): void;
  setShowSuppressed(show: boolean): void;
  setShowAllInMotion(show: boolean): void;

  /** Open a frame: loads its detail and moves the clock to its capture time. */
  openFrame(imageId: string, opts?: { seek?: boolean }): Promise<void>;
  assess(imageId: string): Promise<void>;
  setStepsExpanded(expanded: boolean): void;

  openModal(kind: ModalKind): void;
  closeModal(): void;
  setModalInfoOpen(open: boolean): void;
  setModalTarget(detId: string | null): void;

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
  scaleKm: DEFAULT_SCALE,
  showSuppressed: false,
  showAllInMotion: false,

  frame: null,
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
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
  setScale(scaleKm) {
    set({ scaleKm });
  },
  setShowSuppressed(showSuppressed) {
    set({ showSuppressed });
  },
  setShowAllInMotion(showAllInMotion) {
    set({ showAllInMotion });
  },

  async openFrame(imageId, opts = {}) {
    const { dataset, selectedFrameId, frame } = get();
    const summary = dataset?.frames.find((f) => f.image_id === imageId);

    // Selecting the frame that is already open keeps its evaluation; switching
    // frames discards it, because a brief belongs to one frame only.
    const isSame = selectedFrameId === imageId && frame?.image_id === imageId;
    set({
      selectedFrameId: imageId,
      frameLoading: !isSame,
      ...(isSame
        ? {}
        : {
            frame: null,
            steps: [],
            brief: null,
            assessPhase: 'idle' as AssessPhase,
            assessElapsedMs: 0,
            assessToolCalls: 0,
            assessError: null,
          }),
      ...(opts.seek !== false && summary ? { tMin: summary.capture_min, playing: false } : {}),
    });

    if (isSame) return;
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
          set({ brief: event.brief });
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
          const detail = await api().frame(imageId);
          if (get().selectedFrameId === imageId) set({ frame: detail, frameLoading: false });
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
