/**
 * Where the factory map draws its cards and arrows, in world units (px at zoom 1). The cards
 * are the map's columns (`mapColumns`: the pack's document groups, `curated-view.ts`), each
 * holding its map stages in the column's order. They sit in one row, left to right, always:
 * where the row does not fit its frame, the map pans (`map-camera.ts`).
 *
 * The arrows are the pack graph's, projected onto the view's stages (`mapArrows`) with the view
 * file's words, drawn between cards:
 *
 * - An arrow between two cards takes its direction from card order: into an earlier card, it
 *   is a send-back; into a later one, a forward hand-off. Stages order does not decide it,
 *   since a column need not hold neighbouring stages.
 * - Inside one card, an arrow to a later stage of the card is not drawn: the card's rows show
 *   that order. One into its own stage or an earlier one of the card is a send-back.
 * - A forward hand-off runs straight between neighbouring cards, its label on a pill above
 *   the line, at most `PILL_MAX_LINES` lines: one outcome per line up to that, and past it the
 *   first outcome and how many more ("built +2"), every outcome kept in `outcomes` for the
 *   map's tip (`MapPillTips`). One that would skip cards gets no route of its own: its
 *   outcomes join the label of the hand-off from its source card to the next, as
 *   "<outcome> → <target card>", and when there is no such hand-off, one is drawn for it.
 * - Forward hand-offs between one pair of cards are one line, their outcomes joined, each once.
 * - Every send-back is drawn in the one feedback lane under the row (`map-feedback-lane.ts`).
 *
 * Nothing crosses: forward lines run between cards at mid-height, the lane's legs under the
 * cards, and every pill sits in a gap or under the lane, clear of cards, lines and pills.
 */
import { mapColumns, type ColumnTone } from './map-columns';
import { feedbackLane, type FeedbackLane, type LaneCard, type SendBack } from './map-feedback-lane';
import { cardSize, GAP_MIN, LANE, PILL_CLEAR, PILL_GAP, PILL_LINE } from './map-sizes';
import { pillWidth, PILL_H } from './overview-layout';
import type { MapArrow } from './graph-structure';
import { isSendBack, type Seat } from './stage-direction';
import type { CuratedView } from './curated-view';

type Declaration = CuratedView;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One card on the map: a column, holding its map stages. */
interface MapCardDecl {
  /** The column's id. */
  id: string;
  label: string;
  tone: ColumnTone;
  /** Its stages with a map card, in the column's order; never empty. */
  stages: string[];
}

export interface PlacedCard extends MapCardDecl {
  box: Box;
}

/** A forward hand-off between two neighbouring cards. */
export interface ArrowPath {
  /** Unique on the map: `decl:<index>` of the first arrow it draws. */
  id: string;
  /** The cards it joins, by card id. */
  from: string;
  to: string;
  /** What its pill draws (`pillOf`); empty for an unlabelled hand-off. */
  lines: string[];
  /** Every outcome on the line, in order, whether or not its pill shows it. */
  outcomes: string[];
  /** The SVG path, in M and H, ending where the arrowhead points. */
  d: string;
  /** Where the path starts and ends, for the line's gradient along the flow. */
  start: Point;
  end: Point;
  /** Where its label pill goes; undefined when it has no label. */
  pill: Box | undefined;
}

export interface MapLayout {
  /** The cards, left to right. */
  cards: PlacedCard[];
  /** Every forward hand-off, left to right. */
  arrows: ArrowPath[];
  /** Every send-back, in the one feedback lane, and one pill per target stage. */
  feedback: FeedbackLane;
  /** The box holding every card, line and pill; empty at the origin when there are no cards. */
  bounds: Box;
}

/** The map's cards: its columns, each with its map stages. */
export function mapCards(view: Declaration): MapCardDecl[] {
  return mapColumns(view).map(column => ({
    id: column.id,
    label: column.label,
    tone: column.tone,
    stages: column.stages,
  }));
}

/** A forward hand-off between two neighbouring cards, by the left card's index. */
interface Forward {
  id: string;
  left: number;
  parts: string[];
}

