/* Deciding when the operator stopped talking (stt.md phase 3).
 *
 * There are two voice activity detectors in this system and they do different
 * jobs. Silero, on the server inside faster-whisper, decides whether what arrived
 * was speech at all. This one decides *when to stop recording*, which Silero
 * cannot do because the audio has not been sent yet. Getting that wrong is the
 * difference between a command that lands in a second and one the operator has to
 * repeat.
 *
 * It is energy-based rather than a second neural model, on purpose. Shipping
 * Silero to the browser means onnxruntime-web and a WASM blob in a bundle that has
 * to work with the network off (PLAN F4.3), to make a decision that a noise floor
 * and a hangover timer already make well for a headset at a desk. The server's
 * Silero pass is the backstop for when this one lets noise through, which is why
 * a false trigger here costs nothing worse than a `NO_SPEECH` refusal.
 *
 * The noise floor adapts, because a fixed threshold is what makes energy VAD
 * unusable: it must work in a quiet room and beside a laptop fan, and those differ
 * by more than an order of magnitude. It is measured from the silence the operator
 * is not speaking in, and never raised while speech is in progress -- otherwise a
 * sustained word drags the floor up behind it and clips its own ending.
 *
 * Pure logic, no DOM, no audio API: every case below is a unit test.
 */

export type EndpointPhase = 'calibrating' | 'waiting' | 'speaking' | 'trailing' | 'done';

export interface EndpointConfig {
  /** Frames of silence that close an utterance. From `stt.vad_min_silence_ms`. */
  silenceMs: number;
  /** Sustained level before speech is believed. Short enough not to clip a word. */
  onsetMs: number;
  /** Hard cap; `stt.max_utterance_s`. */
  maxUtteranceS: number;
  /** Below this, the clip is a click rather than a command. */
  minUtteranceS: number;
  /** How long to measure the room before listening for speech. */
  calibrationMs: number;
  /** Speech must exceed the noise floor by this factor. */
  onsetRatio: number;
  /** Speech ends when it falls below this factor, hysteresis against onsetRatio. */
  releaseRatio: number;
  /** Floor under the noise estimate, so a silent digital input is not divided into. */
  floorRms: number;
}

export const DEFAULT_ENDPOINT: EndpointConfig = {
  silenceMs: 500,
  onsetMs: 150,
  maxUtteranceS: 15,
  minUtteranceS: 0.25,
  calibrationMs: 300,
  // 3.5x the room is a spoken word at a headset; 2x is the same word trailing off.
  // Two thresholds rather than one, so a level hovering at the boundary does not
  // chatter the display between "dinliyor" and "duyuyorum".
  onsetRatio: 3.5,
  releaseRatio: 2.0,
  floorRms: 0.004,
};

export interface EndpointUpdate {
  phase: EndpointPhase;
  /** True on the frame speech was first believed. */
  started: boolean;
  /** Set when the utterance closed, with why. */
  finished: null | 'silence' | 'max-duration';
  /** 0-1, for the level bars. Normalised against the noise floor, not absolute. */
  level: number;
  /** Seconds of audio held so far. */
  heldS: number;
  noiseFloor: number;
}

/**
 * Tracks one recording session, frame by frame.
 *
 * `push` is called once per audio block with that block's RMS and duration, and
 * returns what the display and the recorder should do. The detector holds no
 * audio: buffering is the caller's, so this stays testable with a list of numbers.
 */
export class EndpointDetector {
  private readonly cfg: EndpointConfig;
  private phase: EndpointPhase = 'calibrating';
  private elapsedMs = 0;
  /** Audio held in the utterance, speech and the trailing silence together. */
  private heldMs = 0;
  /** Frames that were actually above the release threshold. */
  private speechMs = 0;
  private silenceMs = 0;
  private onsetMs = 0;
  private noise = 0;
  private noiseFrames = 0;
  private peakLevel = 0;

  constructor(cfg: Partial<EndpointConfig> = {}) {
    this.cfg = { ...DEFAULT_ENDPOINT, ...cfg };
  }

