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
  test('the seeded items: running ones by their step, idle ones by their last outcome', () => {
    const items = ['6', '5', '4', '3', '8', '7'].map(realItem);
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

  test('which card a running step belongs to', () => {
    const live = stageLive(
      view,
      [
        itemWith('r', [run('deliver', 'running', null, 'rounds.review__review')]),
        itemWith('b', [run('deliver', 'running', null, 'build__build')]),
        itemWith('h', [run('deliver', 'running', null, 'hostrounds.host__host')]),
        itemWith('n', [run('deliver', 'running')]),
      ],
      []
    );
    expect(chips(live).checks).toEqual([['r'], 1, []]);
    expect(chips(live).build).toEqual([['b', 'n'], 2, []]);
    expect(chips(live).host).toEqual([['h'], 1, []]);
  });

  test('an idle ready item is on Ready, not working; a triage ending is on no card', () => {
    const live = stageLive(
      view,
      [
        itemWith('ready', [run('deliver', 'completed', 'ready')]),
        itemWith('close', [run('triage', 'completed', 'close')]),
      ],
      []
    );
    expect(chips(live).ready).toEqual([['ready'], 0, []]);
    expect([...live.stages.values()].flatMap(entry => entry.items)).toHaveLength(1);
    expect(live.notOnMap).toEqual([]);
  });

  test('an item taken up again after triage closed it stays on a card while its new run is paused', () => {
    const reopened = itemWith('again', [
      run('triage', 'completed', 'reject'),
      run('triage', 'paused'),
    ]);
    const live = stageLive(view, [reopened], []);
    // Paused, it works on no step: the first stage, as on the board.
    expect(chips(live).order).toEqual([['again'], 0, []]);
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

  test("a failed run after a placed completion keeps the completion's card, as on the item page", () => {
    const histories = [
      itemWith('w', [run('deliver', 'completed', 'waiting'), run('deliver', 'failed')]),
      itemWith('p', [run('plan', 'completed', 'planned'), run('triage', 'failed')]),
    ];
    const live = stageLive(view, histories, []);
    expect(chips(live).host).toEqual([['w'], 0, []]);
    expect(chips(live).build).toEqual([['p'], 0, []]);
  });

  test('an item whose progress could not be read sits in the first stage, as on the board', () => {
    const live = stageLive(view, [itemWithoutProgress('z')], []);
    expect(chips(live).order).toEqual([['z'], 0, []]);
    expect(live.notOnMap).toEqual([]);
  });

  test('an item on a stage the map draws no card for is listed with that stage', () => {
    const noCards = { ...view, map: { ...view.map, cards: [] } };
    const ready = itemWith('ready', [run('deliver', 'completed', 'ready')]);
    const live = stageLive(noCards, [ready], []);
    expect(live.notOnMap.map(entry => [entry.item.item.key, entry.why])).toEqual([
      ['ready', { kind: 'no-card', stage: 'ready' }],
    ]);
    expect(chips(live).ready).toEqual([['ready'], 0, []]);
  });

  test('a run on a step no stage names keeps its card where it sat on the last read', () => {
    const between = itemWith('r', [run('deliver', 'running', null, 'rounds')]);
    const first = stageLive(view, [between], [], new Map([['r', 'checks']]));
    expect(chips(first).checks).toEqual([['r'], 1, []]);
    expect(first.positions.get('r')).toBe('checks');
    // With no last read, the workflow's first stage.
    expect(chips(stageLive(view, [between], [])).build).toEqual([['r'], 1, []]);
  });

  test('an item placement finds no column for is listed, not thrown', () => {
    // A view that no longer lists `deliver`, read beside items cached under the old one.
    const stages = view.stages.map(stage => ({
      ...stage,
      workflows: stage.workflows.filter(workflow => workflow !== 'deliver'),
    }));
    const item = itemWith('r', [run('deliver', 'running', null, 'build__build')]);
    const live = stageLive({ ...view, stages }, [item], []);
    expect(live.notOnMap).toEqual([{ item, why: { kind: 'no-column' } }]);
  });
});

describe('the map and the board', () => {
  test('put every item in the same stage, over two reads, a run between named steps included', () => {
    const items = [
      ...['6', '5', '4', '3', '8', '7'].map(realItem),
      itemWith('between', [run('deliver', 'running', null, 'rounds')]),
      itemWith('nostep', [run('deliver', 'running', null, null)]),
      itemWithoutProgress('unread'),
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
