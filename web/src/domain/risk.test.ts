import { describe, expect, it } from 'vitest';
import { bandOf, CRITICAL_SCORE, modalFor, riskRank, riskStyle, shapeOf, styleOf } from './risk';
import type { RiskBand } from './risk';

const ALL: RiskBand[] = ['critical', 'high', 'review', 'low', 'unassessed', 'empty'];

describe('bandOf', () => {
  it('splits ALERT at the critical score', () => {
    expect(bandOf('ALERT', CRITICAL_SCORE)).toBe('critical');
    expect(bandOf('ALERT', CRITICAL_SCORE - 1)).toBe('high');
  });

  it('maps WATCH and CLEAR straight through', () => {
    expect(bandOf('WATCH', 99)).toBe('review');
    expect(bandOf('CLEAR', 99)).toBe('low');
  });

  it('treats a missing level as unassessed, never as safe', () => {
    // "Not judged yet" and "judged and found harmless" are different claims, and
    // collapsing them would let the map imply an assessment that never happened.
    expect(bandOf(null)).toBe('unassessed');
    expect(bandOf(null)).not.toBe('low');
  });
});

describe('riskStyle', () => {
  it('gives every band a distinct shape or an explicit non-shape', () => {
    const shapes = ALL.map((band) => riskStyle(band).shape);
    expect(shapes).toEqual(['triangle', 'triangle', 'circle', 'square', 'none', 'none']);
  });

  it('never encodes a level by colour alone', () => {
    // The accessibility requirement from PLAN 7.3.1: the three levels that carry a
    // risk must differ in shape, not only in hue.
    const risky = ['critical', 'review', 'low'] as const;
    const shapes = new Set(risky.map((band) => riskStyle(band).shape));
    const glyphs = new Set(risky.map((band) => riskStyle(band).glyph));
    expect(shapes.size).toBe(3);
    expect(glyphs.size).toBe(3);
  });

  it('distinguishes critical from high by fill, not by hue', () => {
    expect(riskStyle('critical').color).toBe(riskStyle('high').color);
    expect(riskStyle('critical').filled).toBe(true);
    expect(riskStyle('high').filled).toBe(false);
  });
});

describe('shapeOf and styleOf', () => {
  it('agree with each other', () => {
    expect(shapeOf('ALERT')).toBe(styleOf('ALERT', 99).shape);
    expect(shapeOf('WATCH')).toBe(styleOf('WATCH').shape);
    expect(shapeOf(null)).toBe(styleOf(null).shape);
  });
});

describe('riskRank', () => {
  it('orders worst first when sorted descending', () => {
    const sorted = ['CLEAR', 'ALERT', null, 'WATCH'].sort(
      (a, b) => riskRank(b as never) - riskRank(a as never),
    );
    expect(sorted).toEqual(['ALERT', 'WATCH', 'CLEAR', null]);
  });
});

describe('modalFor', () => {
  it('always interrupts for an ALERT', () => {
    expect(modalFor('ALERT')).toBe('threat');
  });

  it('asks the operator only when the agent and the rules disagree', () => {
    expect(modalFor('WATCH', { agentDisagrees: true })).toBe('review');
    expect(modalFor('WATCH', { agentDisagrees: false })).toBeNull();
  });

  it('never interrupts for CLEAR', () => {
    expect(modalFor('CLEAR', { agentDisagrees: true })).toBeNull();
  });
});
