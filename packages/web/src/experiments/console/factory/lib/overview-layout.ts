/**
 * Where the factory overview draws one view, in world units (px at zoom 1). It routes edges
 * by the rules the overview schema checks on the grid (`factory-overview-geometry.ts` and
 * `factory-overview-lanes.ts` in `@archon/workflows`): a `feeds` or `calls` edge runs straight
 * along the middle row (else column) its two ends share, from side to facing side; a
 * `loops-back` edge that replies to a `calls` edge runs beside it (`overview-lanes.ts`); every
 * other `loops-back` edge drops from a port on its source's bottom into the lane under every
 * box, runs along its own track, and rises into a port on its target's bottom. A file the
 * server lists has passed those rules, so no edge drawn here crosses. Each label is a pill set
 * off its line. The rules do not measure labels, so a long label on a short line can meet a card
 * or a line; `overview-layout.test-fixtures.ts` checks the pills of the shipped file only.
 *
 * A parallel group (`parallelGroups`) also gets a fan on each side an edge meets it: a bar
 * along the frame and a stub to each member, drawn inside the group's pad, which no forward
 * line names a member to enter; `overview-layout.test.ts` checks the fans of the shipped file.
 * The two copies of the rules cannot share a module (the web does not import
 * `@archon/workflows`); `scripts/overview-geometry-parity.test.ts` holds them in step on
 * seeded views, and `overview-layout.test.ts` checks this drawing of the shipped file.
 */
import { TYPE_FLOOR_PX } from './map-camera';
import type { Box, Point } from './map-layout';
import { type LaneLine, type LaneRoute, laneRoutes, replies } from './overview-lanes';
import type { OverviewView } from './overview-nav';

/*
 * Sized in the Visual standard's card language at zoom 1, the fitted view's least zoom: a
 * card is 176 px wide and holds its accent, its icon and kind row, a title and two lines of
 * text (or two of title and one of text). The gaps leave a label pill room between cards a
 * labelled line joins. Rows and tracks are as tight as that allows, so the root view, three
 * rows and three tracks deep, is whole in height in the page's frame at 1440x900.
 */
export const OVERVIEW_CARD_W = 176;
export const OVERVIEW_CARD_H = 120;
const OVERVIEW_GAP_X = 48;
/** Room between rows for a column edge and its label. */
const OVERVIEW_GAP_Y = 48;
/** How far a group's box reaches past its cards: under half of either gap, so it never touches a neighbour. */
export const OVERVIEW_GROUP_PAD = 16;
/** How far under the lowest box the lane's first track runs, and how far apart its tracks are: room for a pill above each. */
const OVERVIEW_LANE_BELOW = 32;
const OVERVIEW_TRACK = 32;
/** How far a reply and the ask it answers each move off the line they would share. */
export const OVERVIEW_REPLY_OFFSET = 24;

/** The px a console type token names: `text-console-15` is 15 px (theme.css's scale). */
const tokenPx = (token: string): number => Number(token.slice('text-console-'.length));
/** A card's title, in the Visual standard's Card title role. */
export const OVERVIEW_TITLE_TEXT = 'text-console-15';
export const OVERVIEW_TITLE_PX = tokenPx(OVERVIEW_TITLE_TEXT);
/** A card's line of text. */
export const OVERVIEW_TEXT = 'text-console-13';
/** The smallest text the overview draws: kind labels, group labels and line labels. */
export const OVERVIEW_SMALL_TEXT = 'text-console-12';
export const OVERVIEW_SMALLEST_PX = tokenPx(OVERVIEW_SMALL_TEXT);
/** The Visual standard's type floor (rule 1): nothing a person reads is drawn under it. */
export const OVERVIEW_TYPE_FLOOR_PX = TYPE_FLOOR_PX;
/**
 * The least zoom a fit opens at, so the smallest text draws at the floor; a view wider than
 * its frame at this zoom pans. The most a fit enlarges a small view, to fill a large frame.
 */
