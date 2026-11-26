import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { NO_ITEM_ASKS } from '../components/ItemAsksSection';
import type { ItemAsk } from '../primitives/run';
import { CardList } from '../routes/board/ItemCard';
import type { ItemRead } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import type { FactoryView, RunRecord } from './api';
import { BoardTable } from './BoardTable';
import { CardsContext } from './cards-context';
import fixture from './lib/__fixtures__/card-items.json';
import { sortRows } from './lib/board-table';
import { runsToRead, type CardPack, type CardProgress } from './lib/item-card';

afterEach(() => {
  invalidate('board');
});

const PREFIX = 'Wirasm/archon-software-factory:';
const WORKFLOWS = ['plan', 'stage-build', 'stage-check', 'stage-host'];
/** The fixture's rounds and returns declarations, as `item-card.test.ts` reads them. */
const VIEW = {
  stages: {},
  words: { round: 'check round', rounds: 'check rounds', sentBack: 'sent back' },
  retired: ['deliver'],
  rounds: [
    { workflow: 'deliver', loop: 'rounds' },
    { workflow: 'stage-check', round: '/round', allowance: '/allowance' },
  ],
  returns: [
    { workflow: 'deliver', node: 'rounds.verdict__verdict', outcome: 'return' },
    { workflow: 'stage-check', node: 'verdict__verdict', outcome: 'return' },
    { workflow: 'stage-host', node: 'rounds__host', outcome: 'return' },
  ],
} as unknown as FactoryView;
const PACK: CardPack = {
  stages: WORKFLOWS.map(workflow => ({ name: `${PREFIX}${workflow}`, workflow, inFlow: true })),
  view: VIEW,
};
const reads = (fixture.items as unknown as ItemRead[]).map(read => ({
  ...read,
  standing: { ...read.standing, pack: null },
}));

test("a Table row's round and returned cells are the card's own for the same item", () => {
  const runs = [...new Set(reads.flatMap(read => runsToRead(PACK, read)))].sort();
  set(K.cardReads('web', runs), {
    records: fixture.records as unknown as RunRecord[],
    missing: [],
    unreadable: [],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CardsContext.Provider
        value={{
          projectId: 'web',
          packs: new Map([['flow', PACK]]),
          packsError: false,
          itemAsks: NO_ITEM_ASKS,
        }}
      >
        <CardList reads={reads} projectId="web" className="" />
        <BoardTable
          projectId="web"
          rows={reads.map(read => ({ read, column: 'Merged', columnOrder: 0 }))}
          earlier={[]}
        />
      </CardsContext.Provider>
    </MemoryRouter>
  );
  const page = new Window().document;
  page.body.innerHTML = html;
  const text = (selector: string): string | undefined =>
    page.querySelector(selector)?.textContent ?? undefined;
  for (const { item } of reads) {
    const card = `[data-item="${item.key}"]`;
    const row = `[data-row="${item.key}"]`;
    expect(text(`${row} [data-cell="round"]`)).toBe(text(`${card} [data-card-rounds]`));
    expect(text(`${row} [data-cell="returned"]`)).toBe(text(`${card} [data-card-returned]`));
  }
  // The comparison is not between two empty cells.
  expect(text('[data-row="125"] [data-cell="round"]')).toBe('4 of 4 check rounds');
});

test('sorting by To merge orders rows by the time from the first run to the merge', () => {
  const merged = (key: string, hours: number): ItemRead =>
    ({
      item: { key },
      runs: [{ startedAt: '2026-11-20T00:00:00Z' }],
      merged: { at: new Date(Date.UTC(2026, 10, 20, hours)).toISOString() },
    }) as unknown as ItemRead;
  const rows = [merged('slow', 5), merged('fast', 1), merged('mid', 3)].map(read => ({
    read,
    column: 'Merged',
    columnOrder: 0,
  }));
  const sorted = sortRows(rows, { by: 'toMerge', descending: false }, () => ({}) as CardProgress);
  expect(sorted.map(row => row.read.item.key)).toEqual(['fast', 'mid', 'slow']);
});

test('an item with open asks shows its state label and one Needs you link in its State cell, to the filtered tab', () => {
  const [read] = reads;
  if (read === undefined) throw new Error('the fixture has no items');
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CardsContext.Provider
        value={{
          projectId: 'web',
          packs: new Map([['flow', PACK]]),
          packsError: false,
          itemAsks: {
            ...NO_ITEM_ASKS,
            asks: [
              {
                kind: 'attention',
                ref: 'ask:a1',
                project: null,
                item: { id: read.item.id, projectKey: read.item.projectKey, key: read.item.key },
                revision: 1,
                labels: {},
                pausedAt: null,
                message: 'Land it?',
                form: 'select',
                options: [{ id: 'land', does: 'Lands it.', cost: 'Nothing.' }],
              } as ItemAsk,
            ],
          },
        }}
      >
        <BoardTable
          projectId="web"
          rows={reads.map(each => ({ read: each, column: 'Merged', columnOrder: 0 }))}
          earlier={[]}
        />
      </CardsContext.Provider>
    </MemoryRouter>
  );
  const page = new Window().document;
  page.body.innerHTML = html;
  const row = page.querySelector(`[data-row="${read.item.key}"]`);
  const links = row?.querySelectorAll('[data-needs-you-link]') ?? [];
  expect(links.length).toBe(1);
  expect(links[0]?.closest('[data-cell="state"]')).not.toBeNull();
  expect(links[0]?.textContent).toBe('Needs you · 1');
  expect(links[0]?.getAttribute('href')).toBe(
    `/console/p/web/needs-you?item=${encodeURIComponent(read.item.key)}`
  );
  // The state cell keeps its label, a label and not a link, with the Needs you button after it;
  // there is no separate Asks column.
  const label = row?.querySelector('[data-cell="state"] [data-chip]');
  expect(label?.tagName).toBe('SPAN');
  expect(label?.closest('a')).toBeNull();
  // The fixture's first item merged: its label says how it ended.
  expect(read.merged).not.toBeNull();
  expect(label?.textContent).toBe('Merged');
  expect(label?.nextElementSibling).toBe(links[0] ?? null);
  expect(page.querySelector('thead')?.textContent).not.toContain('Asks');
  // A row with no ask has its label and no link.
  const other = page.querySelector(`[data-row="${reads[1]?.item.key ?? ''}"]`);
  expect(other?.querySelector('[data-needs-you-link]')).toBeNull();
  expect(other?.querySelector('[data-cell="state"] [data-chip]')).not.toBeNull();
});
