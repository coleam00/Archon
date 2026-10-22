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

it.each(
  [
    {},
    {
      fan_out_outcome: fanOutOutcome([
        { index: 0, outcome: 'failed', child_run_id: 'a' },
        { index: 1, outcome: 'failed', child_run_id: 'b' },
      ]),
    },
    { child_run_id: 'a', child_usage: [{ childRunId: 'a', costUsd: 'bad' }] },
    { child_run_id: 'a', child_usage: null },
  ].flatMap(attribution =>
    ['node_completed', 'node_failed'].map(eventType => ({ attribution, eventType }))
  )
)(
  'rejects ambiguous or invalid historical child attribution: %j',
  async ({ attribution, eventType }) => {
    await expect(
      foldDagResumeSnapshot(
        [
          {
            step_name: 'sub',
            event_type: eventType,
            data: { type: 'workflow', cost_usd: 0.01, ...attribution },
          },
        ],
        'parent'
      )
    ).rejects.toThrow();
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
