/* Endpointing: when the operator stopped talking.
 *
 * This is the part of the speech path with no model in it and the most to get
 * wrong, which makes it the part worth testing hardest. All of it is driven with
 * lists of RMS numbers, so every case below is exact and none of them need a
 * microphone.
 *
 * The properties: the room is measured before anything is believed, a real word is
 * not clipped by the floor rising behind it, silence closes an utterance after the
 * configured hangover and not before, the 15-second cap holds, and a cough is not a
 * command.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, EndpointDetector, type EndpointUpdate } from './endpoint';

/** Feed a level for a duration and return the last update. */
function feed(
  detector: EndpointDetector,
  rms: number,
  ms: number,
  frameMs = 10,
): EndpointUpdate {
  let last: EndpointUpdate = detector.push(rms, frameMs);
  for (let elapsed = frameMs; elapsed < ms; elapsed += frameMs) {
    last = detector.push(rms, frameMs);
  }
  return last;
}

/** Feed and collect every update, for the cases that care about the transition. */
function feedAll(
  detector: EndpointDetector,
  rms: number,
  ms: number,
  frameMs = 10,
): EndpointUpdate[] {
  const out: EndpointUpdate[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += frameMs) {
    out.push(detector.push(rms, frameMs));
  }
  return out;
}

const QUIET = 0.002;
const SPEECH = 0.06;

describe('EndpointDetector', () => {
  it('measures the room before it will believe any speech', () => {
    const detector = new EndpointDetector();
    const early = feedAll(detector, SPEECH, DEFAULT_ENDPOINT.calibrationMs - 20);
    // Loud audio during calibration must not start an utterance: the first 300 ms
    // is how we learn what silence sounds like on this device.
    expect(early.every((update) => update.phase === 'calibrating')).toBe(true);
    expect(early.some((update) => update.started)).toBe(false);
  });

  it('starts an utterance once speech has been sustained past the onset window', () => {
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const updates = feedAll(detector, SPEECH, DEFAULT_ENDPOINT.onsetMs + 40);
    expect(updates.some((update) => update.started)).toBe(true);
    expect(updates.at(-1)?.phase).toBe('speaking');
  });

  it('does not start on a single loud frame, which is a door or a cough', () => {
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const blip = feedAll(detector, SPEECH, 40);
    expect(blip.some((update) => update.started)).toBe(false);
    // ...and it recovers: the transient did not poison the state.
    const speech = feedAll(detector, SPEECH, DEFAULT_ENDPOINT.onsetMs + 40);
    expect(speech.some((update) => update.started)).toBe(true);
  });

  it('closes the utterance after the configured silence and not before', () => {
    const detector = new EndpointDetector({ silenceMs: 500 });
    feed(detector, QUIET, 400);
    feed(detector, SPEECH, 600);

    const early = feed(detector, QUIET, 300);
    expect(early.finished).toBeNull();
    expect(early.phase).toBe('trailing');

    const closed = feed(detector, QUIET, 300);
    expect(closed.finished).toBe('silence');
    expect(closed.phase).toBe('done');
  });

  it('treats a pause inside a sentence as one utterance, not two', () => {
    // "img_000860 karesini... değerlendir" -- a 200 ms gap mid-sentence is normal
    // speech and must not cut the command in half.
    const detector = new EndpointDetector({ silenceMs: 500 });
    feed(detector, QUIET, 400);
    feed(detector, SPEECH, 500);
    const gap = feed(detector, QUIET, 200);
    expect(gap.finished).toBeNull();

    const resumed = feed(detector, SPEECH, 300);
    expect(resumed.phase).toBe('speaking');
    expect(resumed.finished).toBeNull();
  });

  it('stops at the command cap so a stuck microphone cannot record forever', () => {
    const detector = new EndpointDetector({ maxUtteranceS: 2 });
    feed(detector, QUIET, 400);
    const update = feed(detector, SPEECH, 2500);
    expect(update.finished).toBe('max-duration');
  });

  it('does not let the noise floor climb behind a sustained word', () => {
    /* The failure this guards: if the floor kept adapting while someone spoke, a
     * long vowel would raise it past itself and the detector would decide the
     * speech had stopped in the middle of the word. */
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const floorAtOnset = detector.noiseFloor;
    feed(detector, SPEECH, 1500);
    expect(detector.noiseFloor).toBeCloseTo(floorAtOnset, 6);
  });

  it('follows a room that gets noisier while nothing is being said', () => {
    // A fan spinning up must not read as speech.
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const before = detector.noiseFloor;
    feed(detector, 0.01, 2000);
    expect(detector.noiseFloor).toBeGreaterThan(before);
  });

  it('adapts to a loud room instead of triggering on it', () => {
    const detector = new EndpointDetector();
    // Calibrate against a genuinely noisy input, then feed the same level.
    feed(detector, 0.02, 400);
    const updates = feedAll(detector, 0.02, 500);
    expect(updates.some((update) => update.started)).toBe(false);
    // Speech above that floor still registers.
    const speech = feedAll(detector, 0.2, 300);
    expect(speech.some((update) => update.started)).toBe(true);
  });

  it('knows when what it captured is too short to be a command', () => {
    const detector = new EndpointDetector({ minUtteranceS: 0.25, silenceMs: 200 });
    feed(detector, QUIET, 400);
    feed(detector, SPEECH, 160);
    feed(detector, QUIET, 250);
    expect(detector.longEnough).toBe(false);
  });

  it('knows when it is long enough', () => {
    const detector = new EndpointDetector({ minUtteranceS: 0.25, silenceMs: 200 });
    feed(detector, QUIET, 400);
    feed(detector, SPEECH, 900);
    expect(detector.longEnough).toBe(true);
  });

  it('reports a level relative to the room, so a normal voice fills the bars', () => {
    /* An absolute RMS reading makes a normal voice on a quiet input look like
     * near-silence, and the bars exist to tell the operator they are heard. */
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const quiet = detector.push(QUIET, 10);
    const loud = detector.push(SPEECH, 10);
    expect(quiet.level).toBeLessThan(0.2);
    expect(loud.level).toBeGreaterThan(0.5);
    expect(loud.level).toBeLessThanOrEqual(1);
  });

  it('never reports a level outside 0..1 however hard the input clips', () => {
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const update = detector.push(5.0, 10);
    expect(update.level).toBeGreaterThanOrEqual(0);
    expect(update.level).toBeLessThanOrEqual(1);
  });

  it('counts the held seconds as speech, excluding the calibration', () => {
    const detector = new EndpointDetector();
    feed(detector, QUIET, 400);
    const update = feed(detector, SPEECH, 1000);
    expect(update.heldS).toBeGreaterThan(0.9);
    expect(update.heldS).toBeLessThan(1.3);
  });
});
