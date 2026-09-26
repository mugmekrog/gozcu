/* Turning captured audio into what the speech service accepts (stt.md phase 2).
 *
 * The service takes 16 kHz mono 16-bit PCM in a RIFF/WAVE container, and it takes
 * only that: it decodes with Python's own `wave` module rather than shelling out
 * to ffmpeg, which is what keeps the demo laptop from needing a binary on PATH.
 * So the conversion happens here, where we control it, instead of being negotiated
 * per browser.
 *
 * `MediaRecorder` is deliberately not used. It produces WebM/Opus, which would put
 * an ffmpeg dependency back on the server for no gain -- we already have the raw
 * samples, and a command is under half a megabyte as PCM.
 *
 * Nothing in this file touches the DOM, so it is unit-testable without a browser.
 */

/** 16 kHz mono is what Whisper's feature extractor wants (preprocessor_config.json). */
export const TARGET_SAMPLE_RATE = 16000;

const INT16_MAX = 32767;

/** Root-mean-square level of a block, the number the level bars show. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** Largest absolute sample, for the clipping warning. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * Linear resample to `toRate`.
 *
 * Linear and not a windowed sinc, matching the server's decoder for the same
 * reason: the microphone has already band-limited the signal, speech sits well
 * inside 8 kHz, and Whisper's front end is an 80-bin mel filterbank that discards
 * far more than the interpolator loses. A polyphase filter here would cost CPU on
 * the operator's machine to improve a number no downstream stage can see.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;

  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLength);
  const step = (samples.length - 1) / Math.max(1, outLength - 1);

  for (let i = 0; i < outLength; i += 1) {
    const position = i * step;
    const low = Math.floor(position);
    const high = Math.min(low + 1, samples.length - 1);
    const fraction = position - low;
    out[i] = (samples[low] ?? 0) * (1 - fraction) + (samples[high] ?? 0) * fraction;
  }
  return out;
}

/** Join captured blocks into one buffer. */
export function concat(blocks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/**
 * Mono float32 to a 16-bit PCM WAV.
 *
 * The header is the canonical 44 bytes. Samples are clamped before scaling: a
 * gain-staged microphone can hand us values past 1.0, and letting those wrap
 * would turn a loud command into a burst of noise the model cannot read.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, Math.round(clamped * INT16_MAX), true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** Seconds of audio in a buffer at a given rate. */
export function durationOf(samples: Float32Array, sampleRate: number): number {
  return sampleRate > 0 ? samples.length / sampleRate : 0;
}
