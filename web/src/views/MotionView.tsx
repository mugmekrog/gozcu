/* The motion view: the closing-range chart over a ranked table.
 *
 * Default is threat and review vehicles only. Showing all 226 tracks by default
 * would be a legible chart of nothing -- the point of the view is who is closing,
 * and the "tümünü göster" switch is there for the operator who wants to confirm
 * that the quiet ones really are quiet.
 *
 * Chart line, table row and map symbol are one selection. Hovering a row
 * highlights the line; clicking it selects the vehicle everywhere.
 */

import { memo, useMemo } from 'react';
import { RangeChart, type ChartBand, type ChartLine } from '@/components/RangeChart';
import { GlyphChip } from '@/radar/Glyph';
import { Switch } from '@/components/Switch';
import { bandOf } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { rangeSeries, stopsOf } from '@/domain/tracks';
import { PIN_COLOURS } from '@/radar/VehicleLayer';
import { useAppStore } from '@/store/useAppStore';
import type { LiveVehicle } from '@/domain/live';
import './motion-view.css';

/** How much history the chart shows behind the clock. */
const WINDOW_MIN = 120;

const TREND_LABEL = {
  approaching: T.motion.trendApproaching,
  receding: T.motion.trendReceding,
  steady: T.motion.trendSteady,
  stopped: T.motion.trendStopped,
} as const;

export interface MotionViewProps {
  vehicles: readonly LiveVehicle[];
}

