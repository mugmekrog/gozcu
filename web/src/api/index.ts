/* Which adapter this build talks to.
 *
 * Local development talks to the live REST API. Production builds use the
 * configured API URL; without one they retain the static fixture adapter.
 */

import { FixtureApi } from './fixture';
import { HttpApi } from './http';
import type { GoruApi } from './port';

let current: GoruApi | null = null;

export function api(): GoruApi {
  if (current) return current;
  const baseUrl = import.meta.env.VITE_API_BASE_URL ||
    (import.meta.env.DEV ? 'http://127.0.0.1:8080' : undefined);
  current = baseUrl
    ? new HttpApi({ baseUrl, token: import.meta.env.VITE_API_TOKEN })
    : new FixtureApi();
  return current;
}

/** Tests and Storybook substitute an adapter here. */
export function setApi(adapter: GoruApi | null): void {
  current = adapter;
}

export { FixtureApi, HttpApi };
export type { AgentBudget, AgentEvent, AgentStep, GoruApi } from './port';
export { ApiError } from './port';
