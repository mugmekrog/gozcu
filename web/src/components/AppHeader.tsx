/* A short Turkish title for the map and review workspace. */

import { memo } from 'react';
import { T } from '@/domain/strings';
import './app-header.css';

export const AppHeader = memo(function AppHeader() {
  return (
    <header className="app-header">
      <span className="app-header__mark" aria-hidden="true">◎</span>
      <h1 className="app-header__brand">{T.app.title}</h1>
      <span className="app-header__sub">Korunan bölgeler ve araç izleri</span>
    </header>
  );
});
