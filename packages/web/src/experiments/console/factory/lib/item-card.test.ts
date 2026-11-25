import { describe, expect, test } from 'bun:test';
import type { ItemAsk } from '../../primitives/run';
import type { ItemRead } from '../../skills/items';
import type { FactoryView, ForgeSubjects, RunRecord } from '../api';
import fixture from './__fixtures__/card-items.json';
import {
  cardProgress,
  itemMatches,
  resultKeys,
  runsToRead,
  viewWorkflow,
  type CardPack,
} from './item-card';

/**
 * `card-items.json` is read from a copy of the live factory database: items #111 (delivered by
 * the retired `deliver` workflow, its rounds a loop) and #125 (delivered by stage-build,
 * stage-check and stage-host, its rounds one stage-check run each), with their runs' records
 * as `GET /api/workflows/runs/records` serves them (outputs kept to outcome and a cut summary).
 */
const PREFIX = 'Wirasm/archon-software-factory:';

/** The pack view's progress declarations, as `docs/factory-console/pack-view/factory-view.json` has them. */
const VIEW = {
  version: 1,
  title: 'Factory',
  summary: 'x',
  stages: {
    plan: { label: 'Plan', blurb: 'x', steps: { write: 'Writes the plan' } },
    'stage-build': { label: 'Build', blurb: 'x' },
    'stage-check': { label: 'Check', blurb: 'x' },
    'stage-host': { label: 'Host', blurb: 'x' },
  },
  words: { round: 'check round', rounds: 'check rounds', sentBack: 'sent back' },
  retired: ['deliver'],
  rounds: [
    { workflow: 'deliver', loop: 'rounds' },
    { workflow: 'stage-check', round: '/round', allowance: '/allowance' },
  ],
  returns: [
    { workflow: 'deliver', node: 'rounds.verdict__verdict', outcome: 'return' },
    { workflow: 'deliver', node: 'hostrounds.host__host', outcome: 'return' },
    { workflow: 'stage-check', node: 'verdict__verdict', outcome: 'return' },
    { workflow: 'stage-host', node: 'rounds__host', outcome: 'return' },
  ],
  approves: [
    { workflow: 'deliver', node: 'rounds.verdict__verdict', outcome: 'approve' },
    { workflow: 'stage-check', node: 'verdict__verdict', outcome: 'approve' },
  ],
  change: ['deliver', 'stage-build', 'stage-check', 'stage-host'].map(workflow => ({
    workflow,
    pointer: '/change',
  })),
  map: { cards: [{ id: 'plan', stages: ['plan'] }] },
  howItWorks: { title: 'x', caption: 'x', root: 'top', views: {} },
} as unknown as FactoryView;

const STAGES = ['plan', 'stage-build', 'stage-check', 'stage-host'].map(workflow => ({
  name: `${PREFIX}${workflow}`,
  workflow,
}));
const PACK: CardPack = { stages: STAGES, view: VIEW };

// The fixture was read before the item read gained `standing.pack`; its runs recorded none.
const items = (fixture.items as unknown as ItemRead[]).map(read => ({
  ...read,
  standing: { ...read.standing, pack: null },
}));
const records = fixture.records as unknown as RunRecord[];
const byKey = (key: string): ItemRead => {
  const found = items.find(read => read.item.key === key);
  if (found === undefined) throw new Error(`no fixture item ${key}`);
  return found;
};
const allRead = (list: readonly RunRecord[] = records) => ({
  records: new Map(list.map(record => [record.id, record])),
  asked: new Set(list.map(record => record.id)),
  forge: null,
});

