/**
 * The map's send-backs, card by card: where an item goes back to from a card, and why. One
 * route per pair of cards, from the card it leaves to an EARLIER card it returns to
 * (`map-layout.ts` merges the pack graph's send-backs between stages into these, and leaves
 * out the ones inside one card: those are a card's own retries, not a way back). The map draws
 * one card's routes at a time, while that card is hovered, focused or pinned (`MapSendBacks`),
 * so each card's routes are laid out on their own: they never meet another card's.
 *
 * A card S with n routes: each route into a card T gets its own target leg on T's bottom edge,
 * at T's 0.1-0.45 of the width. The routes sorted by target leg, left to right, take source
 * legs on S's bottom edge over its 0.55-0.9, right to left, and tracks under the row from the
 * deepest up: the leftmost target takes the rightmost source leg and the deepest track. Every
 * target leg lies left of every source leg (every target is an earlier card), so the routes
 * are U shapes nested inside each other: none crosses another, and none enters a card, since
 * every leg starts on a card's own bottom edge and every track runs under the row.
 *
 * Each pill says where the route goes back to and why, in plain words: "Back to <card>:" on
 * its first line, the reason on its second (`reasonsOf`). The pills sit under the deepest
 * track, where nothing is drawn (rule 4: a label never sits on a line), in their routes'
 * order, each as near its target leg as it fits, a band down rather than far off
 * (`placePills`).
 */
import type { Box, Point } from './map-layout';
import { pillSize } from './map-pill';
import { LANE, PILL_LINE, TRACK } from './map-sizes';
import { PILL_H } from './map-sizes';

/** Where a card's legs meet its bottom edge, as fractions of its width. */
const TARGET_FROM = 0.1;
const TARGET_TO = 0.45;
const SOURCE_FROM = 0.55;
const SOURCE_TO = 0.9;
/** From the deepest track to the first band of pills, between bands, and between pills on one band. */
const PILL_OFFSET = 8;
const BAND_GAP = 4;
const PILL_CLEAR = 8;
/** How far a pill may slide sideways from its leg before it drops a band. */
const MAX_SLIDE = 120;

export interface RouteCard {
  box: Box;
  /** Its label, as its card shows it. */
  label: string;
}

/** A way back from one card into an earlier card: one per pair of cards. */
export interface SendBackArrow {
  /** Unique on the map: `decl:<index>` of the first send-back it merges. */
  id: string;
  /** The card it leaves and the earlier card it returns to, by card id. */
  from: string;
  to: string;
  /** The outcomes and answers of the send-backs it merges, in the pack's words, each once. */
  words: string[];
}

interface RoutePill {
  box: Box;
  lines: string[];
  /** Whether its reason line leaves some reasons out (`oneLineOf`). */
  shortened: boolean;
}

export interface SendBackRoute extends SendBackArrow {
  /** Why it goes back, in plain words, each once (`reasonsOf`): what its pill's tip lists. */
  reasons: string[];
  /** Its corners, from its source leg to the point its arrowhead reaches. */
  points: Point[];
  /** The same route as an SVG path, in M, H and V. */
  d: string;
  /** Undefined for a route with nothing to say. */
  pill: RoutePill | undefined;
}

export interface CardSendBacks {
  /** Its routes, sorted by target leg, left to right. */
  routes: SendBackRoute[];
  /** What its routes and pills take. */
  extent: Box;
}

const bottomOf = (box: Box): number => box.y + box.h;

/** Spread `n` legs over `from..to` of a box's width, the first nearest `from`. */
const legX = (box: Box, from: number, to: number, n: number, i: number): number =>
  box.x + box.w * (from + ((to - from) / n) * (i + 0.5));

/** Outcomes that only say the card sent the item back, not why. */
const SENT_BACK = new Set(['returned', 'sent back', 'send back', 'rejected']);
/** Outcomes that name no reason at all: listed last, so a "+N" takes them first. */
const NO_REASON = new Set(['other']);

/**
 * Why a route goes back, in plain words, each once: the outcomes that only say "sent back"
 * become "<source card> sent it back", listed first, and one that names no reason ("Other")
 * comes last.
 */
export function reasonsOf(words: readonly string[], source: string): string[] {
  const is = (set: ReadonlySet<string>) => (word: string) => set.has(word.toLowerCase());
  const sentBack = words.some(is(SENT_BACK));
  const rest = words.filter(word => !is(SENT_BACK)(word));
  return [
    ...new Set([
      ...(sentBack ? [`${source} sent it back`] : []),
      ...rest.filter(word => !is(NO_REASON)(word)),
      ...rest.filter(is(NO_REASON)),
    ]),
  ];
}

/** The most reasons a pill names; past that it says how many more ("+2"). */
const MAX_REASONS = 2;

/**
 * The pill's lines: where it goes back to, then why (at most `MAX_REASONS` reasons, then
 * "+N"); only where, for a route the pack gives no words.
 */
function pillLines(
  target: string,
  reasons: readonly string[]
): { lines: string[]; shortened: boolean } {
  if (reasons.length === 0) return { lines: [`Back to ${target}`], shortened: false };
  const shown = reasons.slice(0, MAX_REASONS).join(', ');
  const more = reasons.length - MAX_REASONS;
  const line = more > 0 ? `${shown} +${more.toString()}` : shown;
  return { lines: [`Back to ${target}:`, line], shortened: more > 0 };
}

