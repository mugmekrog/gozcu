/* The microphone (stt.md phase 2).
 *
 * Capture lives in the browser because the display lives in the browser. stt.md
 * is written for a Python desktop app holding the device through `sounddevice`,
 * and that shape does not survive contact with a web UI: the permission prompt is
 * the browser's to show, the level meter can only be drawn from samples the page
 * actually has, and a service that owned the device would stop working the moment
 * the display was opened from a second machine.
 *
 * Push-to-talk, then automatic endpointing. The operator opens the stream
 * deliberately -- a live microphone in an operations room is not a default -- and
 * `EndpointDetector` closes the utterance when they stop talking, so they never
 * have to reach for the button twice.
 *
 * An `AudioWorklet` does the sample collection rather than the long-deprecated
 * `ScriptProcessorNode`, so capture runs on the audio thread and a busy React
 * render cannot drop a syllable. The processor's source is inlined and loaded from
 * a blob URL instead of a served file, because the bundle has to work with the
 * network off (PLAN F4.3) and a separate `public/` asset is one more thing to
 * forget to deploy.
 *
 * Everything this class reports is a callback, so React state lives in the hook
 * above it and this file stays free of framework.
 */

import { EndpointDetector, type EndpointConfig, type EndpointUpdate } from './endpoint';
import { TARGET_SAMPLE_RATE, concat, durationOf, encodeWav, peakOf, resample } from './wav';

/** Why a capture attempt could not start, in terms the display can explain. */
export type CaptureErrorCode =
  | 'NO_MICROPHONE'
  | 'PERMISSION_DENIED'
  | 'DEVICE_BUSY'
  | 'UNSUPPORTED'
  | 'CAPTURE_FAILED';

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

export interface CapturedUtterance {
  wav: Blob;
  durationS: number;
  peak: number;
  /** Why recording stopped, so the display can say "15 saniye doldu". */
  reason: 'silence' | 'max-duration' | 'manual';
}

export interface CaptureHandlers {
  /** Once per audio block: the level bars and the phase readout. */
  onFrame?(update: EndpointUpdate): void;
  /** Speech was believed. The display switches from "dinliyor" to "duyuyorum". */
  onSpeechStart?(): void;
  /** A finished utterance, ready to send. */
  onUtterance?(utterance: CapturedUtterance): void;
  /** The stream ended without a usable utterance. */
  onEmpty?(reason: 'too-short' | 'no-speech' | 'manual'): void;
  onError?(error: CaptureError): void;
}

/* The worklet processor. It forwards every block and does no analysis: the
 * detector needs the samples on the main thread anyway to buffer them, so
 * computing RMS twice would be the only thing a smarter processor achieved. */
const PROCESSOR_SOURCE = `
class GoruCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // A copy, because the render quantum's buffer is reused by the graph.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}
registerProcessor('goru-capture', GoruCaptureProcessor);
`;

let workletUrl: string | null = null;

function processorUrl(): string {
  if (workletUrl) return workletUrl;
  workletUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
  return workletUrl;
}

function rmsOfBlock(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) {
    const sample = block[i] ?? 0;
    sum += sample * sample;
  }
  return block.length ? Math.sqrt(sum / block.length) : 0;
}

export interface VoiceCaptureOptions extends Partial<EndpointConfig> {
  /** Device from `navigator.mediaDevices.enumerateDevices`, or the default. */
  deviceId?: string;
}

