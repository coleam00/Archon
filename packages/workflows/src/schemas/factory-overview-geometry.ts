/**
 * The rules that keep a factory overview view's drawing clean, checked on the grid itself so a
 * console's sizes cannot change the verdict. A card fills the middle of its cell; a group's box
 * wraps its members' cells, a little wider than a card. Every edge is straight or, for a lane
 * line, three straight runs:
 *
 * - `feeds` and `calls` run along a row the two ends share (the middle row of the rows they
 *   share), side to side, or else along a column they share, top to bottom. Ends that share
 *   neither cannot be joined without a bend, so the view is rejected.
 * - A `loops-back` edge that replies to a `calls` edge runs straight beside it, the two shifted
 *   apart. Every other `loops-back` edge drops from a port on the bottom of its source card into
 *   the lane under every box of the view, runs along its own track, and rises into a port on
 *   the bottom of its target card (`factory-overview-lanes.ts` sets ports and tracks).
 *
 * A view validates only when no line runs through a card other than its two ends, through a
 * group that holds neither end, or into another line. A console that routes by these rules
 * (the web's `overview-layout.ts`) draws nothing crossing. The web cannot import this module,
 * so it keeps a copy of these rules; `scripts/overview-geometry-parity.test.ts` checks on seeded
 * views that the two give the same verdict. Change both together.
 */
import { type LaneLine, laneRoutes, replies } from './factory-overview-lanes';

export type Issue = { path: (string | number)[]; message: string };

