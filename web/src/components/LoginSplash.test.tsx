import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginSplash, LOGIN_MS } from './LoginSplash';

afterEach(() => vi.useRealTimers());

describe('LoginSplash', () => {
  it('holds the sign-in for two seconds, then fades and gets out of the way', () => {
    vi.useFakeTimers();
    render(<LoginSplash />);
    expect(screen.getByText('Giriş yapılıyor')).toBeTruthy();

    // Still there a tick before the hold is up: the wait is the whole point.
    act(() => void vi.advanceTimersByTime(LOGIN_MS - 1));
    expect(document.querySelector('.login-splash[data-leaving]')).toBeNull();

    act(() => void vi.advanceTimersByTime(1));
    expect(document.querySelector('.login-splash[data-leaving]')).toBeTruthy();

    act(() => void vi.advanceTimersByTime(400));
    expect(document.querySelector('.login-splash')).toBeNull();
  });

  it('falls back to the wordmark when the logo file is not there', () => {
    vi.useFakeTimers();
    render(<LoginSplash />);
    const mark = screen.getByAltText('SUYLA') as HTMLImageElement;
    expect(mark.getAttribute('src')).toBe('/logo-suyla.jpg');

    act(() => void mark.dispatchEvent(new Event('error')));
    expect(screen.queryByAltText('SUYLA')).toBeNull();
    expect(screen.getByText('SUYLA')).toBeTruthy();
  });
});
