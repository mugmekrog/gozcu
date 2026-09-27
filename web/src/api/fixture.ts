/* The fixture adapter: the real pipeline's output, served as static JSON.
 *
 * `web/scripts/export_fixtures.py` drives `Pipeline.analyse_all()` and writes
 * what the REST endpoints will eventually serve. So these are not mocks -- the
 * detections, matches, kinematics, zone assessments, alerts and rule-baseline
 * brief are the engine's own numbers. What is missing is only what needs a live
 * process: the LLM brief, the copilot, and the audit chain.
 *
 * Honesty about the step list, since it is the one thing that could mislead:
 * the step *labels and counts* are facts read from the frame's own funnel and
 * match records -- the pipeline really did post-process 425 boxes down to 4 and
 * really did match them to 4 tracks. The *timings* are this adapter's own
 * measured fetch and assemble times, not the engine's stage costs, because the
 * engine ran offline and does not report per-stage timing. A live `HttpApi`
 * reports the server's real per-step timings instead.
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
import { T } from '@/domain/strings';
import { describeSteps, type StepId } from '@/domain/steps';
import { ApiError, type AgentBudget, type AgentEvent, type AgentReply, type AgentStep, type GoruApi } from './port';
import { HttpApi } from './http';
import { loadBasemap } from './basemap';

const BASE = 'fixtures';

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`, { signal });
  } catch (cause) {
    throw new ApiError(`${path} okunamadı`, cause);
  }
  if (!response.ok) {
    throw new ApiError(`${path} okunamadı (HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

/** Cache by path: the boot payloads are read once and never change. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load();
    return pending;
  };
}

function step(
  id: string,
  index: number | null,
  title: string,
  detail: string,
  state: AgentStep['state'],
  ms: number | null = null,
  lines?: string[],
): AgentStep {
  return { id, index, title, detail, state, ms, ...(lines ? { lines } : {}) };
}

/** Let the browser paint between steps so the list visibly fills. */
const yieldFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

export class FixtureApi implements GoruApi {
  readonly mode = 'fixture' as const;
  private liveAssessment = false;
  private agentApi() {
    return new HttpApi({ baseUrl: import.meta.env.VITE_AGENT_API_BASE_URL ?? 'http://localhost:8000' });
  }

  private readonly frameCache = new Map<string, Promise<FrameDetail>>();
  private readonly decisionLog: Decision[] = [];
  private imagesPresent: boolean | null = null;

  readonly dataset = once(async () => {
    const info = await getJson<DatasetInfo>('dataset.json');
    // The export copies the drone images beside the frame JSON unless it was
    // run with --no-images. Probing once keeps the camera view honest about it.
    this.imagesPresent = true;
    return info;
  });

  readonly tracks = once(async () => {
    const payload = await getJson<{ tracks: TrackHistory[] }>('tracks.json');
    return payload.tracks;
  });

  readonly reports = once(async () => {
    const payload = await getJson<{ reports: FieldReport[] }>('reports.json');
    return payload.reports;
  });

  readonly alerts = once(async () => {
    const payload = await getJson<{ alerts: Alert[] }>('alerts.json');
    return payload.alerts;
  });

  frame(imageId: string): Promise<FrameDetail> {
    let pending = this.frameCache.get(imageId);
    if (!pending) {
      pending = getJson<FrameDetail>(`frames/${imageId}.json`);
      this.frameCache.set(imageId, pending);
    }
    return pending;
  }

  imageUrl(imageId: string): string | null {
    if (this.imagesPresent === false) return null;
    return `${BASE}/frames/${imageId}.jpg`;
  }

  readonly basemap = once(() => loadBasemap());

  /**
   * Replay one frame's evaluation as a step stream.
   *
   * The work is real -- the frame payload is fetched and parsed here, and that
   * is what the timings measure. Steps whose result was computed offline are
   * reported with the counts they produced, which is the useful part for an
   * operator checking that the funnel behaved.
   */
  async *assess(imageId: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.liveAssessment) {
      yield* this.agentApi().assess(imageId, signal);
      return;
    }
    const started = performance.now();
    const emitted: AgentStep[] = [];
    let toolCalls = 0;

