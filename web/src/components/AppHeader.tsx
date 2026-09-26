/* A short Turkish title for the map and review workspace, and the switch that
 * lets a presenter turn the mobile-push preview on and off. */

import { memo } from 'react';
import { T } from '@/domain/strings';
import { Switch } from './Switch';
import './app-header.css';

export interface AppHeaderProps {
  notifyEnabled: boolean;
  onNotifyEnabledChange: (enabled: boolean) => void;
}

export const AppHeader = memo(function AppHeader({
  notifyEnabled,
  onNotifyEnabledChange,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <span className="app-header__mark" aria-hidden="true">◎</span>
      <h1 className="app-header__brand">{T.app.title}</h1>
      <span className="app-header__sub">Korunan bölgeler ve araç izleri</span>
      <Switch checked={notifyEnabled} onChange={onNotifyEnabledChange} label={T.app.mobileNotify} />
    </header>
  );
});
