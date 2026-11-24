/**
 * The factory overview's two copies of its drawing rules must agree: the schema's
 * (`factory-overview-geometry.ts` in `@archon/workflows`), which refuses a file whose lines
 * would cross, and the web's (`overview-layout.ts`), which draws them. `@archon/web` must not
 * import `@archon/workflows`, so the copies cannot share one module; this test is what keeps
 * them in step. It lives in `scripts/` for the reason `node-ref-parity.test.ts` gives: it is
 * a cross-package invariant, and nothing here is bundled.
 *
 * It generates views from a fixed seed (so a failure reproduces) and, for each, checks that
 * the schema accepts the view exactly when the web draws it with every edge routed and nothing
 * touching. The generator keeps clear of the schema's rules that are not about drawing
 * (repeated cells, undeclared or empty groups, a group covering a card outside it, repeated
 * pairs, self edges), so any disagreement is a disagreement about geometry.
 */
import { describe, expect, test } from 'bun:test';
import { drawingFaults } from '../packages/web/src/experiments/console/factory/lib/overview-layout.test-fixtures';
import type { OverviewView } from '../packages/web/src/experiments/console/factory/lib/overview-nav';
import { geometryIssues } from '../packages/workflows/src/schemas/factory-overview-geometry';

/** mulberry32: a small seeded generator, so every run draws the same views. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Card = OverviewView['cards'][number];
type Edge = OverviewView['edges'][number];

const COLS = 6;
const ROWS = 4;
const VIEWS = 20_000;
/** The most loops-back edges a view gets between cards, besides a reply. */
const LANES = 3;

type Random = () => number;

const pickOf =
  (random: Random) =>
  (n: number): number =>
    Math.floor(random() * n);

/** Up to a dozen cards, each in its own cell. */
function cardsOf(random: Random): Card[] {
  const pick = pickOf(random);
  const cells = Array.from({ length: COLS * ROWS }, (_, i) => i).sort(() => random() - 0.5);
  return cells.slice(0, 2 + pick(11)).map((cell, i) => ({
    id: `c${i.toString()}`,
    title: `Card ${i.toString()}`,
    text: 'A card.',
    icon: 'hammer',
    kind: 'stage',
    col: (cell % COLS) + 1,
    row: Math.floor(cell / COLS) + 1,
  }));
}

/** Cells a set of cards covers: [first col, last col, first row, last row]. */
function spanOf(members: readonly Card[]): [number, number, number, number] {
  return [
    Math.min(...members.map(c => c.col)),
    Math.max(...members.map(c => c.col)),
    Math.min(...members.map(c => c.row)),
    Math.max(...members.map(c => c.row)),
  ];
}

const within = (card: Card, [c0, c1, r0, r1]: readonly number[]): boolean =>
  card.col >= (c0 as number) &&
  card.col <= (c1 as number) &&
  card.row >= (r0 as number) &&
  card.row <= (r1 as number);

/**
 * Up to two groups, so a line can join two ends that share several rows or columns. Every
 * card in a random rectangle joins its group; a group whose bounds would hold a card outside
 * it or meet the other group is dropped, as the schema would refuse it for reasons that are
 * not about lines.
 */
function addGroups(view: OverviewView, random: Random): void {
  const pick = pickOf(random);
  for (const id of ['g', 'h']) {
    if (random() < 0.2) continue;
    const [c0, c1] = [1 + pick(COLS), 1 + pick(COLS)].sort((x, y) => x - y) as [number, number];
    const [r0, r1] = [1 + pick(ROWS), 1 + pick(ROWS)].sort((x, y) => x - y) as [number, number];
    const inside = view.cards.filter(c => within(c, [c0, c1, r0, r1]));
    if (inside.length === 0 || inside.some(c => c.group !== undefined)) continue;
    const span = spanOf(inside);
    const strangers = view.cards.some(c => !inside.includes(c) && within(c, span));
    const meetsOther = (view.groups ?? []).some(group => {
      const [x0, x1, y0, y1] = spanOf(view.cards.filter(c => c.group === group.id));
      return span[0] <= x1 && x0 <= span[1] && span[2] <= y1 && y0 <= span[3];
    });
    if (strangers || meetsOther) continue;
    view.groups?.push({ id, label: `Group ${id}` });
    for (const card of inside) card.group = id;
  }
}

