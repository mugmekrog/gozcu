/* The brief: the verdict, why, and what it rests on.
 *
 * Anatomy from the top: the level badge and score, the headline, one summary
 * sentence, the findings, how the field reports were judged, suggested actions,
 * and the score broken into the terms that produced it.
 *
 * Two honesty rules are enforced here rather than remembered. The chip in the
 * header says `kural tabanlı` whenever the text came from the deterministic
 * template instead of the model, and when the agent's level differs from the rule
 * baseline both are shown with the agent's dissent quoted -- the display never
 * silently presents one as the other.
 */

import { memo } from 'react';
import { riskStyle } from '@/domain/risk';
import { T } from '@/domain/strings';
import * as fmt from '@/domain/format';
import { LevelBadge } from './LevelBadge';
import { Skeleton } from './Skeleton';
import type { AssembledBrief } from '@/domain/brief';
import type { AssessPhase } from '@/store/useAppStore';
import './brief-card.css';

export interface BriefCardProps {
  brief: AssembledBrief | null;
  phase: AssessPhase;
  imageId: string | null;
  error: string | null;
  stepsDone: number;
  onHoverEvidence?: (ids: readonly string[] | null) => void;
}

export const BriefCard = memo(function BriefCard({
  brief,
  phase,
  imageId,
  error,
  stepsDone,
  onHoverEvidence,
}: BriefCardProps) {
  return (
    <section className="panel brief">
      <h2 className="panel__head">
        {T.agent.brief}
        <div className="spacer" />
        {brief && phase === 'done' && (
          <span className={brief.source === 'rules' ? 'brief__chip brief__chip--rules' : 'brief__chip'}>
            {brief.source === 'rules' ? T.agent.briefRules : T.agent.briefLlm(imageId ?? '')}
          </span>
        )}
      </h2>

      {phase === 'idle' && <p className="panel__empty">{T.agent.briefIdle}</p>}

      {phase === 'running' && (
        <div className="brief__body">
          <Skeleton lines={7} note={T.agent.briefPending(stepsDone, 9)} />
        </div>
      )}

      {phase === 'error' && (
        <div className="brief__body brief__error" role="alert">
          <b>{error ?? 'Değerlendirme tamamlanamadı.'}</b>
          <span className="muted">
            Kare yeniden seçilip Değerlendir’e basılabilir. Kural tabanlı seviye etkilenmedi.
          </span>
        </div>
      )}

      {phase === 'done' && brief && (
        <div className="brief__body">
          {brief.band === 'empty' ? (
            <div className="brief__empty">
              <b>{T.agent.noVehicles}</b>
              <span className="muted">{T.agent.noVehiclesHint}</span>
            </div>
          ) : (
            <>
              <div className="brief__verdict">
                <LevelBadge band={brief.band} />
                <span className="brief__score">
                  {fmt.count(brief.score)}
                  <span className="brief__score-max">/100</span>
                </span>
                <span className="muted">
                  Jev güveni: {brief.confidence}
                </span>
              </div>

              <h3 className="brief__headline">{brief.headline}</h3>
              {brief.summary && <p className="brief__summary">{brief.summary}</p>}

              {brief.dissent && (
                <p className="brief__dissent" role="note">
                  <b>Jev kural tabanıyla aynı fikirde değil.</b> Kural: {brief.dissent.baseline} ·
                  Jev: {brief.dissent.agent}. Gösterilen seviye ikisinin yükseği.
                  {brief.dissent.note && ` "${brief.dissent.note}"`}
                </p>
              )}

              {brief.findings.length > 0 && (
                <section className="brief__section">
                  <h4 className="brief__section-title">{T.agent.findings}</h4>
                  <ul>
                    {brief.findings.map((finding, i) => (
                      <li
                        key={i}
                        className="brief__cite"
                        onPointerEnter={() => onHoverEvidence?.(finding.cites)}
                        onPointerLeave={() => onHoverEvidence?.(null)}
                      >
                        · {finding.text}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {brief.reportLines.length > 0 && (
                <section className="brief__section">
                  <h4 className="brief__section-title">{T.agent.reportReview}</h4>
                  <ul>
                    {brief.reportLines.map((line) => (
                      <li key={line.report.report_id}>
                        · <b>{line.report.report_id}</b> · {line.report.source} · {line.report.hhmm}{' '}
                        — <b>{line.verdict}</b>
                        {line.detail && `: ${line.detail}`}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {brief.actions.length > 0 && (
                <section className="brief__section">
                  <h4 className="brief__section-title">{T.agent.actions}</h4>
                  <ol className="brief__actions">
                    {brief.actions.map((action, i) => (
                      <li key={i}>
                        {i + 1}. {action}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {brief.breakdown && brief.breakdown.terms.length > 0 && (
                <section className="brief__section">
                  <h4 className="brief__section-title">{T.agent.scoreBreakdown}</h4>
                  <ul className="brief__terms">
                    {brief.breakdown.terms.map((term) => (
                      <li key={term.label} title={term.detail}>
                        <span>{term.label}</span>
                        <div className="spacer" />
                        <b>{fmt.signed(term.points)}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="brief__total">
                    <span>
                      {T.agent.scoreBase} {fmt.count(brief.breakdown.base_score)}
                      {brief.breakdown.heavy_multiplier &&
                        ` · ağır araç ×${brief.breakdown.heavy_multiplier}`}
                      {brief.dissent && ` · ${T.agent.scoreAgent}`}
                    </span>
                    <b>= {fmt.count(brief.breakdown.score)}</b>
                  </p>
                </section>
              )}

              {brief.source === 'rules' && (
                <p className="brief__footnote" style={{ color: riskStyle(brief.band).textColor }}>
                  {T.agent.rulesOnlyNote}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
});
