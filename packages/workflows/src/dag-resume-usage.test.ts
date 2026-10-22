import { startNodeExecution, finishNodeExecution, newNodeInvocation } from './node-execution';
import { serializeNodeStateRecord, serializeDeferredNodeUsage } from './node-record-serialization';
import { describe, expect, it } from 'bun:test';
import { foldDagResumeSnapshot, type DagResumeEvent } from './dag-resume-snapshot';

const valid: DagResumeEvent = {
  step_name: 'valid',
  event_type: 'node_completed',
  data: { node_output: 'valid output', tokens: { input: 7, output: 3 }, cost_usd: 0.2 },
};

const invalidTokens = [
  { input: 100 },
  { output: 10 },
  { input: 100, output: 'unreadable' },
  { input: null, output: 10 },
  { input: NaN, output: 10 },
  { input: 100, output: Infinity },
  null,
];

describe('historical token accounting', () => {
  for (const eventType of ['node_completed', 'node_failed', 'node_deferred_usage']) {
    it.each(invalidTokens)(
      `${eventType} keeps malformed counted tokens unknown: %j`,
      async tokens => {
        const snapshot = await foldDagResumeSnapshot(
          [
            { step_name: 'old', event_type: 'node_completed', data: { node_output: 'kept' } },
            {
              step_name: 'old',
              event_type: eventType,
              data: { tokens, cost_usd: 0.1, node_output: 'updated', error: 'failed' },
            },
            valid,
          ],
          'run'
        );
        expect(snapshot.tokensUnknown).toBe(true);
        expect(snapshot.tokens).toBeUndefined();
        expect(snapshot.costUsd).toBeCloseTo(0.3);
        expect(snapshot.completedNodeOutputs.get('old')?.output).toBe(
          eventType === 'node_failed'
            ? undefined
            : eventType === 'node_completed'
              ? 'updated'
              : 'kept'
        );
        expect(snapshot.failedNodes.has('old')).toBe(eventType === 'node_failed');
        expect(snapshot.unresolvedNodeStarts.size).toBe(0);
      }
    );

    it(`${eventType} excludes malformed aggregate restatements`, async () => {
      const snapshot = await foldDagResumeSnapshot(
        [
          {
            step_name: 'aggregate',
            event_type: eventType,
            data: { aggregate: true, tokens: { input: 100 }, cost_usd: 99 },
          },
          valid,
        ],
        'run'
      );
      expect(snapshot.tokensUnknown).toBe(false);
      expect(snapshot.tokens).toEqual({ input: 7, output: 3 });
      expect(snapshot.costUsd).toBe(0.2);
    });
  }

  it('excludes malformed leaves covered by an authoritative instance', async () => {
    const snapshot = await foldDagResumeSnapshot(
      [
        {
          step_name: 'fan__item__leaf',
          event_type: 'node_deferred_usage',
          data: { tokens: { input: 100 }, cost_usd: 99 },
        },
        {
          step_name: 'fan__item',
          event_type: 'node_completed',
          data: {
            type: 'compose_fan_out_instance',
            aggregate: true,
            tokens: { input: 100, output: 10 },
            cost_usd: 0.1,
          },
        },
        valid,
      ],
      'run'
    );
    expect(snapshot.tokensUnknown).toBe(false);
    expect(snapshot.tokens).toEqual({ input: 107, output: 13 });
    expect(snapshot.costUsd).toBeCloseTo(0.3);
  });

  it('preserves valid zeros, absent usage and cache partiality', async () => {
    const snapshot = await foldDagResumeSnapshot(
      [
        { step_name: 'empty', event_type: 'node_completed', data: {} },
        {
          step_name: 'old',
          event_type: 'node_failed',
          data: {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cachePartial: true },
          },
        },
        valid,
      ],
      'run'
    );
    expect(snapshot.tokensUnknown).toBe(false);
    expect(snapshot.tokens).toEqual({
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      cachePartial: true,
    });
  });
});

