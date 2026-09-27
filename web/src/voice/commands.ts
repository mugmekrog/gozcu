/* Performing a routed command.
 *
 * The server decides which command an utterance meant; this is where it happens.
 * That split is not incidental -- every command in the registry is a change to the
 * display, and the Python process has no view to switch and no vehicle to pin. It
 * also means a voice command and a mouse click end in exactly the same store
 * action, so speech cannot reach a state a hand could not.
 *
 * `contracts/voice_commands.json` is the authority for the command set, and
 * `COMMANDS` below must cover it exactly. `commands.test.ts` reads that file and
 * asserts the two agree, so a command added to the contract fails here rather than
 * becoming an intent nothing performs.
 *
 * Voice is admin-level by team decision: `record_decision` is in this table and it
 * writes an operator decision. What the display adds is the confirmation the server
 * flags -- see `requires_confirmation` on the routed command, handled in the store
 * before anything here is called.
 */

import type { Decision, VehicleClass } from '@/domain/types';
import type { ScaleKm } from '@/domain/polar';
import type { SimSpeed, ViewName } from '@/store/useAppStore';
import { SPEED_OPTIONS } from '@/store/useAppStore';
import { minutesOf } from '@/domain/format';
import { T } from '@/domain/strings';

/** Everything a command may touch. Passed in, so this file imports no store. */
export interface CommandContext {
  setView(view: ViewName): void;
  selectFrame(imageId: string): Promise<void>;
  selectedFrameId: string | null;
  frameExists(imageId: string): boolean;
  selectTrack(trackId: string | null): void;
  trackExists(trackId: string): boolean;
  isPinned(trackId: string): boolean;
  togglePin(trackId: string): void;
  setTime(tMin: number): void;
  originIso: string;
  play(): void;
  pause(): void;
  setSpeed(speed: SimSpeed): void;
  setZoneFilter(zoneId: string | 'all'): void;
  zoneIdFor(nameOrId: string): string | null;
  setClassFilter(cls: VehicleClass | 'all'): void;
  setScale(scale: ScaleKm): void;
  setCameraOpen(open: boolean): void;
  closeModal(): void;
  hasModal: boolean;
  record(verdict: Decision['verdict'], note: string): Promise<void>;
  ask(question: string): Promise<string>;
}

/** What performing a command produced, for the transcript log. */
export interface CommandResult {
  ok: boolean;
  /** One line, in the operator's language, saying what happened. */
  summary: string;
  /** A copilot answer, when the command was a question. */
  answer?: string;
}

type Args = Record<string, unknown>;

