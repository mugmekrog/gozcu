/* The speech seam.
 *
 * Same shape as `GoruApi` and for the same reason: one interface, two real
 * adapters, so nothing above it can quietly depend on there being a service. The
 * display has to boot and run with speech unavailable, because that is the normal
 * state of a machine with no GPU, no model in the cache, or the speech service not
 * started -- and because the demo has to survive the network being off (PLAN 9.3).
 *
 * `HttpSttApi` talks to the loopback service in `services/api/app/api/stt_server.py`.
 * `OfflineSttApi` reports that speech is unavailable and refuses every utterance
 * with a code, which is what the app uses when `VITE_STT_URL` is unset. The second
 * one is not a stub for tests -- it is the shipped default, and the microphone is
 * disabled with a reason underneath it exactly the way the copilot field already is
 * when there is no gateway.
 *
 * This is deliberately separate from `GoruApi` rather than bolted onto it. The
 * speech service is its own process on its own port with its own lifecycle; the
 * REST API of PLAN 5.4 still does not exist, and standing up speech must not
 * require finishing it first.
 */

/** Every way speech can decline, as the Python service names them. */
export type SttErrorCode =
  | 'STT_DISABLED'
  | 'STT_UNAVAILABLE'
  | 'CUDA_UNAVAILABLE'
  | 'GPU_OUT_OF_MEMORY'
  | 'MODEL_UNAVAILABLE'
  | 'AUDIO_INVALID'
  | 'AUDIO_TOO_LONG'
  | 'AUDIO_TOO_SHORT'
  | 'NO_SPEECH'
  | 'EMPTY_TRANSCRIPT'
  | 'WORKER_CRASHED';

export interface SttMetrics {
  audio_duration_ms: number;
  stt_latency_ms: number;
  real_time_factor: number;
  transcript_chars: number;
  vram_used_mb: number | null;
  speech_ratio: number | null;
  from_vad_gate: boolean;
}

export interface Transcript {
  id: string;
  /** What the router received: cleaned, and with our own ids resolved. */
  text: string;
  /** What the model actually said, kept so a misreading stays inspectable. */
  raw_text: string;
  language: string;
  duration: number;
  final: boolean;
  confidence: number | null;
  no_speech_prob: number | null;
  /** Each rewrite the normaliser made, as "te sifir yuz otuz iki -> T0132". */
  normalised: string[];
  metrics: SttMetrics | null;
  timestamp: string;
}

/** What the display should do about one utterance. */
export interface RoutedCommand {
  command: string;
  args: Record<string, unknown>;
  effect: 'view' | 'compute' | 'audit';
  requires_confirmation: boolean;
  transcript_id: string;
  text: string;
  reason: string;
  from_cache: boolean;
  latency_ms: number;
  cost_usd: number;
}

/** The transcript arrived but could not be turned into a command. */
export interface RouteFailure {
  command: null;
  code: string;
  detail: string;
  transcript_id: string;
  text: string;
}

export interface SttStatus {
  ready: boolean;
  provider: string;
  model: string;
  device: string;
  compute_type: string;
  language: string;
  error: SttErrorCode | null;
  detail: string | null;
  model_load_ms: number | null;
  vram_used_mb: number | null;
  max_utterance_s: number;
}

export interface VoiceStatus {
  enabled: boolean;
  admin: boolean;
  confirm_audit_commands: boolean;
  confirm_timeout_s: number;
  router: string;
  registry_version: string;
  commands: string[];
}

export interface AudioSettings {
  sample_rate: number;
  max_utterance_s: number;
  min_utterance_s: number;
  silence_ms: number;
}

export interface SpeechStatus {
  stt: SttStatus;
  voice: VoiceStatus;
  agent: { live: boolean; mode: string; reason: string | null };
  audio: AudioSettings;
}

/** A refusal, with the code the display turns into a sentence. */
export interface SpeechRejected {
  ok: false;
  code: SttErrorCode | string;
  detail: string;
  heard: string;
  duration: number;
}

export interface SpeechAccepted {
  ok: true;
  transcript: Transcript;
  route: RoutedCommand | RouteFailure | null;
}

export type SpeechResult = SpeechAccepted | SpeechRejected;