describe('historical cost accounting', () => {
  for (const eventType of ['node_completed', 'node_failed', 'node_deferred_usage']) {
    it.each([undefined, null, 'bad', NaN, Infinity])(
      `${eventType} retains unpriced provider evidence before priced work: %j`,
      async cost => {
        const snapshot = await foldDagResumeSnapshot(
          [
            {
              step_name: 'old',
              event_type: eventType,
              data: {
                type: 'agent',
                ...(cost === undefined ? {} : { cost_usd: cost }),
                error: 'failed',
              },
            },
            valid,
          ],
          'run'
        );
        expect(snapshot).toMatchObject({ costUsd: 0.2, costIncomplete: true });
      }
    );
  }
  it('filters cost evidence using the same replay and aggregate scope as amounts', async () => {
    const snapshot = await foldDagResumeSnapshot(
      [
        { step_name: 'cached', event_type: 'node_skipped_prior_success', data: { type: 'agent' } },
        { step_name: 'skipped', event_type: 'node_skipped', data: { type: 'agent' } },
        {
          step_name: 'rollup',
          event_type: 'node_completed',
          data: { type: 'loop', aggregate: true },
        },
        {
          step_name: 'rollup',
          event_type: 'node_deferred_usage',
          data: { type: 'loop', aggregate: true },
        },
        valid,
      ],
      'run'
    );
    expect(snapshot).toMatchObject({ costUsd: 0.2, costIncomplete: false });
  });

  it('takes cost evidence from authoritative instances before excluding their leaves', async () => {
    for (const cost of [
      { source: 'provider', value: 0.1 },
      { source: 'provider', value: 0.1, partial: true },
      { source: 'unavailable', reason: 'incomplete' },
    ] as const) {
      const instance = finishNodeExecution(
        startNodeExecution({
          runId: 'run',
          path: 'fan__item',
          node: { id: 'fan__item', kind: 'compose_fan_out_instance' },
          invocation: newNodeInvocation(),
        }),
        { status: 'completed' }
      );
      instance.spend.costUsd = cost;
      const event = serializeNodeStateRecord(instance);
      const snapshot = await foldDagResumeSnapshot(
        [
          {
            step_name: 'fan__item__leaf',
            event_type: 'node_completed',
            data: { type: 'loop', cost_usd: 'bad' },
          },
          event,
          valid,
        ],
        'run'
      );
      expect(snapshot.costUsd).toBeCloseTo(cost.source === 'provider' ? 0.3 : 0.2);
      expect(snapshot.costIncomplete).toBe(
        cost.source === 'unavailable' || ('partial' in cost && cost.partial)
      );
    }
  });

  it('retains typed partial and unavailable cost in completed, failed and deferred rows', async () => {
    for (const cost of [
      { source: 'provider', value: 0, partial: true },
      { source: 'unavailable', reason: 'unsupported' },
      { source: 'unavailable', reason: 'not_applicable' },
    ] as const) {
      for (const channel of ['completed', 'failed', 'deferred'] as const) {
        const record = finishNodeExecution(
          startNodeExecution({
            runId: 'run',
            path: 'old',
            provider: 'claude',
            invocation: newNodeInvocation(),
            node: { id: 'old', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } },
          }),
          channel === 'failed' ? { status: 'failed', error: 'Failed.' } : { status: 'completed' }
        );
        record.spend.costUsd = cost;
        const event =
          channel === 'deferred'
            ? serializeDeferredNodeUsage(record)
            : serializeNodeStateRecord(record);
        const snapshot = await foldDagResumeSnapshot([event, valid], 'run');
        expect(snapshot.costUsd).toBe(0.2);
        expect(snapshot.costIncomplete).toBe(
          cost.source === 'provider' || cost.reason !== 'not_applicable'
        );
      }
    }
  });

  it('keeps reported zero and non-provider work distinct from unpriced work', async () => {
    const snapshot = await foldDagResumeSnapshot(
      [
        { step_name: 'exec', event_type: 'node_completed', data: { type: 'bash' } },
        { step_name: 'zero', event_type: 'node_completed', data: { type: 'agent', cost_usd: 0 } },
        valid,
      ],
      'run'
    );
    expect(snapshot.costUsd).toBe(0.2);
    expect(snapshot.costIncomplete).not.toBe(true);
  });
});

it('replaces cumulative child snapshots within an invocation while counting distinct loop invocations', async () => {
  const started = (iteration: number) =>
    startNodeExecution({
      runId: 'run',
      path: 'group.sub',
      node: { id: 'sub', kind: 'workflow', workflow: 'child' },
      invocation: newNodeInvocation([{ groupId: 'group', iteration }]),
    });
  const first = started(0);
  const second = started(1);
  const suspended = (execution: ReturnType<typeof started>, costUsd: number) =>
    finishNodeExecution(
      execution,
      { status: 'suspended', point: 'child_workflow' },
      { costUsd, costIncomplete: true, output: { text: '' } }
    );
  const rows = [
    serializeNodeStateRecord(suspended(first, 0.2)),
    serializeDeferredNodeUsage(suspended(first, 0.3)),
    serializeNodeStateRecord(
      finishNodeExecution(
        first,
        { status: 'completed' },
        { costUsd: 0.5, costIncomplete: true, output: { text: 'done' } }
      )
    ),
    serializeNodeStateRecord(suspended(second, 0.7)),
  ];
  const snapshot = await foldDagResumeSnapshot(rows, 'run');
  expect(snapshot.costUsd).toBe(1.2);
  expect(snapshot.costIncomplete).toBe(true);
  expect(snapshot.childWorkflowUsage?.size).toBe(2);
});

it.each(['node_completed', 'node_failed', 'node_suspended'])(
  '%s unreadable counted usage keeps tokens unknown and readable cost available',
  async eventType => {
    const snapshot = await foldDagResumeSnapshot(
      [{ step_name: 'old', event_type: eventType, data: '{' }, valid],
      'run'
    );
    expect(snapshot).toMatchObject({ costUsd: 0.2, costIncomplete: true, tokensUnknown: true });
    expect(snapshot.tokens).toBeUndefined();
  }
);

it.each(['node_completed', 'node_failed', 'node_suspended'])(
  '%s unreadable usage evidence obeys authoritative instance scope',
  async eventType => {
    const snapshot = await foldDagResumeSnapshot(
      [
        { step_name: 'fan__item__leaf', event_type: eventType, data: '{' },
        {
          step_name: 'fan__item',
          event_type: 'node_completed',
          data: { type: 'compose_fan_out_instance', aggregate: true, cost_usd: 0.1 },
        },
        valid,
      ],
      'run'
    );
    expect(snapshot.costUsd).toBeCloseTo(0.3);
    expect(snapshot.costIncomplete).toBe(false);
    expect(snapshot.tokensUnknown).toBe(false);
    expect(snapshot.tokens).toEqual({ input: 7, output: 3 });
  }
);

it.each([
  'node_started',
  'node_skipped',
  'node_skipped_prior_success',
  'node_always_run_reset',
  'node_prior_cache_invalidated',
  'fan_out_instances',
])('unreadable %s has no new accounting evidence', async eventType => {
  const snapshot = await foldDagResumeSnapshot(
    [{ step_name: 'old', event_type: eventType, data: '{' }, valid],
    'run'
  );
  expect(snapshot).toMatchObject({ costUsd: 0.2, costIncomplete: false });
  expect(snapshot.tokensUnknown).toBe(false);
  expect(snapshot.tokens).toEqual({ input: 7, output: 3 });
});
