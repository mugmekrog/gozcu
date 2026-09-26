/* A smoke test over the whole shell, driven through the data seam.
 *
 * This is the test the seam was built for. A fake adapter satisfies `GoruApi`, so
 * the app boots, renders the radar, runs an evaluation and records a decision
 * without a server, a network or a fixture file -- and any runtime error anywhere
 * in the component tree fails here rather than in front of a judge.
 *
 * It also pins the two behaviours that are easy to break by accident: a frame with
 * no vehicles must not raise a modal, and an ALERT must.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { setApi } from './api';
import { FakeApi } from './test/fake-api';

let fake: FakeApi;

beforeEach(() => {
  fake = new FakeApi();
  setApi(fake);
});

afterEach(() => {
  cleanup();
  setApi(null);
});

describe('App', () => {
  it('boots and renders the map, the timeline and the agent column', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole('img', { name: /Bölge haritası/ })).toBeTruthy());

    // The map names the base and the zone it was given.
    const map = screen.getByRole('img', { name: /Bölge haritası/ });
    expect(map.textContent).toContain('MERKEZ US');
    expect(map.textContent).toContain('Dogu Yolu');

    // The agent column is present and idle.
    expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy();
    expect(screen.getByText(/Kare seçip Değerlendir/)).toBeTruthy();

    // The clock opens on the first frame's capture time, not at 08:10, so the
    // display is not an empty field of not-yet-assessed dots.
    expect(document.body.textContent).toContain('14:10');
  });

  it('marks the frame unassessed until an evaluation runs', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy());
    expect(screen.getByText('DEĞERLENDİRİLMEDİ')).toBeTruthy();
  });

  it('runs an evaluation, fills the brief and raises the threat modal', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: /Değerlendir/ }).click();
    });

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    const modal = screen.getByRole('alertdialog');
    expect(modal.textContent).toContain('KRİTİK TEHDİT ALGILANDI');
    // The score and its breakdown are the engine's, and both must be on screen.
    expect(document.body.textContent).toContain('78');
    expect(document.body.textContent).toContain('kural tabanlı');
  });

  it('records a decision and shows it in the log', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: /Değerlendir/ }).click();
    });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: 'Tehdidi onayla ve bildir' }).click();
    });

    await waitFor(() => expect(fake.recorded).toHaveLength(1));
    expect(fake.recorded[0]!.verdict).toBe('confirmed');
    expect(fake.recorded[0]!.image_id).toBe('img_0001');
    expect(fake.recorded[0]!.agent_level).toBe('ALERT');
    // The modal closes and the confirmation names what was recorded, with a route
    // to the log entry it created.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText(/Operatör kararı kaydedildi/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kayda git' })).toBeTruthy();
  });

  it('does not raise a modal for a frame with no vehicles', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: /Değerlendir/ }).click();
    });
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await act(async () => {
      screen.getByRole('button', { name: /Uyarıyı kapat/ }).click();
    });

    // Switch to the empty frame and evaluate it.
    const picker = screen.getByLabelText('Hedef kare') as HTMLSelectElement;
    await act(async () => {
      picker.value = 'img_0002';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole('button', { name: /Değerlendir/ }).click();
    });

    await waitFor(() => expect(screen.getByText('ARAÇ YOK')).toBeTruthy());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.body.textContent).toContain('Bu karede araç tespit edilmedi');
  });

  it('switches views without losing the agent column', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy());

    await act(async () => {
      screen.getByRole('button', { name: /Görünüm menüsünü aç/ }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: /Hareket/ }).click();
    });

    expect(screen.getByText('ÜSSE MESAFE – ZAMAN')).toBeTruthy();
    expect(screen.getByText('AGENT OUTPUTS')).toBeTruthy();
  });

  it('disables the copilot when no gateway is configured', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('AJANA SOR')).toBeTruthy());
    const input = screen.getByLabelText('AJANA SOR') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toContain('kural tabanlı');
  });
});
