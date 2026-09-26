/* The view menu: a panel inside the map card, not a page navigation.
 *
 * It slides over the map only, leaving the agent column live -- which is the
 * point of wireframe 1b: an operator changes how they are looking at the day
 * without losing the evaluation they were reading. Escape and a click on the
 * scrim close it, and focus moves into the panel so a keyboard user is not left
 * behind the scrim.
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

const ITEMS: { view: ViewName; icon: string; name: string; description: string }[] = [
  { view: 'map', icon: '🗺', name: T.view.mapName, description: T.view.mapDesc },
  { view: 'motion', icon: '📈', name: T.view.motionName, description: T.view.motionDesc },
  { view: 'logs', icon: '🗂', name: T.view.logsName, description: T.view.logsDesc },
  { view: 'voice', icon: '🎙', name: T.view.voiceName, description: T.view.voiceDesc },
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
          {T.view.menuTitle}
          <div className="spacer" />
          <button type="button" className="view-menu__close" onClick={onClose}>
            {T.view.menuClose}
          </button>
        </div>
        <ul>
          {ITEMS.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className="view-menu__item"
                data-current={item.view === current}
                aria-current={item.view === current ? 'true' : undefined}
                onClick={() => onSelect(item.view)}
              >
                <span className="view-menu__name">
                  <span aria-hidden="true">{item.icon}</span> {item.name}
                </span>
                <span className="view-menu__desc">{item.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
});