/** One card's routes, laid out as the header says; `arrows` all leave `source`, each into its own card. */
function cardRoutes(
  source: RouteCard,
  arrows: readonly SendBackArrow[],
  cards: ReadonlyMap<string, RouteCard>
): { arrow: SendBackArrow; points: Point[] }[] {
  const legs = arrows.flatMap(arrow => {
    const box = cards.get(arrow.to)?.box;
    if (box === undefined) return [];
    return [{ arrow, x: legX(box, TARGET_FROM, TARGET_TO, 1, 0), y: bottomOf(box) }];
  });
  legs.sort((p, q) => p.x - q.x);
  const top = bottomOf(source.box);
  const n = legs.length;
  return legs.map(({ arrow, x, y }, i) => {
    // The leftmost target takes the rightmost source leg and the deepest track.
    const from = legX(source.box, SOURCE_TO, SOURCE_FROM, n, i);
    const track = top + LANE + (n - 1 - i) * TRACK;
    return {
      arrow,
      points: [
        { x: from, y: top },
        { x: from, y: track },
        { x, y: track },
        { x, y },
      ],
    };
  });
}

/**
 * The pills under the deepest track at `y`, in their routes' order (by target leg, left to
 * right), each as near its target leg as it fits: centred on it where that is free, else at
 * the nearest free place on that band no further than `MAX_SLIDE` from centred, else a band
 * down. All within the row's span `row`, so a long label on the first card's leg does not
 * hang off the row's start (where the map opens). Keeping each pill near its leg (the owner's
 * ruling on #289) costs a band now and then; the frame grows to hold them while they show.
 */
function placePills(
  wanted: readonly { lines: string[]; shortened: boolean; x: number }[],
  y: number,
  row: { lo: number; hi: number }
): (RoutePill | undefined)[] {
  /** What each band holds so far, as spans along the row. */
  const bands: { lo: number; hi: number }[][] = [];
  return wanted.map(({ lines, shortened, x }) => {
    if (lines.length === 0) return undefined;
    const { w, h } = pillSize(lines);
    const centred = Math.max(row.lo, Math.min(row.hi - w, x - w / 2));
    let band = 0;
    let left = nearestFree(bands[band] ?? [], centred, w, row);
    while (left === undefined) {
      band += 1;
      left = nearestFree(bands[band] ?? [], centred, w, row);
    }
    bands[band] = [...(bands[band] ?? []), { lo: left, hi: left + w }];
    const box = { x: left, y: y + PILL_OFFSET + band * (PILL_H + PILL_LINE + BAND_GAP), w, h };
    return { box, lines, shortened };
  });
}

/**
 * The left edge nearest `want` where a pill `w` wide meets none of `taken` (kept `PILL_CLEAR`
 * apart) and stays within `row`, no further than `MAX_SLIDE` from `want`; undefined when there
 * is none. A band nothing is on yet always takes the pill, even one wider than the row.
 */
function nearestFree(
  taken: readonly { lo: number; hi: number }[],
  want: number,
  w: number,
  row: { lo: number; hi: number }
): number | undefined {
  if (taken.length === 0) return want;
  const free = (at: number): boolean =>
    at >= row.lo &&
    at + w <= row.hi &&
    taken.every(span => at + w + PILL_CLEAR <= span.lo || at >= span.hi + PILL_CLEAR);
  const candidates = [
    want,
    ...taken.flatMap(span => [span.hi + PILL_CLEAR, span.lo - PILL_CLEAR - w]),
  ].filter(at => free(at) && Math.abs(at - want) <= MAX_SLIDE);
  candidates.sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
  return candidates[0];
}

function extentOf(routes: readonly SendBackRoute[]): Box {
  const boxes = routes.flatMap(route => (route.pill === undefined ? [] : [route.pill.box]));
  const points = routes.flatMap(route => route.points);
  const xs = [...points.map(p => p.x), ...boxes.flatMap(box => [box.x, box.x + box.w])];
  const ys = [...points.map(p => p.y), ...boxes.flatMap(box => [box.y, box.y + box.h])];
  const [left, top] = [Math.min(...xs), Math.min(...ys)];
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
}

const pathOf = (points: readonly Point[]): string => {
  const [start, down, across, up] = points as [Point, Point, Point, Point];
  return `M${start.x.toString()},${start.y.toString()} V${down.y.toString()} H${across.x.toString()} V${up.y.toString()}`;
};

/**
 * Every card's send-backs, by card id, for the cards (by card id, in row order) and the ways
 * back between them (one per pair of cards). A card nothing leaves for another card is not in
 * the map, nor is a way back into a card not on the map or into its own card.
 */
export function sendBackRoutes(
  cards: ReadonlyMap<string, RouteCard>,
  arrows: readonly SendBackArrow[]
): Map<string, CardSendBacks> {
  const boxes = [...cards.values()].map(card => card.box);
  const row = {
    lo: Math.min(...boxes.map(box => box.x)),
    hi: Math.max(...boxes.map(box => box.x + box.w)),
  };
  const out = new Map<string, CardSendBacks>();
  for (const [id, source] of cards) {
    const mine = arrows.filter(
      arrow => arrow.from === id && arrow.to !== id && cards.has(arrow.to)
    );
    if (mine.length === 0) continue;
    const laid = cardRoutes(source, mine, cards).map(entry => ({
      ...entry,
      reasons: reasonsOf(entry.arrow.words, source.label),
    }));
    const deepest = Math.max(...laid.map(({ points }) => (points[1] as Point).y));
    const pills = placePills(
      laid.map(({ arrow, points, reasons }) => ({
        ...pillLines(cards.get(arrow.to)?.label ?? arrow.to, reasons),
        x: (points[3] as Point).x,
      })),
      deepest,
      row
    );
    const routes = laid.map(
      ({ arrow, points, reasons }, i): SendBackRoute => ({
        ...arrow,
        reasons,
        points,
        d: pathOf(points),
        pill: pills[i],
      })
    );
    out.set(id, { routes, extent: extentOf(routes) });
  }
  return out;
}
