import { memo, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import { LINE, rounded } from '../canvas-lines';
import type { Box } from '../lib/map-layout';
import { overviewFlow, type FlowMove, type OverviewFlow as Flow } from '../lib/overview-flow';
import type { OverviewLayout } from '../lib/overview-layout';
import type { OverviewView } from '../lib/overview-nav';
import { KINDS } from './overview-kinds';
import { useReducedMotion } from './useReducedMotion';

/**
 * A dot's radius, its halo's radius and strength (a second, faint circle, never a blur), how
 * far a card's glow reaches past it, how strong the glow's rim gets and how faint its fill.
 */
const DOT_R = 5;
const HALO_R = 10;
const HALO_OPACITY = 0.28;
const GLOW_PAD = 6;
const GLOW_OPACITY = 0.45;
const GLOW_FILL = 0.12;
/**
 * How long a glow and a dot take to fade in and out, in ms. A dot's is shorter: a hop between
 * neighbours lasts about 270 ms, and the dot should be at full strength for most of it. These
 * are edges inside a span, not durations of the loop, so `FLOW_TEMPO` does not scale them; the
 * shortest spans (a 600 ms rest, a 267 ms hop) still exceed twice the fade.
 */
const GLOW_FADE = 150;
const DOT_FADE = 80;

/**
 * The view's flow when it has one, motion is allowed and `animate` asks for it (the root view
 * only); undefined otherwise, and then neither the dots nor their Pause control are drawn.
 */
export function useOverviewFlow(
  view: OverviewView,
  layout: OverviewLayout,
  animate: boolean
): Flow | undefined {
  const reduced = useReducedMotion();
  const flow = useMemo(
    () => (animate ? overviewFlow(view, layout) : undefined),
    [animate, view, layout]
  );
  return reduced ? undefined : flow;
}

/**
 * `ms` as SMIL key times within `period`: from 0, never decreasing, ending at 1. Equal neighbours
 * are allowed and make a step.
 */
function keyTimes(ms: readonly number[], period: number): string {
  let last = 0;
  const times = [0, ...ms, period].map(t => {
    last = Math.max(last, Math.min(1, Math.round((t / period) * 10000) / 10000));
    return last;
  });
  return times.join(';');
}

/** Opacity over the period: 0, up to `peak` across `start..end` (fading at both ends), 0. */
function opacityAnimation(
  start: number,
  end: number,
  peak: number,
  period: number,
  fadeMs: number
): { values: string; keyTimes: string } {
  const fade = Math.min(fadeMs, (end - start) / 2);
  return {
    values: `0;0;${peak.toString()};${peak.toString()};0;0`,
    keyTimes: keyTimes([start, start + fade, end - fade, end], period),
  };
}

/**
 * The flow of the root view, as a quiet loop on one SVG timeline (`lib/overview-flow.ts` says
 * which dots move where and when): a dot along each move's line, with a soft halo, in the
 * colour of the card it travels to, and a faint glow around each card, in its kind's colour,
 * while a dot rests on it. Drawn between the lines and the cards, so
 * a dot slips under a card's edge for its beat while the halo shows outside it. Only position and
 * opacity animate, in the browser's SMIL engine: no frame loop, no re-render, no filter. Paused
 * through the SVG's own `pauseAnimations`, applied again whenever the layer mounts (full screen
 * remounts it).
 */
export const OverviewFlow = memo(function OverviewFlow({
  flow,
  view,
  cards,
  bounds,
  paused,
}: {
  flow: Flow;
  /** For each card's kind, whose colour its halo takes. */
  view: OverviewView;
  cards: ReadonlyMap<string, Box>;
  bounds: Box;
  paused: boolean;
}): ReactElement {
  const kindOf = useMemo(() => new Map(view.cards.map(card => [card.id, card.kind])), [view]);
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (paused) svg.current?.pauseAnimations();
    else svg.current?.unpauseAnimations();
  }, [paused]);
  const dur = `${flow.period.toString()}ms`;
  return (
    <svg
      ref={svg}
      aria-hidden="true"
      data-flow={paused ? 'paused' : 'playing'}
      className="pointer-events-none absolute overflow-visible motion-reduce:hidden"
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
      viewBox={`${bounds.x.toString()} ${bounds.y.toString()} ${bounds.w.toString()} ${bounds.h.toString()}`}
    >
      {flow.glows.map(glow => {
        const box = cards.get(glow.card);
        const kind = kindOf.get(glow.card);
        if (box === undefined || kind === undefined) return null;
        const fade = opacityAnimation(glow.start, glow.end, GLOW_OPACITY, flow.period, GLOW_FADE);
        return (
          <rect
            key={`${glow.card}@${glow.start.toString()}`}
            data-flow-glow={glow.card}
            x={box.x - GLOW_PAD}
            y={box.y - GLOW_PAD}
            width={box.w + GLOW_PAD * 2}
            height={box.h + GLOW_PAD * 2}
            rx={16}
            // The card is opaque, so the fill shows only as a soft rim in the pad around it.
            fill={KINDS[kind].color}
            fillOpacity={GLOW_FILL}
            stroke={KINDS[kind].color}
            strokeWidth={2}
            opacity={0}
          >
            <animate
              attributeName="opacity"
              dur={dur}
              repeatCount="indefinite"
              calcMode="linear"
              {...fade}
            />
          </rect>
        );
      })}
      {flow.moves.map(move => {
        const to = kindOf.get(move.to);
        return (
          <FlowDot
            key={`${move.from}->${move.to}`}
            move={move}
            period={flow.period}
            dur={dur}
            colour={to === undefined ? LINE : KINDS[to].color}
          />
        );
      })}
    </svg>
  );
});

/** A move's dot and its halo, one group moving and fading on the view's timeline. */
function FlowDot({
  move,
  period,
  dur,
  colour,
}: {
  move: FlowMove;
  period: number;
  dur: string;
  /** The kind colour of the card it travels to. */
  colour: string;
}): ReactElement {
  const fade = opacityAnimation(move.start, move.end, 1, period, DOT_FADE);
  return (
    <g data-flow-move={`${move.from}->${move.to}`} fill={colour} opacity={0}>
      <circle r={HALO_R} opacity={HALO_OPACITY} />
      <circle r={DOT_R} />
      {/* Linear, not the default paced: paced ignores keyTimes, which hold the dot still outside its leg. */}
      <animateMotion
        path={rounded(move.points)}
        dur={dur}
        repeatCount="indefinite"
        calcMode="linear"
        keyPoints="0;0;1;1"
        keyTimes={keyTimes([move.start, move.end], period)}
      />
      <animate attributeName="opacity" dur={dur} repeatCount="indefinite" {...fade} />
    </g>
  );
}
