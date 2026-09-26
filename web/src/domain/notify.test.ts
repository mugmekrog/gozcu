import { describe, expect, it } from 'vitest';
import { alertMessage, zoneDative } from './notify';

describe('zoneDative', () => {
  it.each([
    ['Kuzey Yolu', "Kuzey Yolu'na"],
    ['Kuzeydogu Kavsagi', "Kuzeydogu Kavsagi'na"],
    ['Dogu Yolu', "Dogu Yolu'na"],
    ['Guneydogu Yerlesimi', "Guneydogu Yerlesimi'ne"],
    ['Guney Kapisi Yaklasimi', "Guney Kapisi Yaklasimi'na"],
    ['Bati Yerlesimi', "Bati Yerlesimi'ne"],
    ['Merkez Üs', "Merkez Üs'e"],
  ])('%s -> %s', (name, expected) => {
    expect(zoneDative(name)).toBe(expected);
  });
});

describe('alertMessage', () => {
  it('names the zone the vehicle is closing on', () => {
    expect(alertMessage('Kuzey Yolu')).toBe(
      "Kuzey Yolu'na yaklaşan şüpheli bir araç tespit edildi!",
    );
  });

  it('falls back to the base when the alert names no zone', () => {
    expect(alertMessage(null)).toBe('Üsse yaklaşan şüpheli bir araç tespit edildi!');
  });
});
