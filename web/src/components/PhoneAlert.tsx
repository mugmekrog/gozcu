/* The operator's phone, sliding in over the map when a vehicle goes critical.
 *
 * A presentation device for the mobile push the system would send: when a
 * vehicle on the map reaches ALERT at the sim clock, a lock screen slides in
 * from the right with one notification per vehicle, naming the zone it is
 * closing on. It is driven by the same live set as the map, so scrubbing past
 * a frame's capture time raises it and scrubbing back before it takes it away.
 *
 * Each vehicle is announced once per stretch of being critical. The phone
 * stays up for a few seconds once its cards have landed, then fades away on its
 * own; closing it early does the same with a slide. It comes back only when a
 * new vehicle goes critical. Tapping a notification selects that vehicle.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { classLabel } from '@/domain/strings';
import { alertMessage } from '@/domain/notify';
import * as fmt from '@/domain/format';
import type { LiveVehicle } from '@/domain/live';
import './phone-alert.css';

export interface PhoneAlertProps {
  /** Vehicles at ALERT right now, ignoring the map's filters. */
  critical: readonly LiveVehicle[];
  /** Lock-screen clock and date, from the sim clock. */
  clock: string;
  date: string;
  enabled: boolean;
  onSelect: (trackId: string) => void;
}

interface Note {
  trackId: string;
  message: string;
  meta: string;
  at: string;
}

type Phase = 'hidden' | 'in' | 'out' | 'fade';

/** How many cards the lock screen shows before collapsing into "+N". */
const MAX_CARDS = 3;

/** The slide-in and the card drop finish by here (see phone-alert.css). */
const ARRIVE_MS = 1_040;
/** How long the phone stays fully visible before it fades out. */
const VISIBLE_MS = 3_000;
/** Exit animation lengths, matching phone-alert.css. */
const EXIT_MS = { out: 420, fade: 900 } as const;

function noteFor(vehicle: LiveVehicle, at: string): Note {
  const alert = vehicle.alert;
  const parts = [vehicle.trackId];
  if (vehicle.cls) parts.push(classLabel(vehicle.cls));
  if (alert?.dist_now_m != null) parts.push(fmt.km(alert.dist_now_m));
  if (alert?.eta_entry_s != null) parts.push(`ETA ${fmt.eta(alert.eta_entry_s)}`);
  return {
    trackId: vehicle.trackId,
    message: alertMessage(alert?.zone_name ?? null),
    meta: parts.join(' · '),
    at,
  };
}

export const PhoneAlert = memo(function PhoneAlert({
  critical,
  clock,
  date,
  enabled,
  onSelect,
}: PhoneAlertProps) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [notes, setNotes] = useState<Note[]>([]);
  const announced = useRef(new Set<string>());
  const clockRef = useRef(clock);
  clockRef.current = clock;

  // Switching the phone back on re-announces whatever is critical right now,
  // so the presenter can bring it back on cue.
  useEffect(() => {
    announced.current = new Set();
    if (!enabled) {
      setPhase((p) => (p === 'in' ? 'out' : p));
    }
  }, [enabled]);

  const key = critical.map((v) => v.trackId).join(',');
  useEffect(() => {
    if (!enabled) return;
    const current = new Set(critical.map((v) => v.trackId));
    const fresh = critical.filter((v) => !announced.current.has(v.trackId));
    announced.current = current;

    // Drop cards for vehicles that are no longer critical (the clock went back).
    setNotes((prev) => {
      const kept = prev.filter((n) => current.has(n.trackId));
      // Never two cards for one vehicle, however often this effect re-runs.
      const added = fresh
        .filter((v) => !kept.some((n) => n.trackId === v.trackId))
        .map((v) => noteFor(v, clockRef.current));
      return added.length || kept.length !== prev.length ? [...added.reverse(), ...kept] : prev;
    });

    if (fresh.length > 0) setPhase('in');
    else if (current.size === 0) setPhase((p) => (p === 'in' ? 'out' : p));
    // `key` stands in for `critical`, which is a new array on every clock tick.
  }, [key, enabled]);

  // Fade out a few seconds after the last card landed; a new card restarts it.
  useEffect(() => {
    if (phase !== 'in') return;
    const timer = window.setTimeout(() => setPhase('fade'), ARRIVE_MS + VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [phase, notes]);

  // Unmount once the exit animation has run. A timer rather than
  // `animationend`, which never fires while the tab is in the background.
  useEffect(() => {
    if (phase !== 'out' && phase !== 'fade') return;
    const timer = window.setTimeout(() => {
      setPhase('hidden');
      setNotes([]);
    }, EXIT_MS[phase]);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === 'hidden') return null;

  const shown = notes.slice(0, MAX_CARDS);
  const more = notes.length - shown.length;

  return (
    <div
      className={`phone phone--${phase}`}
      role="region"
      aria-label="Mobil bildirim önizlemesi"
    >
      <button
        type="button"
        className="phone__close"
        onClick={() => setPhase('out')}
        aria-label="Telefonu kapat"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>

      <div className="phone__device">
        <div className="phone__frame">
          <span className="phone__button phone__button--action" aria-hidden="true" />
          <span className="phone__button phone__button--up" aria-hidden="true" />
          <span className="phone__button phone__button--down" aria-hidden="true" />
          <span className="phone__button phone__button--power" aria-hidden="true" />

          <div className="phone__screen">
            <div className="phone__status" aria-hidden="true">
              <span className="phone__signal">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="phone__island" />
              <span className="phone__battery">
                <i />
              </span>
            </div>

            <div className="phone__lock">
              <span className="phone__lock-icon" aria-hidden="true" />
              <p className="phone__date">{date}</p>
              <p className="phone__clock">{clock}</p>
            </div>

            <ul className="phone__notes" aria-live="assertive">
              {shown.map((note) => (
                <li key={note.trackId}>
                  <button
                    type="button"
                    className="phone__note"
                    onClick={() => onSelect(note.trackId)}
                  >
                    <span className="phone__app-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path
                          d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                        <circle cx="12" cy="12" r="3.2" fill="currentColor" />
                      </svg>
                    </span>
                    <span className="phone__note-text">
                      <span className="phone__note-head">
                        <b>GÖZCÜ · Kritik uyarı</b>
                        <span>{note.at}</span>
                      </span>
                      <span className="phone__note-body">{note.message}</span>
                      <span className="phone__note-meta">{note.meta}</span>
                    </span>
                  </button>
                </li>
              ))}
              {more > 0 && <li className="phone__more">+{more} bildirim daha</li>}
            </ul>

            <div className="phone__dock" aria-hidden="true">
              <span className="phone__dock-btn">
                <svg viewBox="0 0 24 24">
                  <path d="M9 2h6l-1 6h-4L9 2Zm1 7h4v11a2 2 0 0 1-4 0V9Z" fill="currentColor" />
                </svg>
              </span>
              <span className="phone__dock-btn">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M4 8h3l2-3h6l2 3h3v11H4V8Zm8 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </div>
            <span className="phone__home" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
});
