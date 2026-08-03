/**
 * Renders smart-guide helper lines in flow coordinates while a node drags.
 * The math lives in `editor/smart-guides.ts` (unit-tested); this overlay just
 * draws the result inside xyflow's `ViewportPortal` so the lines pan/zoom
 * with the canvas.
 */
import { type ReactElement } from 'react';
import { ViewportPortal } from '@xyflow/react';

interface SmartGuidesProps {
  vertical: readonly number[];
  horizontal: readonly number[];
}

const LINE_EXTENT = 100000;

export function SmartGuides({ vertical, horizontal }: SmartGuidesProps): ReactElement | null {
  if (vertical.length === 0 && horizontal.length === 0) return null;
  return (
    <ViewportPortal>
      {vertical.map(x => (
        <div
          key={`v:${x}`}
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: x,
            top: -LINE_EXTENT / 2,
            width: 1,
            height: LINE_EXTENT,
            background: 'var(--accent-bright)',
            opacity: 0.6,
          }}
        />
      ))}
      {horizontal.map(y => (
        <div
          key={`h:${y}`}
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: y,
            left: -LINE_EXTENT / 2,
            height: 1,
            width: LINE_EXTENT,
            background: 'var(--accent-bright)',
            opacity: 0.6,
          }}
        />
      ))}
    </ViewportPortal>
  );
}
