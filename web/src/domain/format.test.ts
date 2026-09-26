import { describe, expect, it } from 'vitest';
import * as fmt from './format';

describe('distance', () => {
  it('uses metres below a kilometre and a decimal comma above it', () => {
    expect(fmt.distance(514.8)).toBe('515 m');
    expect(fmt.distance(1570)).toBe('1,57 km');
  });

  it('prints an em dash rather than a zero for a missing figure', () => {
    // A missing measurement and a measurement of zero mean different things.
    expect(fmt.distance(null)).toBe('—');
    expect(fmt.distance(undefined)).toBe('—');
    expect(fmt.distance(Number.NaN)).toBe('—');
    expect(fmt.distance(0)).toBe('0 m');
  });
});

describe('eta', () => {
  it('rounds to whole minutes and flags the approximation', () => {
    expect(fmt.eta(360)).toBe('~6 dk');
    expect(fmt.eta(80.3)).toBe('~1 dk');
  });

  it('collapses under a minute rather than printing ~0', () => {
    expect(fmt.eta(30)).toBe('<1 dk');
  });

  it('shows nothing when there is no entry time', () => {
    expect(fmt.eta(null)).toBe('—');
  });
});

describe('speed', () => {
  it('prints one decimal with a comma', () => {
    expect(fmt.speed(6.55)).toBe('6,6 m/s');
    expect(fmt.speed(0)).toBe('0,0 m/s');
  });
});

describe('clockOf and minutesOf', () => {
  const origin = '2026-09-26T05:10:00+00:00'; // 08:10 Istanbul

  it('converts minutes from the origin to the Istanbul exercise clock', () => {
    // The capture times in the data are local: the first frame is 10:10, not 07:10.
    expect(fmt.clockOf(origin, 0)).toBe('08:10');
    expect(fmt.clockOf(origin, 120)).toBe('10:10');
    expect(fmt.clockOf(origin, 460)).toBe('15:50');
  });

  it('round-trips against minutesOf', () => {
    expect(fmt.minutesOf(origin, '08:10')).toBe(0);
    const minutes = fmt.minutesOf(origin, '10:10');
    expect(minutes).toBe(120);
    expect(fmt.clockOf(origin, minutes)).toBe('10:10');
  });
});

describe('signed', () => {
  it('keeps the plus sign on a positive contribution', () => {
    // The score breakdown reads as a sum, so every term needs its sign.
    expect(fmt.signed(20)).toBe('+20');
    expect(fmt.signed(0)).toBe('+0');
    expect(fmt.signed(-3)).toBe('-3');
  });
});

describe('percent', () => {
  it('uses the Turkish leading percent sign', () => {
    expect(fmt.percent(0.91)).toBe('%91');
    expect(fmt.percent(null)).toBe('—');
  });
});

describe('heading', () => {
  it('names the compass point in Turkish alongside the figure', () => {
    expect(fmt.heading(0)).toBe('K 0°');
    expect(fmt.heading(90)).toBe('D 90°');
    expect(fmt.heading(225)).toBe('GB 225°');
    expect(fmt.heading(359)).toBe('K 359°');
  });
});
