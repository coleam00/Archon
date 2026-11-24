import { describe, expect, test } from 'bun:test';
import type { AttentionQueueItem } from '../../skills/runs';
import { askItem, usageLimitItem } from '../../lib/needs-you.test-fixtures';
import { stageLive as stageLiveAt } from './map-live';
import { itemWith, itemWithoutProgress, realItem, run } from './map.test-fixtures';
import { shippedView } from '../item-detail.test-fixtures';
import { boardModel } from './board';
import { FIXTURE_NOW, needsShaping } from './board.test-fixtures';

const view = shippedView;

/** `stageLive` for project `cb-1` at the fixtures' clock, with no last read unless given. */
const stageLive = (
  declaration: Parameters<typeof stageLiveAt>[0],
  items: Parameters<typeof stageLiveAt>[2],
  attention: Parameters<typeof stageLiveAt>[3],
  previous: ReadonlyMap<string, string> = new Map()
): ReturnType<typeof stageLiveAt> =>
  stageLiveAt(declaration, 'cb-1', items, attention, previous, FIXTURE_NOW);

/** Per stage: [keys here, working, keys needing you]. */
function chips(live: ReturnType<typeof stageLive>): Record<string, [string[], number, string[]]> {
  return Object.fromEntries(
    [...live.stages].map(([stage, entry]) => [
      stage,
      [
        entry.items.map(item => item.item.key),
        entry.working,
        entry.needYou.map(item => item.item.key),
      ],
    ])
  );
}

const askOn = (id: string, key: string): AttentionQueueItem =>
  askItem({ ref: `ask:${key}`, item: { id, projectKey: 'acme', key } });

describe('the live chips on each card', () => {
  test('the seeded items: running ones by their step, idle ones by their last outcome, endings on none', () => {
    // A triage ending is on no card, and not listed as missing one either.
    const closed = itemWith('close', [run('triage', 'completed', 'close')]);
    const items = [...['6', '5', '4', '3', '8', '7'].map(realItem), closed];
    const live = stageLive(view, items, []);
    expect(chips(live)).toEqual({
      order: [[], 0, []],
      triage: [[], 0, []],
      plan: [[], 0, []],
      build: [['5', '3'], 1, []],
      checks: [['4'], 1, []],
      host: [['6'], 1, []],
      ready: [[], 0, []],
      landed: [['8', '7'], 0, []],
    });
    expect(live.notOnMap).toEqual([]);
  });

  test('needs you: an open ask on the item, matched by item id; a usage limit is not', () => {
    const asking = itemWith('ask', [run('deliver', 'completed', 'ask')]);
    const limited = itemWith('limit', [run('deliver', 'running', null, 'build__build')]);
    const live = stageLive(
      view,
      [asking, limited],
      [
        askOn(asking.item.id, asking.item.key),
        usageLimitItem({ item: { id: limited.item.id, projectKey: 'acme', key: 'limit' } }),
        // Same key, another item: not this one.
        askOn('other-id', 'limit'),
      ]
    );
    expect(chips(live).build).toEqual([['ask', 'limit'], 1, ['ask']]);
  });

  test('needs you: an item waiting on you with no ask open counts, once', () => {
    const shaping = needsShaping('9s', ['Which?']);
    const live = stageLive(shippedView, [shaping], []);
    expect(live.stages.get('triage')?.needYou.map(item => item.item.key)).toEqual(['9s']);
    const asking = { ...shaping, questions: [askOn(shaping.item.id, '9s')] };
    const both = stageLive(shippedView, [asking], [askOn(shaping.item.id, '9s')]);
    expect(both.stages.get('triage')?.needYou).toHaveLength(1);
  });

  test('needs you: a wait the item read lists among its questions counts, as on the item page', () => {
    const asking = itemWith('child', [run('deliver', 'completed', 'ask')]);
    // A wait inside a child run: the queue names no item, the item read lists its ref.
    const wait = askItem({ ref: 'ask:child-run', item: undefined });
    asking.questions = [wait];
    expect(chips(stageLive(view, [asking], [wait])).build).toEqual([['child'], 0, ['child']]);
  });
});

describe('the map and the board', () => {
  // Placement's rules are tested in placement.test.ts; the map must only agree with the board.
  test('put every item in the same stage, over two reads, a run between named steps included', () => {
    const items = [
      ...['6', '5', '4', '3', '8', '7'].map(realItem),
      itemWith('between', [run('deliver', 'running', null, 'rounds')]),
      itemWith('nostep', [run('deliver', 'running', null, null)]),
      itemWithoutProgress('unread'),
      itemWith('again', [run('triage', 'completed', 'reject'), run('triage', 'paused')]),
      itemWith('w', [run('deliver', 'completed', 'waiting'), run('deliver', 'failed')]),
    ];
    // The first read has no last read; the second holds the run between steps in Checks.
    for (const previous of [
      new Map<string, string>(),
      new Map([
        ['between', 'checks'],
        ['nostep', 'checks'],
      ]),
    ]) {
      const board = boardModel(view, 'cb-1', items, previous, FIXTURE_NOW).positions;
      const map = stageLive(view, items, [], previous).positions;
      for (const item of items) expect(map.get(item.item.key)).toBe(board.get(item.item.key));
    }
  });
});

test('a pending merge state marks the stage holding it and the landed stage, no other', () => {
  const pending = itemWith('p', [run('deliver', 'completed', 'ready')], 'pending');
  const live = stageLive(view, [realItem('6'), realItem('7'), pending], []);
  const marked = [...live.stages].filter(([, entry]) => entry.pending).map(([stage]) => stage);
  expect(marked).toEqual(['ready', view.landed.stage]);
  const settled = itemWith('u', [run('deliver', 'completed', 'ready')], 'unknown');
  const none = stageLive(view, [realItem('7'), settled], []);
  expect([...none.stages.values()].some(entry => entry.pending)).toBe(false);
});