describe('rounds and returns from run records', () => {
  test('#111: the retired deliver loop gives two rounds, returned then approved, sent back once', () => {
    const card = cardProgress(byKey('111'), PACK, allRead(), []);
    expect(card.round).toEqual({
      dots: [
        { iteration: 1, verdict: 'returned' },
        { iteration: 2, verdict: 'approved' },
      ],
      text: '2 of 3 check rounds',
    });
    expect(card.returned?.text).toBe('sent back 1x');
    // The reason is the deciding step's own `summary` field, never matched against prose.
    expect(card.returned?.reason).toStartWith('Return. The approach and the main behaviour hold');
    expect(card.pr?.url).toBe('https://github.com/coleam00/archon-factory-console/pull/112');
  });

  test("#125: stage-check runs are its rounds, numbered by their results; stage-host's return counts", () => {
    const card = cardProgress(byKey('125'), PACK, allRead(), []);
    expect(card.round?.dots.map(dot => dot.verdict)).toEqual([
      'returned',
      'returned',
      'returned',
      'undecided',
    ]);
    expect(card.round?.text).toBe('4 of 4 check rounds');
    expect(card.returned?.count).toBe(4);
    expect(card.pr?.url).toBe('https://github.com/coleam00/archon-factory-console/pull/128');
  });

  test('a view that declares no rounds source shows no rounds', () => {
    const view = { ...VIEW, rounds: undefined } as FactoryView;
    expect(cardProgress(byKey('111'), { stages: STAGES, view }, allRead(), []).round).toBeNull();
  });

  test('a record that could not be read shows no rounds or returns, and says so', () => {
    // Every record but the newest stage-check run's: what was read would still count rounds.
    const read = byKey('125');
    const newestCheck = read.runs.filter(run => run.workflow === `${PREFIX}stage-check`).at(-1);
    const partial = records.filter(record => record.id !== newestCheck?.id);
    const reads = { ...allRead(), records: new Map(partial.map(record => [record.id, record])) };
    const card = cardProgress(read, PACK, reads, []);
    expect(card.unread).toBe(true);
    expect(card.round).toBeNull();
    expect(card.returned).toBeNull();
  });

  test('with no view file there are no rounds or returns, and the PR is the recorded merge', () => {
    const card = cardProgress(byKey('111'), { stages: STAGES, view: null }, allRead(), []);
    expect(card.round).toBeNull();
    expect(card.returned).toBeNull();
    expect(card.pr?.url).toBe(byKey('111').merged?.change);
  });

  test('the words come from the view: a view that says "returned" reads "returned 1x"', () => {
    const view = { ...VIEW, words: { ...VIEW.words, sentBack: 'returned' } } as FactoryView;
    const card = cardProgress(byKey('111'), { stages: STAGES, view }, allRead(), []);
    expect(card.returned?.text).toBe('returned 1x');
  });

  /** #125 with a stage-check run now running, its record naming the step it is on. */
  function checkRunning(read: ItemRead): { read: ItemRead; records: RunRecord[] } {
    const check = read.runs.find(run => run.workflow === `${PREFIX}stage-check`)!;
    const newest = {
      ...check,
      id: 'running-check',
      status: 'running' as const,
      startedAt: '2099-01-01T00:00:00.000Z',
    };
    const running: RunRecord = {
      ...records[0]!,
      id: 'running-check',
      status: 'running',
      returns: undefined,
      running: ['review__review'],
      node_outcomes: { run_id: 'running-check', first_failed_node: null, nodes: [] },
      loop_iterations: [],
    };
    return { read: { ...read, runs: [...read.runs, newest] }, records: [...records, running] };
  }

  test('a check round running after recorded ones is not numbered: "next one running"', () => {
    const { read, records: all } = checkRunning(byKey('125'));
    const card = cardProgress(read, PACK, allRead(all), []);
    // v1's reading: after a replan or past the allowance, N+1 would be a wrong number.
    expect(card.round?.text).toBe('4 of 4 check rounds, next one running');
    expect(card.round?.dots.at(-1)?.verdict).toBe('running');
    expect(card.running).toMatchObject({ stage: 'Check', step: 'review' });
  });

  test('a first check round running, before any is recorded, reads "first check round running"', () => {
    const { read, records: all } = checkRunning(byKey('125'));
    // No stage-check run but the running one: no round is recorded yet.
    const runs = read.runs.filter(
      run => run.id === 'running-check' || run.workflow !== `${PREFIX}stage-check`
    );
    const card = cardProgress({ ...read, runs }, PACK, allRead(all), []);
    expect(card.round).toEqual({
      dots: [{ iteration: 1, verdict: 'running' }],
      text: 'first check round running',
    });
  });
});

