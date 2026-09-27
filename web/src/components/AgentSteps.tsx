/* The agent's step list: what it did, in order, with what it found.
 *
 * This panel is the system's answer to "why should I believe this?" -- it shows
 * the chain from opening an image to a level, and it shows the failures too: a
 * tool call as an indented blue line, a report the guardrails refused as an amber
 * line, an unreachable gateway as a red line that ends in the rules-based brief.
 * Hiding a failure here would make the whole panel worthless.
 *
 * Each numbered step reads like a lab notebook entry: "3/9 · STEP", one sentence
 * on what was done, then the values it produced in a fixed-width face (see
 * domain/steps.ts). The list collapses to one row once the run finishes, because
 * by then the brief below it is what an operator is reading.
 */

import { memo } from 'react';
import { T } from '@/domain/strings';
import type { AgentStep } from '@/api';
import type { AssessPhase } from '@/store/useAppStore';
import './agent-steps.css';

export interface AgentStepsProps {
  steps: readonly AgentStep[];
  phase: AssessPhase;
  elapsedMs: number;
  toolCalls: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

const ICON: Record<AgentStep['state'], string> = {
  pending: '○',
  active: '◐',
  done: '✓',
  tool: 'ƒ',
  warn: '●',
  error: '✕',
};

export const AgentSteps = memo(function AgentSteps({
  steps,
  phase,
  elapsedMs,
  toolCalls,
  expanded,
  onExpandedChange,
}: AgentStepsProps) {
  const total = 9;
  const done = steps.filter((s) => s.state === 'done' && s.index !== null).length;
  const seconds = (elapsedMs / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 });

  return (
    <section className="panel agent-steps">
      <h2 className="panel__head">
        {T.agent.steps}
        <div className="spacer" />
        {phase === 'running' && (
          <span className="panel__head-note" role="status">
            {done} / {total}
          </span>
        )}
        {(phase === 'done' || phase === 'error') && (
          <>
            <span className="panel__head-note">
              {phase === 'error' ? `${done} / ${total} · 1 hata` : T.agent.stepsDone(total, toolCalls, seconds)}
            </span>
            <button
              type="button"
              className="agent-steps__toggle"
              aria-expanded={expanded}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? T.agent.stepsHide : T.agent.stepsShow}
            </button>
          </>
        )}
      </h2>

      {phase === 'idle' && <p className="panel__empty">{T.agent.stepsIdle}</p>}

      {phase !== 'idle' && expanded && (
        <ol className="agent-steps__list">
          {steps.map((step) => (
            <li
              key={step.id}
              className="agent-steps__row"
              data-state={step.state}
              aria-current={step.state === 'active' ? 'step' : undefined}
            >
              <span className="agent-steps__text">
                <span className="agent-steps__title">
                  <span className="agent-steps__icon" aria-hidden="true">
                    {ICON[step.state]}
                  </span>
                  {step.index !== null && (
                    <span className="agent-steps__index">
                      {step.index}/{total}
                    </span>
                  )}
                  <span className="agent-steps__name">
                    {step.index !== null ? step.title.toLocaleUpperCase('tr-TR') : step.title}
                  </span>
                  {step.ms !== null && step.state !== 'active' && (
                    <span className="agent-steps__time">
                      {step.ms < 1000
                        ? `${step.ms} ms`
                        : `${(step.ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn`}
                    </span>
                  )}
                </span>
                {step.detail && <span className="agent-steps__detail">{step.detail}</span>}
                {step.lines && step.lines.length > 0 && (
                  <span className="agent-steps__lines">
                    {step.lines.map((line, i) => (
                      <span key={i} className="agent-steps__line">
                        {line}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});
