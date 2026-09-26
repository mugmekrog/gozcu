/* The simulation clock.
 *
 * One rAF loop for the whole app. It advances the store's `tMin` by real elapsed
 * time times the sim speed, which keeps playback smooth at any frame rate and
 * makes a dropped frame cost nothing -- the next tick simply covers more sim
 * minutes rather than the clock falling behind.
 *
 * PLAN F3.5 asks for no frame drops at high speed. The loop writes the store at
 * most every `MIN_WRITE_MS`, because at 300x a per-frame write asks the map to
 * re-project 226 tracks 60 times a second to show motion the eye reads as smooth
 * at 15. Interpolation between writes is the map's job, not the clock's.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from './useAppStore';

/** ~15 store writes a second while playing. */
const MIN_WRITE_MS = 66;

export function useSimClock(): void {
  const playing = useAppStore((s) => s.playing);
  const speed = useAppStore((s) => s.speed);
  const frame = useRef<number | null>(null);
  const last = useRef<number>(0);
  const carried = useRef<number>(0);

  useEffect(() => {
    if (!playing) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      carried.current = 0;
      return;
    }

    last.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - last.current;
      carried.current += elapsed;
      last.current = now;

      if (carried.current >= MIN_WRITE_MS) {
        // Sim minutes covered = real seconds elapsed x speed / 60.
        const simMinutes = (carried.current / 1000) * (speed / 60);
        carried.current = 0;
        useAppStore.getState().advance(simMinutes);
      }

      if (useAppStore.getState().playing) frame.current = requestAnimationFrame(tick);
      else frame.current = null;
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [playing, speed]);
}
