import { type ReactElement, useId } from 'react';
import {
  BACK,
  BACK_DASH,
  BACK_OPACITY,
  FlowGradient,
  HeadMarker,
  LINE,
  LINE_TO,
  LinePill,
  MAIN_STROKE,
  rounded,
  SHADOW,
  STROKE,
} from '../canvas-lines';
import type { Box } from '../lib/map-layout';
import type { OverviewEdgePath, OverviewFan } from '../lib/overview-layout';

/*
 * Lines in the Visual standard's rule 4 (`canvas-lines.tsx`): a forward line 2 px, brightening
 * along the flow; asks dotted; send-backs dashed and a little quieter; a shadow line as it was.
 */

const DASH: Record<OverviewEdgePath['kind'], string | undefined> = {
  feeds: undefined,
  calls: '2 3',
  'loops-back': BACK_DASH,
};

/** The colour a line is drawn in, and the arrowhead marker of that colour. */
function colourOf(edge: {
  kind: OverviewEdgePath['kind'];
  shadow: boolean;
}): 'flow' | 'line' | 'back' | 'shadow' {
  if (edge.shadow) return 'shadow';
  if (edge.kind === 'loops-back') return 'back';
  return edge.kind === 'feeds' ? 'flow' : 'line';
}
/** `flow` is a forward line's head, in the colour its gradient ends on. */
const COLOURS = { flow: LINE_TO, line: LINE, back: BACK, shadow: SHADOW } as const;

/**
 * A view's edges and fans, under its cards, with an arrowhead at each target card and each
 * label on a pill set off its line. An edge into a parallel group ends on the group's bar
 * without a head; the bar's stubs carry the heads into each member.
 */
export function OverviewEdges({
  edges,
  fans,
  bounds,
}: {
  edges: readonly OverviewEdgePath[];
  fans: readonly OverviewFan[];
  bounds: Box;
}): ReactElement {
  const fannedIn = new Set(fans.filter(fan => fan.into).map(fan => fan.group));
  // Unique per mount: full screen remounts this SVG beside the page's.
  const gradient = `${useId()}-flow`;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute overflow-visible"
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
      viewBox={`${bounds.x.toString()} ${bounds.y.toString()} ${bounds.w.toString()} ${bounds.h.toString()}`}
    >
      <defs>
        {(Object.keys(COLOURS) as (keyof typeof COLOURS)[]).map(id => (
          <HeadMarker key={id} id={`overview-head-${id}`} colour={COLOURS[id]} />
        ))}
        {edges.map((edge, i) => {
          const [from, to] = [edge.points[0], edge.points.at(-1)];
          return colourOf(edge) !== 'flow' || from === undefined || to === undefined ? null : (
            <FlowGradient
              key={`${edge.from}->${edge.to}:${edge.kind}`}
              id={`${gradient}-${i.toString()}`}
              from={from}
              to={to}
            />
          );
        })}
      </defs>
      {edges.map((edge, i) => (
        <EdgeLine
          key={`${edge.from}->${edge.to}:${edge.kind}`}
          edge={edge}
          head={!fannedIn.has(edge.to)}
          gradient={`${gradient}-${i.toString()}`}
        />
      ))}
      {fans.map(fan => (
        <FanLines key={`${fan.group}:${fan.side}`} fan={fan} />
      ))}
      {edges.map(edge =>
        edge.pill === undefined || edge.label === undefined ? null : (
          <LinePill
            key={`${edge.from}->${edge.to}:${edge.kind}`}
            pill={edge.pill}
            lines={[edge.label]}
            shadow={edge.shadow}
          />
        )
      )}
    </svg>
  );
}

/** One edge; a forward one is painted with its `gradient`, defined in the SVG's defs. */
function EdgeLine({
  edge,
  head,
  gradient,
}: {
  edge: OverviewEdgePath;
  head: boolean;
  gradient: string;
}): ReactElement {
  const colour = colourOf(edge);
  const flow = colour === 'flow';
  return (
    <path
      data-edge={edge.kind}
      d={rounded(edge.points)}
      fill="none"
      stroke={flow ? `url(#${gradient})` : COLOURS[colour]}
      strokeWidth={flow ? MAIN_STROKE : STROKE}
      strokeDasharray={DASH[edge.kind]}
      strokeOpacity={colour === 'back' ? BACK_OPACITY : undefined}
      markerEnd={head ? `url(#overview-head-${colour})` : undefined}
    />
  );
}

/**
 * A fan's bar and its stubs, in its edge's style; into the group, each stub ends in a head. A
 * forward fan is solid in the bright end of the flow: its pieces are too short for a gradient.
 */
function FanLines({ fan }: { fan: OverviewFan }): ReactElement {
  const feeds = fan.kind === 'feeds';
  const stroke = {
    fill: 'none',
    stroke: feeds ? LINE_TO : LINE,
    strokeWidth: feeds ? MAIN_STROKE : STROKE,
    strokeDasharray: DASH[fan.kind],
  };
  return (
    <g data-fan={`${fan.group}:${fan.side}`}>
      <path d={rounded(fan.bar)} {...stroke} strokeLinecap="round" />
      {fan.stubs.map(stub => (
        <path
          key={stub.card}
          d={rounded([stub.from, stub.to])}
          {...stroke}
          markerEnd={fan.into ? `url(#overview-head-${feeds ? 'flow' : 'line'})` : undefined}
        />
      ))}
    </g>
  );
}
