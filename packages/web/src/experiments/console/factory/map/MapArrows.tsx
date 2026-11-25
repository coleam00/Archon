import { type ReactElement, useId } from 'react';
import {
  BACK,
  BACK_DASH,
  BACK_OPACITY,
  FlowGradient,
  HeadMarker,
  LINE_TO,
  LinePill,
  MAIN_STROKE,
  rounded,
  STROKE,
} from '../canvas-lines';
import type { MapLayout } from '../lib/map-layout';

/**
 * The map's lines in the Visual standard's rule 4: each forward hand-off solid, brightening
 * along the flow, its label on a pill above it; the feedback lane dashed in the send-back
 * colour, each of its pieces drawn once, and one pill per stage it returns to.
 */
export function MapArrows({
  layout,
}: {
  layout: Pick<MapLayout, 'arrows' | 'feedback' | 'bounds'>;
}): ReactElement {
  const { arrows, feedback, bounds } = layout;
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
        <HeadMarker id="factory-map-head-back" colour={BACK} />
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
      {feedback.strokes.map(stroke => (
        <path
          key={stroke.points.map(p => `${p.x.toString()},${p.y.toString()}`).join(' ')}
          data-lane="feedback"
          d={rounded(stroke.points)}
          fill="none"
          stroke={BACK}
          strokeWidth={STROKE}
          strokeDasharray={BACK_DASH}
          strokeOpacity={BACK_OPACITY}
          markerEnd={stroke.head ? 'url(#factory-map-head-back)' : undefined}
        />
      ))}
      {feedback.pills.map(pill => (
        <g key={pill.stage} data-lane-pill={pill.stage}>
          <LinePill pill={pill.box} lines={[pill.text]} />
        </g>
      ))}
    </svg>
  );
}
