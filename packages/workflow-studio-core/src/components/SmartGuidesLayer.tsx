import type { ReactElement } from 'react';
import type { Guide } from '../smart-guides';

interface Props {
  guides: Guide[];
  width: number;
  height: number;
}

export function SmartGuidesLayer({ guides, width, height }: Props): ReactElement | null {
  if (guides.length === 0) return null;
  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 10 }}
      width={width}
      height={height}
    >
      {guides.map((g, i) =>
        g.type === 'vertical' ? (
          <line
            key={i}
            x1={g.position}
            y1={0}
            x2={g.position}
            y2={height}
            stroke="#f59e0b"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        ) : (
          <line
            key={i}
            x1={0}
            y1={g.position}
            x2={width}
            y2={g.position}
            stroke="#f59e0b"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        )
      )}
    </svg>
  );
}
