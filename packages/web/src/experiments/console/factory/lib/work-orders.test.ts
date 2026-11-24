import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { boardModel } from './board';
import { FIXTURE_NOW, progressOf, realItem, VIEW } from './board.test-fixtures';
import {
  displayKeyOf,
  highlightedKeys,
  membershipOf,
  NOT_STARTED,
  orderSearch,
  workOrders,
  type WorkOrder,
} from './work-orders';

const AT = '2026-11-17T10:00:00.000Z';

/** A `part_of` link from `item` to `order`, recorded at `at`; ended when `ended` is set. */
function linkTo(item: FactoryItem, order: string, at = AT, ended = false): FactoryItem {
  const link: FactoryItem['links'][number] = {
    id: `link-${item.item.key}-${order}-${at}`,
    kind: 'part_of',
    direction: 'outgoing',
    other: { id: `id-${order}`, projectKey: item.item.projectKey, key: order },
    at,
    via: 'cli',
    by: null,
    fromRun: null,
    ended: ended ? { at, via: 'cli', by: null, fromRun: null } : null,
  };
  return { ...item, links: [...item.links, link] };
}

/** `item` whose latest completed order run named `order`. */
function namedBy(item: FactoryItem, order: string): FactoryItem {
  return { ...item, progress: { ...progressOf(item), partOf: order } };
}

function ordersOf(items: FactoryItem[], members: Record<string, string[]> = {}): WorkOrder[] {
  return workOrders(items, boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW), members);
}

describe("an item's key as it reads", () => {
  /** `realItem('5')` keyed as a split member of `issue-136`. */
  const member = (): FactoryItem => {
    const item = realItem('5');
    return { ...item, item: { ...item.item, key: 'issue-136-item-keys' } };
  };

  test("a member of a work order reads as the order's number and its piece", () => {
    expect(displayKeyOf(linkTo(member(), 'issue-136'))).toBe('#136 · item keys');
  });
});

describe("an item's work order", () => {
  const five = (): FactoryItem => realItem('5');
  // Expected as `source order`, or null for no work order.
  test.each([
    ['an active part_of link', () => linkTo(five(), '48'), 'link 48'],
    ["its order run's result, with no link", () => namedBy(five(), '48'), 'output 48'],
    ['a link wins over a result', () => linkTo(namedBy(five(), '60'), '48'), 'link 48'],
    ['an ended link makes no member', () => linkTo(five(), '48', AT, true), null],
    ['no link and no result', five, null],
  ] as const)('%s', (_name, item, expected) => {
    const found = membershipOf(item());
    expect(found === null ? null : `${found.source} ${found.order}`).toBe(expected);
  });
});

describe('the work orders on a board', () => {
  test('an order with no runs is no card, and its members, linked or not yet started, count', () => {
    const items = [linkTo(realItem('5'), '48'), linkTo(realItem('2'), '48'), realItem('3')];
    const model = boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW);
    // 48 is in no column: only its members are on the board.
    expect(model.positions.has('48')).toBe(false);
    const [order, ...rest] = workOrders(items, model, { '48': ['5', '2', '9'] });
    expect(rest).toEqual([]);
    expect(order).toMatchObject({ key: '48', title: 'Work order #48', landed: 1 });
    expect(order?.members.map(member => [member.key, member.pill, member.where])).toEqual([
      ['5', 'running', 'Build'],
      ['2', 'landed', 'Merged'],
      // 9 is linked and has no run yet: on no board, waiting.
      ['9', 'waiting', NOT_STARTED],
    ]);
  });

  test('an order with runs of its own keeps its card and its title', () => {
    const items = [realItem('8'), linkTo(realItem('5'), '8')];
    const [order] = ordersOf(items, { '8': ['5'] });
    expect(order).toMatchObject({ key: '8', title: progressOf(realItem('8')).title });
    expect(highlightedKeys(order)).toEqual(new Set(['8', '5']));
  });
});

test("lighting an order keeps the board's other params; clearing it removes only the order", () => {
  const params = new URLSearchParams('view=table&show=landed');
  expect(orderSearch(params, '48')).toBe('?view=table&show=landed&order=48');
  expect(orderSearch(new URLSearchParams('order=48'), null)).toBe('');
});
