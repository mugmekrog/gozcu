import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Alert } from '@/domain/types';
import { ScenarioPanel } from './ScenarioPanel';

it('requires a named operator and reason for each decision', async () => {
  const onDecide = vi.fn().mockResolvedValue(undefined);
  const alert = {
    alert_id: 'A-img_000860-T0001', track_id: 'T0001', level: 'WATCH', reasons: ['zone approach'],
  } as Alert;
  render(<ScenarioPanel imageId="img_000860" alerts={[alert]} decisions={[]} onDecide={onDecide} />);
  const watch = screen.getByRole('button', { name: 'İzlemeye al' }) as HTMLButtonElement;
  expect(watch.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Operatör kimliği'), { target: { value: 'operator-1' } });
  expect(watch.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Karar gerekçesi'), { target: { value: 'Yaklaşma sürdü' } });
  expect(watch.disabled).toBe(false);
  fireEvent.click(watch);
  await waitFor(() => expect(onDecide).toHaveBeenCalledWith(
    'scenario', 'T0001', 'watch', 'Yaklaşma sürdü', 'operator-1',
  ));
  fireEvent.change(screen.getByLabelText('Karar gerekçesi'), { target: { value: 'Görüntü ile teyit edildi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Tehdidi onayla' }));
  await waitFor(() => expect(onDecide).toHaveBeenCalledWith(
    'alert', 'T0001', 'confirmed', 'Görüntü ile teyit edildi', 'operator-1',
  ));
});
