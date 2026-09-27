/* The real adapter, the real exported data, the real component tree.
 *
 * `App.test.tsx` proves the shell works against a fake adapter. This proves it
 * works against the engine's actual output: 226 track histories, 149 alerts, 137
 * reports and a 127 KB frame payload, assembled into a brief and rendered. It is
 * the closest thing to opening the page that can run without a browser, and it is
 * what catches a field the export renames or a shape the domain layer assumed.
 *
 * `fetch` is shimmed onto the filesystem because jsdom has no server. Nothing else
 * is substituted -- `FixtureApi` is the adapter the browser uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { FixtureApi } from './fixture';
import { setApi } from './index';
import { assembleBrief } from '@/domain/brief';
import type { FrameDetail, TrackHistory } from '@/domain/types';

const DIR = join(__dirname, '..', '..', 'public', 'fixtures');
const present = existsSync(join(DIR, 'dataset.json'));
const suite = present ? describe : describe.skip;

/** Serve `fixtures/<path>` out of `public/fixtures`, as the dev server does. */
function fileFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : String(input);
  const relative = url.replace(/^fixtures\//, '');
  const path = join(DIR, relative);

  if (!existsSync(path)) {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
  if (path.endsWith('.json')) {
    return Promise.resolve(
      new Response(readFileSync(path, 'utf-8'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(new Response(new Uint8Array(readFileSync(path)), { status: 200 }));
}

suite('FixtureApi against the exported data', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(fileFetch));
    setApi(new FixtureApi());
  });

  afterEach(() => {
    cleanup();
    setApi(null);
    vi.unstubAllGlobals();
  });

  it('loads the whole boot payload through the port', async () => {
    const client = new FixtureApi();
    const [dataset, tracks, reports, alerts] = await Promise.all([
      client.dataset(),
      client.tracks(),
      client.reports(),
      client.alerts(),
    ]);

    expect(dataset.frames).toHaveLength(40);
    expect(tracks).toHaveLength(226);
    expect(reports).toHaveLength(137);
    expect(alerts).toHaveLength(158);
  });

  it('assembles a brief for every one of the 40 frames without throwing', async () => {
    // The brief is the most derived thing in the app; running it over all 40
    // frames exercises the empty frame, the untracked-detection frame and the
    // contradicting-report frame without having to know which is which.
    const client = new FixtureApi();
    const dataset = await client.dataset();
    const tracks = await client.tracks();
    const histories = new Map<string, TrackHistory>(tracks.map((t) => [t.track_id, t]));

    let withLead = 0;
    for (const summary of dataset.frames) {
      const frame: FrameDetail = await client.frame(summary.image_id);
      const brief = assembleBrief(frame, {
        zones: dataset.zones,
        histories,
        stationaryDispM: dataset.thresholds.stationary_disp_m,
        originIso: dataset.origin_ts,
      });

      expect(brief.headline.length).toBeGreaterThan(0);
      expect(brief.findings.length).toBeGreaterThan(0);
      expect(brief.source).toBe('rules');
      // The score on the card must be the one the engine put on the alert.
      if (brief.lead) {
        withLead += 1;
        expect(brief.score).toBe(brief.lead.alert.breakdown.score);
        const sum = (brief.breakdown?.terms ?? []).reduce((t, term) => t + term.points, 0);
        expect(sum).toBe(brief.score);
      }
    }
    expect(withLead).toBeGreaterThan(30);
  });

  it('caches a frame instead of refetching it', async () => {
    const client = new FixtureApi();
    await client.frame('img_008333');
    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await client.frame('img_008333');
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });

  it('refuses a copilot question rather than inventing an answer', async () => {
    // With no gateway there is nothing to ask, and fabricating a reply would put
    // words in the agent's mouth -- exactly what the guardrails exist to prevent.
    await expect(new FixtureApi().ask('T0062 neden uyarı verdi?')).rejects.toThrow();
  });

  it('boots the app and draws the real zones on the map', async () => {
    render(<App />);
    await waitFor(
      () => expect(screen.getByRole('img', { name: /Bölge haritası/ })).toBeTruthy(),
      { timeout: 5000 },
    );

    const map = screen.getByRole('img', { name: /Bölge haritası/ });
    // The eight ASCII-folded names from zones.json, at their measured bearings.
    for (const name of [
      'Kuzey Yolu',
      'Kuzeydogu Kavsagi',
      'Dogu Yolu',
      'Guneydogu Yerlesimi',
      'Guney Kapisi Yaklasimi',
      'Guneybati Yolu',
      'Bati Yerlesimi',
      'Kuzeybati Yolu',
    ]) {
      expect(map.textContent, `map is missing ${name}`).toContain(name);
    }
    expect(map.textContent).toContain('MERKEZ US');
  });

  it('shows the real frame warning through a selected vehicle', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('img', { name: /Bölge haritası/ })).toBeTruthy(), {
      timeout: 5000,
    });
    fireEvent.click(screen.getByRole('button', { name: /T0062, / }));
    await act(async () => { screen.getByRole('button', { name: 'Uyarıyı incele' }).click(); });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy(), {
      timeout: 5000,
    });
    // T0062 is a truck 2.73 km out that closed on the base in the last hour: a
    // possible approach (WATCH), in the Kuzeydogu Kavsagi observation sector.
    const modal = screen.getByRole('alertdialog');
    expect(modal.textContent).toContain('İNSAN İNCELEMESİ GEREKMEKTE');
    expect(modal.textContent).toContain('ŞÜPHELİ');
    expect(modal.textContent).toContain('Kuzeydogu Kavsagi');
  });
});
