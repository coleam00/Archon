import { type ReactElement, useId } from 'react';
import { FlowGradient, HeadMarker, LINE_TO, LinePill, MAIN_STROKE } from '../canvas-lines';
import type { MapLayout } from '../lib/map-layout';

/**
 * The map's forward lines in the Visual standard's rule 4: each hand-off solid, brightening
 * along the flow, its label on a pill above it. A card's send-backs are drawn apart, only
 * while it shows them (`MapSendBacks`).
 */
export function MapArrows({
  layout,
}: {
  layout: Pick<MapLayout, 'arrows' | 'bounds'>;
}): ReactElement {
  const { arrows, bounds } = layout;
  // Unique per mount, so two maps on one page never share a gradient.
  const gradient = `${useId()}-flow`;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute overflow-visible"
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
      viewBox={`${bounds.x.toString()} ${bounds.y.toString()} ${bounds.w.toString()} ${bounds.h.toString()}`}
    >
      <defs>
        <HeadMarker id="factory-map-head" colour={LINE_TO} />
        {arrows.map((arrow, i) => (
          <FlowGradient
            key={arrow.id}
            id={`${gradient}-${i.toString()}`}
            from={arrow.start}
            to={arrow.end}
          />
        ))}
      </defs>
      {arrows.map((arrow, i) => (
        <g key={arrow.id} data-arrow={arrow.id}>
          <path
            d={arrow.d}
            fill="none"
            stroke={`url(#${gradient}-${i.toString()})`}
            strokeWidth={MAIN_STROKE}
            markerEnd="url(#factory-map-head)"
          />
          {arrow.pill === undefined ? null : <LinePill pill={arrow.pill} lines={arrow.lines} />}
        </g>
      ))}
    </svg>
  );
}