describe('which runs are read, and as which workflow', () => {
  test('a run that recorded no pack maps through the graph, a retired workflow through its prefix', () => {
    expect(viewWorkflow(PACK, { workflow: `${PREFIX}stage-check`, pack: null })).toBe(
      'stage-check'
    );
    expect(viewWorkflow(PACK, { workflow: `${PREFIX}deliver`, pack: null })).toBe('deliver');
    expect(viewWorkflow(PACK, { workflow: 'other:deliver', pack: null })).toBeNull();
    expect(viewWorkflow(PACK, { workflow: 'x', pack: { key: 'p', workflow: 'stage-host' } })).toBe(
      'stage-host'
    );
  });

  test('only declared workflows and running runs are read, with the result keys the pointers name', () => {
    const base = byKey('111');
    const deliver = base.runs.find(run => run.workflow.endsWith(':deliver'));
    // A running run of a workflow the view declares nothing for is read for its running step.
    const plan = {
      ...base.runs[0]!,
      id: 'running-plan',
      workflow: `${PREFIX}plan`,
      status: 'running' as const,
    };
    const read = { ...base, runs: [...base.runs, plan] };
    expect(runsToRead(PACK, read)).toEqual([deliver!.id, 'running-plan']);
    expect(resultKeys(VIEW).sort()).toEqual(['allowance', 'change', 'round']);
  });
});

const ask = (over: Partial<ItemAsk>): ItemAsk =>
  ({
    kind: 'attention',
    ref: 'r1',
    project: null,
    revision: 1,
    labels: {},
    pausedAt: null,
    message: 'Which way?',
    form: 'select',
    options: [{ id: 'send-back', label: 'Send it back' }, { id: 'take-as-is' }],
    ...over,
  }) as ItemAsk;

describe('open asks', () => {
  test('the count is the open asks; no asks, null', () => {
    expect(
      cardProgress(byKey('125'), PACK, allRead(), [
        ask({ recommendation: { option: 'send-back', why: 'x' } }),
        ask({ ref: 'r2' }),
      ]).asks
    ).toEqual({ count: 2 });
    expect(cardProgress(byKey('125'), PACK, allRead(), []).asks).toBeNull();
  });
});

describe('title', () => {
  const forge = (title: string | null): ForgeSubjects => ({
    issues: [{ number: 111, title, state: 'closed', url: null, pending: false }],
    changes: [],
  });

  test('an empty title column falls back to the forge issue title', () => {
    const read = byKey('111');
    expect(read.item.title ?? null).toBeNull();
    const card = cardProgress(read, PACK, { ...allRead(), forge: forge('Asks show in full') }, []);
    expect(card).toMatchObject({ title: 'Asks show in full', titleIsKey: false, keyText: '#111' });
  });

  test("the item's own title wins over the forge's", () => {
    const read = { ...byKey('111'), item: { ...byKey('111').item, title: 'Own title' } };
    expect(cardProgress(read, PACK, { ...allRead(), forge: forge('Forge') }, []).title).toBe(
      'Own title'
    );
  });

  test('with no title known, the card reads its key; a split member as its parent and piece', () => {
    expect(cardProgress(byKey('111'), PACK, allRead(), [])).toMatchObject({
      title: '#111',
      titleIsKey: true,
    });
    const member: ItemRead = {
      ...byKey('111'),
      item: { ...byKey('111').item, key: 'issue-199-board-furniture', title: null },
      links: [
        {
          kind: 'part_of',
          direction: 'outgoing',
          ended: null,
          other: { id: 'p', projectKey: 'x', key: 'issue-199' },
        },
      ] as unknown as ItemRead['links'],
    };
    expect(cardProgress(member, PACK, allRead(), []).title).toBe('#199 · board furniture');
  });
});

describe('the board filter finds what the card shows', () => {
  const issues = [
    {
      number: 111,
      title: 'Asks show in full',
      state: 'closed' as const,
      url: null,
      pending: false,
    },
  ];

  test('by the issue title, the key as the card prints it, or the raw key', () => {
    const read = byKey('111');
    for (const query of ['asks show', '#111', '111', ''])
      expect(itemMatches(read, issues, query)).toBe(true);
    expect(itemMatches(read, issues, 'polish')).toBe(false);
    // With no forge answer, the title is not known and only the key finds it.
    expect(itemMatches(read, null, 'asks show')).toBe(false);
    // The raw key, which the printed key does not contain: `issue-111` prints as `#111`.
    const issueKeyed = { ...read, item: { ...read.item, key: 'issue-111' } };
    expect(itemMatches(issueKeyed, issues, 'issue-111')).toBe(true);
  });
});
