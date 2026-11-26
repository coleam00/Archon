/**
 * Where the pack's whole workflow draws its cards and arrows, in world units (px at zoom 1), from
 * the pack graph alone: one card per flow stage, stacked in a column per document group (Intake,
 * Plan and build, Checks, Landing), the columns left to right in the document's order, then a
 * Merged card. An arrow into a later column runs forward, card to card; one into the same or an
 * earlier column is a send-back, drawn in the lanes under the cards with its outcome on a pill.
 *
 * Pure.
 */
import type { PackGraph } from '../../skills/items';
import type { StageGroup } from '../../routes/BoardPage';
import { rounded } from '../canvas-lines';
import { PILL_LINE } from './map-sizes';
import { PILL_H, pillWidth } from './overview-layout';
import type { Box, Point } from './map-layout';
import { wordsOf } from './graph-structure';

export const FW_CARD_W = 208;
export const FW_CARD_H = 92;
export const FW_COL_GAP = 148;
/** Room between stacked cards for the tallest pill a hop to the card under draws (three lines), with 8 px each side. */
export const FW_ROW_GAP = PILL_H + 2 * PILL_LINE + 16;
/** The room above the cards for the group's heading. */
export const FW_HEAD = 44;
const LANE_FIRST = 36;
const LANE_STEP = 14;
/** How far right of its column the first hop to a card further down runs, and the next. */
const SIDE_FIRST = 40;
const SIDE_STEP = 16;
/** How far a forward pill moves along its line at a time to clear what is placed. */
const PLACE_STEP = 4;
const PAD = 16;

export const MERGED = 'merged';

export interface FullCard {
  /** The stage's workflow name; `merged` for the closing card. */
  id: string;
  /** The column's index. */
  column: number;
  box: Box;
}

export interface FullColumn {
  name: string;
  /** The column's stages, by workflow name. */
  stages: string[];
  box: Box;
}

export interface FullArrow {
  from: string;
  to: string;
  /** Outcomes the arrow carries, each once, in the graph's order. */
  labels: string[];
  back: boolean;
  /** The line, in world units. */
  d: string;
  points: Point[];
  /** What the pill says: each outcome on its own line, past three the first two and how many more. */
  lines: string[];
  /** Where the pill draws, clear of every card and every other pill. */
  pillBox: Box;
}

export interface FullLayout {
  columns: FullColumn[];
  cards: FullCard[];
  arrows: FullArrow[];
  bounds: Box;
}

/** The workflow each of the graph's stage names stands for. */
function workflowOf(graph: PackGraph): Map<string, string> {
  return new Map(graph.stages.map(stage => [stage.name, stage.workflow]));
}

interface Pair {
  from: string;
  to: string;
  labels: string[];
}

/** A pill's lines: every outcome while there are three or fewer, else two and how many more. */
function linesOf(labels: readonly string[]): string[] {
  return labels.length > 3
    ? [...labels.slice(0, 2), `+${String(labels.length - 2)} more`]
    : [...labels];
}

const pillHeight = (lines: readonly string[]): number => PILL_H + (lines.length - 1) * PILL_LINE;

/** The pill for `lines` centred on `at`. */
function pillAt(lines: readonly string[], at: Point): Box {
  const w = Math.max(...lines.map(pillWidth));
  const h = pillHeight(lines);
  return { x: at.x - w / 2, y: at.y - h / 2, w, h };
}

/** Whether two boxes overlap, edges touching not counted. */
const meet = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A forward pill on its line's `along` run: the run's middle when that is clear of every box
 * `taken`, else the nearest clear spot along the run, stepping out from the middle both ways.
 * Where the whole run is taken it sits in the middle; the layout test fails the shipped graph
 * on that.
 */
function placePill(lines: readonly string[], along: [Point, Point], taken: readonly Box[]): Box {
  const [p, q] = along;
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  const at = (t: number): Point => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const middle = pillAt(lines, at(0.5));
  const steps = Math.floor(length / 2 / PLACE_STEP);
  for (let step = 0; step <= steps; step += 1)
    for (const sign of step === 0 ? [1] : [1, -1]) {
      const box = pillAt(lines, at(0.5 + (sign * step * PLACE_STEP) / Math.max(length, 1)));
      if (!taken.some(other => meet(box, other))) return box;
    }
  return middle;
}

