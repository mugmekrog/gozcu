/* The one hook that owns the microphone.
 *
 * Mounted in the app shell, not in the voice view, and that is a requirement
 * rather than tidiness: "kayıtlar sayfasına geç" changes the view, so a hook that
 * belonged to the voice screen would be unmounted by the command it had just
 * performed, tearing down the `AudioContext` mid-session. The device belongs to the
 * app.
 *
 * It does four things in order, and nothing else:
 *
 *   1. reads whether speech is available, once, at boot;
 *   2. opens the microphone on request and throttles the level into the store;
 *   3. sends a finished utterance and takes back a transcript and a command;
 *   4. performs the command -- after asking, when the server flagged it.
 *
 * The throttle in step 2 is the whole reason speech does not cost the display
 * anything: raw frames arrive around 370 times a second and are reduced here to
 * about 20 store writes, carrying each window's peak so a transient is not lost.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { T } from '@/domain/strings';
import { useAppStore, type SimSpeed, type ViewName } from '@/store/useAppStore';
import {
  entryFromTranscript,
  speechAvailable,
  useVoiceStore,
  type PendingConfirm,
  type VoiceEntry,
} from '@/store/useVoiceStore';
import { CaptureError, VoiceCapture, type CapturedUtterance } from '@/voice/capture';
import { performCommand, type CommandContext } from '@/voice/commands';
import { isRouted, stt, type RoutedCommand, type SpeechResult } from '@/voice/stt';
import type { ScaleKm } from '@/domain/polar';
import type { Decision, VehicleClass } from '@/domain/types';

/** About 20 level writes a second. Below a frame's worth of change, above flicker. */
const LEVEL_INTERVAL_MS = 50;

/** Level under this for a whole utterance means the microphone barely heard it. */
const QUIET_LEVEL = 0.08;

export interface UseVoiceResult {
  available: boolean;
  /** Why the microphone is disabled, when it is. */
  unavailableReason: string | null;
  start(): void;
  stopAndSend(): void;
  cancel(): void;
  confirm(): void;
  reject(): void;
}

/** Extra context the executor needs that the store does not hold. */
export interface VoiceHostBindings {
  setCameraOpen(open: boolean): void;
}