/** The arrows sorted into forward hand-offs and send-backs, by the rules above. */
function sortArrows(
  arrows: readonly MapArrow[],
  cards: readonly MapCardDecl[]
): { forward: Forward[]; sendBacks: SendBack[] } {
  const seats = new Map<string, Seat>();
  cards.forEach((card, i) => {
    card.stages.forEach((stage, row) => seats.set(stage, { card: i, row }));
  });
  const forward = new Map<number, Forward>();
  const sendBacks: SendBack[] = [];
  arrows.forEach((arrow, index) => {
    const a = seats.get(arrow.from);
    const b = seats.get(arrow.to);
    if (a === undefined || b === undefined) return;
    const id = `decl:${index.toString()}`;
    if (isSendBack(a, b)) {
      sendBacks.push({ id, from: cards[a.card]?.id ?? '', to: arrow.to, label: arrow.label });
      return;
    }
    if (a.card === b.card) return;
    const parts = forwardParts(arrow.label, b.card > a.card + 1 ? cards[b.card]?.label : undefined);
    const into = forward.get(a.card) ?? { id, left: a.card, parts: [] };
    for (const part of parts) if (!into.parts.includes(part)) into.parts.push(part);
    forward.set(a.card, into);
  });
  return { forward: [...forward.values()].sort((p, q) => p.left - q.left), sendBacks };
}

/**
 * A forward arrow's outcomes as its neighbour hand-off's label reads them: as they are, or,
 * for one that skips to the card labelled `skipsTo`, each followed by where it goes.
 */
function forwardParts(label: string | undefined, skipsTo: string | undefined): string[] {
  const outcomes = label?.split(', ') ?? [];
  if (skipsTo === undefined) return outcomes;
  if (outcomes.length === 0) return [`→ ${skipsTo}`];
  return outcomes.map(outcome => `${outcome} → ${skipsTo}`);
}

/** The most lines a forward hand-off's pill holds (issue #146). */
export const PILL_MAX_LINES = 2;

/**
 * A label's pill: one line per outcome, the last without its comma, while they fit in
 * `PILL_MAX_LINES`; past that, one line naming the first outcome and how many more.
 */
function pillOf(parts: readonly string[]): { lines: string[]; w: number; h: number } | undefined {
  if (parts.length === 0) return undefined;
  const lines =
    parts.length > PILL_MAX_LINES
      ? [`${parts[0] ?? ''} +${(parts.length - 1).toString()}`]
      : parts.map((part, i) => (i < parts.length - 1 ? `${part},` : part));
  return {
    lines,
    w: Math.max(...lines.map(line => pillWidth(line))),
    h: PILL_H + PILL_LINE * (lines.length - 1),
  };
}

function boundsOf(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...boxes.map(box => box.x));
  const right = Math.max(...boxes.map(box => box.x + box.w));
  const top = Math.min(...boxes.map(box => box.y));
  const lowest = Math.max(...boxes.map(box => box.y + box.h));
  return { x: left, y: top, w: right - left, h: lowest - top };
}

/** The map's cards, lines, pills and bounds, for the arrows the pack graph draws (`mapArrows`). */
export function layoutMap(view: Declaration, drawn: readonly MapArrow[]): MapLayout {
  const decls = mapCards(view);
  const { forward, sendBacks } = sortArrows(drawn, decls);
  const size = cardSize(Math.max(0, ...decls.map(card => card.stages.length)));
  const pills = new Map(forward.map(entry => [entry.left, pillOf(entry.parts)]));
  const cards: PlacedCard[] = [];
  let x = 0;
  decls.forEach((card, i) => {
    cards.push({ ...card, box: { x, y: 0, w: size.w, h: size.h } });
    const pill = pills.get(i);
    x += size.w + Math.max(GAP_MIN, pill === undefined ? 0 : pill.w + 2 * PILL_CLEAR);
  });
  const mid = size.h / 2;
  const arrows = forward.flatMap((entry): ArrowPath[] => {
    const a = cards[entry.left];
    const b = cards[entry.left + 1];
    if (a === undefined || b === undefined) return [];
    const [x1, x2] = [a.box.x + a.box.w, b.box.x];
    const pill = pills.get(entry.left);
    return [
      {
        id: entry.id,
        from: a.id,
        to: b.id,
        lines: pill?.lines ?? [],
        outcomes: entry.parts,
        d: `M${x1.toString()},${mid.toString()} H${x2.toString()}`,
        start: { x: x1, y: mid },
        end: { x: x2, y: mid },
        pill:
          pill === undefined
            ? undefined
            : { x: (x1 + x2 - pill.w) / 2, y: mid - PILL_GAP - pill.h, w: pill.w, h: pill.h },
      },
    ];
  });
  const laneCards = new Map(
    cards.map((card): [string, LaneCard] => [card.id, { box: card.box, stages: card.stages }])
  );
  const feedback = feedbackLane(laneCards, size.h + LANE, sendBacks);
  return {
    cards,
    arrows,
    feedback,
    bounds: boundsOf([
      ...cards.map(card => card.box),
      ...arrows.flatMap(arrow => (arrow.pill === undefined ? [] : [arrow.pill])),
      ...(feedback.extent === undefined ? [] : [feedback.extent]),
    ]),
  };
}
