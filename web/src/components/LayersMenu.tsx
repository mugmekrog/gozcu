/* The layers control: one menu over everything the map draws.
 *
 * Mapbox's stack, in the operator's words. Each layer is a real checkbox, so a
 * screen reader announces it as checked and the whole list is one tab stop's
 * worth of arrow keys -- the density field in particular used to be a lone
 * button in the corner of the SVG with no sibling to compare it against.
 *
 * It sits where that button did, bottom-right, and opens upward so the panel
 * never covers the vehicles the operator is ticking layers on and off to see.
 * Escape and a click outside close it; the button keeps focus, so a run of
 * ticks costs one open.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { DEFAULT_LAYERS, LAYER_GROUPS, type MapLayerId } from '@/domain/mapLayers';
import { T } from '@/domain/strings';
import { useAppStore } from '@/store/useAppStore';
import './layers-menu.css';

export const LayersMenu = memo(function LayersMenu() {
  const layers = useAppStore((s) => s.layers);
  const basemap = useAppStore((s) => s.basemap);
  const setLayer = useAppStore((s) => s.setLayer);
  const toggleLayer = useAppStore((s) => s.toggleLayer);

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('.layers-menu__button')?.focus();
    };
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  /** The basemap layers have nothing to show until the city file has landed. */
  const unavailable = (id: MapLayerId) => !basemap && (id === 'basemap' || id === 'labels');
  const shown = LAYER_GROUPS.flatMap((group) => group.layers).filter(
    (layer) => layers[layer.id] && !unavailable(layer.id),
  ).length;

  return (
    <div className="layers-menu" ref={root} data-open={open || undefined}>
      {open && (
        <div className="layers-menu__panel" role="group" aria-label={T.layers.title}>
          <div className="layers-menu__head">
            <p className="layers-menu__title">{T.layers.title}</p>
            <p className="layers-menu__hint">{T.layers.hint}</p>
          </div>
          {LAYER_GROUPS.map((group) => (
            <section key={group.title} className="layers-menu__group">
              <h3 className="layers-menu__group-title">{group.title}</h3>
              {group.layers.map((layer) => {
                const off = unavailable(layer.id);
                return (
                  <label key={layer.id} className="layers-menu__row" data-disabled={off || undefined}>
                    <input
                      type="checkbox"
                      checked={layers[layer.id] && !off}
                      disabled={off}
                      onChange={() => toggleLayer(layer.id)}
                    />
                    <span className="layers-menu__text">
                      <span className="layers-menu__name">{layer.name}</span>
                      <span className="layers-menu__desc">
                        {off ? T.layers.unavailable : layer.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
          <button
            type="button"
            className="layers-menu__reset"
            onClick={() => {
              for (const [id, on] of Object.entries(DEFAULT_LAYERS)) {
                setLayer(id as MapLayerId, on);
              }
            }}
          >
            {T.layers.reset}
          </button>
        </div>
      )}
      <button
        type="button"
        className="layers-menu__button"
        aria-expanded={open}
        aria-label={open ? T.layers.close : T.layers.open}
        title={open ? T.layers.close : T.layers.open}
        onClick={() => setOpen((was) => !was)}
      >
        {/* A stack of sheets, the one symbol every map control uses for this. */}
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M10 2.5 18 7l-8 4.5L2 7z" />
          <path d="M3.6 10 10 13.6 16.4 10" />
          <path d="M3.6 13.2 10 16.8l6.4-3.6" />
        </svg>
        <span className="layers-menu__caption">{T.layers.name}</span>
        <span className="layers-menu__count" aria-hidden="true">{shown}</span>
      </button>
    </div>
  );
});
