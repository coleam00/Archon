import { useId, useMemo, type ReactElement } from 'react';
import {
  BACK,
  BACK_DASH,
  BACK_OPACITY,
  HeadMarker,
  LinePill,
  rounded,
  STROKE,
} from '../canvas-lines';
import { branchFlow } from '../lib/map-flow';
import type { MapLayout } from '../lib/map-layout';
import type { CardSendBacks } from '../lib/map-send-backs';
import { FlowDot } from './FlowDot';
import { useReducedMotion } from './useReducedMotion';

/** A branch dot's radius and its halo's: smaller than the forward flow's dot. */
const BRANCH_R = 2.5;
const BRANCH_HALO_R = 5;

/**
 * The send-backs of the card that shows them (hovered, focused or pinned, `useShownSendBacks`),
 * in rule 4: each route on its own dashed line in the send-back colour, from the stage it leaves
 * to the stage it returns to, its pill under the routes. While motion is allowed, a small dot
 * leaves the card along each route at once, on one timeline, over and over, so the ways back
 * read as branches of the flow. The caller keys it by card, so a newly shown card's dots start
 * at the card.
 */
export function MapSendBacks({
  bounds,
  card,
}: {
  bounds: MapLayout['bounds'];
  card: CardSendBacks;
}): ReactElement {
  const head = `${useId()}-back`;
  const reduced = useReducedMotion();
  const flow = useMemo(() => (reduced ? undefined : branchFlow(card.routes)), [reduced, card]);
  const dur = flow === undefined ? '' : `${flow.period.toString()}ms`;
  return (
    <svg
      aria-hidden="true"
      data-send-backs=""
      className="pointer-events-none absolute overflow-visible"
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
      viewBox={`${bounds.x.toString()} ${bounds.y.toString()} ${bounds.w.toString()} ${bounds.h.toString()}`}
    >
      <defs>
        <HeadMarker id={head} colour={BACK} />
      </defs>
      {card.routes.map(route => (
        <g key={route.id} data-route={`${route.from}>${route.to}`}>
          <path
            d={rounded(route.points)}
            fill="none"
            stroke={BACK}
            strokeWidth={STROKE}
            strokeDasharray={BACK_DASH}
            strokeOpacity={BACK_OPACITY}
            markerEnd={`url(#${head})`}
          />
          {route.pill === undefined ? null : (
            <g data-route-pill={`${route.from}>${route.to}`}>
              <LinePill pill={route.pill.box} lines={route.pill.lines} />
            </g>
          )}
        </g>
      ))}
      {flow?.moves.map(move => (
        <FlowDot
          key={`${move.from}>${move.to}`}
          move={move}
          period={flow.period}
          dur={dur}
          colour={BACK}
          r={BRANCH_R}
          haloR={BRANCH_HALO_R}
          data={{ 'data-branch-dot': `${move.from}>${move.to}` }}
        />
      ))}
    </svg>
  );
}
