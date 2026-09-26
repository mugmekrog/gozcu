/* Speech through the real shell.
 *
 * The microphone itself cannot run here -- jsdom has no `AudioWorklet` and no
 * capture device -- so what is driven is everything downstream of it: the real
 * store, the real `useVoice`, the real executor and the real components, with a
 * fake speech service in place of the loopback one and the capture step stood in
 * for by pushing a routed command the way the service would have returned it.
 *
 * The test that matters most is the confirmation gate. Voice is admin-level by
 * team decision, so `record_decision` is reachable by speech, and the single thing
 * standing between a misheard sentence and an irreversible audit entry is this
 * dialog. It is asserted from both sides: nothing is recorded before the operator
 * agrees, and nothing is recorded if they decline.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '@/App';
import { setApi } from '@/api';
import { useAppStore } from '@/store/useAppStore';
import { FakeApi } from '@/test/fake-api';
import { useVoiceStore, entryFromTranscript } from '@/store/useVoiceStore';
import {
  OfflineSttApi,
  setSttApi,
  offlineStatus,
  type RoutedCommand,
  type SpeechResult,
  type SpeechStatus,
  type SttApi,
  type Transcript,
} from './stt';

function readyStatus(): SpeechStatus {
  const base = offlineStatus();
  return {
    ...base,
    stt: {
      ...base.stt,
      ready: true,
      provider: 'local_whisper',
      model: 'oguzhangokboru/whisper-large-v3-tr',
      device: 'cuda',
      compute_type: 'float16',
      error: null,
      detail: null,
      model_load_ms: 7676,
      vram_used_mb: 3851,
    },
    voice: {
      ...base.voice,
      enabled: true,
      admin: true,
      registry_version: '1',
      commands: ['set_view', 'record_decision', 'ask_copilot'],
    },
  };
}

/** A speech service that returns whatever the test queued. */
class FakeStt implements SttApi {
  readonly mode = 'http' as const;
  queued: SpeechResult[] = [];

  constructor(private readonly reported: SpeechStatus) {}

  async status(): Promise<SpeechStatus> {
    return this.reported;
  }
  async utterance(): Promise<SpeechResult> {
    return this.queued.shift() ?? { ok: false, code: 'NO_SPEECH', detail: 'x', heard: '', duration: 0 };
  }
  async route(): Promise<SpeechResult> {
    return this.queued.shift() ?? { ok: false, code: 'NO_SPEECH', detail: 'x', heard: '', duration: 0 };
  }
}

function transcript(text: string): Transcript {
  return {
    id: 'speech_00001',
    text,
    raw_text: text,
    language: 'tr',
    duration: 1.4,
    final: true,
    confidence: 0.72,
    no_speech_prob: 0.01,
    normalised: [],
    metrics: null,
    timestamp: new Date().toISOString(),
  };
}

function routed(command: string, args: Record<string, unknown>, confirm = false): RoutedCommand {
  return {
    command,
    args,
    effect: command === 'record_decision' ? 'audit' : 'view',
    requires_confirmation: confirm,
    transcript_id: 'speech_00001',
    text: 'söylenen',
    reason: '',
    from_cache: false,
    latency_ms: 90,
    cost_usd: 0.0002,
  };
}

/** Stand in for the capture step: hand the app what the service would have said. */
async function speak(text: string, route: RoutedCommand | null) {
  const store = useVoiceStore.getState();
  const entry = entryFromTranscript(transcript(text), route);
  store.addEntry(entry);
  return entry;
}

/* jsdom has no `AudioWorkletNode` and no capture device, so `VoiceCapture.supported()`
 * is correctly false there -- and that would mask every other reason the microphone
 * might be disabled. Declaring the APIs present (not working) lets the tests below
 * exercise the service-availability logic; `reports an unsupported browser` removes
 * the stub again and checks the real fallback. */
function stubAudioApis(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.AudioWorkletNode = class {};
  globals.AudioContext = class {};
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
}

function unstubAudioApis(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals.AudioWorkletNode;
  delete globals.AudioContext;
}

let fake: FakeApi;

