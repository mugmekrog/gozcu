/* The data seam.
 *
 * Every screen reads through this interface and nothing else, so the app does
 * not know whether its numbers came from a static export or from a live
 * FastAPI process. That matters twice: the REST and WS layer of PLAN 5.4/5.5
 * belongs to the backend stream and does not exist yet, and the demo has to
 * survive the network being off (PLAN 9.3).
 *
 * Two adapters satisfy it -- `FixtureApi` over the real pipeline's exported
 * output, and `HttpApi` over the REST endpoints -- which is what makes the seam
 * real rather than hypothetical. Neither is a mock: the fixture adapter serves
 * the same numbers the engine computed.
 *
 * The interface is deliberately small. Four loads for the data that boots the
 * app, one lazy load per frame, one evaluation stream, one question, one
 * decision. Anything a screen wants beyond that is derived in `src/domain/`,
 * not added here.
 */

import type {
  Alert,
  Brief,
  DatasetInfo,
  Decision,
  FieldReport,
  FrameDetail,
  TrackHistory,
} from '@/domain/types';
import type { BasemapFile } from '@/domain/basemap';

/** One line of the agent step list. */
export interface AgentStep {
  id: string;
  /** 1-based position in the numbered sequence; null for a nested tool call. */
  index: number | null;
  title: string;
  detail: string;
  state: 'pending' | 'active' | 'done' | 'tool' | 'warn' | 'error';
  /** Measured wall time for this step, once it has finished. */
  ms: number | null;
}

/**
 * What an evaluation emits as it runs.
 *
 * A stream rather than a promise because the wireframe's screen 8 shows the
 * steps arriving one at a time, and because a live LLM call takes 10-15 seconds
 * (PLAN 6.11) during which the operator must see progress. The brief arrives
 * separately from the completion event so the card can fill before the timings
 * settle.
 */
export type AgentEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'decision'; frame: FrameDetail }
  | { type: 'brief'; brief: Brief }
  | { type: 'done'; elapsedMs: number; toolCalls: number }
  | { type: 'error'; message: string; step?: AgentStep };

export interface AgentBudget {
  spend_usd: number;
  cap_usd: number;
}

export interface GoruApi {
  /** How this adapter got its data, for the honesty pill in the header. */
  readonly mode: 'fixture' | 'http';

  /** Zones, frame summaries, thresholds, the sim window. Loaded once. */
  dataset(): Promise<DatasetInfo>;
  /** All 226 track histories. Loaded once; the map interpolates from them. */
  tracks(): Promise<TrackHistory[]>;
  /** All 137 field reports. */
  reports(): Promise<FieldReport[]>;
  /** Every alert from every frame, for the timeline and the logs view. */
  alerts(): Promise<Alert[]>;

  /** One frame in full. Lazy: ~130 KB each, and only the opened frame is read. */
  frame(imageId: string): Promise<FrameDetail>;
  /** Where the drone image lives, or null when images were not exported. */
  imageUrl(imageId: string): string | null;
  /**
   * The OpenStreetMap basemap under the radar, from the app's own static assets
   * (`api/basemap.ts`). Null when it was never baked; the map then draws on its
   * plain ground.
   */
  basemap(): Promise<BasemapFile | null>;

  /** Run the assessment for one frame, reporting progress as it goes. */
  assess(imageId: string, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** Ask the read-only copilot. Rejects when no gateway is configured. */
  ask(question: string, signal?: AbortSignal): Promise<string>;
  /** Spend against the cap, or null when there is no gateway to ask. */
  budget(): Promise<AgentBudget | null>;

  /** Record an operator decision. Returns what was stored. */
  record(decision: Decision): Promise<Decision>;
  /** Decisions recorded so far, newest last. */
  decisions(): Promise<Decision[]>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
