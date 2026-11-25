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
import { PILL_H } from './overview-layout';
import type { Box, Point } from './map-layout';

export const FW_CARD_W = 208;
export const FW_CARD_H = 92;
export const FW_COL_GAP = 148;
export const FW_ROW_GAP = 28;
/** The room above the cards for the group's heading. */
export const FW_HEAD = 44;
const LANE_FIRST = 36;
const LANE_STEP = 14;
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
  /** The pill's centre. */
  pill: Point;
}

export interface FullLayout {
  columns: FullColumn[];
  cards: FullCard[];
  arrows: FullArrow[];
  bounds: Box;
}

/** What an arrow of the graph says: its outcome, or what settles the ask it follows. */
function wordsOf(from: PackGraph['arrows'][number]['from']): string {
  if ('outcome' in from) return from.outcome;
  if (from.option !== undefined) return from.option;
  return from.settled === 'any' ? 'asked' : from.settled;
}

/** The workflow each of the graph's stage names stands for. */
function workflowOf(graph: PackGraph): Map<string, string> {
  return new Map(graph.stages.map(stage => [stage.name, stage.workflow]));
}

export function fullWorkflowLayout(graph: PackGraph, groups: readonly StageGroup[]): FullLayout {
  const workflows = workflowOf(graph);
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
  const byId = new Map(cards.map(card => [card.id, card]));

  // One arrow per pair of stages, its outcomes joined. An arrow over a `depends_on` link moves
  // no item between stages, as on the curated map. Outcomes that end the item go to Merged.
  const pairs = new Map<string, { from: string; to: string; labels: string[] }>();
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

  const forwardOf = (from: FullCard, to: FullCard): boolean =>
    to.column > from.column || (to.column === from.column && to.box.y > from.box.y);
  const bottom = Math.max(...cards.map(card => card.box.y + card.box.h));
  let laneY = bottom + LANE_FIRST;
  let lane = 0;
  const arrows: FullArrow[] = [];
  for (const entry of pairs.values()) {
    const from = byId.get(entry.from) as FullCard;
    const to = byId.get(entry.to) as FullCard;
    const forward = forwardOf(from, to);
    const hops = to.column - from.column;
    if (forward && hops <= 1) {
      // Card to card: straight down inside a column, else right across the gap.
      const same = hops === 0;
      const a: Point = same
        ? { x: from.box.x + from.box.w / 2, y: from.box.y + from.box.h }
        : { x: from.box.x + from.box.w, y: from.box.y + from.box.h / 2 };
      const b: Point = same
        ? { x: to.box.x + to.box.w / 2, y: to.box.y }
        : { x: to.box.x, y: to.box.y + to.box.h / 2 };
      const mid = (a.x + b.x) / 2;
      const points = same || a.y === b.y ? [a, b] : [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
      arrows.push({
        ...entry,
        back: false,
        points,
        d: rounded(points),
        pill: same
          ? { x: a.x, y: (a.y + b.y) / 2 }
          : { x: mid, y: a.y === b.y ? a.y : a.y + (b.y - a.y) / 2 },
      });
      continue;
    }
    // A send-back, or a hand-off that skips a column: routed in a lane under the cards, so it
    // crosses no card.
    const spread = (lane % 3) * 12 - 12;
    lane += 1;
    const shown = Math.min(entry.labels.length, 3);
    const a: Point = { x: from.box.x + from.box.w / 2 + spread, y: from.box.y + from.box.h };
    const b: Point = { x: to.box.x + to.box.w / 2 + spread, y: to.box.y + to.box.h };
    const y = laneY + (PILL_H + (shown - 1) * PILL_LINE) / 2;
    laneY += PILL_H + (shown - 1) * PILL_LINE + LANE_STEP;
    const points = [a, { x: a.x, y }, { x: b.x, y }, b];
    arrows.push({
      ...entry,
      back: !forward,
      points,
      d: rounded(points),
      pill: { x: (a.x + b.x) / 2, y },
    });
  }
  const lowest = Math.max(bottom, ...arrows.map(arrow => arrow.pill.y + 16));
  const right = Math.max(...cards.map(card => card.box.x + card.box.w));
  return {
    columns,
    cards,
    arrows,
    bounds: { x: 0, y: 0, w: right + PAD, h: lowest + PAD },
  };
}
