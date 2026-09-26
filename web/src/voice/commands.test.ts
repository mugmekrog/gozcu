/* The browser half of the voice contract.
 *
 * The first test here is the one that matters most in the whole speech stack:
 * `contracts/voice_commands.json` is read by the Python router and by this
 * executor, and if the two halves drift the failure is silent -- the model happily
 * emits a command nothing performs and the operator watches a transcript scroll
 * past with no action. Python has the mirror of this assertion in
 * `tests/test_stt.py`, so a command added to the contract fails on whichever side
 * forgot it.
 *
 * The rest pin the behaviour that keeps a misheard sentence from doing damage: a
 * command naming something that does not exist says so instead of acting on a
 * neighbour, and nothing here throws, because a failed voice command has to become
 * a readable line rather than an unhandled rejection.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_NAMES, performCommand, type CommandContext } from './commands';

/* Resolved from the working directory rather than `import.meta.url`: under the
 * jsdom environment Vite rewrites that to an http URL, which `fileURLToPath`
 * rejects. Vitest runs with `web/` as the cwd. */
const CONTRACT = resolve(process.cwd(), '..', 'contracts', 'voice_commands.json');

interface ContractCommand {
  name: string;
  effect: string;
  confirm: boolean;
  args: Record<string, { type: string; required?: boolean; enum?: unknown[] }>;
}

function contract(): ContractCommand[] {
  return (JSON.parse(readFileSync(CONTRACT, 'utf-8')) as { commands: ContractCommand[] })
    .commands;
}

/** A context that records what was called instead of touching a store. */
function fakeContext(overrides: Partial<CommandContext> = {}) {
  const calls: string[] = [];
  const record = (label: string): void => {
    calls.push(label);
  };

  const ctx: CommandContext = {
    setView: (view) => record(`setView:${view}`),
    selectFrame: async (id) => record(`selectFrame:${id}`),
    assess: async (id) => record(`assess:${id}`),
    selectedFrameId: 'img_000860',
    frameExists: (id) => id === 'img_000860' || id === 'img_004388',
    selectTrack: (id) => record(`selectTrack:${id}`),
    trackExists: (id) => id === 'T0132' || id === 'T0029',
    isPinned: () => false,
    togglePin: (id) => record(`togglePin:${id}`),
    setTime: (t) => record(`setTime:${t}`),
    originIso: '2026-09-26T05:10:00Z',
    play: () => record('play'),
    pause: () => record('pause'),
    setSpeed: (s) => record(`setSpeed:${s}`),
    setZoneFilter: (z) => record(`setZoneFilter:${z}`),
    zoneIdFor: (name) => (name.toLowerCase().includes('kuzeydogu') ? 'Z01' : null),
    setClassFilter: (c) => record(`setClassFilter:${c}`),
    setScale: (s) => record(`setScale:${s}`),
    setCameraOpen: (open) => record(`setCameraOpen:${open}`),
    closeModal: () => record('closeModal'),
    hasModal: false,
    record: async (verdict, note) => record(`record:${verdict}:${note}`),
    ask: async (question) => {
      record(`ask:${question}`);
      return 'T0029 iki kez durdu çünkü…';
    },
    ...overrides,
  };
  return { ctx, calls };
}

describe('the voice command contract', () => {
  it('is covered by this executor exactly, with nothing extra and nothing missing', () => {
    const declared = contract()
      .map((command) => command.name)
      .sort();
    expect([...COMMAND_NAMES].sort()).toEqual(declared);
  });

  it('declares exactly one audit-writing command, and it is the decision', () => {
    // If this ever grows, the confirmation path has to be reconsidered for the
    // new one rather than inherited by accident.
    const audit = contract().filter((command) => command.effect === 'audit');
    expect(audit.map((command) => command.name)).toEqual(['record_decision']);
    expect(audit[0]?.confirm).toBe(true);
  });

  it('declares the fall-through every unmatched utterance lands on', () => {
    const names = contract().map((command) => command.name);
    expect(names).toContain('ask_copilot');
  });
});