interface View {
  groups?: { id: string; label: string }[];
  cards: { id: string; col: number; row: number; group?: string }[];
  edges: { from: string; to: string; kind: 'feeds' | 'calls' | 'loops-back' }[];
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Cells, inclusive, that an end covers. */
interface Span {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

/** A card's half extent in its cell (cell pitch 1), and how far a group's box reaches past its cells' centres. */
const CARD_HALF = 0.36;
const GROUP_HALF = 0.43;
/** How far under the lowest box the lane's first track runs, and how far apart its tracks are. */
const LANE_BELOW = 0.3;
const TRACK = 0.15;
/** How far a reply and the ask it answers each move off the line they would share. */
const REPLY_OFFSET = 0.1;

interface End {
  id: string;
  span: Span;
  box: Box;
  /** The group this end sits in, for a card. */
  group: string | undefined;
  isCard: boolean;
}

function boxOf(span: Span, half: number): Box {
  return {
    left: span.c0 - half,
    right: span.c1 + half,
    top: span.r0 - half,
    bottom: span.r1 + half,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/** Each card and group of the view as an edge end, and the view's own issues with them. */
function endsOf(view: View): { ends: Map<string, End>; issues: Issue[] } {
  const ends = new Map<string, End>();
  const issues: Issue[] = [];
  const cells = new Map<string, string>();
  view.cards.forEach((card, index) => {
    const cell = `${card.col.toString()},${card.row.toString()}`;
    const other = cells.get(cell);
    if (other !== undefined)
      issues.push({
        path: ['cards', index],
        message: `cell ${cell} already holds card "${other}"`,
      });
    cells.set(cell, card.id);
    const span = { c0: card.col, c1: card.col, r0: card.row, r1: card.row };
    ends.set(card.id, {
      id: card.id,
      span,
      box: boxOf(span, CARD_HALF),
      group: card.group,
      isCard: true,
    });
  });
  view.groups?.forEach((group, index) => {
    const members = view.cards.filter(card => card.group === group.id);
    if (members.length === 0) {
      issues.push({ path: ['groups', index], message: `group "${group.id}" holds no card` });
      return;
    }
    const span = {
      c0: Math.min(...members.map(card => card.col)),
      c1: Math.max(...members.map(card => card.col)),
      r0: Math.min(...members.map(card => card.row)),
      r1: Math.max(...members.map(card => card.row)),
    };
    ends.set(group.id, {
      id: group.id,
      span,
      box: boxOf(span, GROUP_HALF),
      group: undefined,
      isCard: false,
    });
  });
  return { ends, issues };
}

/** Cards name a declared group; a group's box holds only its members and overlaps no other. */
function groupIssues(view: View, ends: Map<string, End>): Issue[] {
  const issues: Issue[] = [];
  const declared = new Set((view.groups ?? []).map(group => group.id));
  view.cards.forEach((card, index) => {
    if (card.group !== undefined && !declared.has(card.group))
      issues.push({
        path: ['cards', index, 'group'],
        message: `names group "${card.group}", which this view does not declare`,
      });
  });
  const groups = [...ends.values()].filter(end => !end.isCard);
  groups.forEach((group, index) => {
    const path = ['groups', (view.groups ?? []).findIndex(g => g.id === group.id)];
    for (const card of view.cards)
      if (card.group !== group.id && overlaps(group.box, boxOf(cellSpan(card), CARD_HALF)))
        issues.push({
          path,
          message: `group "${group.id}" covers card "${card.id}", which is not in it`,
        });
    for (const other of groups.slice(index + 1))
      if (overlaps(group.box, other.box))
        issues.push({ path, message: `group "${group.id}" overlaps group "${other.id}"` });
  });
  return issues;
}

function cellSpan(card: { col: number; row: number }): Span {
  return { c0: card.col, c1: card.col, r0: card.row, r1: card.row };
}

/** A straight run of a line, as a degenerate box. */
type Segment = Box;

const segment = (x0: number, y0: number, x1: number, y1: number): Segment => ({
  left: Math.min(x0, x1),
  right: Math.max(x0, x1),
  top: Math.min(y0, y1),
  bottom: Math.max(y0, y1),
});

/** The middle of the shared cells `lo..hi`: the row or column a straight edge runs along. */
const middle = (lo: number, hi: number): number => Math.floor((lo + hi) / 2);

/** A `feeds` or `calls` edge's one run, or why it has none. */
function straightRun(a: End, b: End): Segment | string {
  if (overlaps(a.box, b.box))
    return 'joins two ends that overlap, such as a group and a card in it';
  const rowLo = Math.max(a.span.r0, b.span.r0);
  const rowHi = Math.min(a.span.r1, b.span.r1);
  if (rowLo <= rowHi) {
    const [left, right] = a.box.right < b.box.left ? [a, b] : [b, a];
    const y = middle(rowLo, rowHi);
    return segment(left.box.right, y, right.box.left, y);
  }
  const colLo = Math.max(a.span.c0, b.span.c0);
  const colHi = Math.min(a.span.c1, b.span.c1);
  if (colLo <= colHi) {
    const [upper, lower] = a.box.bottom < b.box.top ? [a, b] : [b, a];
    const x = middle(colLo, colHi);
    return segment(x, upper.box.bottom, x, lower.box.top);
  }
  return 'an edge must share a row or a column with its other end';
}

/** A run moved `by` across its own direction: a row's run down, a column's run right. */
function shifted(run: Segment, by: number): Segment {
  return run.top === run.bottom
    ? { ...run, top: run.top + by, bottom: run.bottom + by }
    : { ...run, left: run.left + by, right: run.right + by };
}

/** Why a loops-back edge cannot be a lane line, or undefined when it can. */
function laneRefusal(a: End, b: End): string | undefined {
  if (!a.isCard || !b.isCard) return 'a loops-back edge joins two cards, not groups';
  if (a.span.c0 === b.span.c0) return 'a loops-back edge joins cards in different columns';
  return undefined;
}

const laneEnd = (end: End) => ({
  id: end.id,
  col: end.span.c0,
  left: end.box.left,
  width: end.box.right - end.box.left,
  bottom: end.box.bottom,
});

/** The runs of every lane line the view can route, by edge index. */
function laneRuns(lines: LaneLine[], ends: Map<string, End>): Map<number, Segment[]> {
  const top = Math.max(...[...ends.values()].map(end => end.box.bottom)) + LANE_BELOW;
  const runs = new Map<number, Segment[]>();
  for (const [index, route] of laneRoutes(lines, top, TRACK)) {
    const p = route.points;
    runs.set(
      index,
      p.slice(1).map((q, i) => segment((p[i] as typeof q).x, (p[i] as typeof q).y, q.x, q.y))
    );
  }
  return runs;
}

interface Line {
  index: number;
  from: End;
  to: End;
  runs: Segment[];
}

/** The pair key of an edge: a lane line or a reply may join a pair a straight edge joins. */
function pairKey(edge: View['edges'][number], reply: boolean): string {
  const kind = reply ? ' reply' : edge.kind === 'loops-back' ? ' lane' : '';
  return `${[edge.from, edge.to].sort().join(' ')}${kind}`;
}

/** Each edge's runs, and the issues of edges that name nothing, repeat a pair, or cannot be drawn. */
function linesOf(view: View, ends: Map<string, End>): { lines: Line[]; issues: Issue[] } {
  const routed: { index: number; from: End; to: End; runs: Segment[] | 'lane' }[] = [];
  const issues: Issue[] = [];
  const pairs = new Set<string>();
  const pair = replies(view.edges);
  const lanes: LaneLine[] = [];
  view.edges.forEach((edge, index) => {
    const from = ends.get(edge.from);
    const to = ends.get(edge.to);
    const fail = (message: string, at: (string | number)[] = []): void => {
      issues.push({ path: ['edges', index, ...at], message });
    };
    if (from === undefined)
      return fail(`names "${edge.from}", no card or group of this view`, ['from']);
    if (to === undefined) return fail(`names "${edge.to}", no card or group of this view`, ['to']);
    if (from === to) return fail('joins a card to itself');
    const key = pairKey(edge, pair.replies.has(index));
    if (pairs.has(key)) return fail(`joins "${edge.from}" and "${edge.to}" a second time`);
    pairs.add(key);
    if (edge.kind === 'loops-back' && !pair.replies.has(index)) {
      const refused = laneRefusal(from, to);
      if (refused !== undefined) return fail(refused);
      lanes.push({ index, from: laneEnd(from), to: laneEnd(to) });
      return void routed.push({ index, from, to, runs: 'lane' });
    }
    if (edge.kind === 'loops-back' && (!from.isCard || !to.isCard))
      return fail('a loops-back edge joins two cards, not groups');
    const run = straightRun(from, to);
    if (typeof run === 'string') return fail(run);
    const by = pair.replies.has(index)
      ? REPLY_OFFSET
      : pair.answered.has(index)
        ? -REPLY_OFFSET
        : 0;
    routed.push({ index, from, to, runs: [shifted(run, by)] });
  });
  const laneRunsOf = laneRuns(lanes, ends);
  const lines = routed.map(line => ({
    ...line,
    runs: line.runs === 'lane' ? (laneRunsOf.get(line.index) as Segment[]) : line.runs,
  }));
  return { lines, issues };
}

/** Whether a line may pass through `end`'s box: it is one of its ends, or a group holding one. */
function passes(line: Line, end: End): boolean {
  if (end === line.from || end === line.to) return true;
  return !end.isCard && (line.from.group === end.id || line.to.group === end.id);
}

/** No line runs through a card or group it may not pass, or into another line. */
function crossingIssues(lines: Line[], ends: Map<string, End>): Issue[] {
  const issues: Issue[] = [];
  lines.forEach((line, at) => {
    const path = ['edges', line.index];
    for (const end of ends.values())
      if (!passes(line, end) && line.runs.some(run => overlaps(run, end.box)))
        issues.push({
          path,
          message: `runs through ${end.isCard ? 'card' : 'group'} "${end.id}"; move a card so the line has a clear row or column`,
        });
    for (const other of lines.slice(at + 1))
      if (line.runs.some(run => other.runs.some(run2 => overlaps(run, run2))))
        issues.push({
          path,
          message: `crosses or touches the edge from "${other.from.id}" to "${other.to.id}"`,
        });
  });
  return issues;
}

/** Every issue with one view's drawing; paths are relative to the view. */
export function geometryIssues(view: View): Issue[] {
  const { ends, issues } = endsOf(view);
  const { lines, issues: edgeIssues } = linesOf(view, ends);
  return [...issues, ...groupIssues(view, ends), ...edgeIssues, ...crossingIssues(lines, ends)];
}