function asString(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asBoolean(args: Args, key: string): boolean | null {
  const value = args[key];
  return typeof value === 'boolean' ? value : null;
}

function asNumber(args: Args, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const VIEW_NAMES: Record<string, ViewName> = {
  map: 'map',
  motion: 'motion',
  logs: 'logs',
  voice: 'voice',
};

const VIEW_LABEL: Record<ViewName, string> = {
  map: T.view.mapName,
  motion: T.view.motionName,
  logs: T.view.logsName,
  voice: T.view.voiceName,
};

const CLASSES: readonly string[] = ['car', 'van', 'truck', 'bus'];

type Handler = (args: Args, ctx: CommandContext) => Promise<CommandResult>;

/**
 * One handler per registry command. The keys are the contract.
 *
 * Every handler checks that what it was asked for exists before doing it. A
 * routed command carries an id the model read out of a transcript, and a
 * transcript can mishear: selecting a frame that is not in the dataset should say
 * so, not fail silently or -- worse -- act on a neighbouring one.
 */
export const COMMANDS: Record<string, Handler> = {
  async set_view(args, ctx) {
    const requested = asString(args, 'view');
    const view = requested ? VIEW_NAMES[requested] : undefined;
    if (!view) return { ok: false, summary: T.voice.badView(requested ?? '') };
    ctx.setView(view);
    return { ok: true, summary: T.voice.didView(VIEW_LABEL[view]) };
  },

  async select_frame(args, ctx) {
    const imageId = asString(args, 'image_id');
    if (!imageId) return { ok: false, summary: T.voice.needFrame };
    if (!ctx.frameExists(imageId)) return { ok: false, summary: T.voice.noSuchFrame(imageId) };
    await ctx.selectFrame(imageId);
    return { ok: true, summary: T.voice.didFrame(imageId) };
  },

  async select_vehicle(args, ctx) {
    const trackId = asString(args, 'track_id');
    if (!trackId) return { ok: false, summary: T.voice.needTrack };
    if (!ctx.trackExists(trackId)) return { ok: false, summary: T.voice.noSuchTrack(trackId) };
    ctx.setView('map');
    ctx.selectTrack(trackId);
    return { ok: true, summary: T.voice.didSelect(trackId) };
  },

  async pin_vehicle(args, ctx) {
    const trackId = asString(args, 'track_id');
    if (!trackId) return { ok: false, summary: T.voice.needTrack };
    if (!ctx.trackExists(trackId)) return { ok: false, summary: T.voice.noSuchTrack(trackId) };

    const wanted = asBoolean(args, 'pinned');
    const pinned = ctx.isPinned(trackId);
    // `togglePin` is the only pin action the store has, so asking for a state it
    // is already in is a no-op rather than an accidental unpin.
    if (wanted !== null && wanted === pinned) {
      return { ok: true, summary: T.voice.pinAlready(trackId, pinned) };
    }
    ctx.togglePin(trackId);
    return { ok: true, summary: T.voice.didPin(trackId, !pinned) };
  },

  async set_clock(args, ctx) {
    const hhmm = asString(args, 'hhmm');
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) {
      return { ok: false, summary: T.voice.badClock(hhmm ?? '') };
    }
    const minutes = minutesOf(ctx.originIso, hhmm.padStart(5, '0'));
    if (!Number.isFinite(minutes)) return { ok: false, summary: T.voice.badClock(hhmm) };
    ctx.setTime(minutes);
    return { ok: true, summary: T.voice.didClock(hhmm) };
  },

  async set_playback(args, ctx) {
    const playing = asBoolean(args, 'playing');
    const speed = asNumber(args, 'speed');
    const done: string[] = [];

    if (speed !== null) {
      const match = SPEED_OPTIONS.find((option) => option === speed);
      if (!match) return { ok: false, summary: T.voice.badSpeed(speed) };
      ctx.setSpeed(match);
      done.push(T.voice.didSpeed(match));
    }
    if (playing !== null) {
      playing ? ctx.play() : ctx.pause();
      done.push(playing ? T.voice.didPlay : T.voice.didPause);
    }
    if (!done.length) return { ok: false, summary: T.voice.needPlayback };
    return { ok: true, summary: done.join(' · ') };
  },

  async set_filter(args, ctx) {
    const done: string[] = [];

    const zone = asString(args, 'zone');
    if (zone) {
      if (zone.toLowerCase() === 'all' || zone === 'tümü') {
        ctx.setZoneFilter('all');
        done.push(T.voice.didZone(T.filter.all));
      } else {
        const zoneId = ctx.zoneIdFor(zone);
        if (!zoneId) return { ok: false, summary: T.voice.noSuchZone(zone) };
        ctx.setZoneFilter(zoneId);
        done.push(T.voice.didZone(zone));
      }
    }

    const cls = asString(args, 'vehicle_class');
    if (cls) {
      if (cls === 'all') {
        ctx.setClassFilter('all');
        done.push(T.voice.didClass(T.filter.all));
      } else if (CLASSES.includes(cls)) {
        ctx.setClassFilter(cls as VehicleClass);
        done.push(T.voice.didClass(cls));
      } else {
        return { ok: false, summary: T.voice.noSuchClass(cls) };
      }
    }

    const scale = asNumber(args, 'scale_km');
    if (scale !== null) {
      const allowed: readonly number[] = [3, 5, 8, 12];
      if (!allowed.includes(scale)) return { ok: false, summary: T.voice.badScale(scale) };
      ctx.setScale(scale as ScaleKm);
      done.push(T.voice.didScale(scale));
    }

    if (!done.length) return { ok: false, summary: T.voice.needFilter };
    return { ok: true, summary: done.join(' · ') };
  },

  async open_camera(args, ctx) {
    const open = asBoolean(args, 'open') ?? true;
    if (open && !ctx.selectedFrameId) return { ok: false, summary: T.voice.needFrame };
    ctx.setCameraOpen(open);
    return { ok: true, summary: open ? T.voice.didCameraOpen : T.voice.didCameraClose };
  },

  async dismiss_alert(_args, ctx) {
    if (!ctx.hasModal) return { ok: false, summary: T.voice.noModal };
    ctx.closeModal();
    return { ok: true, summary: T.voice.didDismiss };
  },

  async record_decision(args, ctx) {
    const verdict = asString(args, 'verdict') as Decision['verdict'] | null;
    const allowed: readonly string[] = [
      'confirmed',
      'false_alarm',
      'not_threat',
      'marked_threat',
    ];
    if (!verdict || !allowed.includes(verdict)) {
      return { ok: false, summary: T.voice.badVerdict(verdict ?? '') };
    }
    // A decision belongs to the frame the operator is looking at. Without one
    // there is nothing to record against, and inventing a subject for an audit
    // event is the one thing this command must never do.
    if (!ctx.selectedFrameId) return { ok: false, summary: T.voice.needFrame };

    const note = asString(args, 'note') ?? '';
    await ctx.record(verdict, note ? `${note} (sesle)` : T.voice.noteBySpeech);
    return { ok: true, summary: T.voice.didDecision(T.decision[verdict]) };
  },

  async ask_copilot(args, ctx) {
    const question = asString(args, 'question');
    if (!question) return { ok: false, summary: T.voice.needQuestion };
    const answer = await ctx.ask(question);
    return { ok: true, summary: T.voice.didAsk, answer };
  },
};

/** The names this executor covers. Asserted against the contract in the tests. */
export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

/**
 * Perform one routed command.
 *
 * Never throws: a command that failed has to land in the transcript log as a line
 * the operator can read, not as an unhandled rejection that leaves the display
 * looking as though speech simply did nothing.
 */
export async function performCommand(
  command: string,
  args: Args,
  ctx: CommandContext,
): Promise<CommandResult> {
  const handler = COMMANDS[command];
  if (!handler) return { ok: false, summary: T.voice.unknownCommand(command) };
  try {
    return await handler(args ?? {}, ctx);
  } catch (cause) {
    return {
      ok: false,
      summary: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
