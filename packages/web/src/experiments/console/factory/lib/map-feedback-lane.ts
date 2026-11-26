/**
 * The map's one feedback lane: every send-back the view file declares (`map-layout.ts` says
 * which arrows are send-backs) drawn on a single line under the row of cards, running right
 * to left. A send-back leaves its source card's bottom edge on the card's one source leg,
 * runs along the lane, and rises into its target stage's leg on the target card. A card has
 * one source leg (at 0.85 of its width) and one target leg per stage something returns to,
 * spread over its left 0.1-0.6 in the card's stage order, so every send-back into one stage
 * shares one leg, and one pill under the lane names them all.
 *
 * Why nothing crosses: every leg is a vertical between its card's bottom edge and the lane,
 * and every run lies on the lane. Two verticals never cross; a vertical meets the lane only
 * at its own end; and no leg enters a card, since it starts on the card's own edge. Where two
 * runs overlap they are collinear: one line, not a crossing. The pills sit under the lane,
 * where nothing else is drawn, each on the first band down where it meets no pill before it,
 * centred on its leg but kept within the row's span, so a long label on the first card's leg
 * does not hang off the row's start (where the map opens).
 */
import type { Box, Point } from './map-layout';
import { pillWidth, PILL_H } from './overview-layout';

/** Where a card's legs meet its bottom edge, as fractions of its width. */
const SOURCE_LEG = 0.85;
const TARGET_FROM = 0.1;
const TARGET_TO = 0.6;
/** From the lane to the first band of pills, between bands, and between pills on one band. */
const PILL_OFFSET = 6;
const BAND_GAP = 4;
const PILL_CLEAR = 8;

export interface LaneCard {
  box: Box;
  /** Its stages, in the order it lists them. */
  stages: readonly string[];
}

/** A send-back the pack graph draws, from a card into a stage. */
export interface SendBack {
  /** Unique on the map: `decl:<index>`. */
  id: string;
  /** The card it leaves from, by card id. */
  from: string;
  /** The stage it returns to. */
  to: string;
  label: string | undefined;
}

interface LanePath extends SendBack {
  /** The SVG path, in M, H and V, ending where the arrowhead points into the target. */
  d: string;
}

interface LanePill {
  /** The stage its leg rises into. */
  stage: string;
  /** Its send-backs' outcomes, each once, in declared order. */
  text: string;
  box: Box;
}

/**
 * What the map draws: each distinct piece of the lane once, so two send-backs sharing a run
 * do not draw two dashed lines over each other, out of step. `head` ends a piece in an
 * arrowhead into a card.
 */
interface LaneStroke {
  points: Point[];
  head: boolean;
}

export interface FeedbackLane {
  /** One path per send-back: what each send-back's route is. */
  paths: LanePath[];
  /** The same lines, each piece once, as the map draws them. */
  strokes: LaneStroke[];
  /** One per target stage. */
  pills: LanePill[];
  /** What the lane and its pills take; undefined when nothing sends back. */
  extent: Box | undefined;
}

const bottomOf = (card: LaneCard): number => card.box.y + card.box.h;
const sourceX = (card: LaneCard): number => card.box.x + card.box.w * SOURCE_LEG;

/** Each card's target legs, keyed by stage: one per stage something returns to. */
function targetLegs(
  cards: ReadonlyMap<string, LaneCard>,
  drawn: readonly SendBack[]
): Map<string, { x: number; y: number }> {
  const targets = new Set(drawn.map(entry => entry.to));
  const legs = new Map<string, { x: number; y: number }>();
  for (const card of cards.values()) {
    const mine = card.stages.filter(stage => targets.has(stage));
    const step = (TARGET_TO - TARGET_FROM) / mine.length;
    mine.forEach((stage, i) =>
      legs.set(stage, {
        x: card.box.x + card.box.w * (TARGET_FROM + step * (i + 0.5)),
        y: bottomOf(card),
      })
    );
  }
  return legs;
}

/** Each target's outcomes, each once, in declared order; a target with none has no pill. */
function pillTexts(drawn: readonly SendBack[]): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const entry of drawn) {
    const list = parts.get(entry.to) ?? [];
    for (const text of entry.label?.split(', ') ?? []) if (!list.includes(text)) list.push(text);
    parts.set(entry.to, list);
  }
  return new Map(
    [...parts].filter(([, list]) => list.length > 0).map(([k, v]) => [k, v.join(', ')])
  );
}

const meets = (a: Box, b: Box, clear: number): boolean =>
  a.x < b.x + b.w + clear && b.x < a.x + a.w + clear && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The pills under the lane at `y`, left to right, each centred on its leg but within the
 * row's span `row` (one wider than the row starts at its left edge), each on the first band
 * it fits.
 */