export class VoiceCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private detector: EndpointDetector | null = null;
  private blocks: Float32Array[] = [];
  private speaking = false;
  private closing = false;

  constructor(
    private readonly handlers: CaptureHandlers,
    private readonly options: VoiceCaptureOptions = {},
  ) {}

  get active(): boolean {
    return this.context !== null;
  }

  static supported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  /** Open the device and start listening. Rejects with a `CaptureError`. */
  async start(): Promise<void> {
    if (this.active) return;
    if (!VoiceCapture.supported()) {
      throw new CaptureError(
        'UNSUPPORTED',
        'Bu tarayıcı mikrofon yakalamayı desteklemiyor.',
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.options.deviceId ? { exact: this.options.deviceId } : undefined,
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
          // On for a room with other people in it. All three degrade a transcript
          // slightly in a quiet booth and improve it a lot anywhere else, and an
          // operations room is not a booth.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (cause) {
      throw asCaptureError(cause);
    }

    try {
      const context = new AudioContext();
      await context.audioWorklet.addModule(processorUrl());

      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'goru-capture');

      this.context = context;
      this.stream = stream;
      this.source = source;
      this.node = node;
      this.blocks = [];
      this.speaking = false;
      this.closing = false;
      this.detector = new EndpointDetector(this.options);

      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.onBlock(event.data, context.sampleRate);
      };

      source.connect(node);
      // Not connected to the destination: routing the microphone to the speakers
      // would feed the room back to itself.
      if (context.state === 'suspended') await context.resume();
    } catch (cause) {
      stream.getTracks().forEach((track) => track.stop());
      await this.teardown();
      throw new CaptureError(
        'CAPTURE_FAILED',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  /** Stop and send whatever has been captured, if it is long enough to be a command. */
  async stop(): Promise<void> {
    if (!this.active || this.closing) return;
    this.closing = true;
    const detector = this.detector;
    const held = concat(this.blocks);
    const rate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    await this.teardown();

    if (!this.speaking || !detector) {
      this.handlers.onEmpty?.('manual');
      return;
    }
    this.emit(held, rate, detector, 'manual');
  }

  /** Stop and discard. Used when the operator cancels. */
  async cancel(): Promise<void> {
    if (!this.active) return;
    this.closing = true;
    await this.teardown();
    this.handlers.onEmpty?.('manual');
  }

  private onBlock(block: Float32Array, sampleRate: number): void {
    const detector = this.detector;
    if (!detector || this.closing) return;

    const frameMs = (block.length / sampleRate) * 1000;
    const update = detector.push(rmsOfBlock(block), frameMs);

    // Buffer from the moment the level rises, not from the moment onset is
    // confirmed: the first 150 ms of a word is what confirms it, and dropping
    // those clips the consonant the model needs most.
    if (update.phase !== 'calibrating' && update.phase !== 'waiting') {
      this.blocks.push(block);
    } else if (update.level > 0) {
      // A short pre-roll, so the onset frames are already held when speech starts.
      this.blocks.push(block);
      const maxPreRoll = Math.ceil((0.4 * sampleRate) / block.length);
      if (this.blocks.length > maxPreRoll) this.blocks.shift();
    }

    if (update.started && !this.speaking) {
      this.speaking = true;
      this.handlers.onSpeechStart?.();
    }
    this.handlers.onFrame?.(update);

    if (update.finished) {
      this.closing = true;
      const held = concat(this.blocks);
      void this.teardown().then(() => {
        this.emit(held, sampleRate, detector, update.finished as 'silence' | 'max-duration');
      });
    }
  }

  private emit(
    held: Float32Array,
    sampleRate: number,
    detector: EndpointDetector,
    reason: CapturedUtterance['reason'],
  ): void {
    if (held.length === 0) {
      this.handlers.onEmpty?.('no-speech');
      return;
    }
    if (!detector.longEnough) {
      this.handlers.onEmpty?.('too-short');
      return;
    }

    const resampled = resample(held, sampleRate, TARGET_SAMPLE_RATE);
    this.handlers.onUtterance?.({
      wav: encodeWav(resampled, TARGET_SAMPLE_RATE),
      durationS: durationOf(resampled, TARGET_SAMPLE_RATE),
      peak: peakOf(resampled),
      reason,
    });
  }

  private async teardown(): Promise<void> {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context) {
      const context = this.context;
      this.context = null;
      try {
        await context.close();
      } catch {
        // Closing an already-closed context is not a failure worth surfacing.
      }
    }
    this.detector = null;
    this.blocks = [];
  }
}

function asCaptureError(cause: unknown): CaptureError {
  const name = (cause as { name?: string } | null)?.name ?? '';
  const message = cause instanceof Error ? cause.message : String(cause);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError(
        'PERMISSION_DENIED',
        'Mikrofon izni verilmedi. Tarayıcının adres çubuğundaki izinleri açın.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CaptureError('NO_MICROPHONE', 'Kullanılabilir bir mikrofon bulunamadı.');
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError(
        'DEVICE_BUSY',
        'Mikrofon başka bir uygulama tarafından kullanılıyor.',
      );
    default:
      return new CaptureError('CAPTURE_FAILED', message);
  }
}