/** Whether the view has a `calls` edge `from`->`to`: a loops-back edge back along it is a reply. */
const asks = (view: OverviewView, from: string, to: string): boolean =>
  view.edges.some(edge => edge.kind === 'calls' && edge.from === from && edge.to === to);

/**
 * Up to six straight edges between distinct ends, then up to three loops-back edges between
 * cards, some sharing an end and some nested, apart or interleaved, and sometimes a reply to
 * one of the asks. No pair twice, keyed as the schema keys them (a lane line and a reply each
 * apart from a straight edge), since the web has no rule against a repeated pair.
 */
function addEdges(view: OverviewView, random: Random): void {
  const pick = pickOf(random);
  const ends = [...view.cards.map(c => c.id), ...(view.groups ?? []).map(g => g.id)];
  // A lane end with a card under it is refused, so lane ends are mostly the lowest card of a column.
  const lowest = view.cards
    .filter(c => !view.cards.some(o => o.col === c.col && o.row > c.row))
    .map(c => c.id);
  const all = view.cards.map(c => c.id);
  const laneEnd = (): string => {
    const from = random() < 0.85 ? lowest : all;
    return from[pick(from.length)] as string;
  };
  const pairs = new Set<string>();
  const add = (from: string, to: string, kind: Edge['kind']): void => {
    const reply = kind === 'loops-back' && asks(view, to, from);
    const tag = kind !== 'loops-back' ? '' : reply ? ' reply' : ' lane';
    const key = `${[from, to].sort().join(' ')}${tag}`;
    if (from === to || pairs.has(key)) return;
    pairs.add(key);
    view.edges.push({ from, to, kind });
  };
  for (let tries = 0; tries < 1 + pick(6); tries++)
    add(
      ends[pick(ends.length)] as string,
      ends[pick(ends.length)] as string,
      random() < 0.5 ? 'feeds' : 'calls'
    );
  for (let tries = pick(LANES + 1); tries > 0; tries--) add(laneEnd(), laneEnd(), 'loops-back');
  const calls = view.edges.filter(edge => edge.kind === 'calls');
  if (calls.length > 0 && random() < 0.3) {
    const asked = calls[pick(calls.length)] as Edge;
    add(asked.to, asked.from, 'loops-back');
  }
}

/** One view, clear of the schema's rules that are not about lines. */
function generate(random: Random): OverviewView {
  const view: OverviewView = { cards: cardsOf(random), edges: [], groups: [] };
  addGroups(view, random);
  addEdges(view, random);
  return view;
}

describe('the overview schema and the web drawing agree', () => {
  test(`on ${VIEWS.toString()} seeded views: the schema accepts a view exactly when the web draws it clean`, () => {
    const random = seeded(31);
    const disagreements: string[] = [];
    let clean = 0;
    for (let i = 0; i < VIEWS; i++) {
      const view = generate(random);
      const issues = geometryIssues(view);
      const faults = drawingFaults(view);
      if (issues.length === 0) clean++;
      if ((issues.length === 0) !== (faults.length === 0))
        disagreements.push(
          `view ${i.toString()}: schema ${JSON.stringify(issues.map(x => x.message))}, web ${JSON.stringify(faults)}, ${JSON.stringify(view)}`
        );
    }
    expect(disagreements.slice(0, 3)).toEqual([]);
    // Both verdicts must be common, or the agreement proves little.
    expect(clean).toBeGreaterThan(VIEWS / 10);
    expect(VIEWS - clean).toBeGreaterThan(VIEWS / 10);
  });
});
