import { memo } from 'react';
import type { Level, VehicleClass } from '@/domain/types';

export interface VehicleSymbolProps {
  x: number;
  y: number;
  cls: VehicleClass | null;
  level: Level | null;
  size: number;
  opacity?: number;
}

export const VehicleSymbol = memo(function VehicleSymbol({ x, y, cls, level, size, opacity = 1 }: VehicleSymbolProps) {
  const fill = level === 'ALERT' ? 'var(--risk-threat)' : level === 'WATCH'
    ? 'var(--risk-review)' : level === 'CLEAR' ? 'var(--risk-safe)' : 'var(--ink-faint)';
  const stroke = level === 'WATCH' ? 'var(--risk-review-deep)' : 'var(--surface)';
  const common = { fill, stroke, strokeWidth: 1.3, opacity };
  let shape: React.ReactNode;
  switch (cls) {
    case 'van':
      shape = <polygon points={`${x},${y - size * 1.3} ${x + size * 1.2},${y + size} ${x - size * 1.2},${y + size}`} />;
      break;
    case 'truck': {
      const points = Array.from({ length: 10 }, (_, i) => {
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 === 0 ? size * 1.35 : size * 0.6;
        return `${x + Math.cos(angle) * radius},${y + Math.sin(angle) * radius}`;
      }).join(' ');
      shape = <polygon points={points} />;
      break;
    }
    case 'bus':
      shape = <circle cx={x} cy={y} r={size} />;
      break;
    case 'car':
      shape = <rect x={x - size} y={y - size} width={size * 2} height={size * 2} />;
      break;
    default:
      shape = <polygon points={`${x},${y - size} ${x + size},${y} ${x},${y + size} ${x - size},${y}`} />;
  }
  return <g {...common} data-vehicle-class={cls ?? 'unknown'} data-risk-level={level ?? 'unknown'}>{shape}</g>;
});
