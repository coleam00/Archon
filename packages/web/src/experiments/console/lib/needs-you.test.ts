import { describe, expect, test } from 'bun:test';
import { askItem, gateItem, overdueWaitItem, usageLimitItem } from './needs-you.test-fixtures';
import { needsShaping } from '../factory/lib/board.test-fixtures';
import { askQuestion, askTile } from './ask-card';
import {
  askRunId,
  askWorkflow,
  needsYou,
  awaitingItems,
  needsYouCount,
  needsYouPath,
  needsYouSubjectWords,
  needsYouSubjects,
  overdueWaitMessage,
  ownerLostMessage,
} from './needs-you';

describe('needsYou', () => {
  test('orders newest first, untimed waits last in server order, and drops usage limits', () => {
    const older = askItem({ ref: 'ask:old', pausedAt: '2026-11-15T09:00:00.000Z' });
    const newer = askItem({ ref: 'ask:new', pausedAt: '2026-11-16T09:00:00.000Z' });
    const gateA = gateItem({ ref: 'gate:a' });
    const gateB = gateItem({ ref: 'gate:b' });
    const limit = usageLimitItem({ ref: 'limit:1', pausedAt: '2026-11-16T10:00:00.000Z' });
    const items = [gateA, older, limit, gateB, newer];

    const list = needsYou(items);

    expect(list.map(item => item.ref)).toEqual(['ask:new', 'ask:old', 'gate:a', 'gate:b']);
    // The input is left as the server sent it.
    expect(items.map(item => item.ref)).toEqual([
      'gate:a',
      'ask:old',
      'limit:1',
      'gate:b',
      'ask:new',
    ]);
    // A queue holding only a usage limit needs no one.
    expect(needsYou([limit])).toEqual([]);
  });
});

describe('needsYouCount with a factory', () => {
  test('counts the items waiting on you with no ask open, and an item with an ask once', () => {
    const queue = { items: [askItem({ ref: 'ask:1' })] };
    const shaping = needsShaping('9s', ['Which?']);
    const asking = { ...needsShaping('9t', []), questions: [askItem({ ref: 'ask:9t' })] };
    expect(awaitingItems([shaping, asking]).map(item => item.item.key)).toEqual(['9s']);
    expect(needsYouCount(queue, [shaping, asking])).toBe(2);
    // Without the factory's items it is the asks and waits alone.
    expect(needsYouCount(queue)).toBe(1);
  });
});

describe('needsYouCount and needsYouSubjects', () => {
  test('count asks and waits, not usage limits; items once each, item-less waits by run', () => {
    const items = [
      askItem({ ref: 'ask:1' }),
      askItem({ ref: 'ask:2' }),
      askItem({ ref: 'ask:3', item: { id: 'item-9', projectKey: 'acme', key: '#9' } }),
      gateItem({ ref: 'gate:a' }),
      gateItem({ ref: 'gate:b' }),
      usageLimitItem(),
    ];
    expect(needsYouCount({ items })).toBe(5);
    // #7 (two asks) and #9 are items; the one gate run holding both waits is a run, not an item.
    const subjects = needsYouSubjects(needsYou(items));
    expect(subjects).toEqual({ items: 2, runs: 1 });
    expect(needsYouSubjectWords(subjects)).toBe('on 2 items and 1 run');
    expect(needsYouSubjectWords({ items: 0, runs: 1 })).toBe('on 1 run');
    expect(needsYouSubjectWords({ items: 1, runs: 0 })).toBe('on 1 item');
  });

  test('the tab path carries the ask it brings forward, encoded', () => {
    expect(needsYouPath('cb-1')).toBe('/console/p/cb-1/needs-you');
    expect(needsYouPath('cb-1', 'ask:a/b')).toBe('/console/p/cb-1/needs-you?ask=ask%3Aa%2Fb');
  });
});

describe('an overdue wait', () => {
  test('names what the stage waits for and the run holding the wait', () => {
    const wait = overdueWaitItem();
    expect(overdueWaitMessage(wait)).toBe(
      'The deliver run is still waiting for CI on the change past its deadline.'
    );
    expect(askRunId(wait)).toBe('run-wait');
    expect(askWorkflow(wait)).toBe('deliver');
    expect(askQuestion(wait)).toBe('A stage is still waiting past its deadline');
    expect(askTile(wait)).toEqual({ label: 'Look at it on the run', recommended: false });
    // Item-less, it counts as its run.
    expect(needsYouSubjects([overdueWaitItem({ item: undefined })])).toEqual({ items: 0, runs: 1 });
  });
});

describe('ownerLostMessage', () => {
  const holder = (key: string | undefined): Parameters<typeof ownerLostMessage>[0] => ({
    kind: 'owner_lost',
    ref: 'holder-1',
    project: { key: 'p', codebaseId: 'cb-1', name: 'demo' },
    ...(key === undefined ? {} : { item: { id: 'i-1', projectKey: 'p', key } }),
    revision: 1,
    labels: {},
    pausedAt: null,
    run: {
      id: 'holder-1',
      workflow: 'build',
      parentRunId: null,
      fanOut: null,
      context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
    },
    observedStatus: 'running',
  });

  test('says the run still holds its item, leaving the naming to what is drawn above it', () => {
    const words = 'The build run lost its owner and still holds its item.';
    for (const key of ['issue-136-item-keys', 'issue-7', undefined])
      expect(ownerLostMessage(holder(key))).toBe(words);
  });
});