export const OVERVIEW_MIN_K = OVERVIEW_TYPE_FLOOR_PX / OVERVIEW_SMALLEST_PX;
export const OVERVIEW_MAX_K = 1.5;
/**
 * Space kept between the fitted view and the frame's edge: on the page, and full screen, where
 * the breadcrumb, the controls and the legend float over the frame's corners.
 */
export const OVERVIEW_FIT_PAD = 16;
export const OVERVIEW_FULL_FIT_PAD = 64;
/** Full screen, the band at the bottom a fit leaves clear for the legend docked over it. */
export const OVERVIEW_FULL_LEGEND_H = 96;
/**
 * The tallest the map frame grows on the page, so the root view's lane and its labels are in
 * the first screen at 1440x900 under the console's header and the section's tabs; full screen
 * it fills the screen instead.
 */
export const OVERVIEW_PAGE_MAX_H = 640;

/** A label pill's height. */
export const PILL_H = 20;
/** A pill's width for `text`: 12 px text and 6 px padding. */
export function pillWidth(text: string): number {
  return Math.ceil(text.length * 7 + 14);
}
/** How far a pill sits off the line it labels. */
const PILL_GAP = 6;

/** Where a group's label sits: on its top border, inset from the left corner. */
export function groupLabelBox(group: Box, label: string): Box {
  return { x: group.x + 16, y: group.y - PILL_H / 2, w: label.length * 8.5 + 16, h: PILL_H };
}

type EdgeKind = OverviewView['edges'][number]['kind'];

export interface OverviewEdgePath {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string | undefined;
  /** From the source to the target. */
  points: Point[];
  /** The label's pill, set off the line; undefined without a label. */
  pill: Box | undefined;
}

/**
 * Where a parallel group's edge branches to its members: a bar on the frame's side, spanning the
 * members' row centres, and a stub along each member's row between the bar and the card. Into
 * the group, the stubs run bar to card and carry the arrowheads; out of it, card to bar.
 */
export interface OverviewFan {
  group: string;
  kind: Exclude<EdgeKind, 'loops-back'>;
  side: 'left' | 'right';
  into: boolean;
  bar: [Point, Point];
  stubs: { card: string; from: Point; to: Point }[];
}

export interface OverviewLayout {
  /** Every card's grid cell. */
  cards: Map<string, Box>;
  groups: Map<string, Box>;
  edges: OverviewEdgePath[];
  bounds: Box;
  fans: OverviewFan[];
}

