/* The view menu: a panel inside the map card, not a page navigation.
 *
 * It slides over the map only, leaving the agent column live -- which is the
 * point of wireframe 1b: an operator changes how they are looking at the day
 * without losing the evaluation they were reading. Escape and a click on the
 * scrim close it, and focus moves into the panel so a keyboard user is not left
 * behind the scrim. Each item shows the key that switches to it from anywhere.
 */

import { memo, useEffect, useRef } from 'react';
import { T } from '@/domain/strings';
import type { ViewName } from '@/store/useAppStore';
import './view-menu.css';

export interface ViewMenuProps {
  current: ViewName;
  onSelect: (view: ViewName) => void;
  onClose: () => void;
}

/** Line icons drawn in currentColor, so the active tile can invert them. */
const ICONS: Record<ViewName, JSX.Element> = {
  map: (
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 10 14.5 5.5" />
    </>
  ),
  motion: (
    <>
      <path d="M3 16h14" />
      <path d="M4 13 8 8.5l3 2.5 5-6" />
    </>
  ),
  logs: (
    <>
      <rect x="4" y="3" width="12" height="14" rx="1.5" />
      <path d="M7 7h6M7 10h6M7 13h4" />
    </>
  ),
};

/** The shortcut keys App binds for each view. */
const ITEMS: { view: ViewName; name: string; description: string; key: string }[] = [
  { view: 'map', name: T.view.mapName, description: T.view.mapDesc, key: 'M' },
  { view: 'motion', name: T.view.motionName, description: T.view.motionDesc, key: 'H' },
  { view: 'logs', name: T.view.logsName, description: T.view.logsDesc, key: 'K' },
];

export const ViewMenu = memo(function ViewMenu({ current, onSelect, onClose }: ViewMenuProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button[data-current="true"], button')?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="view-menu__scrim" onClick={onClose} />
      <div
        className="view-menu"
        ref={panel}
        role="dialog"
        aria-modal="false"
        aria-label={T.view.menuTitle}
      >
        <div className="view-menu__head">
          <div>
            <p className="view-menu__title">{T.view.menuTitle}</p>
            <p className="view-menu__hint">{T.view.menuHint}</p>
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="view-menu__close"
            onClick={onClose}
            aria-label={T.view.menuClose}
            title={`${T.view.menuClose} (Esc)`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </div>
        <ul className="view-menu__list">
          {ITEMS.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className="view-menu__item"
                data-current={item.view === current}
                aria-current={item.view === current ? 'true' : undefined}
                aria-keyshortcuts={item.key}
                onClick={() => onSelect(item.view)}
              >
                <span className="view-menu__icon" aria-hidden="true">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {ICONS[item.view]}
                  </svg>
                </span>
                <span className="view-menu__text">
                  <span className="view-menu__name">{item.name}</span>
                  <span className="view-menu__desc">{item.description}</span>
                </span>
                <kbd className="view-menu__key">{item.key}</kbd>
              </button>
            </li>
          ))}
        </ul>
        <p className="view-menu__foot">
          <kbd className="view-menu__key">Esc</kbd> {T.view.menuEsc}
        </p>
      </div>
    </>
  );
});
