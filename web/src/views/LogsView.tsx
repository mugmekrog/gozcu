/* The audit view: which frames were evaluated, how each report was judged, and
 * what the operator decided.
 *
 * Three record types, one at a time behind tabs that carry their counts, in the
 * order an auditor reads them: what the system saw, what it was told, and what a
 * human then did about it. Each tab has its own filters, so a question like
 * "which reports contradict us" is one click rather than a scroll past forty
 * frames. The reports tab is the important one for the brief's requirement that
 * some field reports are wrong and are not marked as such -- it shows our verdict
 * on every report beside the report's own words, and which frame made the call,
 * so a reader can check it rather than take it.
 *
 * Only records at or before the clock appear. A frame the day has not reached is
 * not part of the record yet.
 */

import { memo, useMemo, useState } from 'react';
import { GlyphChip } from '@/radar/Glyph';
import { LevelBadge } from '@/components/LevelBadge';
import { bandOf, riskStyle } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { framesUpTo } from '@/domain/live';
import { useAppStore } from '@/store/useAppStore';
import type { FieldReport, FrameSummary } from '@/domain/types';
import './logs-view.css';

type Tab = 'frames' | 'reports' | 'decisions';
type LevelFilter = 'all' | 'threat' | 'review' | 'safe';
type VerdictFilter = 'all' | 'contradicts' | 'agrees' | 'unrelated' | 'unchecked';
type SourceFilter = 'all' | 'official' | 'third_party';

const LEVEL_OF: Record<FrameSummary['level'], Exclude<LevelFilter, 'all'>> = {
  ALERT: 'threat',
  WATCH: 'review',
  CLEAR: 'safe',
};

const KIND_LABEL: Record<string, string> = {
  area_wide: 'bölge geneli',
  degraded_coverage: 'görüş kısıtlı',
  identified_friendly: 'kimliği doğrulanmış',
  irrelevant: 'ilgisiz',
  negative_claim: 'olumsuz bildirim',
  sighting: 'gözlem',
  unknown: 'belirsiz',
  unverified: 'doğrulanmamış',
  zone_status: 'bölge durumu',
};

const verdictOf = (report: FieldReport): Exclude<VerdictFilter, 'all'> =>
  report.consistency ?? 'unchecked';

/** Count each key of a list, for the numbers on the filter chips. */
function countBy<T, K extends string>(items: readonly T[], key: (item: T) => K) {
  const out = new Map<K, number>();
  for (const item of items) out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  return out;
}

