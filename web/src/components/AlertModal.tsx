/* The decision modal.
 *
 * This is where the human stays in the loop, so it is the one surface in the app
 * that is deliberately hard to dismiss by accident and deliberately slow: the
 * decision it records is audited against a named operator, and nothing in the
 * system acts without it.
 *
 * Three stages, per the wireframe:
 *   1  camera full width, rationale beneath, confirm or reject
 *   2  camera narrows to 45%, the closing-range chart appears beside it
 *   3  a box is clicked: the chart is replaced by that detection's crop,
 *      its confidence and threat readings, and the assessment text
 *
 * Two variants. The red one states a threat and asks for confirmation. The amber
 * one names what the agent could not settle and asks the operator to settle it --
 * which is the honest shape for a verdict the system is not confident in, rather
 * than rounding it to a decision it did not make.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CameraFrame } from './CameraFrame';
import { RangeChart, type ChartBand, type ChartLine } from './RangeChart';
import { GlyphChip } from '@/radar/Glyph';
import { bandOf, riskStyle } from '@/domain/risk';
import { classLabel, T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { cropAround } from '@/domain/crop';
import { modalRows, type AssembledBrief } from '@/domain/brief';
import { rangeSeries, stopsOf } from '@/domain/tracks';
import type { Alert, Decision, FrameDetail, TrackHistory } from '@/domain/types';
import type { ModalKind } from '@/store/useAppStore';
import './alert-modal.css';

export interface AlertModalProps {
  kind: ModalKind;
  frame: FrameDetail;
  brief: AssembledBrief;
  imageUrl: string | null;
  histories: ReadonlyMap<string, TrackHistory>;
  originIso: string;
  stationaryDispM: number;
  infoOpen: boolean;
  targetDetId: string | null;
  showSuppressed: boolean;
  onInfoOpen: (open: boolean) => void;
  onTarget: (detId: string | null) => void;
  onShowSuppressed: (show: boolean) => void;
  onDecide: (verdict: Decision['verdict'], note: string, operator: string) => void;
  onClose: () => void;
}

/** How much history the modal's chart shows. */
const WINDOW_MIN = 120;

function alertEvidence(alert: Alert): string {
  const place = alert.zone_name || alert.zone_id || 'korunan bölge';
  const facts = [`${alert.track_id}, ${place} bölgesine ${fmt.distance(alert.dist_now_m)} uzaklıkta`];
  if (alert.eta_entry_s != null) facts.push(`tahmini giriş ${fmt.eta(alert.eta_entry_s)}`);
  if (alert.closing_speed_mps != null) {
    facts.push(`${alert.closing_speed_mps >= 0 ? 'yaklaşma' : 'uzaklaşma'} hızı ${fmt.speed(Math.abs(alert.closing_speed_mps))}`);
  }
  facts.push(`yaklaşma güveni ${fmt.percent(alert.approach_conf)}`);
  return facts.join(' · ');
}