    const plan: { id: string; index: number; title: string }[] = [
      { id: 'open', index: 1, title: T.step.open },
      { id: 'place', index: 2, title: T.step.place },
      { id: 'detect', index: 3, title: T.step.detect },
      { id: 'georef', index: 4, title: T.step.georef },
      { id: 'tracks', index: 5, title: T.step.findTracks },
      { id: 'kinematics', index: 6, title: T.step.kinematics },
      { id: 'reports', index: 7, title: T.step.compareReports },
      { id: 'score', index: 8, title: T.step.baseScore },
      { id: 'assess', index: 9, title: T.step.assess },
    ];

    // Step 1 covers the fetch, so it is announced active before the await.
    yield { type: 'step', step: step('open', 1, T.step.open, imageId, 'active') };

    let frame: FrameDetail;
    const fetchStarted = performance.now();
    try {
      frame = await this.frame(imageId);
    } catch (error) {
      const failed = step(
        'open',
        1,
        T.step.open,
        error instanceof Error ? error.message : 'okunamadı',
        'error',
        Math.round(performance.now() - fetchStarted),
      );
      yield { type: 'error', message: `${imageId} okunamadı`, step: failed };
      return;
    }
    if (signal?.aborted) return;

    const fetchMs = Math.round(performance.now() - fetchStarted);
    // The base anchors the ENU frame, so coordinates can be shown as lat/lon.
    const dataset = await this.dataset().catch(() => null);
    const texts = describeSteps(frame, { base: dataset?.base ?? null, zones: dataset?.zones ?? [] });

    for (const entry of plan) {
      if (signal?.aborted) return;

      // A frame with no vehicles genuinely skips the motion and report stages,
      // and saying so is more useful than showing them tick by.
      const skipped =
        frame.track_states.length === 0 &&
        (entry.id === 'kinematics' || entry.id === 'reports' || entry.id === 'score');
      if (skipped) {
        const s = step(entry.id, entry.index, entry.title, 'araç yok · atlandı', 'warn', 0);
        emitted.push(s);
        yield { type: 'step', step: s };
        continue;
      }

      const stepStarted = performance.now();
      const text = texts[entry.id as StepId];
      const active = step(entry.id, entry.index, entry.title, text.detail, 'active');
      yield { type: 'step', step: active };
      await yieldFrame();

      // The pipeline's own tool seam: the copilot's `get_track_history` is what
      // the evidence bundle's per-vehicle history stands in for here, so the
      // nested line only appears when a lead vehicle actually has one.
      if (entry.id === 'tracks' && frame.alerts.length > 0) {
        toolCalls += 1;
        const lead = frame.alerts[0];
        yield {
          type: 'step',
          step: step(
            'tool-history',
            null,
            `${T.step.toolCall} · get_track_history`,
            `track_id=${lead?.track_id} · pencere=120 dk`,
            'tool',
            1,
          ),
        };
        await yieldFrame();
      }

      const done = step(
        entry.id,
        entry.index,
        entry.title,
        text.detail,
        'done',
        entry.id === 'open' ? fetchMs : Math.max(1, Math.round(performance.now() - stepStarted)),
        text.lines,
      );
      emitted.push(done);
      yield { type: 'step', step: done };
    }

    yield { type: 'brief', brief: frame.brief };
    yield {
      type: 'done',
      elapsedMs: Math.round(performance.now() - started),
      toolCalls,
    };
  }

  /** Send questions to the live agent while keeping fixture data as the display source. */
  async ask(question: string): Promise<AgentReply> {
    let reply: AgentReply;
    try {
      reply = await this.agentApi().ask(question);
    } catch (cause) {
      throw new ApiError('Ajan servisine bağlanılamadı. Backend’i başlatın veya VITE_AGENT_API_BASE_URL ayarlayın.', cause);
    }
    this.liveAssessment = reply.assessment_image_ids.length > 0;
    return reply;
  }

  async budget(): Promise<AgentBudget | null> {
    return null;
  }

  async record(decision: Decision): Promise<Decision> {
    this.decisionLog.push(decision);
    return decision;
  }

  async decisions(): Promise<Decision[]> {
    return [...this.decisionLog];
  }
}

/** Exported for tests, which drive the adapter against the checked-in fixtures. */
export type { Brief };
