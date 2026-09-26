/* The HTTP adapter: the same interface over the REST API of PLAN 5.4.
 *
 * This exists now, before `services/api/app/api/rest.py` does, for two reasons.
 * First, it is what makes the seam real rather than hypothetical -- with one
 * adapter the interface is a guess, and with two it is a contract that has been
 * tested against something. Second, it pins down exactly which endpoints the
 * frontend needs and in what shape, so the backend stream can build against a
 * written expectation instead of a conversation.
 *
 * Every path and payload below comes from PLAN 5.4. Where the plan's REST
 * surface does not yet cover something the screens need, the gap is marked with
 * NEEDS-BACKEND and listed in logs/step_frontend_development_logs.md rather
 * than quietly invented.
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
import { ApiError, type AgentBudget, type AgentEvent, type AgentStep, type GoruApi } from './port';

export interface HttpApiOptions {
  baseUrl: string;
  /** Bearer token from POST /auth/login. */
  token?: string;
}

export class HttpApi implements GoruApi {
  readonly mode = 'http' as const;

  constructor(private readonly opts: HttpApiOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (this.opts.token) headers.set('authorization', `Bearer ${this.opts.token}`);
    if (init.body) headers.set('content-type', 'application/json');

    let response: Response;
    try {
      response = await fetch(`${this.opts.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new ApiError(`${path} isteği başarısız`, cause);
    }
    if (!response.ok) {
      throw new ApiError(`${path} isteği başarısız (HTTP ${response.status})`);
    }
    return (await response.json()) as T;
  }

  /**
   * NEEDS-BACKEND: PLAN 5.4 has GET /zones but no single call that returns the
   * zones, the frame index, the thresholds and the sim window together. The
   * screens need all four before first paint, so this composes them; a
   * GET /dataset would replace the composition with one round trip.
   */
  async dataset(): Promise<DatasetInfo> {
    return this.request<DatasetInfo>('/dataset');
  }

  async tracks(): Promise<TrackHistory[]> {
    const payload = await this.request<{ tracks: TrackHistory[] }>('/tracks?history=full');
    return payload.tracks;
  }

  async reports(): Promise<FieldReport[]> {
    const payload = await this.request<{ reports: FieldReport[] }>('/reports');
    return payload.reports;
  }

  async alerts(): Promise<Alert[]> {
    const payload = await this.request<{ alerts: Alert[] }>('/alerts');
    return payload.alerts;
  }

  /**
   * NEEDS-BACKEND: PLAN 5.4 splits this across GET /images/{id},
   * GET /images/{id}/detections and GET /tracks. One frame view needs all of it
   * at once, so a GET /frames/{id} that returns the `ImageAnalysis` the pipeline
   * already builds would save three round trips per frame click.
   */
  async frame(imageId: string): Promise<FrameDetail> {
    return this.request<FrameDetail>(`/frames/${encodeURIComponent(imageId)}`);
  }

  imageUrl(imageId: string): string {
    return `${this.opts.baseUrl}/images/${encodeURIComponent(imageId)}`;
  }

  /**
   * Stream the evaluation from POST /agents/assess/{image_id}.
   *
   * The server streams newline-delimited JSON, one object per step, so the step
   * list fills with the server's own measured timings and the real tool calls
   * the agent made. This is why `assess` is an async iterable on the port: a
   * live GLM call takes 10-15 seconds at low reasoning effort (PLAN 6.11), and
   * an operator watching a blank panel for that long assumes it has hung.
   */
  async *assess(imageId: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    let response: Response;
    try {
      response = await fetch(
        `${this.opts.baseUrl}/agents/assess/${encodeURIComponent(imageId)}`,
        {
          method: 'POST',
          signal,
          headers: {
            accept: 'application/x-ndjson',
            ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
          },
        },
      );
    } catch {
      yield { type: 'error', message: `${imageId} değerlendirilemedi` };
      return;
    }

    if (!response.ok || !response.body) {
      yield {
        type: 'error',
        message: `${imageId} değerlendirilemedi (HTTP ${response.status})`,
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          yield JSON.parse(line) as AgentEvent;
        } catch {
          // A partial or malformed line is skipped rather than failing the run:
          // the agent is never on the critical path (PLAN principle 2).
        }
      }
    }
  }

  async ask(question: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.request<{ answer: string }>('/agents/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
      signal,
    });
    return payload.answer;
  }

  async budget(): Promise<AgentBudget | null> {
    return this.request<AgentBudget>('/agents/budget');
  }

  /**
   * Record a decision through the ack/dismiss endpoints, which require a reason
   * and write an audit event (PLAN 5.4, 7.4).
   *
   * NEEDS-BACKEND: those endpoints are per alert, while the wireframe's decision
   * is per frame -- an operator confirms "this frame is a threat", not one alert
   * at a time. A POST /frames/{id}/decision that fans out to the frame's alerts
   * would match the screen; until then the caller passes the frame and the
   * server decides the fan-out.
   */
  async record(decision: Decision): Promise<Decision> {
    return this.request<Decision>(
      `/frames/${encodeURIComponent(decision.image_id)}/decision`,
      { method: 'POST', body: JSON.stringify(decision) },
    );
  }

  async decisions(): Promise<Decision[]> {
    const payload = await this.request<{ decisions: Decision[] }>('/decisions');
    return payload.decisions;
  }
}

export type { AgentStep, Brief };
