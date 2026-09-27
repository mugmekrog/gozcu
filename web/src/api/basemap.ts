/* The basemap file, shared by both adapters.
 *
 * The city under the radar is not engine output: it is OpenStreetMap, baked by
 * `web/scripts/export_basemap.py` into the web app's own static assets. So
 * whichever adapter is serving the data, the map comes from the same place --
 * the app's origin, never the API and never a tile server, which is what keeps
 * it working with the network off (PLAN F4.3).
 *
 * A missing or unreadable file is not an error. The radar draws on its plain
 * ground exactly as it did before the basemap existed.
 */

import type { BasemapFile } from '@/domain/basemap';

export const BASEMAP_PATH = 'basemap/ankara.json';

export async function loadBasemap(signal?: AbortSignal): Promise<BasemapFile | null> {
  try {
    const response = await fetch(BASEMAP_PATH, { signal });
    if (!response.ok) return null;
    const file = (await response.json()) as BasemapFile;
    return file.version === 1 ? file : null;
  } catch {
    return null;
  }
}