beforeEach(() => {
  fake = new FakeApi();
  setApi(fake);
  stubAudioApis();
  useAppStore.setState({ view: 'map', modal: null, selectedTrackId: null });
  /* The voice store is a module singleton and `useVoice` reads availability once,
   * so `statusLoaded` has to be cleared too -- otherwise a later test inherits the
   * status an earlier one installed and the adapter it sets is never consulted. */
  useVoiceStore.setState({
    status: offlineStatus(),
    statusLoaded: false,
    history: [],
    pending: null,
    phase: 'idle',
    open: false,
    level: 0,
    heldS: 0,
    error: null,
    quiet: false,
    clipping: false,
  });
});

afterEach(() => {
  cleanup();
  setApi(null);
  setSttApi(null);
  unstubAudioApis();
});

async function boot() {
  render(<App />);
  await waitFor(() => expect(screen.getByRole('img', { name: /Bölge haritası/ })).toBeTruthy());
}

describe('the speech dock', () => {
  it('is present in the shell, whichever view is on stage', async () => {
    setSttApi(new FakeStt(readyStatus()));
    await boot();
    expect(screen.getByText('SESLE KONTROL')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dinle/ })).toBeTruthy();
  });

  it('disables the microphone and says why when no speech service is running', async () => {
    // The shipped default: `VITE_STT_URL` unset. The same courtesy AskAgent
    // already extends when there is no gateway.
    setSttApi(new OfflineSttApi());
    await boot();

    const mic = screen.getByRole('button', { name: /Dinle/ }) as HTMLButtonElement;
    await waitFor(() => expect(mic.disabled).toBe(true));
    expect(document.body.textContent).toContain('serve-stt');
  });

  it('enables the microphone when the service reports a loaded model', async () => {
    setSttApi(new FakeStt(readyStatus()));
    await boot();
    const mic = screen.getByRole('button', { name: /Dinle/ }) as HTMLButtonElement;
    await waitFor(() => expect(mic.disabled).toBe(false));
  });

  it('reports an unsupported browser ahead of any service problem', async () => {
    // A browser without AudioWorklet cannot capture whatever the service says, so
    // that is the reason the operator should be given.
    unstubAudioApis();
    setSttApi(new FakeStt(readyStatus()));
    await boot();

    const mic = screen.getByRole('button', { name: /Dinle/ }) as HTMLButtonElement;
    await waitFor(() => expect(mic.disabled).toBe(true));
    expect(document.body.textContent).toContain('desteklemiyor');
  });
});

describe('the speech view', () => {
  it('opens from the dock shortcut and from the S key', async () => {
    setSttApi(new FakeStt(readyStatus()));
    await boot();

    await act(async () => {
      screen.getByRole('button', { name: /Sesle kontrol →/ }).click();
    });
    await waitFor(() => expect(screen.getByText('DUYULANLAR')).toBeTruthy());

    // Back to the map via the toolbar, then in again with the key the shell binds.
    await act(async () => {
      screen.getByRole('button', { name: 'Harita' }).click();
    });
    await waitFor(() => expect(screen.queryByText('DUYULANLAR')).toBeNull());
    await act(async () => {
      fireEvent.keyDown(window, { key: 's' });
    });
    await waitFor(() => expect(screen.getByText('DUYULANLAR')).toBeTruthy());
  });

  it('says what to do when nothing has been said yet', async () => {
    setSttApi(new FakeStt(readyStatus()));
    await boot();
    await act(async () => {
      useVoiceStore.setState({ history: [] });
      screen.getByRole('button', { name: /Sesle kontrol →/ }).click();
    });
    await waitFor(() => expect(document.body.textContent).toContain('Henüz sesli komut verilmedi'));
  });

  it('shows what was heard, and names each rewrite the normaliser made', async () => {
    setSttApi(new FakeStt(readyStatus()));
    await boot();

    await act(async () => {
      const entry = entryFromTranscript(
        {
          ...transcript('T0132 sabitle'),
          raw_text: 'te sıfır yüz otuz iki sabitle',
          normalised: ['sifir yuz otuz iki -> 132', 'te 132 -> T0132'],
        },
        routed('pin_vehicle', { track_id: 'T0132' }),
      );
      useVoiceStore.getState().addEntry({ ...entry, ok: true, summary: 'T0132 sabitlendi' });
      screen.getByRole('button', { name: /Sesle kontrol →/ }).click();
    });

    await waitFor(() => expect(screen.getByText('DUYULANLAR')).toBeTruthy());
    // Both halves are on screen: what the model wrote, and what was routed.
    expect(document.body.textContent).toContain('T0132 sabitle');
    expect(document.body.textContent).toContain('te sıfır yüz otuz iki sabitle');
    expect(document.body.textContent).toContain('te 132 -> T0132');
  });
});

