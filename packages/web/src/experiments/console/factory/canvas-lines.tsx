/**
 * The Visual standard's lines (rule 4), shared by the canvases that draw them: the grouped map
 * and the full workflow. 8 px rounded bends, 6 px heads; a forward line 2 px, solid, brightening
 * along the flow (`FlowGradient`); send-backs 1.5 px, dashed `6 4` in the approval colour and a
 * little quieter; asks 1.5 px dotted in the tertiary text colour; and each label on a pill set
 * off its line.
 */
import type { ReactElement } from 'react';
import type { Box, Point } from './lib/map-layout';
import { PILL_LINE, PILL_TEXT } from './lib/map-sizes';

export const LINE = 'var(--text-tertiary)';
/** A forward line's ends: dim where it leaves, brighter where it arrives (its head's colour). */
const LINE_FROM = 'var(--border-bright)';
export const LINE_TO = 'var(--text-secondary)';
/** A forward line's width; every other line is `STROKE`. */
export const MAIN_STROKE = 2;
/** A send-back's opacity: it stays readable but steps back behind the main line. */
export const BACK_OPACITY = 0.85;
export const BACK = 'var(--node-approval)';
export const STROKE = 1.5;
export const HEAD = 6;
/** A send-back's dash. */
export const BACK_DASH = '6 4';
const BEND = 8;

/** An orthogonal path with each bend rounded, never by more than half a run. */
export function rounded(points: readonly Point[]): string {
  const at = (p: Point): string => `${p.x.toString()},${p.y.toString()}`;
  const first = points[0];
  if (first === undefined) return '';
  let d = `M${at(first)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const corner = points[i] as Point;
    const next = points[i + 1] as Point;
    const into = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const out = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(BEND, into / 2, out / 2);
    const toward = (from: Point, len: number): Point => ({
      x: corner.x + ((from.x - corner.x) / len) * r,
      y: corner.y + ((from.y - corner.y) / len) * r,
    });
    d += ` L${at(toward(prev, into))} Q${at(corner)} ${at(toward(next, out))}`;
  }
  const last = points.at(-1) as Point;
  return points.length > 1 ? `${d} L${at(last)}` : d;
}

/**
 * A forward line's paint, from `from` (dim) to `to` (bright), for `stroke="url(#<id>)"`. In
 * user space: the default bounding-box units paint nothing on a straight horizontal line, whose
 * box has no height.
 */
export function FlowGradient({
  id,
  from,
  to,
}: {
  id: string;
  from: Point;
  to: Point;
}): ReactElement {
  return (
    <linearGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
    >
      <stop offset="0" stopColor={LINE_FROM} />
      <stop offset="1" stopColor={LINE_TO} />
    </linearGradient>
  );
}

/** A 6 px filled arrowhead in `colour`, for a line's `markerEnd="url(#<id>)"`. */
export function HeadMarker({ id, colour }: { id: string; colour: string }): ReactElement {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerUnits="userSpaceOnUse"
      markerWidth={HEAD}
      markerHeight={HEAD}
      orient="auto-start-reverse"
    >
      <path d="M0,0 L10,5 L0,10 z" fill={colour} />
    </marker>
  );
}

/**
 * A line's label on a pill: one text line per entry of `lines`, `PILL_LINE` apart, so several
 * outcomes stack in one narrow pill.
 */
export function LinePill({ pill, lines }: { pill: Box; lines: readonly string[] }): ReactElement {
  const first = pill.y + pill.h / 2 - (PILL_LINE * (lines.length - 1)) / 2;
  return (
    <g data-pill={lines.join(' ')} className={PILL_TEXT}>
      <rect
        x={pill.x}
        y={pill.y}
        width={pill.w}
        height={pill.h}
        rx={Math.min(pill.h, pill.w) / 2}
        fill="var(--surface-inset)"
        stroke="var(--border)"
      />
      {lines.map((line, index) => (
        <text
          key={line}
          x={pill.x + pill.w / 2}
          y={first + PILL_LINE * index}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-secondary)"
        >
          {line}
        </text>
      ))}
    </g>
  );
}