/** The columns (the groups, then Merged) and a card per stage, each column centred on the tallest. */
function placeColumns(groups: readonly StageGroup[]): { columns: FullColumn[]; cards: FullCard[] } {
  const names: StageGroup[] = [...groups, { name: 'Merged', stages: [MERGED] }];
  const tallest = Math.max(1, ...names.map(group => group.stages.length));
  const colHeight = tallest * FW_CARD_H + (tallest - 1) * FW_ROW_GAP;
  const columns: FullColumn[] = [];
  const cards: FullCard[] = [];
  names.forEach((group, column) => {
    const x = PAD + column * (FW_CARD_W + FW_COL_GAP);
    const height = group.stages.length * FW_CARD_H + (group.stages.length - 1) * FW_ROW_GAP;
    const top = FW_HEAD + (colHeight - height) / 2;
    columns.push({
      name: group.name,
      stages: group.stages,
      box: { x, y: PAD, w: FW_CARD_W, h: FW_HEAD + colHeight },
    });
    group.stages.forEach((stage, row) =>
      cards.push({
        id: stage,
        column,
        box: { x, y: PAD + top + row * (FW_CARD_H + FW_ROW_GAP), w: FW_CARD_W, h: FW_CARD_H },
      })
    );
  });
  return { columns, cards };
}

/**
 * One pair per two stages the graph connects, its outcomes joined. An arrow over a
 * `depends_on` link moves no item between stages, as on the curated map. Outcomes that end the
 * item go to Merged.
 */
function stagePairs(graph: PackGraph, byId: ReadonlyMap<string, FullCard>): Pair[] {
  const workflows = workflowOf(graph);
  const pairs = new Map<string, Pair>();
  const add = (from: string, to: string, label: string): void => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const key = JSON.stringify([from, to]);
    const entry = pairs.get(key) ?? { from, to, labels: [] };
    if (!entry.labels.includes(label)) entry.labels.push(label);
    pairs.set(key, entry);
  };
  for (const arrow of graph.arrows) {
    if (arrow.linked?.kind === 'depends_on') continue;
    const from = workflows.get(arrow.from.stage);
    const to = workflows.get(arrow.to);
    if (from !== undefined && to !== undefined) add(from, to, wordsOf(arrow.from));
  }
  for (const stage of graph.stages) {
    if (!stage.inFlow) continue;
    for (const value of stage.outcome?.values ?? [])
      if (value.final) add(stage.workflow, MERGED, value.value);
  }
  return [...pairs.values()];
}

/** A forward arrow's route and the run its pill sits on, placed once every lane is known. */
interface ForwardRoute {
  points: Point[];
  along: [Point, Point];
}

/** The card under it in its column: straight down, the pill in the gap between them. */
function routeDown(from: FullCard, to: FullCard): ForwardRoute {
  const a: Point = { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h };
  const b: Point = { x: a.x, y: to.box.y };
  return { points: [a, b], along: [a, b] };
}

/**
 * A card further down its column: down the column's right side (the `side`th hop there), so
 * the line and its pill pass the cards between rather than hide behind one.
 */
function routeColumnSide(from: FullCard, to: FullCard, side: number): ForwardRoute {
  const shift = (side % 3) * 12 - 12;
  const x = from.box.x + from.box.w + SIDE_FIRST + side * SIDE_STEP;
  const a: Point = { x: from.box.x + from.box.w, y: from.box.y + from.box.h / 2 + shift };
  const b: Point = { x: to.box.x + to.box.w, y: to.box.y + to.box.h / 2 + shift };
  const turnA: Point = { x, y: a.y };
  const turnB: Point = { x, y: b.y };
  return { points: [a, turnA, turnB, b], along: [turnA, turnB] };
}

/** The next column: right across the gap, turning in its middle. */
function routeNextColumn(from: FullCard, to: FullCard): ForwardRoute {
  const a: Point = { x: from.box.x + from.box.w, y: from.box.y + from.box.h / 2 };
  const b: Point = { x: to.box.x, y: to.box.y + to.box.h / 2 };
  if (a.y === b.y) return { points: [a, b], along: [a, b] };
  const mid = (a.x + b.x) / 2;
  const turnA: Point = { x: mid, y: a.y };
  const turnB: Point = { x: mid, y: b.y };
  return { points: [a, turnA, turnB, b], along: [turnA, turnB] };
}

