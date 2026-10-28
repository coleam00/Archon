import { expect, it } from 'bun:test';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { fanOutOutcome } from '../schemas/fan-out-outcome';
import { unreportedChildUsage } from './child-usage';
import { sumReportedCost, sumFanOutTokens } from './usage';

it('subtracts each retained child baseline while charging a replacement in full', async () => {
  const first = { childRunId: 'retained', costUsd: 0.01, tokens: { input: 7, output: 3 } };
  const deleted = { ...first, childRunId: 'deleted' };
  const later = { ...first, costUsd: 0.02, tokens: { input: 14, output: 6 } };
  const terminal = (children: (typeof first)[], costUsd: number) =>
    serializeNodeStateRecord(
      finishNodeExecution(
        startNodeExecution({
          runId: 'parent',
          path: 'sub',
          node: { id: 'sub', kind: 'workflow', workflow: 'child' },
          invocation: newNodeInvocation(),
        }),
        { status: 'failed', error: 'child failed' },
        {
          costUsd,
          diagnostics: { childUsage: children },
        }
      )
    );
  const snapshot = await foldDagResumeSnapshot(
    [terminal([first, deleted], 0.02), terminal([later, deleted], 0.01)],
    'parent'
  );
  expect(snapshot.costUsd).toBe(0.03);
  expect(snapshot.reportedChildUsage?.get('retained')).toEqual(later);
  const contributions = [later, { ...first, childRunId: 'replacement' }].map(child =>
    unreportedChildUsage(child, snapshot.reportedChildUsage, child.childRunId)
  );
  expect(sumReportedCost(contributions)).toBe(0.01);
  expect(sumFanOutTokens(contributions)).toEqual({ input: 7, output: 3 });
  expect(unreportedChildUsage(first, undefined, first.childRunId)).toBe(first);
});

it.each(['child_run_id', 'fan_out_outcome'])(
  'recovers legacy usage by durable %s identity',
  async identity => {
    const data = {
      type: 'workflow',
      cost_usd: 0.01,
      tokens: { input: 7, output: 3, cacheRead: 5 },
      ...(identity === 'child_run_id'
        ? { child_run_id: 'retained' }
        : {
            fan_out_outcome: fanOutOutcome([
              { index: 0, outcome: 'failed', child_run_id: 'retained' },
            ]),
          }),
    };
    const snapshot = await foldDagResumeSnapshot(
      [
        { step_name: 'sub', event_type: 'node_failed', data },
        { step_name: 'sub', event_type: 'node_failed', data },
      ],
      'parent'
    );
    expect(snapshot.costUsd).toBe(0.02);
    expect(
      unreportedChildUsage(
        { costUsd: 0.03, tokens: { input: 21, output: 9, cacheRead: 15 } },
        snapshot.reportedChildUsage,
        'retained'
      )
    ).toEqual({
      costUsd: expect.closeTo(0.01),
      tokens: { input: 7, output: 3, cacheRead: 5 },
      tokensUnknown: false,
    });
    expect(
      unreportedChildUsage({ costUsd: 0.03 }, snapshot.reportedChildUsage, 'replacement').costUsd
    ).toBe(0.03);
  }
);

it('keeps malformed legacy token totals unknown in the retained child baseline', async () => {
  const snapshot = await foldDagResumeSnapshot(
    [
      {
        step_name: 'sub',
        event_type: 'node_failed',
        data: {
          type: 'workflow',
          child_run_id: 'child',
          cost_usd: 0.01,
          tokens: { input: 7 },
        },
      },
    ],
    'parent'
  );
  const incremental = unreportedChildUsage(
    { costUsd: 0.03, tokens: { input: 21, output: 9 } },
    snapshot.reportedChildUsage,
    'child'
  );
  expect(incremental.costUsd).toBeCloseTo(0.02);
  expect(incremental.tokensUnknown).toBe(true);
  expect(incremental.tokens).toBeUndefined();
});

const legacyIdentities = [
  {},
  { child_run_id: 'a' },
  {
    fan_out_outcome: fanOutOutcome([
      { index: 0, outcome: 'completed', child_run_id: 'a' },
      { index: 1, outcome: 'completed', child_run_id: 'b' },
    ]),
  },
];

it.each(
  legacyIdentities.flatMap(attribution =>
    ['node_completed', 'node_failed'].flatMap(eventType =>
      [undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }].map(
        tokens => ({ attribution, eventType, tokens })
      )
    )
  )
)(
  'folds legacy zero usage without a child baseline: %j',
  async ({ attribution, eventType, tokens }) => {
    const snapshot = await foldDagResumeSnapshot(
      [
        {
          step_name: 'sub',
          event_type: eventType,
          data: { type: 'workflow', cost_usd: 0, tokens, ...attribution },
        },
      ],
      'parent'
    );
    expect(snapshot.costUsd).toBe(0);
    expect(snapshot.tokensUnknown).toBe(false);
    expect(snapshot.tokens).toEqual(
      tokens === undefined ? undefined : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    );
    expect(snapshot.reportedChildUsage?.size).toBe(0);
    expect(snapshot.unattributedChildUsagePaths?.size).toBe(0);
  }
);

