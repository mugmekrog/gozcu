import { useState } from 'react';
import type { Alert, Decision } from '@/domain/types';

interface Props {
  imageId: string;
  alerts: Alert[];
  decisions: Decision[];
  onDecide: (kind: Decision['target_kind'], trackId: string,
    verdict: Decision['verdict'], reason: string, operator: string) => Promise<void>;
}

export function ScenarioPanel({ imageId, alerts, decisions, onDecide }: Props) {
  const [operator, setOperator] = useState(() => globalThis.localStorage?.getItem('goru.operator') ?? '');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(kind: Decision['target_kind'], trackId: string, verdict: Decision['verdict']) {
    const reason = reasons[trackId]?.trim() ?? '';
    if (!operator.trim() || !reason) return;
    setPending(trackId);
    setError(null);
    try {
      await onDecide(kind, trackId, verdict, reason, operator);
      setReasons((current) => ({ ...current, [trackId]: '' }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Karar kaydedilemedi');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel" aria-label="Senaryolar">
      <h2 className="panel__head">Senaryolar</h2>
      <div className="brief__body">
        <label>Operatör kimliği
          <input className="input" value={operator} onChange={(event) => {
            setOperator(event.target.value);
            globalThis.localStorage?.setItem('goru.operator', event.target.value);
          }} />
        </label>
        {alerts.length === 0 && <p className="muted">Bu karede izlenecek alarm yok.</p>}
        {alerts.map((alert) => {
          const relevant = [...decisions].reverse().filter((decision) =>
            decision.image_id === imageId &&
            decision.target_id === alert.track_id);
          const latestScenario = relevant.find((decision) => decision.target_kind === 'scenario');
          const latestAlert = relevant.find((decision) => decision.target_kind === 'alert');
          const ready = Boolean(operator.trim() && reasons[alert.track_id]?.trim()) && pending === null;
          return (
            <div className="brief__section" key={alert.alert_id}>
              <h3>{alert.track_id} · {alert.level}</h3>
              <p>{alert.reasons.join(' · ') || 'Alarm gerekçesi bulunmuyor'}</p>
              {latestScenario && <p className="muted">Senaryo kararı: {latestScenario.verdict} · {latestScenario.operator}</p>}
              {latestAlert && <p className="muted">Kart kararı: {latestAlert.verdict} · {latestAlert.operator}</p>}
              <label>Karar gerekçesi
                <input className="input" value={reasons[alert.track_id] ?? ''}
                  onChange={(event) => setReasons((current) => ({ ...current, [alert.track_id]: event.target.value }))} />
              </label>
              <div>
                <span>Senaryo: </span>
                <button className="btn" disabled={!ready} onClick={() => void decide('scenario', alert.track_id, 'watch')}>İzlemeye al</button>
                <button className="btn" disabled={!ready} onClick={() => void decide('scenario', alert.track_id, 'invalid')}>Geçersiz</button>
                <button className="btn" disabled={!ready} onClick={() => void decide('scenario', alert.track_id, 'verified')}>Doğrulandı</button>
              </div>
              <div>
                <span>Tehdit kartı: </span>
                <button className="btn" disabled={!ready} onClick={() => void decide('alert', alert.track_id, 'confirmed')}>Tehdidi onayla</button>
                <button className="btn" disabled={!ready} onClick={() => void decide('alert', alert.track_id, 'false_alarm')}>Yanlış alarm</button>
              </div>
            </div>
          );
        })}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
