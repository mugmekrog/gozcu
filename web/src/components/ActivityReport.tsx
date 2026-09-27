/* The route report: one vehicle's movement history on one printable page.
 *
 * Laid out the way a fitness app lays out a run, because that layout already
 * answers the questions a report on a vehicle has to answer, in the order they
 * are asked: who and when (the header), what happened in one line (the
 * headline), where (the map), what matters most (the highlight), how much (the
 * figures), how it unfolded (the range chart, the half-hour splits, the events).
 *
 * Everything is "as of" the simulation clock. The activity is clipped there
 * (domain/activity.ts), the header says so, and the footer says where every
 * figure came from. "PDF olarak yazdır" is the browser's print dialog over a
 * print stylesheet that leaves only this sheet on the page -- no PDF library,
 * nothing fetched, so it works with the network off like the rest of the app.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { BasemapLabels, BasemapLayer, Attribution } from '@/radar/BasemapLayer';
import { BaseLayer, ZoneLayer } from '@/radar/ZoneLayer';
import { RouteLayer } from '@/radar/RouteLayer';
import { VehicleSymbol } from '@/radar/VehicleSymbol';
import { RangeChart, type ChartBand, type ChartLine } from './RangeChart';
import { LevelBadge } from './LevelBadge';
import { headlineOf, type Activity, type ActivityEvent } from '@/domain/activity';
import { visibleBox, type PreparedBasemap } from '@/domain/basemap';
import { fitView, projectionFor, VIEW } from '@/domain/polar';
import { bandOf } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import type { LiveVehicle } from '@/domain/live';
import type { Zone } from '@/domain/types';
import './activity-report.css';

export interface ActivityReportProps {
  activity: Activity;
  /** The vehicle as the map sees it now; null once it has left the map. */
  vehicle: LiveVehicle | null;
  zones: readonly Zone[];
  basemap: PreparedBasemap | null;
  originIso: string;
  baseName: string;
  onClose: () => void;
}

/** Height of the report map's window into the viewBox, in SVG units. */
const MAP_H = 380;
const NO_ALERTS: ReadonlySet<string> = new Set();

const DATE = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: fmt.EXERCISE_TZ,
});

