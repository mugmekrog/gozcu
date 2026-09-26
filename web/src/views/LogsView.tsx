/* The audit view: which frames were evaluated, how each report was judged, and
 * what the operator decided.
 *
 * Three tables, in the order an auditor would read them: what the system saw,
 * what it was told, and what a human then did about it. The middle table is the
 * important one for the brief's requirement that some field reports are wrong and
 * are not marked as such -- it shows our verdict on every report beside the
 * report's own words, so a reader can check the call rather than take it.
 *
 * Only frames at or before the clock appear. A frame the day has not reached is
 * not part of the record yet.
 */

import { memo, useMemo, useState } from 'react';
import { GlyphChip } from '@/radar/Glyph';
import { LevelBadge } from '@/components/LevelBadge';
import { bandOf, riskStyle } from '@/domain/risk';
import { classLabel, consistencyLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { framesUpTo } from '@/domain/live';
import { useAppStore } from '@/store/useAppStore';
import type { FieldReport } from '@/domain/types';
import './logs-view.css';

type ReportFilter = 'all' | 'contradicts' | 'third_party';

export const LogsView = memo(function LogsView() {
  const dataset = useAppStore((s) => s.dataset);
  const reports = useAppStore((s) => s.reports);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const decisions = useAppStore((s) => s.decisions);
  const tMin = useAppStore((s) => s.tMin);
  const selectedFrameId = useAppStore((s) => s.selectedFrameId);
  const openFrame = useAppStore((s) => s.openFrame);

  const [reportFilter, setReportFilter] = useState<ReportFilter>('all');

  const frames = useMemo(
    () => (dataset ? [...framesUpTo(dataset.frames, tMin)].reverse() : []),
    [dataset, tMin],
  );

  const visibleReports = useMemo(() => {
    const upToNow = reports.filter((r) => (r.t_min ?? 0) <= tMin);
    const filtered =
      reportFilter === 'contradicts'
        ? upToNow.filter((r) => r.consistency === 'contradicts')
        : reportFilter === 'third_party'
          ? upToNow.filter((r) => r.source === 'third_party')
          : upToNow;
    return filtered.slice(-40).reverse();
  }, [reports, tMin, reportFilter]);

  const decisionsByFrame = useMemo(
    () => new Map(decisions.map((d) => [d.image_id, d])),
    [decisions],
  );

  if (!dataset) return null;

  return (
    <div className="logs-view">
      <section>
        <div className="section-head">
          <b className="section-head__title">{T.logs.frames}</b>
          <span className="muted">{T.logs.framesNote(frames.length)}</span>
        </div>
        <table className="data-table logs-view__table">
          <thead>
            <tr>
              <th scope="col">{T.logs.col.time}</th>
              <th scope="col">{T.logs.col.frame}</th>
              <th scope="col">{T.logs.col.zone}</th>
              <th scope="col" className="num">
                {T.logs.col.vehicles}
              </th>
              <th scope="col">{T.logs.col.level}</th>
              <th scope="col">{T.logs.col.alert}</th>
              <th scope="col">{T.logs.col.decision}</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((frame) => {
              const frameAlerts = alertsByFrame.get(frame.image_id) ?? [];
              const threats = frameAlerts.filter((a) => a.level === 'ALERT').length;
              const reviews = frameAlerts.filter((a) => a.level === 'WATCH').length;
              const decision = decisionsByFrame.get(frame.image_id);
              const band = frame.vehicle_count === 0 ? 'empty' : bandOf(frame.level, frame.score);

              return (
                <tr
                  key={frame.image_id}
                  data-selected={frame.image_id === selectedFrameId}
                  data-interactive="true"
                  onClick={() => void openFrame(frame.image_id)}
                >
                  <td>{frame.capture_hhmm}</td>
                  <th scope="row">{frame.image_id}</th>
                  <td>{frame.zone_name ?? '—'}</td>
                  <td className="num">{fmt.count(frame.vehicle_count)}</td>
                  <td>
                    <LevelBadge band={band} size="small" />
                  </td>
                  <td>
                    {threats === 0 && reviews === 0 ? (
                      <span className="muted">{T.logs.noAlert}</span>
                    ) : (
                      <span className="logs-view__alert-cell">
                        {threats > 0 && (
                          <span style={{ color: riskStyle('critical').textColor }}>
                            ▲ {fmt.count(threats)} {T.logs.alertThreat}
                          </span>
                        )}
                        {reviews > 0 && (
                          <span style={{ color: riskStyle('review').textColor }}>
                            ● {fmt.count(reviews)} {T.logs.alertReview}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    {decision ? (
                      <b>
                        ✓ {T.decision[decision.verdict]} · {decision.hhmm}
                      </b>
                    ) : (
                      <span className="muted">{T.logs.pending}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <div className="section-head">
          <b className="section-head__title">{T.logs.reports}</b>
          <span className="muted">{T.logs.reportsNote(visibleReports.length)}</span>
          <div className="spacer" />
          <div className="seg" role="group" aria-label="Rapor filtresi">
            {(
              [
                ['all', T.logs.filterAll],
                ['contradicts', T.consistency.contradicts],
                ['third_party', 'third_party'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="seg__opt"
                aria-pressed={reportFilter === value}
                onClick={() => setReportFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <table className="data-table logs-view__table">
          <thead>
            <tr>
              <th scope="col">{T.logs.col.time}</th>
              <th scope="col">{T.logs.col.id}</th>
              <th scope="col">{T.logs.col.source}</th>
              <th scope="col">{T.logs.col.text}</th>
              <th scope="col">{T.logs.col.agentReview}</th>
            </tr>
          </thead>
          <tbody>
            {visibleReports.map((report) => (
              <tr key={report.report_id}>
                <td>{report.hhmm}</td>
                <th scope="row">{report.report_id}</th>
                <td>
                  <SourceBadge source={report.source} />
                </td>
                <td className="logs-view__text">“{report.text}”</td>
                <td className="logs-view__verdict">
                  <ReportVerdict report={report} />
                </td>
              </tr>
            ))}
            {visibleReports.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Bu filtreye uyan rapor yok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <div className="section-head">
          <b className="section-head__title">{T.logs.decisions}</b>
        </div>
        {decisions.length === 0 ? (
          <p className="logs-view__empty muted">{T.logs.decisionsEmpty}</p>
        ) : (
          <table className="data-table logs-view__table">
            <thead>
              <tr>
                <th scope="col">{T.logs.col.time}</th>
                <th scope="col">{T.logs.col.frame}</th>
                <th scope="col">{T.logs.col.agent}</th>
                <th scope="col">{T.logs.col.decision}</th>
                <th scope="col">{T.logs.col.note}</th>
                <th scope="col">{T.logs.col.operator}</th>
              </tr>
            </thead>
            <tbody>
              {[...decisions].reverse().map((decision, i) => (
                <tr key={`${decision.image_id}-${i}`}>
                  <td>{decision.hhmm}</td>
                  <th scope="row">{decision.image_id}</th>
                  <td>
                    <span className="logs-view__agent-cell">
                      <GlyphChip band={bandOf(decision.agent_level, decision.agent_score)} />
                      {fmt.count(decision.agent_score)}
                    </span>
                  </td>
                  <td>
                    <b>{T.decision[decision.verdict]}</b>
                  </td>
                  <td>{decision.note || <span className="muted">—</span>}</td>
                  <td className="muted">{decision.operator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
});

/** Official is a solid border, third party a dashed one -- trust, not colour. */
function SourceBadge({ source }: { source: FieldReport['source'] }) {
  return (
    <span className="logs-view__source" data-source={source}>
      {source}
    </span>
  );
}

/**
 * Our verdict on one report.
 *
 * `contradicts` is the case the brief cares about: the report disagrees with what
 * we detected, and our detection wins. The note explains which part disagreed, so
 * the judgement is auditable rather than asserted.
 */
function ReportVerdict({ report }: { report: FieldReport }) {
  const tone =
    report.consistency === 'contradicts'
      ? riskStyle('critical').textColor
      : report.consistency === 'agrees'
        ? 'var(--terrain-deep)'
        : 'var(--ink-muted)';

  return (
    <>
      <b style={{ color: tone }}>{consistencyLabel(report.consistency)}</b>{' '}
      <span className="muted">
        · {report.kind}
        {report.vehicle_type && ` · ${classLabel(report.vehicle_type)}`}
        {report.zone_ref && ` · ${report.zone_ref}`}
        {report.matched_track_ids.length > 0 && ` · ${report.matched_track_ids.length} iz`}
        {report.consistency_note && ` — ${report.consistency_note}`}
      </span>
    </>
  );
}
