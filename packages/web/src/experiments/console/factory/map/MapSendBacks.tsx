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
import type { SendBackRoute } from '../lib/map-send-backs';
import { FlowDot } from './FlowDot';
import { useReducedMotion } from './useReducedMotion';

/** A branch dot's radius and its halo's: smaller than the forward flow's dot. */
const BRANCH_R = 2.5;
const BRANCH_HALO_R = 5;

/** How much a route shows while another card's routes are lit. */
const DIMMED = 0.3;

/**
 * Every send-back on the map, always, in rule 4: each route on its own dashed line in the
 * send-back colour, from the card it leaves to the earlier card it returns to, its pill (where
 * and why) under the routes. While a card is hovered or focused (`useShownSendBacks`), its
 * routes stay as they are and the others dim. While motion is allowed, a small dot leaves its
 * card along each route at once, on one timeline, over and over, so the ways back read as
 * branches of the flow.
 */
export function MapSendBacks({
  bounds,
  routes,
  lit,
}: {
  bounds: MapLayout['bounds'];
  routes: readonly SendBackRoute[];
  /** The card whose routes are lit; null for none, every route as it is. */
  lit: string | null;
}): ReactElement {
  const head = `${useId()}-back`;
  const reduced = useReducedMotion();
  const flow = useMemo(() => (reduced ? undefined : branchFlow(routes)), [reduced, routes]);
  const dur = flow === undefined ? '' : `${flow.period.toString()}ms`;
  const dim = (from: string): boolean => lit !== null && from !== lit;
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
      {routes.map(route => (
        <g
          key={route.id}
          data-route={`${route.from}>${route.to}`}
          data-dimmed={dim(route.from) ? '' : undefined}
          opacity={dim(route.from) ? DIMMED : undefined}
        >
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