describe('performing a command', () => {
  it('switches the view', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('set_view', { view: 'logs' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toContain('setView:logs');
  });

  it('reaches the speech view itself, so "sesle kontrole geç" works', async () => {
    const { ctx, calls } = fakeContext();
    await performCommand('set_view', { view: 'voice' }, ctx);
    expect(calls).toContain('setView:voice');
  });

  it('selects a frame that exists', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('select_frame', { image_id: 'img_004388' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toContain('selectFrame:img_004388');
  });

  it('refuses a frame that does not exist instead of acting on a neighbour', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('select_frame', { image_id: 'img_999999' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('img_999999');
    expect(calls).toHaveLength(0);
  });

  it('evaluates the frame on screen when the utterance named none', async () => {
    // "bu kareyi değerlendir" -- the router is told not to guess an id.
    const { ctx, calls } = fakeContext();
    const result = await performCommand('assess_frame', {}, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toContain('assess:img_000860');
  });

  it('says what to do when no frame is selected at all', async () => {
    const { ctx } = fakeContext({ selectedFrameId: null });
    const result = await performCommand('assess_frame', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBeTruthy();
  });

  it('selects a vehicle and shows it on the map', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('select_vehicle', { track_id: 'T0132' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toContain('setView:map');
    expect(calls).toContain('selectTrack:T0132');
  });

  it('refuses a track id nothing was tracked under', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('select_vehicle', { track_id: 'T9999' }, ctx);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not unpin a vehicle when asked to pin one that is already pinned', async () => {
    const { ctx, calls } = fakeContext({ isPinned: () => true });
    const result = await performCommand('pin_vehicle', { track_id: 'T0132', pinned: true }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('moves the exercise clock', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('set_clock', { hhmm: '13:50' }, ctx);
    expect(result.ok).toBe(true);
    // 13:50 Istanbul is 340 minutes after the 08:10 origin (05:10Z).
    expect(calls).toContain('setTime:340');
  });

  it('refuses something that is not a clock', async () => {
    const { ctx } = fakeContext();
    const result = await performCommand('set_clock', { hhmm: 'yarın' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('only accepts the speeds the transport actually offers', async () => {
    const { ctx, calls } = fakeContext();
    expect((await performCommand('set_playback', { speed: 300 }, ctx)).ok).toBe(true);
    expect(calls).toContain('setSpeed:300');
    expect((await performCommand('set_playback', { speed: 7 }, ctx)).ok).toBe(false);
  });

  it('resolves a spoken zone name to its id', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('set_filter', { zone: 'Kuzeydogu Kavsagi' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toContain('setZoneFilter:Z01');
  });

  it('refuses a zone that is not in the dataset', async () => {
    const { ctx } = fakeContext();
    const result = await performCommand('set_filter', { zone: 'Batı Tepesi' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('records a decision against the frame on screen', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('record_decision', { verdict: 'confirmed' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.startsWith('record:confirmed:'))).toBe(true);
  });

  it('will not record a decision with no frame to record it against', async () => {
    // An audit event needs a subject, and inventing one is the single worst thing
    // this command could do.
    const { ctx, calls } = fakeContext({ selectedFrameId: null });
    const result = await performCommand('record_decision', { verdict: 'confirmed' }, ctx);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a verdict that is not one of the four', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand('record_decision', { verdict: 'maybe' }, ctx);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('marks a spoken decision as spoken in its note', async () => {
    const { ctx, calls } = fakeContext();
    await performCommand('record_decision', { verdict: 'false_alarm', note: 'sivil araç' }, ctx);
    const call = calls.find((entry) => entry.startsWith('record:'));
    expect(call).toContain('sesle');
  });

  it('passes a question to the copilot and returns its answer', async () => {
    const { ctx, calls } = fakeContext();
    const result = await performCommand(
      'ask_copilot',
      { question: 'T0029 neden iki kez durdu' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.answer).toBeTruthy();
    expect(calls).toContain('ask:T0029 neden iki kez durdu');
  });

  it('will not close an alert that is not open', async () => {
    const { ctx, calls } = fakeContext({ hasModal: false });
    expect((await performCommand('dismiss_alert', {}, ctx)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports an unknown command rather than throwing', async () => {
    const { ctx } = fakeContext();
    const result = await performCommand('drop_database', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('drop_database');
  });

  it('turns a thrown error into a readable line', async () => {
    // A store action that rejected must not surface as an unhandled rejection,
    // because the operator would see speech do nothing with no explanation.
    const { ctx } = fakeContext({
      assess: vi.fn().mockRejectedValue(new Error('değerlendirme başarısız')),
    });
    const result = await performCommand('assess_frame', { image_id: 'img_000860' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('değerlendirme başarısız');
  });
});