/**
 * A send-back, or a hand-off that skips a column: routed in the `lane`th lane under the cards,
 * at `laneY`, so it crosses no card. Each lane is one pill tall, so no two lanes' pills meet.
 */
function routeLane(entry: Pair, from: FullCard, to: FullCard, lane: number, laneY: number) {
  const spread = (lane % 3) * 12 - 12;
  const lines = linesOf(entry.labels);
  const h = pillHeight(lines);
  const a: Point = { x: from.box.x + from.box.w / 2 + spread, y: from.box.y + from.box.h };
  const b: Point = { x: to.box.x + to.box.w / 2 + spread, y: to.box.y + to.box.h };
  const y = laneY + h / 2;
  const points = [a, { x: a.x, y }, { x: b.x, y }, b];
  return {
    pillBox: pillAt(lines, { x: (a.x + b.x) / 2, y }),
    points,
    lines,
    nextLaneY: laneY + h + LANE_STEP,
  };
}

/** Each pair routed: forward hops between neighbours by `routeDown`/`routeColumnSide`/`routeNextColumn`, the rest in lanes. */
function routePairs(pairs: readonly Pair[], byId: ReadonlyMap<string, FullCard>, bottom: number) {
  const forwardOf = (from: FullCard, to: FullCard): boolean =>
    to.column > from.column || (to.column === from.column && to.box.y > from.box.y);
  let laneY = bottom + LANE_FIRST;
  let lane = 0;
  /** How many hops already run down each column's right side. */
  const sides = new Map<number, number>();
  const lanes: FullArrow[] = [];
  const forward: (ForwardRoute & { entry: Pair })[] = [];
  for (const entry of pairs) {
    const from = byId.get(entry.from) as FullCard;
    const to = byId.get(entry.to) as FullCard;
    const isForward = forwardOf(from, to);
    const hops = to.column - from.column;
    if (isForward && hops === 0 && to.box.y === from.box.y + FW_CARD_H + FW_ROW_GAP) {
      forward.push({ entry, ...routeDown(from, to) });
    } else if (isForward && hops === 0) {
      const side = sides.get(from.column) ?? 0;
      sides.set(from.column, side + 1);
      forward.push({ entry, ...routeColumnSide(from, to, side) });
    } else if (isForward && hops === 1) {
      forward.push({ entry, ...routeNextColumn(from, to) });
    } else {
      const routed = routeLane(entry, from, to, lane, laneY);
      lane += 1;
      laneY = routed.nextLaneY;
      const { points, lines, pillBox } = routed;
      lanes.push({ ...entry, back: !isForward, points, d: rounded(points), lines, pillBox });
    }
  }
  return { lanes, forward };
}

/** The forward arrows, each pill placed clear of the cards and of every pill placed before it. */
function placeForwardPills(
  forward: readonly (ForwardRoute & { entry: Pair })[],
  taken: Box[]
): FullArrow[] {
  return forward.map(({ entry, points, along }) => {
    const lines = linesOf(entry.labels);
    const pillBox = placePill(lines, along, taken);
    taken.push(pillBox);
    return { ...entry, back: false, points, d: rounded(points), lines, pillBox };
  });
}

/** The box everything is drawn in, with the layout's margin. */
function boundsOf(cards: readonly FullCard[], arrows: readonly FullArrow[], bottom: number): Box {
  const lowest = Math.max(bottom, ...arrows.map(arrow => arrow.pillBox.y + arrow.pillBox.h));
  const right = Math.max(
    ...cards.map(card => card.box.x + card.box.w),
    ...arrows.map(arrow => arrow.pillBox.x + arrow.pillBox.w)
  );
  return { x: 0, y: 0, w: right + PAD, h: lowest + PAD };
}

export function fullWorkflowLayout(graph: PackGraph, groups: readonly StageGroup[]): FullLayout {
  const { columns, cards } = placeColumns(groups);
  const byId = new Map(cards.map(card => [card.id, card]));
  const bottom = Math.max(...cards.map(card => card.box.y + card.box.h));
  const { lanes, forward } = routePairs(stagePairs(graph, byId), byId, bottom);
  const taken = [...cards.map(card => card.box), ...lanes.map(arrow => arrow.pillBox)];
  const arrows = [...lanes, ...placeForwardPills(forward, taken)];
  return { columns, cards, arrows, bounds: boundsOf(cards, arrows, bottom) };
}