export const LogsView = memo(function LogsView() {
  const dataset = useAppStore((s) => s.dataset);
  const reports = useAppStore((s) => s.reports);
  const alertsByFrame = useAppStore((s) => s.alertsByFrame);
  const decisions = useAppStore((s) => s.decisions);
  const tMin = useAppStore((s) => s.tMin);
  const selectedFrameId = useAppStore((s) => s.selectedFrameId);
  const openFrame = useAppStore((s) => s.openFrame);

  const [tab, setTab] = useState<Tab>('frames');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  const frames = useMemo(
    () => (dataset ? [...framesUpTo(dataset.frames, tMin)].reverse() : []),
    [dataset, tMin],
  );
  const reportsSoFar = useMemo(
    () => reports.filter((r) => (r.t_min ?? 0) <= tMin).reverse(),
    [reports, tMin],
  );

  const levelCounts = useMemo(() => countBy(frames, (f) => LEVEL_OF[f.level]), [frames]);
  const sourceScoped = useMemo(
    () =>
      sourceFilter === 'all' ? reportsSoFar : reportsSoFar.filter((r) => r.source === sourceFilter),
    [reportsSoFar, sourceFilter],
  );
  const verdictCounts = useMemo(() => countBy(sourceScoped, verdictOf), [sourceScoped]);

  const visibleFrames = useMemo(
    () => (levelFilter === 'all' ? frames : frames.filter((f) => LEVEL_OF[f.level] === levelFilter)),
    [frames, levelFilter],
  );
  const visibleReports = useMemo(
    () =>
      verdictFilter === 'all'
        ? sourceScoped
        : sourceScoped.filter((r) => verdictOf(r) === verdictFilter),
    [sourceScoped, verdictFilter],
  );

  const decisionsByFrame = useMemo(
    () => new Map(decisions.map((d) => [d.image_id, d])),
    [decisions],
  );

  if (!dataset) return null;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'frames', label: T.logs.tabs.frames, count: frames.length },
    { id: 'reports', label: T.logs.tabs.reports, count: reportsSoFar.length },
    { id: 'decisions', label: T.logs.tabs.decisions, count: decisions.length },
  ];

  return (
    <div className="logs-view">
      <div className="logs-view__head">
        <div className="logs-view__tabs" role="tablist" aria-label={T.logs.tabsLabel}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`logs-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`logs-panel-${t.id}`}
              className="logs-view__tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="logs-view__count">{fmt.count(t.count)}</span>
            </button>
          ))}
        </div>
        <span className="muted">{T.logs.upToClock(fmt.clockOf(dataset.origin_ts, tMin))}</span>
      </div>

      {tab === 'frames' && (
        <section
          className="logs-view__panel"
          role="tabpanel"
          id="logs-panel-frames"
          aria-labelledby="logs-tab-frames"
        >
          <div className="logs-view__toolbar">
            <FilterChips
              label={T.logs.levelFilter}
              value={levelFilter}
              onChange={setLevelFilter}
              options={[
                ['all', T.logs.level.all, frames.length],
                ['threat', T.logs.level.threat, levelCounts.get('threat') ?? 0],
                ['review', T.logs.level.review, levelCounts.get('review') ?? 0],
                ['safe', T.logs.level.safe, levelCounts.get('safe') ?? 0],
              ]}
            />
            <div className="spacer" />
            <span className="muted">{T.logs.decided(decisionsByFrame.size, frames.length)}</span>
          </div>
          <div className="logs-view__scroll">
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
                {visibleFrames.map((frame) => {
                  const frameAlerts = alertsByFrame.get(frame.image_id) ?? [];
                  const threats = frameAlerts.filter((a) => a.level === 'ALERT').length;
                  const reviews = frameAlerts.filter((a) => a.level === 'WATCH').length;
                  const decision = decisionsByFrame.get(frame.image_id);
                  const band =
                    frame.vehicle_count === 0 ? 'empty' : bandOf(frame.level, frame.score);

                  return (
                    <tr
                      key={frame.image_id}
                      data-selected={frame.image_id === selectedFrameId}
                      data-interactive="true"
                      onClick={() => void openFrame(frame.image_id)}
                    >
                      <td className="logs-view__time">{frame.capture_hhmm}</td>
                      <th scope="row">{frame.image_id}</th>
                      <td>{frame.zone_name ?? <span className="muted">—</span>}</td>
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
                          <span className="logs-view__pending">{T.logs.pending}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleFrames.length === 0 && <EmptyRow span={7} />}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'reports' && (
        <section
          className="logs-view__panel"
          role="tabpanel"
          id="logs-panel-reports"
          aria-labelledby="logs-tab-reports"
        >
          <div className="logs-view__toolbar">
            <FilterChips
              label={T.logs.verdictFilter}
              value={verdictFilter}
              onChange={setVerdictFilter}
              options={[
                ['all', T.logs.verdict.all, sourceScoped.length],
                ['contradicts', T.logs.verdict.contradicts, verdictCounts.get('contradicts') ?? 0],
                ['agrees', T.logs.verdict.agrees, verdictCounts.get('agrees') ?? 0],
                ['unrelated', T.logs.verdict.unrelated, verdictCounts.get('unrelated') ?? 0],
                ['unchecked', T.logs.verdict.unchecked, verdictCounts.get('unchecked') ?? 0],
              ]}
            />
            <div className="spacer" />
            <FilterChips
              label={T.logs.sourceFilter}
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                ['all', T.logs.source.all],
                ['official', T.logs.source.official],
                ['third_party', T.logs.source.third_party],
              ]}
            />
          </div>
          <div className="logs-view__scroll">
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
                  <tr key={report.report_id} data-verdict={verdictOf(report)}>
                    <td className="logs-view__time">{report.hhmm}</td>
                    <th scope="row">{report.report_id}</th>
                    <td>
                      <SourceBadge source={report.source} />
                    </td>
                    <td className="logs-view__text">
                      “{report.text}”
                      <ReportMeta report={report} />
                    </td>
                    <td className="logs-view__verdict">
                      <ReportVerdict report={report} onOpenFrame={openFrame} />
                    </td>
                  </tr>
                ))}
                {visibleReports.length === 0 && <EmptyRow span={5} />}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'decisions' && (
        <section
          className="logs-view__panel"
          role="tabpanel"
          id="logs-panel-decisions"
          aria-labelledby="logs-tab-decisions"
        >
          {decisions.length === 0 ? (
            <p className="logs-view__empty muted">{T.logs.decisionsEmpty}</p>
          ) : (
            <div className="logs-view__scroll">
              <table className="data-table logs-view__table">
                <thead>
                  <tr>
                    <th scope="col">{T.logs.col.time}</th>
                    <th scope="col">{T.logs.col.frame}</th>
                    <th scope="col">Hedef</th>
                    <th scope="col">{T.logs.col.agent}</th>
                    <th scope="col">{T.logs.col.decision}</th>
                    <th scope="col">{T.logs.col.note}</th>
                    <th scope="col">{T.logs.col.operator}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...decisions].reverse().map((decision, i) => (
                    <tr
                      key={`${decision.image_id}-${i}`}
                      data-interactive="true"
                      onClick={() => void openFrame(decision.image_id)}
                    >
                      <td className="logs-view__time">{decision.hhmm}</td>
                      <th scope="row">{decision.image_id}</th>
                      <td>{decision.target_kind === 'scenario' ? 'Senaryo' : 'Tehdit kartı'} · {decision.target_id}</td>
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
            </div>
          )}
        </section>
      )}
    </div>
  );
});

/** A row of pill filters; the count, when given, is what the pill would show. */
function FilterChips<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: readonly (readonly [V, string, number?])[];
}) {
  return (
    <div className="logs-view__chips" role="group" aria-label={label}>
      {options.map(([option, text, count]) => (
        <button
          key={option}
          type="button"
          className="logs-view__chip"
          data-option={option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {text}
          {count !== undefined && <span className="logs-view__chip-count">{fmt.count(count)}</span>}
        </button>
      ))}
    </div>
  );
}

function EmptyRow({ span }: { span: number }) {
  return (
    <tr>
      <td colSpan={span} className="logs-view__empty muted">
        {T.logs.noMatch}
      </td>
    </tr>
  );
}

/** Official is a solid border, third party a dashed one -- trust, not colour. */
function SourceBadge({ source }: { source: FieldReport['source'] }) {
  return (
    <span className="logs-view__source" data-source={source}>
      {source === 'official' ? T.logs.source.official : T.logs.source.third_party}
    </span>
  );
}

/** What the parser read out of the report, under its text. */
function ReportMeta({ report }: { report: FieldReport }) {
  const parts = [
    KIND_LABEL[report.kind] ?? report.kind,
    report.vehicle_type ? classLabel(report.vehicle_type) : null,
    report.zone_ref,
    report.matched_track_ids.length > 0 ? `${report.matched_track_ids.length} iz` : null,
  ].filter(Boolean);
  return <span className="logs-view__meta">{parts.join(' · ')}</span>;
}

/**
 * Our verdict on one report.
 *
 * `contradicts` is the case the brief cares about: the report disagrees with what
 * we detected, and our detection wins. The note explains which part disagreed and
 * the frame link shows the detections that decided it, so the judgement is
 * auditable rather than asserted.
 */
function ReportVerdict({
  report,
  onOpenFrame,
}: {
  report: FieldReport;
  onOpenFrame: (imageId: string) => Promise<void>;
}) {
  const verdict = verdictOf(report);
  return (
    <>
      <span className="logs-view__verdict-badge" data-verdict={verdict}>
        {T.logs.verdict[verdict]}
      </span>
      {report.consistency_note && (
        <span className="logs-view__note">{report.consistency_note}</span>
      )}
      {report.checked_in ? (
        <button
          type="button"
          className="logs-view__frame-link"
          onClick={() => void onOpenFrame(report.checked_in!)}
        >
          {report.checked_in} {T.logs.checkedIn}
        </button>
      ) : (
        <span className="logs-view__note">{T.logs.uncheckedNote}</span>
      )}
    </>
  );
}
