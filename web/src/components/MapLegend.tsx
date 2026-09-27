/* The legend, on the map and doing work.
 *
 * It used to be a strip of static swatches in the toolbar: it said what the
 * shapes and colours meant and then made the operator go and find a dropdown to
 * act on it. Here each entry is a button. One press isolates that vehicle type
 * or that warning level; pressing it again puts everything back. That is the
 * fastest thing a legend can be, and it is the same two filters the toolbar
 * dropdowns drive, so the two never disagree.
 *
 * Unassessed is a row of its own because it is most of the map most of the
 * time -- at 10:10 there are 87 of them behind 4 judged vehicles -- and hiding
 * them is the single most useful press on this control.
 */

import { memo } from 'react';
import { T } from '@/domain/strings';
import { HEAT_RAMP } from '@/radar/HeatLayer';
import { framePath, LEVEL_STYLES, VEHICLE_ICONS } from '@/radar/VehicleSymbol';
import type { LevelFilter } from '@/domain/live';
import type { VehicleClass } from '@/domain/types';
import { useAppStore } from '@/store/useAppStore';
import './map-legend.css';

const CLASSES: VehicleClass[] = ['car', 'van', 'truck', 'bus'];

/** The map's own icon, at chip size, so the legend and the map cannot drift. */
const ClassMark = ({ cls }: { cls: VehicleClass }) => (
  <svg className="map-legend__mark" viewBox="-1.1 -1.1 2.2 2.2" width="22" height="22" aria-hidden="true">
    <path d={VEHICLE_ICONS[cls]} fill="var(--ink)" />
  </svg>
);

/** The map's own frame, so a level reads by shape here too, not only colour. */
const LevelMark = ({ level }: { level: Exclude<LevelFilter, 'all'> }) => {
  const key = level === 'unassessed' || level === 'judged' ? 'pending' : level;
  const style = LEVEL_STYLES[key];
  return (
    <svg className="map-legend__mark" viewBox="-7.6 -7.6 15.2 15.2" width="22" height="22" aria-hidden="true">
      {style.frame === 'pending' ? (
        <circle r={5.6} fill="none" stroke={style.ink} strokeWidth={1.6} strokeDasharray="2.2 1.7" />
      ) : (
        <path d={framePath(style.frame, 5.6)} fill={style.fill} stroke={style.stroke} strokeWidth={1.1} />
      )}
    </svg>
  );
};

const LEVELS: { level: Exclude<LevelFilter, 'all'>; label: string }[] = [
  { level: 'CLEAR', label: T.legend.safe },
  { level: 'WATCH', label: T.legend.review },
  { level: 'ALERT', label: T.legend.threat },
  { level: 'unassessed', label: T.legend.unassessed },
];

/* The one press that clears the map: at 10:10 the drone has judged 4 vehicles
 * and is still following 87 it has not reached, so "show me only what has been
 * ruled on" is worth a chip of its own. */
const JUDGED: Exclude<LevelFilter, 'all'> = 'judged';

export const MapLegend = memo(function MapLegend() {
  const classFilter = useAppStore((s) => s.classFilter);
  const levelFilter = useAppStore((s) => s.levelFilter);
  const heatOn = useAppStore((s) => s.layers.heat);
  const setClassFilter = useAppStore((s) => s.setClassFilter);
  const setLevelFilter = useAppStore((s) => s.setLevelFilter);

  const filtered = classFilter !== 'all' || levelFilter !== 'all';

  /** A press isolates; the same press again clears. */
  const toggleClass = (cls: VehicleClass) => setClassFilter(classFilter === cls ? 'all' : cls);
  const toggleLevel = (level: LevelFilter) => setLevelFilter(levelFilter === level ? 'all' : level);

  return (
    <div className="map-legend">
      <div className="map-legend__row" role="group" aria-label={T.filter.class}>
        {!heatOn && <h3 className="map-legend__title">{T.filter.class}</h3>}
        {CLASSES.map((cls) => (
          <button
            key={cls}
            type="button"
            className="map-legend__chip map-legend__chip--class"
            aria-pressed={classFilter === cls}
            data-muted={classFilter !== 'all' && classFilter !== cls ? '' : undefined}
            title={T.legend.only(T.cls[cls])}
            onClick={() => toggleClass(cls)}
          >
            <ClassMark cls={cls} />
            {T.cls[cls]}
          </button>
        ))}
      </div>

      <span className="map-legend__split" aria-hidden="true" />

      <div className="map-legend__row" role="group" aria-label={T.legend.levels}>
        {!heatOn && <h3 className="map-legend__title">{T.legend.levels}</h3>}
        {LEVELS.map(({ level, label }) => (
          <button
            key={level}
            type="button"
            className="map-legend__chip"
            aria-pressed={levelFilter === level}
            data-muted={levelFilter !== 'all' && levelFilter !== level ? '' : undefined}
            title={T.legend.only(label)}
            onClick={() => toggleLevel(level)}
          >
            <LevelMark level={level} />
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="map-legend__chip map-legend__chip--wide"
        aria-pressed={levelFilter === JUDGED}
        title={T.legend.only(T.legend.judged)}
        onClick={() => toggleLevel(JUDGED)}
      >
        {T.legend.judged}
      </button>

      {filtered && (
        <button type="button" className="map-legend__clear" onClick={() => {
          setClassFilter('all');
          setLevelFilter('all');
        }}>
          {T.legend.clear}
        </button>
      )}

      {heatOn && (
        <>
          <span className="map-legend__split" aria-hidden="true" />
          <span className="map-legend__heat" aria-label={T.heat.ramp}>
            {T.heat.legend}
            {HEAT_RAMP.map((colour) => <i key={colour} style={{ background: colour }} aria-hidden="true" />)}
          </span>
        </>
      )}
    </div>
  );
});
