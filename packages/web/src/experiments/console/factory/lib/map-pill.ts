/**
 * A map label's pill and how much of a label it shows. Its own module because the forward
 * hand-offs (`map-layout.ts`) and the send-backs (`map-send-backs.ts`) both word their pills by
 * it, and the layout imports the send-backs.
 */
import { PILL_LINE } from './map-sizes';
import { pillWidth, PILL_H } from './overview-layout';

/** The most lines a forward hand-off's pill holds (issue #146). */
export const PILL_MAX_LINES = 2;

/** A pill's size for its text lines, stacked `PILL_LINE` apart. */
export function pillSize(lines: readonly string[]): { w: number; h: number } {
  return {
    w: Math.max(...lines.map(line => pillWidth(line))),
    h: PILL_H + PILL_LINE * (lines.length - 1),
  };
}

/**
 * A label's pill: one line per outcome, the last without its comma, while they fit in
 * `PILL_MAX_LINES`; past that, one line naming the first outcome and how many more.
 */
export function pillOf(
  parts: readonly string[]
): { lines: string[]; w: number; h: number } | undefined {
  if (parts.length === 0) return undefined;
  const lines =
    parts.length > PILL_MAX_LINES
      ? [moreOf(parts)]
      : parts.map((part, i) => (i < parts.length - 1 ? `${part},` : part));
  return { lines, ...pillSize(lines) };
}

/**
 * Outcomes on one line: all of them while they fit in `PILL_MAX_LINES`, else the first and how
 * many more, and whether it left some out (the map then offers the full list, `MapPillTips`).
 */
export function oneLineOf(parts: readonly string[]): { line: string; shortened: boolean } {
  const shortened = parts.length > PILL_MAX_LINES;
  return { line: shortened ? moreOf(parts) : parts.join(', '), shortened };
}

const moreOf = (parts: readonly string[]): string =>
  `${parts[0] ?? ''} +${(parts.length - 1).toString()}`;