function placePills(
  texts: ReadonlyMap<string, string>,
  legs: ReadonlyMap<string, { x: number }>,
  y: number,
  row: { lo: number; hi: number }
): LanePill[] {
  const ordered = [...texts].flatMap(([stage, text]) => {
    const leg = legs.get(stage);
    return leg === undefined ? [] : [{ stage, text, x: leg.x }];
  });
  ordered.sort((p, q) => p.x - q.x);
  const placed: LanePill[] = [];
  for (const { stage, text, x } of ordered) {
    const w = pillWidth(text);
    let band = 0;
    const at = (n: number): Box => ({
      x: Math.max(row.lo, Math.min(row.hi - w, x - w / 2)),
      y: y + PILL_OFFSET + n * (PILL_H + BAND_GAP),
      w,
      h: PILL_H,
    });
    while (placed.some(pill => meets(pill.box, at(band), PILL_CLEAR))) band += 1;
    placed.push({ stage, text, box: at(band) });
  }
  return placed;
}

/** Where two ranges on the lane overlap, they are drawn as one run. */
function mergedRuns(spans: readonly { lo: number; hi: number }[]): { lo: number; hi: number }[] {
  const sorted = [...spans].sort((p, q) => p.lo - q.lo);
  const runs: { lo: number; hi: number }[] = [];
  for (const span of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && span.lo < last.hi) last.hi = Math.max(last.hi, span.hi);
    else runs.push({ ...span });
  }
  return runs;
}

/**
 * The pieces the map draws. A merged run's right end is a source leg and its left end a
 * target leg (every send-back runs right to left), so each run is one U from the one into
 * the other; the legs between its ends meet it at a T.
 */
function strokesOf(
  spans: readonly { lo: number; hi: number; top: number; end: number }[],
  y: number
): LaneStroke[] {
  const legs = new Map<string, LaneStroke>();
  for (const span of spans) {
    legs.set(`s:${span.hi.toString()}`, {
      points: [
        { x: span.hi, y: span.top },
        { x: span.hi, y },
      ],
      head: false,
    });
    legs.set(`t:${span.lo.toString()}`, {
      points: [
        { x: span.lo, y },
        { x: span.lo, y: span.end },
      ],
      head: true,
    });
  }
  const strokes: LaneStroke[] = [];
  for (const run of mergedRuns(spans)) {
    const source = legs.get(`s:${run.hi.toString()}`);
    const target = legs.get(`t:${run.lo.toString()}`);
    if (source === undefined || target === undefined) continue;
    strokes.push({ points: [...source.points, ...target.points], head: true });
    legs.delete(`s:${run.hi.toString()}`);
    legs.delete(`t:${run.lo.toString()}`);
  }
  return [...strokes, ...legs.values()];
}

/**
 * The send-backs between `cards` (by card id) drawn on the lane at `y`, pills under it. A
 * send-back whose source card or target stage has no card is left out.
 */
export function feedbackLane(
  cards: ReadonlyMap<string, LaneCard>,
  y: number,
  sendBacks: readonly SendBack[]
): FeedbackLane {
  const stages = new Set([...cards.values()].flatMap(card => card.stages));
  const drawn = sendBacks.filter(entry => cards.has(entry.from) && stages.has(entry.to));
  const legs = targetLegs(cards, drawn);
  const spans = drawn.flatMap(entry => {
    const from = cards.get(entry.from);
    const to = legs.get(entry.to);
    if (from === undefined || to === undefined) return [];
    return [{ entry, lo: to.x, hi: sourceX(from), top: bottomOf(from), end: to.y }];
  });
  const paths = spans.map(
    ({ entry, lo, hi, top, end }): LanePath => ({
      ...entry,
      d: `M${hi.toString()},${top.toString()} V${y.toString()} H${lo.toString()} V${end.toString()}`,
    })
  );
  const boxes = [...cards.values()].map(card => card.box);
  const row = {
    lo: Math.min(...boxes.map(box => box.x)),
    hi: Math.max(...boxes.map(box => box.x + box.w)),
  };
  const pills = placePills(pillTexts(drawn), legs, y, row);
  return { paths, strokes: strokesOf(spans, y), pills, extent: extentOf(spans, pills, y) };
}

function extentOf(
  spans: readonly { lo: number; hi: number }[],
  pills: readonly LanePill[],
  y: number
): Box | undefined {
  if (spans.length === 0) return undefined;
  const xs = [
    ...spans.flatMap(span => [span.lo, span.hi]),
    ...pills.flatMap(pill => [pill.box.x, pill.box.x + pill.box.w]),
  ];
  const lowest = Math.max(y, ...pills.map(pill => pill.box.y + pill.box.h));
  const left = Math.min(...xs);
  return { x: left, y, w: Math.max(...xs) - left, h: lowest - y };
}
