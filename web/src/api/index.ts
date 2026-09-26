/* Which adapter this build talks to.
 *
 * Fixtures by default, because that is what works with the network off and what
 * exists today. Setting `VITE_API_BASE_URL` switches the whole app onto the live
 * REST API without touching a screen -- which is the point of the seam.
 */

import { FixtureApi } from './fixture';
import { HttpApi } from './http';
import type { GoruApi } from './port';

let current: GoruApi | null = null;

export function api(): GoruApi {
  if (current) return current;
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
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
