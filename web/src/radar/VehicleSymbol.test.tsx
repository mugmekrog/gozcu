import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { VehicleSymbol } from './VehicleSymbol';
import type { Level, VehicleClass } from '@/domain/types';

afterEach(cleanup);

const draw = (cls: VehicleClass | null, level: Level | null) =>
  render(<svg><VehicleSymbol x={20} y={20} cls={cls} level={level} size={8} /></svg>).container;

it('uyarı düzeyini APP-6 çerçevesi, araç türünü içindeki simge taşır', () => {
  // Level is shape as well as colour, so it survives a colour-blind reviewer.
  const frames: [Level | null, string][] = [
    ['ALERT', 'diamond'],
    ['WATCH', 'quatrefoil'],
    ['CLEAR', 'square'],
    [null, 'pending'],
  ];
  for (const [level, frame] of frames) {
    const view = draw('car', level);
    expect(view.querySelector(`[data-frame="${frame}"]`)).toBeTruthy();
    cleanup();
  }
});

it('aynı çerçevede farklı araç türleri farklı simge çizer', () => {
  const seen = new Set<string>();
  for (const cls of ['car', 'van', 'truck', 'bus'] as VehicleClass[]) {
    const icon = draw(cls, 'CLEAR').querySelector('.vehicle-symbol__icon')?.getAttribute('d');
    expect(icon).toBeTruthy();
    seen.add(icon!);
    cleanup();
  }
  expect(seen.size).toBe(4);
});

it('sınıfı bilinmeyeni soru işaretiyle, çizili değil konturlu çizer', () => {
  const icon = draw(null, 'CLEAR').querySelector('.vehicle-symbol__icon');
  expect(icon?.getAttribute('fill')).toBe('none');
  expect(icon?.getAttribute('stroke')).toBeTruthy();
});

it('değerlendirilmemiş aracı kesik çizgili halka ile çizer', () => {
  const frame = draw('bus', null).querySelector('.vehicle-symbol__frame');
  expect(frame?.tagName.toLowerCase()).toBe('circle');
  expect(frame?.getAttribute('stroke-dasharray')).toBeTruthy();
});