export interface SttApi {
  readonly mode: 'http' | 'offline';
  /** Can speech be used, and if not, why. Read once at boot. */
  status(signal?: AbortSignal): Promise<SpeechStatus>;
  /** Audio in, a transcript and the command it routed to out. */
  utterance(wav: Blob, signal?: AbortSignal): Promise<SpeechResult>;
  /** Route text: the typed field, and re-submitting a confirmed command. */
  route(text: string, transcriptId?: string, signal?: AbortSignal): Promise<SpeechResult>;
}

const OFFLINE_DETAIL =
  'Sesli kontrol için konuşma servisi çalışmıyor. Depo kökünde başlatın: ' +
  'python services/api/app/cli.py serve-stt';

export function offlineStatus(detail = OFFLINE_DETAIL): SpeechStatus {
  return {
    stt: {
      ready: false,
      provider: 'none',
      model: '',
      device: 'none',
      compute_type: 'none',
      language: 'tr',
      error: 'STT_UNAVAILABLE',
      detail,
      model_load_ms: null,
      vram_used_mb: null,
      max_utterance_s: 15,
    },
    voice: {
      enabled: false,
      admin: false,
      confirm_audit_commands: true,
      confirm_timeout_s: 20,
      router: 'llm',
      registry_version: '0',
      commands: [],
    },
    agent: { live: false, mode: 'offline', reason: detail },
    audio: { sample_rate: 16000, max_utterance_s: 15, min_utterance_s: 0.25, silence_ms: 500 },
  };
}

/** The shipped default: speech is off, and the microphone says why. */
export class OfflineSttApi implements SttApi {
  readonly mode = 'offline' as const;

  constructor(private readonly detail: string = OFFLINE_DETAIL) {}

  async status(): Promise<SpeechStatus> {
    return offlineStatus(this.detail);
  }

  async utterance(): Promise<SpeechResult> {
    return { ok: false, code: 'STT_UNAVAILABLE', detail: this.detail, heard: '', duration: 0 };
  }

  async route(): Promise<SpeechResult> {
    return { ok: false, code: 'STT_UNAVAILABLE', detail: this.detail, heard: '', duration: 0 };
  }
}

export class HttpSttApi implements SttApi {
  readonly mode = 'http' as const;

  constructor(private readonly baseUrl: string) {}

  async status(signal?: AbortSignal): Promise<SpeechStatus> {
    const response = await fetch(`${this.baseUrl}/stt/status`, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return offlineStatus(`Konuşma servisi yanıt vermedi (HTTP ${response.status}).`);
    }
    return (await response.json()) as SpeechStatus;
  }

  async utterance(wav: Blob, signal?: AbortSignal): Promise<SpeechResult> {
    const body = new FormData();
    body.append('audio', wav, 'utterance.wav');
    return this.send('/voice/utterance', { method: 'POST', body, signal });
  }

  async route(text: string, transcriptId = 'typed_00000', signal?: AbortSignal): Promise<SpeechResult> {
    return this.send('/voice/route', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, transcript_id: transcriptId }),
    });
  }

  private async send(path: string, init: RequestInit): Promise<SpeechResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
      });
    } catch (cause) {
      // A transport failure is reported with the same shape as a refusal, so the
      // display has one error path rather than two.
      return {
        ok: false,
        code: 'STT_UNAVAILABLE',
        detail: `Konuşma servisine ulaşılamadı. ${cause instanceof Error ? cause.message : ''}`.trim(),
        heard: '',
        duration: 0,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        code: 'STT_UNAVAILABLE',
        detail: `Konuşma servisi okunamayan bir yanıt döndü (HTTP ${response.status}).`,
        heard: '',
        duration: 0,
      };
    }
    return payload as SpeechResult;
  }
}

let current: SttApi | null = null;

/** Which adapter this build talks to. HTTP when `VITE_STT_URL` is set. */
export function stt(): SttApi {
  if (current) return current;
  const baseUrl = import.meta.env.VITE_STT_URL;
  current = baseUrl ? new HttpSttApi(String(baseUrl).replace(/\/+$/, '')) : new OfflineSttApi();
  return current;
}

/** Tests substitute an adapter here, the same way `setApi` does for `GoruApi`. */
export function setSttApi(adapter: SttApi | null): void {
  current = adapter;
}

/** True when a result carries a command the display should perform. */
export function isRouted(
  route: RoutedCommand | RouteFailure | null | undefined,
): route is RoutedCommand {
  return !!route && route.command !== null;
}
