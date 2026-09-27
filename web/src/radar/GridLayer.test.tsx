import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { projectionFor } from '@/domain/polar';
import { GridLayer } from './GridLayer';

it('shows the 1, 2 and 3.2 km base rings at the default scale', () => {
  const markup = renderToStaticMarkup(<svg><GridLayer projection={projectionFor(8)} /></svg>);
  expect(markup).toContain('1 km');
  expect(markup).toContain('2 km');
  expect(markup).toContain('3.2 km');
});