describe('the confirmation before speech records a decision', () => {
  /** Get the app into a state where a decision has something to attach to. */
  async function withEvaluatedFrame() {
    setSttApi(new FakeStt(readyStatus()));
    await boot();
    fireEvent.click(screen.getAllByRole('button', { name: /T0001, kamyon/ })[0]!);
    await act(async () => {
      screen.getByRole('button', { name: 'Uyarıyı incele' }).click();
    });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    // Close the threat modal so only the voice dialog is on screen.
    await act(async () => {
      screen.getByRole('button', { name: /Uyarıyı kapat/ }).click();
    });
  }

  it('holds the decision back and asks, rather than recording it', async () => {
    await withEvaluatedFrame();

    const route = routed('record_decision', { verdict: 'confirmed' }, true);
    await act(async () => {
      const entry = await speak('tehdidi onayla ve bildir', route);
      useVoiceStore.getState().setPending({
        entryId: entry.id,
        command: route.command,
        args: route.args,
        what: 'Tehdit onaylandı ve bildirildi',
        heard: 'tehdidi onayla ve bildir',
        expiresAt: Date.now() + 20000,
      });
    });

    await waitFor(() => expect(screen.getByText('SESLİ KARAR ONAYI')).toBeTruthy());
    // Nothing has been written yet. This is the whole point.
    expect(fake.recorded).toHaveLength(0);
    // The operator is shown what was heard, because a misheard sentence is the
    // failure this dialog exists to catch.
    expect(document.body.textContent).toContain('tehdidi onayla ve bildir');
  });

  it('records only once the operator agrees, and marks it as spoken', async () => {
    await withEvaluatedFrame();

    const route = routed('record_decision', { verdict: 'confirmed' }, true);
    await act(async () => {
      const entry = await speak('tehdidi onayla ve bildir', route);
      useVoiceStore.getState().setPending({
        entryId: entry.id,
        command: route.command,
        args: route.args,
        what: 'Tehdit onaylandı ve bildirildi',
        heard: 'tehdidi onayla ve bildir',
        expiresAt: Date.now() + 20000,
      });
    });
    await waitFor(() => expect(screen.getByText('SESLİ KARAR ONAYI')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Evet, kaydet' }).click();
    });

    await waitFor(() => expect(fake.recorded).toHaveLength(1));
    expect(fake.recorded[0]!.verdict).toBe('confirmed');
    expect(fake.recorded[0]!.image_id).toBe('img_0001');
    // An audit entry has to say it came from speech.
    expect(fake.recorded[0]!.note).toContain('sesle');
  });

  it('records nothing when the operator declines', async () => {
    await withEvaluatedFrame();

    const route = routed('record_decision', { verdict: 'false_alarm' }, true);
    await act(async () => {
      const entry = await speak('yanlış alarm', route);
      useVoiceStore.getState().setPending({
        entryId: entry.id,
        command: route.command,
        args: route.args,
        what: 'Yanlış alarm',
        heard: 'yanlış alarm',
        expiresAt: Date.now() + 20000,
      });
    });
    await waitFor(() => expect(screen.getByText('SESLİ KARAR ONAYI')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Vazgeç' }).click();
    });

    await waitFor(() => expect(screen.queryByText('SESLİ KARAR ONAYI')).toBeNull());
    expect(fake.recorded).toHaveLength(0);
  });

  it('focuses the cancel button, not the one that writes to the record', async () => {
    await withEvaluatedFrame();

    const route = routed('record_decision', { verdict: 'confirmed' }, true);
    await act(async () => {
      const entry = await speak('tehdidi onayla', route);
      useVoiceStore.getState().setPending({
        entryId: entry.id,
        command: route.command,
        args: route.args,
        what: 'Tehdit onaylandı ve bildirildi',
        heard: 'tehdidi onayla',
        expiresAt: Date.now() + 20000,
      });
    });

    await waitFor(() => expect(screen.getByText('SESLİ KARAR ONAYI')).toBeTruthy());
    expect(document.activeElement?.textContent).toBe('Vazgeç');
  });
});
