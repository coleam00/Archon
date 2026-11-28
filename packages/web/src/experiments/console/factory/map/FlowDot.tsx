/**
 * A dot moving along a line on an SVG (SMIL) timeline, with a faint halo: the map's forward flow
 * (`MapFlow`) and a card's send-back branches (`MapSendBacks`). Only position and opacity
 * animate, in the browser's SMIL engine: no frame loop, no re-render, no filter. A CSS class
 * cannot stop SMIL, so callers draw none under reduced motion (`useReducedMotion`).
 */
import type { ReactElement } from 'react';
import { rounded } from '../canvas-lines';
import type { FlowMove } from '../lib/map-flow';

/** A dot's halo strength: a second, faint circle, never a blur. */
const HALO_OPACITY = 0.28;
/**
 * How long a dot takes to fade in and out, in ms: an edge inside its leg, not a duration of the
 * loop, so the loop's tempo does not scale it.
 */
const DOT_FADE = 80;

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
  period: number
): { values: string; keyTimes: string } {
  const fade = Math.min(DOT_FADE, (end - start) / 2);
  return {
    values: `0;0;${peak.toString()};${peak.toString()};0;0`,
    keyTimes: keyTimes([start, start + fade, end - fade, end], period),
  };
}

/** A move's dot and its halo, one group moving and fading on its loop's timeline. */
export function FlowDot({
  move,
  period,
  dur,
  colour,
  r,
  haloR,
  peak = 1,
  data,
}: {
  move: FlowMove;
  period: number;
  dur: string;
  colour: string;
  r: number;
  haloR: number;
  /** Its opacity while it travels: full unless given. */
  peak?: number;
  /** The attribute a test finds it by. */
  data: Record<`data-${string}`, string>;
}): ReactElement {
  const fade = opacityAnimation(move.start, move.end, peak, period);
  return (
    <g {...data} fill={colour} opacity={0}>
      <circle r={haloR} opacity={HALO_OPACITY} />
      <circle r={r} />
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