it.each(
  [legacyIdentities[0], legacyIdentities[2]].flatMap(attribution =>
    ['node_completed', 'node_failed'].flatMap(eventType =>
      [
        { cost_usd: 0.01 },
        { tokens: { input: 1 } },
        ...['input', 'output', 'cacheRead', 'cacheWrite'].map(axis => ({
          tokens: { input: 0, output: 0, [axis]: 1 },
        })),
        { tokens: { input: 0, output: 0, cacheRead: 0, cachePartial: true } },
      ].map(usage => ({ attribution, eventType, usage }))
    )
  )
)(
  'preserves nonzero or unknown legacy usage without inventing child attribution: %j',
  async ({ attribution, eventType, usage }) => {
    const snapshot = await foldDagResumeSnapshot(
      [
        {
          step_name: 'sub',
          event_type: eventType,
          data: {
            type: 'workflow',
            cost_usd: 0,
            ...usage,
            ...attribution,
            node_output: 'legacy output',
          },
        },
      ],
      'parent'
    );
    expect(snapshot.costUsd).toBe('cost_usd' in usage ? usage.cost_usd : 0);
    expect(snapshot.unattributedChildUsagePaths).toEqual(new Set(['sub']));
    expect(snapshot.reportedChildUsage?.size).toBe(0);
    expect(snapshot.completedNodeOutputs.get('sub')?.output).toBe(
      eventType === 'node_completed' ? 'legacy output' : undefined
    );
    if (usage.tokens !== undefined) {
      expect(snapshot.tokensUnknown).toBe(!('output' in usage.tokens));
      if ('output' in usage.tokens) expect(snapshot.tokens).toMatchObject(usage.tokens);
    }
  }
);

it.each([false, true])(
  'keeps measured child baselines after an unmetered terminal (fan-out %s)',
  async fanOut => {
    const paid = { childRunId: 'child', costUsd: 0.01, tokens: { input: 7, output: 3 } };
    const identity = fanOut
      ? { fan_out_outcome: fanOutOutcome([{ index: 0, outcome: 'failed', child_run_id: 'child' }]) }
      : { child_run_id: 'child' };
    const rows = [
      {
        step_name: 'sub',
        event_type: 'node_failed',
        data: {
          type: 'workflow',
          ...identity,
          cost_usd: 0.01,
          tokens: paid.tokens,
          child_usage: [paid],
        },
      },
      {
        step_name: 'sub',
        event_type: 'node_failed',
        data: { type: 'workflow', ...identity, child_usage: [{ childRunId: 'child' }] },
      },
    ];
    const snapshot = await foldDagResumeSnapshot(rows, 'parent');
    expect(snapshot.reportedChildUsage?.get('child')).toEqual(paid);
    const next = unreportedChildUsage(
      { costUsd: 0.02, tokens: { input: 14, output: 6 } },
      snapshot.reportedChildUsage,
      'child'
    );
    expect((snapshot.costUsd ?? 0) + (next.costUsd ?? 0)).toBeCloseTo(0.02);
    expect(next.tokens).toEqual({ input: 7, output: 3 });
  }
);

it.each([
  {
    measured: { costUsd: 0 },
    expected: { costUsd: 0, tokens: { input: 7, output: 3, cacheRead: 5 } },
  },
  {
    measured: { tokens: { input: 0, output: 0 } },
    expected: { costUsd: 0.01, tokens: { input: 0, output: 0, cacheRead: 5 } },
  },
  { measured: { tokensUnknown: true }, expected: { costUsd: 0.01, tokensUnknown: true } },
])(
  'updates measured axes without erasing absent child measurements: %j',
  async ({ measured, expected }) => {
    const snapshot = await foldDagResumeSnapshot(
      [
        {
          step_name: 'sub',
          event_type: 'node_failed',
          data: {
            type: 'workflow',
            child_usage: [
              { childRunId: 'child', costUsd: 0.01, tokens: { input: 7, output: 3, cacheRead: 5 } },
            ],
          },
        },
        {
          step_name: 'sub',
          event_type: 'node_failed',
          data: { type: 'workflow', child_usage: [{ childRunId: 'child', ...measured }] },
        },
      ],
      'parent'
    );
    expect(snapshot.reportedChildUsage?.get('child')).toMatchObject(expected);
    if (measured.tokensUnknown)
      expect(snapshot.reportedChildUsage?.get('child')?.tokens).toBeUndefined();
  }
);