export const MotionView = memo(function MotionView({ vehicles }: MotionViewProps) {
  const dataset = useAppStore((s) => s.dataset);
  const trackIndex = useAppStore((s) => s.trackIndex);
  const tMin = useAppStore((s) => s.tMin);
  const showAll = useAppStore((s) => s.showAllInMotion);
  const setShowAll = useAppStore((s) => s.setShowAllInMotion);
  const selectedTrackId = useAppStore((s) => s.selectedTrackId);
  const hoveredTrackId = useAppStore((s) => s.hoveredTrackId);
  const pins = useAppStore((s) => s.pins);
  const selectTrack = useAppStore((s) => s.selectTrack);
  const hoverTrack = useAppStore((s) => s.hoverTrack);
  const openFrame = useAppStore((s) => s.openFrame);

  const interesting = useMemo(
    () =>
      vehicles.filter(
        (v) => v.level === 'ALERT' || v.level === 'WATCH' || pins.includes(v.trackId),
      ),
    [vehicles, pins],
  );
  const shown = showAll ? vehicles : interesting;

  const fromMin = Math.max(0, tMin - WINDOW_MIN);
  const pinIndex = new Map(pins.map((id, i) => [id, i]));

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    for (const vehicle of shown) {
      const history = trackIndex.get(vehicle.trackId);
      if (!history) continue;
      const points = rangeSeries(history).filter((p) => p.tMin >= fromMin && p.tMin <= tMin);
      if (points.length < 2) continue;

      const pin = pinIndex.get(vehicle.trackId);
      out.push({
        id: vehicle.trackId,
        label: `${vehicle.trackId} · ${classLabel(vehicle.cls)}`,
        level: vehicle.level,
        score: vehicle.score,
        points,
        emphasis: vehicle.trackId === selectedTrackId || vehicle.trackId === hoveredTrackId,
        ...(pin !== undefined ? { colour: PIN_COLOURS[pin] } : {}),
      });
    }
    // Cap the chart: beyond a dozen lines it stops being readable, and the table
    // below carries the rest. The worst vehicles keep their lines.
    return out
      .sort((a, b) => b.score - a.score)
      .slice(0, showAll ? 24 : 12);
  }, [shown, trackIndex, fromMin, tMin, selectedTrackId, hoveredTrackId, pins, showAll]);

  /** Stop bands for the selected vehicle only; every vehicle's would be soup. */
  const bands = useMemo<ChartBand[]>(() => {
    if (!selectedTrackId || !dataset) return [];
    const history = trackIndex.get(selectedTrackId);
    if (!history) return [];
    return stopsOf(history, dataset.thresholds.stationary_disp_m)
      .filter((stop) => stop.toMin >= fromMin && stop.fromMin <= tMin)
      .map((stop) => ({
        fromMin: stop.fromMin,
        toMin: stop.toMin,
        label: fmt.minutes(stop.durationMin),
      }));
  }, [selectedTrackId, trackIndex, dataset, fromMin, tMin]);

  const maxRangeM = useMemo(() => {
    let max = 2000;
    for (const line of lines) for (const point of line.points) max = Math.max(max, point.range_m);
    return Math.ceil(max / 1000) * 1000;
  }, [lines]);

  const rows = useMemo(
    () => [...shown].sort((a, b) => b.score - a.score || a.sample.range_m - b.sample.range_m),
    [shown],
  );

  if (!dataset) return null;

  return (
    <div className="motion-view">
      <section className="motion-view__chart">
        <div className="motion-view__chart-head">
          <b className="section-head__title">{T.motion.chartTitle}</b>
          <span className="muted">{T.motion.chartNote(shown.length)}</span>
          <div className="spacer" />
          {bands.length > 0 && (
            <span className="motion-view__band-key">
              <span className="motion-view__band-swatch" aria-hidden="true" />
              {selectedTrackId} {T.motion.stopBand}
            </span>
          )}
          <Switch checked={showAll} onChange={setShowAll} label={T.motion.showAll} />
        </div>

        <div className="motion-view__chart-body">
          {lines.length === 0 ? (
            <div className="motion-view__empty" role="status">
              <b>{T.motion.empty}</b>
              <span className="muted">{T.motion.emptyHint}</span>
            </div>
          ) : (
            <RangeChart
              lines={lines}
              bands={bands}
              originIso={dataset.origin_ts}
              fromMin={fromMin}
              toMin={tMin + 6}
              maxRangeM={maxRangeM}
              cursorMin={tMin}
              onHoverLine={hoverTrack}
            />
          )}
        </div>
      </section>

      <div className="motion-view__table">
        <table className="data-table">
          <caption className="sr-only">
            İzlenen araçlar, risk puanına göre sıralı
          </caption>
          <thead>
            <tr>
              <th scope="col" aria-label="Seviye" />
              <th scope="col">{T.motion.col.track}</th>
              <th scope="col">{T.motion.col.class}</th>
              <th scope="col">{T.motion.col.zone}</th>
              <th scope="col">{T.motion.col.trend}</th>
              <th scope="col" className="num">
                {T.motion.col.base}
              </th>
              <th scope="col" className="num">
                {T.motion.col.speed}
              </th>
              <th scope="col" className="num">
                {T.motion.col.eta}
              </th>
              <th scope="col">{T.motion.col.stops}</th>
              <th scope="col" className="num">
                {T.motion.col.score} ▾
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((vehicle) => {
              const zoneName = vehicle.alert?.zone_name ?? '—';
              return (
                <tr
                  key={vehicle.trackId}
                  data-selected={vehicle.trackId === selectedTrackId}
                  data-interactive="true"
                  onPointerEnter={() => hoverTrack(vehicle.trackId)}
                  onPointerLeave={() => hoverTrack(null)}
                  onClick={() => selectTrack(vehicle.trackId)}
                  onDoubleClick={() => vehicle.imageId && void openFrame(vehicle.imageId)}
                >
                  <td>
                    <GlyphChip band={bandOf(vehicle.level, vehicle.score)} />
                  </td>
                  <th scope="row">{vehicle.trackId}</th>
                  <td>{classLabel(vehicle.cls)}</td>
                  <td>{zoneName}</td>
                  <td>{TREND_LABEL[vehicle.trend]}</td>
                  <td className="num">{fmt.km(vehicle.sample.range_m)}</td>
                  <td className="num">{fmt.speed(vehicle.sample.speed_mps)}</td>
                  <td className="num">{fmt.eta(vehicle.alert?.eta_entry_s ?? null)}</td>
                  <td>
                    {vehicle.stops.count === 0
                      ? '0'
                      : `${fmt.count(vehicle.stops.count)} · ${fmt.minutes(vehicle.stops.totalMin)}`}
                  </td>
                  <td className="num">
                    <b>{vehicle.level === null ? '—' : fmt.count(vehicle.score)}</b>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});