export const ActivityReport = memo(function ActivityReport({
  activity,
  vehicle,
  zones,
  basemap,
  originIso,
  baseName,
  onClose,
}: ActivityReportProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const clock = (tMin: number) => fmt.clockOf(originIso, tMin);
  const level = vehicle?.level ?? null;
  const band = bandOf(level, vehicle?.score ?? 0);
  const headline = headlineText(activity, baseName, clock);
  const nearest = activity.zones[0] ?? null;

  const fit = useMemo(() => fitView(activity.box, { w: VIEW.w, h: MAP_H }), [activity.box]);
  const projection = useMemo(() => projectionFor(fit.scaleKm), [fit.scaleKm]);
  const view = visibleBox(projection, fit.pan, { x: 1.15, y: 1.15 });
  const shift = `translate(${-fit.pan.eKm * projection.unitsPerKm} ${fit.pan.nKm * projection.unitsPerKm})`;
  const end = activity.route[activity.route.length - 1];

  const chart = useMemo(() => {
    const points = activity.route.map((p) => ({ tMin: p.tMin, range_m: Math.hypot(p.e, p.n) }));
    const peak = Math.max(...points.map((p) => p.range_m), 1000);
    const line: ChartLine = {
      id: activity.trackId,
      label: activity.trackId,
      level,
      score: vehicle?.score ?? 0,
      points,
      emphasis: true,
    };
    const bands: ChartBand[] = activity.stops.map((stop) => ({
      fromMin: stop.fromMin,
      toMin: stop.toMin,
      label: T.motion.stopBand,
    }));
    return { line, bands, maxRangeM: Math.ceil((peak * 1.15) / 1000) * 1000 };
  }, [activity, level, vehicle?.score]);

  const highlight = highlightOf(vehicle, nearest, clock);

  return (
    <div className="activity-layer">
      <div className="activity__scrim" onClick={onClose} />
      <section
        className="activity"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
      >
        <header className="activity__bar">
          <p className="kicker">{T.report.kicker}</p>
          <div className="spacer" />
          <button type="button" className="btn btn--small btn--primary activity__print" onClick={() => window.print()}>
            {T.report.print}
          </button>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--small activity__close"
            onClick={onClose}
            aria-label={T.report.closeLabel}
          >
            {T.report.close}
          </button>
        </header>

        <div className="activity__body">
          <div className="activity__who">
            <div className="activity__id-row">
              <b className="activity__id">{activity.trackId}</b>
              <span className="activity__cls">{classLabel(activity.cls)}</span>
              <LevelBadge band={band} size="small" />
            </div>
            <p className="activity__when muted">
              {DATE.format(new Date(Date.parse(originIso) + activity.fromMin * 60_000))}
              {' · '}
              {clock(activity.fromMin)} → {clock(activity.toMin)}
              {' · '}
              {T.report.place}, {baseName}
              {' · '}
              <span className="activity__state" data-complete={activity.complete || undefined}>
                {activity.complete ? T.report.complete : T.report.ongoing}
              </span>
            </p>
          </div>

          <h2 id="activity-title" className="activity__title">{headline}</h2>

          <svg
            className="activity__map"
            viewBox={`0 ${VIEW.cy - MAP_H / 2} ${VIEW.w} ${MAP_H}`}
            preserveAspectRatio="xMidYMid slice"
            role="img"
            aria-label={`${activity.trackId} rotası, ${fmt.distance(activity.distanceM)}, ${clock(activity.fromMin)}–${clock(activity.toMin)}`}
          >
            <rect x={0} y={VIEW.cy - MAP_H / 2} width={VIEW.w} height={MAP_H} fill="var(--map-land)" />
            <g transform={shift}>
              {basemap && <BasemapLayer map={basemap} projection={projection} view={view} />}
              {basemap && (
                <BasemapLabels map={basemap} projection={projection} view={view} zones={zones} baseName={baseName} />
              )}
              <ZoneLayer zones={zones} projection={projection} alerting={NO_ALERTS} focus="all" />
              <BaseLayer name={baseName} />
              <RouteLayer
                route={activity.route}
                stops={activity.stops}
                projection={projection}
                originIso={originIso}
                emphasis
              />
              {end && (() => {
                const [x, y] = projection.project({ e_m: end.e, n_m: end.n });
                return <VehicleSymbol x={x} y={y} cls={activity.cls} level={level} size={6.5} />;
              })()}
            </g>
            {basemap && <Attribution text={basemap.attribution} />}
          </svg>

          <p className="activity__highlight" data-tone={highlight.tone}>
            <span aria-hidden="true" className="activity__highlight-mark">{highlight.mark}</span>
            {highlight.text}
          </p>

          <dl className="activity__stats">
            <Stat label={T.report.stat.distance} value={fmt.distance(activity.distanceM)} />
            <Stat label={T.report.stat.avgSpeed} value={fmt.speedKmh(activity.avgMovingSpeedMps)} />
            <Stat label={T.report.stat.moving} value={fmt.minutes(activity.movingMin)} />
            <Stat label={T.report.stat.elapsed} value={fmt.minutes(activity.elapsedMin)} />
            <Stat
              label={T.report.stat.maxSpeed}
              value={fmt.speedKmh(activity.maxSpeedMps)}
              note={activity.maxSpeedAtMin !== null ? clock(activity.maxSpeedAtMin) : undefined}
            />
            <Stat
              label={T.report.stat.stops}
              value={fmt.count(activity.stops.length)}
              note={activity.stops.length > 0 ? fmt.minutes(activity.stoppedMin) : undefined}
            />
            <Stat
              label={T.report.stat.closestBase}
              value={fmt.distance(activity.closestBaseM)}
              note={clock(activity.closestBaseAtMin)}
            />
            <Stat
              label={T.report.stat.net}
              value={`${activity.netApproachM > 0 ? '−' : '+'}${fmt.distance(Math.abs(activity.netApproachM))}`}
              note={fmt.heading(activity.headingDeg)}
            />
            <Stat
              label={T.report.stat.closestZone}
              value={nearest ? fmt.distance(nearest.closestM) : '—'}
              note={nearest?.name}
            />
          </dl>

          <section className="activity__section" aria-label={T.report.chart}>
            <p className="kicker">{T.report.chart}</p>
            <RangeChart
              lines={[chart.line]}
              bands={chart.bands}
              originIso={originIso}
              fromMin={activity.fromMin}
              toMin={Math.max(activity.toMin, activity.fromMin + 10)}
              maxRangeM={chart.maxRangeM}
              cursorMin={activity.toMin}
              width={900}
              height={200}
              labelGutter={80}
            />
          </section>

          <div className="activity__columns">
            <section className="activity__section" aria-label={T.report.splits}>
              <p className="kicker">{T.report.splits}</p>
              <table className="data-table activity__splits">
                <thead>
                  <tr>
                    <th scope="col">{T.report.col.split}</th>
                    <th scope="col">{T.report.col.time}</th>
                    <th scope="col" className="num">{T.report.col.distance}</th>
                    <th scope="col" className="num">{T.report.col.speed}</th>
                    <th scope="col" className="num">{T.report.col.range}</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.splits.map((split) => (
                    <tr key={split.index}>
                      <td>{split.index}</td>
                      <td>{clock(split.fromMin)}–{clock(split.toMin)}</td>
                      <td className="num">{fmt.distance(split.distanceM)}</td>
                      <td className="num">{split.movingMin > 0 ? fmt.speedKmh(split.avgSpeedMps) : '—'}</td>
                      <td className="num" data-closing={split.rangeDeltaM < -50 || undefined}>
                        {split.rangeDeltaM < 0 ? '−' : '+'}{fmt.distance(Math.abs(split.rangeDeltaM))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="activity__section" aria-label={T.report.events}>
              <p className="kicker">{T.report.events}</p>
              <ol className="activity__events">
                {activity.events.map((event, i) => (
                  <li key={`${event.kind}-${event.tMin}-${i}`} data-kind={event.kind}>
                    <span className="activity__event-time">{clock(event.tMin)}</span>
                    <span>{eventText(event)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <footer className="activity__foot muted">
            <p>
              {T.report.provenance(activity.fixCount)}
              {basemap ? ` · harita ${basemap.attribution}` : ''}
              {' · '}
              {T.report.asOf(clock(activity.toMin))}
            </p>
            <p>
              {T.report.method}
              {activity.outlierSteps > 0 ? ` ${T.report.outliers(activity.outlierSteps)}` : ''}
            </p>
          </footer>
        </div>
      </section>
    </div>
  );
});

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="activity__stat">
      <dt className="label">{label}</dt>
      <dd>
        <span className="activity__stat-value">{value}</span>
        {note && <span className="activity__stat-note">{note}</span>}
      </dd>
    </div>
  );
}

function headlineText(activity: Activity, baseName: string, clock: (t: number) => string): string {
  const h = headlineOf(activity);
  switch (h.kind) {
    case 'zone':
      return T.report.headline.zone(h.name, clock(h.atMin));
    case 'buffer':
      return T.report.headline.buffer(h.name, clock(h.atMin));
    case 'parked':
      return T.report.headline.parked(fmt.minutes(h.minutes));
    case 'approaching':
      return T.report.headline.approaching(baseName, fmt.distance(h.metres));
    case 'receding':
      return T.report.headline.receding(baseName, fmt.distance(h.metres));
    case 'roaming':
      return T.report.headline.roaming(fmt.distance(h.metres));
  }
}

function highlightOf(
  vehicle: LiveVehicle | null,
  nearest: Activity['zones'][number] | null,
  clock: (t: number) => string,
): { tone: 'threat' | 'review' | 'neutral'; mark: string; text: string } {
  const alert = vehicle?.alert ?? null;
  const zone = alert?.zone_name ?? alert?.zone_id ?? nearest?.name ?? '—';
  if (vehicle?.level === 'ALERT') {
    return { tone: 'threat', mark: '▲', text: T.report.highlight.threat(zone, fmt.eta(alert?.eta_entry_s)) };
  }
  if (vehicle?.level === 'WATCH') {
    return { tone: 'review', mark: '●', text: T.report.highlight.review(zone) };
  }
  if (nearest) {
    const text = T.report.highlight.closest(nearest.name, fmt.distance(nearest.closestM), clock(nearest.closestAtMin));
    return {
      tone: 'neutral',
      mark: '◎',
      text: vehicle?.level === null ? `${text} · ${T.report.highlight.unassessed}` : text,
    };
  }
  return { tone: 'neutral', mark: '◎', text: T.report.highlight.unassessed };
}

function eventText(event: ActivityEvent): string {
  switch (event.kind) {
    case 'start':
      return T.report.event.start(fmt.distance(event.rangeM));
    case 'stop':
      return T.report.event.stop(fmt.minutes(event.durationMin));
    case 'buffer':
      return T.report.event.buffer(event.name);
    case 'zone':
      return T.report.event.zone(event.name);
    case 'closest':
      return T.report.event.closest(fmt.distance(event.rangeM));
    case 'end':
      return event.complete
        ? T.report.event.end(fmt.distance(event.rangeM))
        : T.report.event.now(fmt.distance(event.rangeM));
  }
}
