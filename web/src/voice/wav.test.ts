/* The audio the browser sends.
 *
 * The service decodes with Python's `wave` module, which accepts PCM WAV and
 * nothing else -- that is what keeps ffmpeg off the demo laptop. So the header this
 * writes has to be exactly right, and "exactly right" is checkable: the bytes are
 * asserted field by field here, and `tests/test_stt.py` decodes the same shape from
 * the other side.
 */

import { describe, expect, it } from 'vitest';
import { TARGET_SAMPLE_RATE, concat, durationOf, encodeWav, peakOf, resample, rmsOf } from './wav';

function tone(seconds: number, rate: number, freq = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

/* jsdom's `Blob` has no `arrayBuffer()`, so read through `FileReader`, which both
 * it and every real browser implement. */
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function headerOf(blob: Blob) {
  const view = new DataView(await bytesOf(blob));
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(
      ...Array.from({ length }, (_, i) => view.getUint8(offset + i)),
    );
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataBytes: view.getUint32(40, true),
    byteLength: view.byteLength,
  };
}

describe('encodeWav', () => {
  it('writes the PCM header the Python service will decode', async () => {
    const samples = tone(0.5, TARGET_SAMPLE_RATE);
    const header = await headerOf(encodeWav(samples, TARGET_SAMPLE_RATE));

    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmt).toBe('fmt ');
    expect(header.audioFormat).toBe(1); // uncompressed PCM
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(header.bitsPerSample).toBe(16);
    expect(header.blockAlign).toBe(2);
    expect(header.byteRate).toBe(TARGET_SAMPLE_RATE * 2);
    expect(header.data).toBe('data');
    expect(header.dataBytes).toBe(samples.length * 2);
    expect(header.byteLength).toBe(44 + samples.length * 2);
  });

  it('clamps rather than wrapping, so a hot microphone does not become noise', async () => {
    /* A gain-staged input can hand us values past 1.0. Letting those overflow the
     * int16 would turn a loud command into a burst the model cannot read at all,
     * which is far worse than clipping it. */
    const hot = new Float32Array([2.5, -2.5, 0.5, -0.5]);
    const view = new DataView(await bytesOf(encodeWav(hot, TARGET_SAMPLE_RATE)));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBeCloseTo(16384, -2);
  });

  it('produces a payload the service will accept for a full-length command', async () => {
    // 15 s at 16 kHz mono 16-bit is 480 KB; the service refuses past 4 MB.
    const blob = encodeWav(tone(15, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
    expect(blob.size).toBeLessThan(4 * 1024 * 1024);
    expect(blob.type).toBe('audio/wav');
  });
});

describe('resample', () => {
  it('converts the browser rate to what Whisper wants, keeping the duration', () => {
    // An AudioContext usually runs at 48 kHz whatever we asked getUserMedia for.
    const at48k = tone(1, 48000);
    const at16k = resample(at48k, 48000, TARGET_SAMPLE_RATE);
    expect(at16k.length).toBeCloseTo(16000, -2);
    expect(durationOf(at16k, TARGET_SAMPLE_RATE)).toBeCloseTo(1, 2);
  });

  it('is a no-op when the rates already match', () => {
    const samples = tone(0.2, TARGET_SAMPLE_RATE);
    expect(resample(samples, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE)).toBe(samples);
  });

  it('preserves the signal well enough that its level survives', () => {
    const at44k = tone(1, 44100, 300);
    const at16k = resample(at44k, 44100, TARGET_SAMPLE_RATE);
    // A 300 Hz tone is far inside the new Nyquist limit, so RMS should barely move.
    expect(rmsOf(at16k)).toBeCloseTo(rmsOf(at44k), 2);
  });

  it('handles an empty buffer without throwing', () => {
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

describe('level measurement', () => {
  it('reports the RMS of a sine as its amplitude over root two', () => {
    expect(rmsOf(tone(0.5, TARGET_SAMPLE_RATE))).toBeCloseTo(0.4 / Math.SQRT2, 2);
  });

  it('reports zero for silence rather than dividing by nothing', () => {
    expect(rmsOf(new Float32Array(100))).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it('reports the peak, which is what the clipping warning reads', () => {
    expect(peakOf(new Float32Array([0.1, -0.9, 0.3]))).toBeCloseTo(0.9, 5);
  });
});

describe('concat', () => {
  it('joins the captured blocks in order', () => {
    const joined = concat([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])]);
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty buffer for no blocks', () => {
    expect(concat([]).length).toBe(0);
  });
});
