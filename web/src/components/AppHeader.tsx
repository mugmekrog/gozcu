/* The header bar: identity, provenance pills, and the LLM brief switch.
 *
 * The two pills are the honesty row. `dedektör: YOLO + RF-DETR` names where the detections
 * came from, and the LLM pill says whether a brief is model output or the
 * deterministic rule template -- which is the difference between "the agent
 * judged this" and "the rules did", and an operator is entitled to know which
 * they are reading before they act on it.
 */

import { memo } from 'react';
import { T } from '@/domain/strings';
import { Switch } from './Switch';
import './app-header.css';

export interface AppHeaderProps {
  llmConnected: boolean;
  briefEnabled: boolean;
  onBriefEnabledChange: (enabled: boolean) => void;
}

export const AppHeader = memo(function AppHeader({
  llmConnected,
  briefEnabled,
  onBriefEnabledChange,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <h1 className="app-header__brand">{T.app.title}</h1>

      <div className="app-header__pills">
        <span className="pill">
          <span className="pill__dot" aria-hidden="true" />
          {T.app.detector}
        </span>
        <span className={llmConnected ? 'pill' : 'pill pill--strong'}>
          <span
            className="pill__dot"
            style={llmConnected ? { background: 'var(--ink)' } : { background: 'transparent', border: '1px solid var(--ink)' }}
            aria-hidden="true"
          />
          {llmConnected ? T.app.llmOn : T.app.llmOff}
        </span>
      </div>

      <div className="spacer" />

      <Switch
        checked={briefEnabled}
        onChange={onBriefEnabledChange}
        label={T.app.llmBrief}
        disabled={!llmConnected}
      />
    </header>
  );
});