export function useVoice(bindings: VoiceHostBindings): UseVoiceResult {
  const status = useVoiceStore((s) => s.status);
  const statusLoaded = useVoiceStore((s) => s.statusLoaded);
  const setStatus = useVoiceStore((s) => s.setStatus);
  const setPhase = useVoiceStore((s) => s.setPhase);
  const setLevel = useVoiceStore((s) => s.setLevel);
  const setOpen = useVoiceStore((s) => s.setOpen);
  const setError = useVoiceStore((s) => s.setError);
  const setQuiet = useVoiceStore((s) => s.setQuiet);
  const setClipping = useVoiceStore((s) => s.setClipping);
  const addEntry = useVoiceStore((s) => s.addEntry);
  const updateEntry = useVoiceStore((s) => s.updateEntry);
  const setPending = useVoiceStore((s) => s.setPending);
  const reset = useVoiceStore((s) => s.reset);

  const capture = useRef<VoiceCapture | null>(null);
  const levelClock = useRef(0);
  const levelPeak = useRef(0);
  const sawLevel = useRef(0);

  const client = stt();

  /* --- availability, read once ------------------------------------------- */

  useEffect(() => {
    if (statusLoaded) return;
    const controller = new AbortController();
    void client
      .status(controller.signal)
      .then(setStatus)
      .catch(() => {
        // `HttpSttApi.status` already degrades to an offline status rather than
        // throwing; this catch is for an aborted request during unmount.
      });
    return () => controller.abort();
  }, [client, statusLoaded, setStatus]);

  /* --- the command context ---------------------------------------------- */

  const context = useMemo<CommandContext>(() => {
    const store = useAppStore.getState;
    return {
      setView: (view: ViewName) => store().setView(view),
      selectFrame: (imageId: string) => store().openFrame(imageId),
      get selectedFrameId() {
        return store().selectedFrameId;
      },
      frameExists: (imageId: string) =>
        !!store().dataset?.frames.some((frame) => frame.image_id === imageId),
      selectTrack: (trackId: string | null) => store().selectTrack(trackId),
      trackExists: (trackId: string) => store().trackIndex.has(trackId),
      isPinned: (trackId: string) => store().pins.includes(trackId),
      togglePin: (trackId: string) => store().togglePin(trackId),
      setTime: (tMin: number) => store().setTime(tMin),
      get originIso() {
        return store().dataset?.origin_ts ?? '';
      },
      play: () => store().play(),
      pause: () => store().pause(),
      setSpeed: (speed: SimSpeed) => store().setSpeed(speed),
      setZoneFilter: (zoneId: string | 'all') => store().setZoneFilter(zoneId),
      zoneIdFor: (nameOrId: string) => {
        const zones = store().dataset?.zones ?? [];
        const folded = fold(nameOrId);
        const match =
          zones.find((zone) => zone.zone_id === nameOrId) ??
          zones.find((zone) => fold(zone.name) === folded) ??
          zones.find((zone) => fold(zone.name).includes(folded));
        return match?.zone_id ?? null;
      },
      setClassFilter: (cls: VehicleClass | 'all') => store().setClassFilter(cls),
      // The store calls this one setZoom; the command vocabulary calls it scale.
      setScale: (scale: ScaleKm) => store().setZoom(scale),
      setCameraOpen: bindings.setCameraOpen,
      closeModal: () => store().closeModal(),
      get hasModal() {
        return store().modal !== null;
      },
      record: (verdict: Decision['verdict'], note: string) => store().record(verdict, note),
      ask: (question: string) => store().askAgent(question),
    };
  }, [bindings]);

  /* --- performing what came back ---------------------------------------- */

  const perform = useCallback(
    async (entry: VoiceEntry, route: RoutedCommand) => {
      setPhase('working');
      const result = await performCommand(route.command, route.args, context);
      updateEntry(entry.id, {
        ok: result.ok,
        summary: result.summary,
        answer: result.answer,
      });
      setPhase('idle');
    },
    [context, setPhase, updateEntry],
  );

  const handleResult = useCallback(
    async (result: SpeechResult) => {
      if (!result.ok) {
        // A refusal is a normal outcome of pressing a microphone, so it lands as
        // a readable line rather than an exception.
        setError(T.voice.err[result.code] ?? result.detail);
        setPhase('idle');
        return;
      }

      const route = isRouted(result.route) ? result.route : null;
      const entry = entryFromTranscript(result.transcript, route);

      if (!route) {
        const failure = result.route;
        entry.summary =
          failure && failure.command === null
            ? (T.voice.err[failure.code] ?? failure.detail)
            : T.voice.unavailable;
        addEntry(entry);
        setPhase('idle');
        return;
      }

      addEntry(entry);

      if (route.requires_confirmation) {
        // Voice is admin-level, so this is the only thing standing between a
        // misheard sentence and a recorded operator decision. The display asks;
        // it does not decide.
        const verdict = String(route.args.verdict ?? '');
        setPending({
          entryId: entry.id,
          command: route.command,
          args: route.args,
          what: T.decision[verdict as keyof typeof T.decision] ?? verdict,
          heard: route.text,
          expiresAt: Date.now() + status.voice.confirm_timeout_s * 1000,
        } satisfies PendingConfirm);
        return;
      }

      await perform(entry, route);
    },
    [addEntry, perform, setError, setPending, setPhase, status.voice.confirm_timeout_s],
  );

  /* --- the microphone --------------------------------------------------- */

  const send = useCallback(
    async (utterance: CapturedUtterance) => {
      setOpen(false);
      setClipping(utterance.peak >= 0.99);
      setPhase('transcribing');
      try {
        const result = await client.utterance(utterance.wav);
        if (result.ok) setPhase('routing');
        await handleResult(result);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('idle');
      }
    },
    [client, handleResult, setClipping, setError, setOpen, setPhase],
  );

  const start = useCallback(() => {
    if (capture.current?.active) return;
    setError(null);
    setQuiet(false);
    setClipping(false);
    levelPeak.current = 0;
    levelClock.current = 0;
    sawLevel.current = 0;

    const instance = new VoiceCapture(
      {
        onFrame: (update) => {
          if (update.level > levelPeak.current) levelPeak.current = update.level;
          if (update.level > sawLevel.current) sawLevel.current = update.level;

          const now = Date.now();
          if (now - levelClock.current >= LEVEL_INTERVAL_MS) {
            levelClock.current = now;
            setLevel(levelPeak.current, update.heldS);
            levelPeak.current = 0;
          }

          const phase =
            update.phase === 'calibrating'
              ? 'calibrating'
              : update.phase === 'waiting'
                ? 'listening'
                : update.phase === 'trailing'
                  ? 'trailing'
                  : 'hearing';
          if (useVoiceStore.getState().phase !== phase) setPhase(phase);
        },
        onUtterance: (utterance) => void send(utterance),
        onEmpty: (reason) => {
          setOpen(false);
          reset();
          if (reason === 'too-short') setError(T.voice.err.TOO_SHORT ?? null);
          else if (reason === 'no-speech') setError(T.voice.err.NO_SPEECH_HEARD ?? null);
          // A manual cancel needs no message: the operator did it on purpose.
          if (sawLevel.current < QUIET_LEVEL) setQuiet(true);
        },
        onError: (error) => {
          setOpen(false);
          reset();
          setError(T.voice.err[error.code] ?? error.message);
        },
      },
      {
        silenceMs: status.audio.silence_ms,
        maxUtteranceS: status.audio.max_utterance_s,
        minUtteranceS: status.audio.min_utterance_s,
      },
    );

    capture.current = instance;
    setOpen(true);
    setPhase('calibrating');
    void instance.start().catch((cause) => {
      capture.current = null;
      setOpen(false);
      reset();
      setError(
        cause instanceof CaptureError
          ? (T.voice.err[cause.code] ?? cause.message)
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    });
  }, [reset, send, setClipping, setError, setLevel, setOpen, setPhase, setQuiet, status.audio]);

  const stopAndSend = useCallback(() => {
    void capture.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    void capture.current?.cancel();
    setPhase('idle');
  }, [setPhase]);

  /* --- the confirmation ------------------------------------------------- */

  const confirm = useCallback(() => {
    const pending = useVoiceStore.getState().pending;
    if (!pending) return;
    const entry = useVoiceStore.getState().history.find((row) => row.id === pending.entryId);
    setPending(null);
    if (!entry) return;
    void perform(entry, {
      command: pending.command,
      args: pending.args,
      effect: 'audit',
      requires_confirmation: false,
      transcript_id: entry.id,
      text: pending.heard,
      reason: '',
      from_cache: false,
      latency_ms: 0,
      cost_usd: 0,
    });
  }, [perform, setPending]);

  const reject = useCallback(() => {
    const pending = useVoiceStore.getState().pending;
    if (!pending) return;
    setPending(null);
    updateEntry(pending.entryId, { ok: false, summary: T.voice.confirmTimeout });
  }, [setPending, updateEntry]);

  /* A confirmation the operator walked away from must expire rather than sit
   * there waiting to record a decision on a frame they are no longer looking at. */
  const pending = useVoiceStore((s) => s.pending);
  useEffect(() => {
    if (!pending) return;
    const remaining = pending.expiresAt - Date.now();
    if (remaining <= 0) {
      reject();
      return;
    }
    const timer = window.setTimeout(reject, remaining);
    return () => window.clearTimeout(timer);
  }, [pending, reject]);

  /* Release the device when the app goes away. */
  useEffect(
    () => () => {
      void capture.current?.cancel();
      capture.current = null;
    },
    [],
  );

  const available = speechAvailable(status) && VoiceCapture.supported();
  const unavailableReason: string | null = available
    ? null
    : !VoiceCapture.supported()
      ? (T.voice.err.UNSUPPORTED ?? T.voice.unavailable)
      : (status.stt.detail ??
        T.voice.err[status.stt.error ?? 'STT_UNAVAILABLE'] ??
        T.voice.offline);

  return { available, unavailableReason, start, stopAndSend, cancel, confirm, reject };
}

/** Accent-blind, case-blind comparison, for matching a spoken zone name. */
function fold(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}