interface Span {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

const colX = (col: number): number => (col - 1) * (OVERVIEW_CARD_W + OVERVIEW_GAP_X);
const rowY = (row: number): number => (row - 1) * (OVERVIEW_CARD_H + OVERVIEW_GAP_Y);

function spanBox(span: Span, pad: number): Box {
  const x = colX(span.c0) - pad;
  const y = rowY(span.r0) - pad;
  return {
    x,
    y,
    w: colX(span.c1) + OVERVIEW_CARD_W + pad - x,
    h: rowY(span.r1) + OVERVIEW_CARD_H + pad - y,
  };
}

/** The middle of the shared cells `lo..hi`, as the schema picks it. */
const middle = (lo: number, hi: number): number => Math.floor((lo + hi) / 2);

interface End {
  id: string;
  span: Span;
  box: Box;
  card: boolean;
}

/** Whether two ends share a cell: their boxes overlap. */
const spansOverlap = (a: Span, b: Span): boolean =>
  a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;

/** A straight edge's two points, or undefined for ends the schema would have refused. */
function straight(a: End, b: End): [Point, Point] | undefined {
  // Ends that overlap (a group and a card in it) have no line between them; the schema refuses them.
  if (spansOverlap(a.span, b.span)) return undefined;
  const rowLo = Math.max(a.span.r0, b.span.r0);
  const rowHi = Math.min(a.span.r1, b.span.r1);
  if (rowLo <= rowHi) {
    const y = rowY(middle(rowLo, rowHi)) + OVERVIEW_CARD_H / 2;
    const aLeft = a.box.x < b.box.x;
    const ax = aLeft ? a.box.x + a.box.w : a.box.x;
    const bx = aLeft ? b.box.x : b.box.x + b.box.w;
    return [
      { x: ax, y },
      { x: bx, y },
    ];
  }
  const colLo = Math.max(a.span.c0, b.span.c0);
  const colHi = Math.min(a.span.c1, b.span.c1);
  if (colLo > colHi) return undefined;
  const x = colX(middle(colLo, colHi)) + OVERVIEW_CARD_W / 2;
  const aAbove = a.box.y < b.box.y;
  const ay = aAbove ? a.box.y + a.box.h : a.box.y;
  const by = aAbove ? b.box.y : b.box.y + b.box.h;
  return [
    { x, y: ay },
    { x, y: by },
  ];
}

/** Every card and group of `view` as an edge end. */
function endsOf(view: OverviewView): Map<string, End> {
  const ends = new Map<string, End>();
  for (const card of view.cards) {
    const span = { c0: card.col, c1: card.col, r0: card.row, r1: card.row };
    ends.set(card.id, { id: card.id, span, box: spanBox(span, 0), card: true });
  }
  for (const group of view.groups ?? []) {
    const members = view.cards.filter(card => card.group === group.id);
    if (members.length === 0) continue;
    const span = {
      c0: Math.min(...members.map(card => card.col)),
      c1: Math.max(...members.map(card => card.col)),
      r0: Math.min(...members.map(card => card.row)),
      r1: Math.max(...members.map(card => card.row)),
    };
    ends.set(group.id, {
      id: group.id,
      span,
      box: spanBox(span, OVERVIEW_GROUP_PAD),
      card: false,
    });
  }
  return ends;
}

/** A straight line moved `by` across its own direction: a row's line down, a column's line right. */
function shifted([a, b]: [Point, Point], by: number): [Point, Point] {
  return a.y === b.y
    ? [
        { x: a.x, y: a.y + by },
        { x: b.x, y: b.y + by },
      ]
    : [
        { x: a.x + by, y: a.y },
        { x: b.x + by, y: b.y },
      ];
}

/**
 * A straight line's pill: above a row's line, or below it for a reply (whose ask sits above);
 * right of a column's line, or left of it for an ask a reply answers (whose reply sits right).
 */
function straightPill([a, b]: [Point, Point], w: number, role: 'reply' | 'asked' | 'plain'): Box {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (a.y === b.y)
    return {
      x: mid.x - w / 2,
      y: role === 'reply' ? mid.y + PILL_GAP : mid.y - PILL_GAP - PILL_H,
      w,
      h: PILL_H,
    };
  return {
    x: role === 'asked' ? mid.x - PILL_GAP - w : mid.x + PILL_GAP,
    y: mid.y - PILL_H / 2,
    w,
    h: PILL_H,
  };
}

/**
 * A lane line's pill: in the band above its own track, at the target's end, its near edge 8 px
 * inside the target's riser. Only lines its span holds rise inside that span, and they are
 * shallower, so their risers end above the band.
 */
function lanePill(points: readonly Point[], w: number): Box {
  const from = points[1] as Point;
  const to = points[2] as Point;
  const x = to.x < from.x ? to.x + 8 : to.x - 8 - w;
  return { x, y: to.y - OVERVIEW_TRACK / 2 - PILL_H / 2, w, h: PILL_H };
}

/** How the view's edges pair up: replies, the asks they answer, and the lane lines' routes. */
interface Routing {
  replies: Set<number>;
  answered: Set<number>;
  lanes: Map<number, LaneRoute>;
}

/** Whether a loops-back edge may be a lane line: two cards in different columns, as the schema says. */
const laneable = (from: End, to: End): boolean =>
  from.card && to.card && from.span.c0 !== to.span.c0;

function routingOf(view: OverviewView, ends: Map<string, End>, laneTop: number): Routing {
  const pair = replies(view.edges);
  const lines: LaneLine[] = [];
  const laneEnd = (end: End) => ({
    id: end.id,
    col: end.span.c0,
    left: end.box.x,
    width: end.box.w,
    bottom: end.box.y + end.box.h,
  });
  view.edges.forEach((edge, index) => {
    const from = ends.get(edge.from);
    const to = ends.get(edge.to);
    if (edge.kind !== 'loops-back' || pair.replies.has(index)) return;
    if (from === undefined || to === undefined || !laneable(from, to)) return;
    lines.push({ index, from: laneEnd(from), to: laneEnd(to) });
  });
  return { ...pair, lanes: laneRoutes(lines, laneTop, OVERVIEW_TRACK) };
}

/** Which side of a reply pair a straight edge is, if either. */
function roleOf(index: number, routing: Routing): 'reply' | 'asked' | 'plain' {
  if (routing.replies.has(index)) return 'reply';
  return routing.answered.has(index) ? 'asked' : 'plain';
}
const OFFSET = { reply: OVERVIEW_REPLY_OFFSET, asked: -OVERVIEW_REPLY_OFFSET, plain: 0 };

/** A straight edge's points, moved aside when it is half of a reply pair; undefined when refused. */
function straightPoints(
  edge: OverviewView['edges'][number],
  from: End,
  to: End,
  role: 'reply' | 'asked' | 'plain'
): [Point, Point] | undefined {
  // A loops-back edge is straight only as a reply between two cards; the schema refuses the rest.
  if (edge.kind === 'loops-back' && !(role === 'reply' && from.card && to.card)) return undefined;
  const line = straight(from, to);
  return line === undefined ? undefined : shifted(line, OFFSET[role]);
}

/** One edge's path, or undefined for one the schema would have refused. */
function edgePath(
  edge: OverviewView['edges'][number],
  index: number,
  ends: Map<string, End>,
  routing: Routing
): OverviewEdgePath | undefined {
  const from = ends.get(edge.from);
  const to = ends.get(edge.to);
  if (from === undefined || to === undefined) return undefined;
  const w = edge.label === undefined ? 0 : pillWidth(edge.label);
  const base = { from: edge.from, to: edge.to, kind: edge.kind, label: edge.label };
  const lane = routing.lanes.get(index);
  if (lane !== undefined)
    return { ...base, points: lane.points, pill: w > 0 ? lanePill(lane.points, w) : undefined };
  const role = roleOf(index, routing);
  const points = straightPoints(edge, from, to, role);
  if (points === undefined) return undefined;
  return { ...base, points, pill: w > 0 ? straightPill(points, w, role) : undefined };
}

const rowCentre = (row: number): number => rowY(row) + OVERVIEW_CARD_H / 2;

/**
 * The groups drawn as parallel: (a) two or more members, all in one column; (b) every edge that
 * names the group is a feeds or calls edge along a row; (c) no feeds or calls edge names a
 * member. Rule (c) is what lets a fan cross nothing: the only lines inside the group's pad are
 * then its own edges, which land on the frame's sides at a member's row (or between two), on
 * the bar, and lane lines rising into a member's bottom at its middle, away from either side.
 */
export function parallelGroups(view: OverviewView): Set<string> {
  const ends = endsOf(view);
  const named = new Set(
    view.edges.filter(edge => edge.kind !== 'loops-back').flatMap(edge => [edge.from, edge.to])
  );
  const parallel = new Set<string>();
  for (const group of view.groups ?? []) {
    const members = view.cards.filter(card => card.group === group.id);
    const end = ends.get(group.id);
    if (end === undefined || members.length < 2 || end.span.c0 !== end.span.c1) continue;
    if (members.some(card => named.has(card.id))) continue;
    const alongRow = view.edges
      .filter(edge => edge.from === group.id || edge.to === group.id)
      .every(edge => {
        const other = ends.get(edge.from === group.id ? edge.to : edge.from);
        if (edge.kind === 'loops-back' || other === undefined) return false;
        const points = straight(end, other);
        return points !== undefined && points[0].y === points[1].y;
      });
    if (alongRow) parallel.add(group.id);
  }
  return parallel;
}

/** The fan where `edge` meets the parallel group `group`, on the side of the frame it meets. */
function fanOf(
  view: OverviewView,
  edge: OverviewView['edges'][number],
  group: string,
  ends: Map<string, End>
): OverviewFan | undefined {
  const into = edge.to === group;
  const end = ends.get(group);
  const other = ends.get(into ? edge.from : edge.to);
  if (edge.kind === 'loops-back' || end === undefined || other === undefined) return undefined;
  const side = other.box.x < end.box.x ? 'left' : 'right';
  const frameX = side === 'left' ? end.box.x : end.box.x + end.box.w;
  const cardX = side === 'left' ? frameX + OVERVIEW_GROUP_PAD : frameX - OVERVIEW_GROUP_PAD;
  const stubs = view.cards
    .filter(card => card.group === group)
    .map(card => {
      const atFrame = { x: frameX, y: rowCentre(card.row) };
      const atCard = { x: cardX, y: rowCentre(card.row) };
      return into
        ? { card: card.id, from: atFrame, to: atCard }
        : { card: card.id, from: atCard, to: atFrame };
    });
  const bar: [Point, Point] = [
    { x: frameX, y: rowCentre(end.span.r0) },
    { x: frameX, y: rowCentre(end.span.r1) },
  ];
  return { group, kind: edge.kind, side, into, bar, stubs };
}

/** One fan for each end of an edge that is a parallel group. */
function fansOf(view: OverviewView, parallel: Set<string>, ends: Map<string, End>): OverviewFan[] {
  return view.edges.flatMap(edge =>
    [edge.from, edge.to]
      .filter(id => parallel.has(id))
      .flatMap(group => fanOf(view, edge, group, ends) ?? [])
  );
}

/** The box around every box, group label, line and pill of a view. */
function boundsOf(boxes: Box[], edges: OverviewEdgePath[]): Box {
  const all = [
    ...boxes,
    ...edges.flatMap(edge => [
      ...(edge.pill === undefined ? [] : [edge.pill]),
      ...edge.points.map(p => ({ x: p.x, y: p.y, w: 0, h: 0 })),
    ]),
  ];
  const left = Math.min(...all.map(box => box.x));
  const top = Math.min(...all.map(box => box.y));
  const right = Math.max(...all.map(box => box.x + box.w));
  // The deepest track's stroke and dashes reach a little under its centre line.
  const bottom = Math.max(...all.map(box => box.y + box.h)) + 4;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The layout of one view: its cards, groups and edges, and the box around all of them. */
export function layoutOverview(view: OverviewView): OverviewLayout {
  const ends = endsOf(view);
  const cards = new Map(view.cards.map(card => [card.id, (ends.get(card.id) as End).box]));
  const groups = new Map<string, Box>();
  for (const group of view.groups ?? []) {
    const end = ends.get(group.id);
    if (end !== undefined) groups.set(group.id, end.box);
  }
  const boxes = [...ends.values()].map(end => end.box);
  const lowest = Math.max(...boxes.map(box => box.y + box.h));
  const routing = routingOf(view, ends, lowest + OVERVIEW_LANE_BELOW);
  const edges = view.edges.flatMap((edge, index) => edgePath(edge, index, ends, routing) ?? []);
  const labels = (view.groups ?? []).flatMap(group => {
    const box = groups.get(group.id);
    return box === undefined ? [] : [groupLabelBox(box, group.label)];
  });
  return {
    cards,
    groups,
    edges,
    bounds: boundsOf([...boxes, ...labels], edges),
    fans: fansOf(view, parallelGroups(view), ends),
  };
}