  get noiseFloor(): number {
    return Math.max(this.noise, this.cfg.floorRms);
  }

  /** Seconds of speech held, excluding the trailing silence that ended it. */
  get speechSeconds(): number {
    return this.speechMs / 1000;
  }

  push(rms: number, frameMs: number): EndpointUpdate {
    this.elapsedMs += frameMs;

    if (this.phase === 'calibrating') {
      this.noise = this.noise + (rms - this.noise) / (this.noiseFrames + 1);
      this.noiseFrames += 1;
      if (this.elapsedMs >= this.cfg.calibrationMs) this.phase = 'waiting';
      return this.update(rms, false, null);
    }

    const floor = this.noiseFloor;
    const onsetThreshold = floor * this.cfg.onsetRatio;
    const releaseThreshold = floor * this.cfg.releaseRatio;

    if (this.phase === 'waiting') {
      if (rms > onsetThreshold) {
        // A frame this loud is a candidate for speech, so it must not feed the
        // noise estimate. Letting it would be self-defeating: a sustained word
        // drags the floor up behind itself, the threshold outruns the speech, and
        // onset is never confirmed. Only silence tells us what silence sounds
        // like.
        this.onsetMs += frameMs;
        if (this.onsetMs >= this.cfg.onsetMs) {
          this.phase = 'speaking';
          // The onset frames are speech and the caller has been buffering them,
          // so count them rather than starting from zero.
          this.speechMs = this.onsetMs;
          this.heldMs = this.onsetMs;
          this.silenceMs = 0;
          return this.update(rms, true, null);
        }
        return this.update(rms, false, null);
      }

      // Keep following the room while nothing is being said, so a fan that spins
      // up mid-session does not read as speech. Deliberately slow -- a ~1 s time
      // constant, several times the onset window -- so the floor can never move
      // faster than the decision it informs.
      this.noise = this.noise * 0.99 + rms * 0.01;
      this.onsetMs = 0;
      return this.update(rms, false, null);
    }

    // speaking or trailing: the floor is frozen.
    this.heldMs += frameMs;

    // The cap is on held audio, because that is what the WAV will contain and
    // what the service measures against `stt.max_utterance_s`.
    if (this.heldMs / 1000 >= this.cfg.maxUtteranceS) {
      this.phase = 'done';
      return this.update(rms, false, 'max-duration');
    }

    if (rms > releaseThreshold) {
      this.phase = 'speaking';
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
      this.phase = 'trailing';
      if (this.silenceMs >= this.cfg.silenceMs) {
        this.phase = 'done';
        return this.update(rms, false, 'silence');
      }
    }
    return this.update(rms, false, null);
  }

  /**
   * Whether there is enough *speech* to be worth sending.
   *
   * Measured on speech alone, not on held audio. Counting the trailing silence
   * would let a 160 ms cough followed by the half-second hangover clear a 250 ms
   * minimum, which is exactly the clip the minimum exists to reject.
   */
  get longEnough(): boolean {
    return this.speechMs / 1000 >= this.cfg.minUtteranceS;
  }

  private update(
    rms: number,
    started: boolean,
    finished: EndpointUpdate['finished'],
  ): EndpointUpdate {
    // Level is shown relative to the room, not as an absolute RMS: an absolute
    // reading makes a normal voice on a quiet input look like near-silence, and
    // the bars are there to tell the operator they are being heard.
    const floor = this.noiseFloor;
    const scaled = Math.min(1, Math.max(0, (rms - floor) / (floor * 8)));
    // A short square-root curve, because loudness is perceptual and a linear bar
    // spends most of its travel in the top half of a shout.
    const level = Math.sqrt(scaled);
    if (level > this.peakLevel) this.peakLevel = level;

    return {
      phase: this.phase,
      started,
      finished,
      level,
      // Held audio, so the countdown the operator sees matches the cap it is
      // counting down to.
      heldS: this.heldMs / 1000,
      noiseFloor: floor,
    };
  }
}