export const AlertModal = memo(function AlertModal({
  kind,
  frame,
  brief,
  imageUrl,
  histories,
  originIso,
  stationaryDispM,
  infoOpen,
  targetDetId,
  showSuppressed,
  onInfoOpen,
  onTarget,
  onShowSuppressed,
  onDecide,
  onClose,
}: AlertModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState('');
  const [operator, setOperator] = useState(() => globalThis.localStorage?.getItem('goru.operator') ?? '');
  const canDecide = Boolean(note.trim() && operator.trim());

  const threat = kind === 'threat';
  const accent = threat ? 'var(--risk-threat)' : 'var(--risk-review)';

  // Focus moves into the dialog and is trapped while it is open: this is a modal
  // decision, and letting Tab wander back to the map behind the scrim would let
  // an operator act on the wrong surface.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;

      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  const lead = brief.lead;
  const leadTrackId = lead?.alert.track_id ?? null;

  const chartLines = useMemo<ChartLine[]>(() => {
    if (!leadTrackId) return [];
    const history = histories.get(leadTrackId);
    if (!history) return [];
    const points = rangeSeries(history);
    const last = points[points.length - 1]?.tMin ?? 0;
    return [
      {
        id: leadTrackId,
        label: fmt.distance(points[points.length - 1]?.range_m ?? 0),
        level: lead?.alert.level ?? null,
        score: brief.score,
        points: points.filter((p) => p.tMin >= last - WINDOW_MIN),
        emphasis: true,
      },
    ];
  }, [leadTrackId, histories, brief.score, lead]);

  const chartBands = useMemo<ChartBand[]>(() => {
    if (!leadTrackId) return [];
    const history = histories.get(leadTrackId);
    if (!history) return [];
    return stopsOf(history, stationaryDispM).map((stop) => ({
      fromMin: stop.fromMin,
      toMin: stop.toMin,
      label: fmt.minutes(stop.durationMin),
    }));
  }, [leadTrackId, histories, stationaryDispM]);

  const rows = useMemo(() => modalRows(frame), [frame]);
  const target = targetDetId ? frame.detections.find((d) => d.det_id === targetDetId) : null;
  const targetTrackId = targetDetId
    ? frame.matches.find((m) => m.det_id === targetDetId)?.track_id ?? null
    : null;
  const targetAlert = targetTrackId
    ? frame.alerts.find((a) => a.track_id === targetTrackId) ?? null
    : null;

  const chartFrom = chartLines[0]?.points[0]?.tMin ?? 0;
  const chartTo = chartLines[0]?.points[chartLines[0].points.length - 1]?.tMin ?? 1;
  const maxRange = Math.ceil(
    Math.max(2000, ...(chartLines[0]?.points.map((p) => p.range_m) ?? [2000])) / 1000,
  ) * 1000;

  return (
    <>
      <div className="modal__scrim" onClick={onClose} />
      <div
        className="modal"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby="modal-rationale"
        style={{ borderColor: accent }}
      >
        <header className="modal__head">
          {threat ? (
            <span className="modal__pulse" aria-hidden="true">
              ▲
            </span>
          ) : (
            <span className="modal__query" aria-hidden="true">
              ?
            </span>
          )}
          <div>
            <h2
              id="modal-title"
              className="modal__title"
              style={{ color: threat ? 'var(--risk-threat-ink)' : 'var(--risk-review-ink)' }}
            >
              {threat ? T.modal.threatTitle : T.modal.reviewTitle}
            </h2>
            <p className="modal__subtitle muted">
              {frame.image_id} · {brief.lead?.zone?.name ?? '—'} · {frame.capture_hhmm} ·{' '}
              {threat ? `${T.band.critical} ${fmt.count(brief.score)}/100` : T.band.review}
              {` · Jev güveni: ${brief.confidence}`}
              {lead?.alert.agent_dissent === 'modeller ayrışıyor' && ' · modeller ayrışıyor'}
            </p>
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="modal__close"
            ref={closeButton}
            onClick={onClose}
            aria-label={T.modal.closeLabel}
          >
            {T.modal.close}
          </button>
        </header>

        <div className="modal__body">
          <div
            className="modal__camera"
            style={{ width: infoOpen ? '45%' : '100%' }}
            onClick={() => targetDetId && onTarget(null)}
          >
            <CameraFrame
              frame={frame}
              imageUrl={imageUrl}
              evaluated
              selectedDetId={targetDetId}
              showSuppressed={showSuppressed}
              onShowSuppressed={onShowSuppressed}
              onSelectDetection={onTarget}
              compact={infoOpen}
            />
          </div>

          {infoOpen && !target && (
            <section className="modal__panel">
              <h3 className="panel__head">
                {T.modal.motionHistory}
                <div className="spacer" />
                <span className="panel__head-note">
                  {leadTrackId} · {fmt.clockOf(originIso, chartFrom)}–
                  {fmt.clockOf(originIso, chartTo)}
                </span>
              </h3>
              <div className="modal__chart">
                {chartLines.length > 0 ? (
                  <RangeChart
                    lines={chartLines}
                    bands={chartBands}
                    originIso={originIso}
                    fromMin={chartFrom}
                    toMin={chartTo + 8}
                    maxRangeM={maxRange}
                    cursorMin={chartTo}
                    width={720}
                    height={300}
                    labelGutter={90}
                  />
                ) : (
                  <p className="panel__empty">Bu araç için hareket kaydı yok.</p>
                )}
              </div>
              <ul className="modal__rows">
                {rows.slice(0, 6).map((row) => (
                  <li
                    key={row.state.track_id}
                    className="modal__row"
                    data-lead={row.state.track_id === leadTrackId}
                  >
                    <GlyphChip band={bandOf(row.level, row.score)} />
                    <b className="modal__row-id">{row.state.track_id}</b>
                    <span>{row.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {infoOpen && target && (
            <section className="modal__panel modal__panel--target">
              <div className="modal__target">
                <h3 className="panel__head">
                  {T.modal.target}
                  <span className="panel__head-note">
                    {targetTrackId ?? target.det_id} · {classLabel(target.cls)} ·{' '}
                    {Math.round(target.bbox_px[2] - target.bbox_px[0])}×
                    {Math.round(target.bbox_px[3] - target.bbox_px[1])} px
                  </span>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="modal__close"
                    onClick={() => onTarget(null)}
                    aria-label="Hedef kırpımını kapat"
                  >
                    ✕
                  </button>
                </h3>
                <div className="modal__crop">
                  <CameraFrame
                    frame={frame}
                    imageUrl={imageUrl}
                    evaluated
                    selectedDetId={target.det_id}
                    showSuppressed={false}
                    onShowSuppressed={() => {}}
                    onSelectDetection={() => {}}
                    compact
                    crop={cropAround(target.bbox_px, frame.width_px, frame.height_px)}
                  />
                </div>
              </div>

              <div className="modal__readings">
                <Reading
                  label="TESPİT GÜVENİ"
                  value={fmt.percent(target.score)}
                  caption={
                    target.score >= 0.7
                      ? T.modal.highConfidence
                      : target.score >= 0.4
                        ? T.modal.midConfidence
                        : T.modal.lowConfidence
                  }
                  colour={
                    target.score >= 0.7
                      ? 'var(--terrain)'
                      : target.score >= 0.4
                        ? 'var(--risk-review)'
                        : 'var(--risk-threat)'
                  }
                  fraction={target.score}
                />
                <ThreatReading level={targetAlert?.level ?? null} score={targetAlert?.breakdown.score ?? 0} />
              </div>

              <div className="modal__assessment">
                <h4 className="modal__assessment-title">
                  {T.modal.assessment} · {frame.image_id}
                </h4>
                <p className="modal__assessment-text">
                  {targetAlert
                    ? alertEvidence(targetAlert)
                    : `Bu tespit hiçbir hareket kaydıyla eşleşmedi (${fmt.distance(
                        frame.untracked.find((u) => u.det_id === target.det_id)
                          ?.nearest_track_dist_m ?? null,
                      )} en yakın ize).`}
                </p>
                <p className="modal__provenance muted">
                  {T.modal.provenance} · alan {fmt.count(Math.round(target.area_m2))} m²
                  {targetTrackId && ` · hareket: ${targetTrackId}`}
                  <br />
                  rapor: field_reports.json
                  {frame.funnel &&
                    ` · tespit süzmesi: ${fmt.count(frame.funnel.raw)} → ${fmt.count(frame.funnel.kept)}`}
                </p>
              </div>
            </section>
          )}
        </div>

        <div
          className="modal__rationale"
          id="modal-rationale"
          style={
            threat
              ? undefined
              : { borderColor: 'var(--risk-review)', background: 'var(--risk-review-wash)' }
          }
        >
          <h3
            className="modal__rationale-title"
            style={{ color: threat ? 'var(--ink-muted)' : 'var(--risk-review-ink)' }}
          >
            {threat ? T.modal.rationale : T.modal.uncertain}
          </h3>
          {threat ? (
            <p>{brief.summary || brief.headline}</p>
          ) : (
            <ul>
              {uncertaintyLines(brief).map((line, i) => (
                <li key={i}>· {line}</li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal__actions">
          <button
            type="button"
            className={infoOpen ? 'btn btn--action btn--primary' : 'btn btn--action'}
            onClick={() => onInfoOpen(!infoOpen)}
          >
            {infoOpen ? T.modal.hideDetail : T.modal.showDetail}
          </button>

          <label className="modal__note">
            <span className="sr-only">Operatör kimliği</span>
            <input className="input" type="text" value={operator} placeholder="Operatör kimliği"
              onChange={(event) => {
                setOperator(event.target.value);
                globalThis.localStorage?.setItem('goru.operator', event.target.value);
              }} />
          </label>
          <label className="modal__note">
            <span className="sr-only">{T.modal.noteLabel}</span>
            <input
              className="input"
              type="text"
              value={note}
              placeholder={T.modal.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          {threat ? (
            <>
              <button
                type="button"
                className="btn btn--action"
                disabled={!canDecide}
                onClick={() => onDecide('false_alarm', note, operator)}
              >
                {T.modal.falseAlarm}
              </button>
              <button
                type="button"
                className="btn btn--threat"
                disabled={!canDecide}
                onClick={() => onDecide('confirmed', note, operator)}
              >
                {T.modal.confirmThreat}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn--action"
                disabled={!canDecide}
                onClick={() => onDecide('not_threat', note, operator)}
              >
                {T.modal.notThreat}
              </button>
              <button
                type="button"
                className="btn btn--review"
                disabled={!canDecide}
                onClick={() => onDecide('marked_threat', note, operator)}
              >
                {T.modal.markThreat}
              </button>
            </>
          )}
        </footer>
      </div>
    </>
  );
});

/**
 * What the agent could not settle.
 *
 * Built from the evidence rather than written: a contradicting report that the
 * trust policy refused, a detection the matcher could not place, a track the
 * detector missed. These are the real reasons a verdict is uncertain.
 */
function uncertaintyLines(brief: AssembledBrief): string[] {
  const out: string[] = [];
  for (const line of brief.reportLines) {
    if (line.report.consistency === 'contradicts') {
      out.push(
        `${line.report.report_id} (${line.report.source}) bulgularımızla çelişiyor — reddetme kararı operatör onayı ister.`,
      );
    }
  }
  for (const finding of brief.findings.slice(1)) out.push(finding.text);
  if (out.length === 0) out.push(brief.headline);
  return out.slice(0, 4);
}

function Reading({
  label,
  value,
  caption,
  colour,
  fraction,
}: {
  label: string;
  value: string;
  caption: string;
  colour: string;
  fraction: number;
}) {
  return (
    <div className="reading">
      <span className="reading__label">{label}</span>
      <p className="reading__value">
        <b style={{ color: colour }}>{value}</b>
        <span className="muted">{caption}</span>
      </p>
      <div className="reading__bar">
        <span style={{ width: `${Math.round(fraction * 100)}%`, background: colour }} />
      </div>
      <ul className="reading__scale">
        <li>
          <span style={{ background: 'var(--terrain)' }} />≥%70
        </li>
        <li>
          <span style={{ background: 'var(--risk-review)' }} />%40–70
        </li>
        <li>
          <span style={{ background: 'var(--risk-threat)' }} />&lt;%40
        </li>
      </ul>
    </div>
  );
}

/** The threat reading: a 0-1-2 step scale, matching the map's three shapes. */
function ThreatReading({ level, score }: { level: string | null; score: number }) {
  const step = level === 'ALERT' ? 2 : level === 'WATCH' ? 1 : 0;
  const band = bandOf(level as never, score);
  const style = riskStyle(band);
  const word =
    step === 2 ? T.modal.threatDangerous : step === 1 ? T.modal.threatSuspect : T.modal.threatSafe;

  return (
    <div className="reading">
      <span className="reading__label">{T.modal.threatLevel}</span>
      <p className="reading__value">
        <b style={{ color: style.textColor, fontSize: 'var(--text-score)' }}>{step}</b>
        <span
          className="reading__badge"
          style={{
            background: style.color,
            color: step === 1 ? 'var(--risk-review-deep)' : 'var(--ink-inverse)',
          }}
        >
          {word}
        </span>
      </p>
      <div className="reading__steps">
        {[0, 1, 2].map((i) => (
          <span key={i} style={i === step ? { background: style.color } : undefined} />
        ))}
      </div>
      <ul className="reading__scale">
        <li>
          <span style={{ background: 'var(--risk-safe)' }} />
          {T.modal.threatScale0}
        </li>
        <li>
          <span style={{ background: 'var(--risk-review)' }} />
          {T.modal.threatScale1}
        </li>
        <li>
          <span style={{ background: 'var(--risk-threat)' }} />
          {T.modal.threatScale2}
        </li>
      </ul>
    </div>
  );
}
