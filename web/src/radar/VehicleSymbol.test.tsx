import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { VehicleSymbol } from './VehicleSymbol';
import type { VehicleClass } from '@/domain/types';

afterEach(cleanup);

it('araç türünü şekil ve uyarı düzeyini renk ile gösterir', () => {
  const cases: [VehicleClass, string, string][] = [
    ['car', 'rect', 'var(--risk-safe)'],
    ['van', 'polygon', 'var(--risk-review)'],
    ['truck', 'polygon', 'var(--risk-threat)'],
    ['bus', 'circle', 'var(--risk-safe)'],
  ];
  for (const [cls, shape, fill] of cases) {
    const level = cls === 'van' ? 'WATCH' : cls === 'truck' ? 'ALERT' : 'CLEAR';
    const view = render(<svg><VehicleSymbol x={20} y={20} cls={cls} level={level} size={5} /></svg>);
    expect(view.container.querySelector(`[data-vehicle-class="${cls}"] ${shape}`)).toBeTruthy();
    expect(view.container.querySelector(`[data-vehicle-class="${cls}"]`)?.getAttribute('fill')).toBe(fill);
    view.unmount();
  }
});
