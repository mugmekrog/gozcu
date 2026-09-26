/* Speech state.
 *
 * A second store, and the reason is measured rather than stylistic. `useAppStore`
 * exists as one store because the clock, the map, the agent column and the modal
 * all read the same state; splitting that would only move a synchronisation
 * problem. Speech is the opposite case. The microphone's level arrives once per
 * render quantum -- 128 samples, so every 2.7 ms at 48 kHz, around 370 updates a
 * second -- and it is read by exactly two components, both of them the voice UI.
 * Writing that into the store that drives the radar would re-render the tactical
 * display a few hundred times a second to animate a row of bars.
 *
 * So level and phase live here, and `useVoice` throttles the level to about 20
 * writes a second before it ever reaches this store. The bars still read as
 * continuous -- they carry the window's peak rather than its last frame, so a
 * transient is not lost between writes.
 *
 * The session lives here rather than in the voice view for a requirement rather
 * than a preference: saying "kayıtlar sayfasına geç" changes the view, and if the
 * microphone belonged to the voice screen it would be torn down by the command it
 * just performed. The hook that owns the device is mounted in the app shell.
 */

import { create } from 'zustand';
import type { RoutedCommand, SpeechStatus, Transcript } from '@/voice/stt';
import { offlineStatus } from '@/voice/stt';

/** Where a session is, start to finish. Drives the one status line the dock shows. */
export type VoicePhase =
  | 'idle'
  | 'calibrating'
  | 'listening'
  | 'hearing'
  | 'trailing'
  | 'transcribing'
  | 'routing'
  | 'working'
  | 'confirming';

/** One line in DUYULANLAR: what was said, what it meant, what happened. */
export interface VoiceEntry {
  id: string;
  /** Exercise-clock-independent: this is real wall time, when it was said. */
  at: number;
  /** The normalised transcript, which is what the router saw. */
  text: string;
  /** What the model wrote before normalisation, when the two differ. */
  rawText: string;
  normalised: string[];
  durationS: number;
  command: string | null;
  args: Record<string, unknown>;
  effect: 'view' | 'compute' | 'audit' | null;
  /** Whether the command was performed, as opposed to merely understood. */
  ok: boolean;
  /** One operator-facing line saying what happened, or why not. */
  summary: string;
  /** A copilot answer, when the utterance was a question. */
  answer?: string;
  sttLatencyMs: number | null;
  routeLatencyMs: number | null;
  fromCache: boolean;
  costUsd: number;
}

/** A command held back until the operator confirms it out loud. */
export interface PendingConfirm {
  entryId: string;
  command: string;
  args: Record<string, unknown>;
  /** What the operator will be told is about to be recorded. */
  what: string;
  heard: string;
  expiresAt: number;
}

const MAX_HISTORY = 40;

interface VoiceState {
  /** Whether speech can be used at all, and on what. Read once at boot. */
  status: SpeechStatus;
  statusLoaded: boolean;

  phase: VoicePhase;
  /** 0-1, relative to the measured room noise. What the bars draw. */
  level: number;
  /** Seconds of speech held in the current utterance. */
  heldS: number;
  /** True while the microphone is open, whatever the phase. */
  open: boolean;
  /** The last error, already translated. Cleared when a new session starts. */
  error: string | null;
  /** Set when the level never rose: the operator is owed "mikrofona yaklaşın". */
  quiet: boolean;
  clipping: boolean;

  history: VoiceEntry[];
  pending: PendingConfirm | null;
}

interface VoiceActions {
  setStatus(status: SpeechStatus): void;
  setPhase(phase: VoicePhase): void;
  setLevel(level: number, heldS: number): void;
  setOpen(open: boolean): void;
  setError(error: string | null): void;
  setQuiet(quiet: boolean): void;
  setClipping(clipping: boolean): void;

  addEntry(entry: VoiceEntry): void;
  updateEntry(id: string, patch: Partial<VoiceEntry>): void;
  clearHistory(): void;

  setPending(pending: PendingConfirm | null): void;
  reset(): void;
}

export const useVoiceStore = create<VoiceState & VoiceActions>((set, get) => ({
  status: offlineStatus(),
  statusLoaded: false,

  phase: 'idle',
  level: 0,
  heldS: 0,
  open: false,
  error: null,
  quiet: false,
  clipping: false,

  history: [],
  pending: null,

  setStatus(status) {
    set({ status, statusLoaded: true });
  },
  setPhase(phase) {
    set({ phase });
  },
  setLevel(level, heldS) {
    set({ level, heldS });
  },
  setOpen(open) {
    // Closing the microphone zeroes the bars: a meter frozen at its last reading
    // looks like a live one, which is exactly the wrong thing for a mic indicator.
    set(open ? { open } : { open, level: 0, heldS: 0 });
  },
  setError(error) {
    set({ error });
  },
  setQuiet(quiet) {
    set({ quiet });
  },
  setClipping(clipping) {
    set({ clipping });
  },

  addEntry(entry) {
    // Newest first: the operator reads the top of the list, and the thing they
    // just said is the thing they are looking for.
    set({ history: [entry, ...get().history].slice(0, MAX_HISTORY) });
  },
  updateEntry(id, patch) {
    set({
      history: get().history.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    });
  },
  clearHistory() {
    set({ history: [] });
  },

  setPending(pending) {
    set({ pending, phase: pending ? 'confirming' : 'idle' });
  },

  reset() {
    set({ phase: 'idle', level: 0, heldS: 0, open: false, quiet: false, clipping: false });
  },
}));

/** Whether the microphone should be enabled, and why not when it should not. */
export function speechAvailable(status: SpeechStatus): boolean {
  return status.stt.ready && status.voice.enabled;
}

export function nextEntryId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Build a history line from a transcript, before the command has been performed. */
export function entryFromTranscript(
  transcript: Transcript,
  route: RoutedCommand | null,
): VoiceEntry {
  return {
    id: nextEntryId(),
    at: Date.now(),
    text: transcript.text,
    rawText: transcript.raw_text,
    normalised: transcript.normalised,
    durationS: transcript.duration,
    command: route?.command ?? null,
    args: route?.args ?? {},
    effect: route?.effect ?? null,
    ok: false,
    summary: '',
    sttLatencyMs: transcript.metrics?.stt_latency_ms ?? null,
    routeLatencyMs: route?.latency_ms ?? null,
    fromCache: route?.from_cache ?? false,
    costUsd: route?.cost_usd ?? 0,
  };
}
