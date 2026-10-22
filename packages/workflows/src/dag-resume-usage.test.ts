import { describe, expect, it } from 'bun:test';
import { foldDagResumeSnapshot, type DagResumeEvent } from './dag-resume-snapshot';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';

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

describe('historical cost floor', () => {
  const attempt = (path: string, costUsd?: number): DagResumeEvent[] => {
    const start = startNodeExecution({
      runId: 'run',
      path,
      node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
    return [
      serializeNodeStateRecord(start),
      serializeNodeStateRecord(
        finishNodeExecution(start, { status: 'completed' }, { output: { text: path }, costUsd })
      ),
    ];
  };

  it.each([
    ['absent', { tokens: { input: 1, output: 1 } }],
    ['a string', { cost_usd: 'NaN' }],
    ['non-finite', { cost_usd: Infinity }],
  ])(
    'a metadata-free contribution with %s cost keeps later priced work as the floor',
    async (_, data) => {
      const snapshot = await foldDagResumeSnapshot(
        [
          { step_name: 'old', event_type: 'node_completed', data: { node_output: 'o', ...data } },
          ...attempt('later', 0.2),
        ],
        'run'
      );
      expect(snapshot.costUsd).toBeCloseTo(0.2);
    }
  );

  it('keeps reported zero distinct from absence', async () => {
    expect((await foldDagResumeSnapshot(attempt('a', 0), 'run')).costUsd).toBe(0);
    expect((await foldDagResumeSnapshot(attempt('a'), 'run')).costUsd).toBeUndefined();
  });
});

describe('composed instance accounting segments', () => {
  it.each(
    ['node_completed', 'node_failed', 'node_deferred_usage'].flatMap(eventType =>
      ['fan__item__leaf', 'fan__item__nested__item__leaf'].map(path => ({ eventType, path }))
    )
  )('keeps later own spend after an instance terminal: %j', async ({ eventType, path }) => {
    const terminalData = {
      type: 'compose_fan_out_instance',
      aggregate: true,
      cost_usd: 0.01,
      tokens: { input: 7, output: 3 },
    };
    const terminal: DagResumeEvent = {
      step_name: 'fan__item',
      event_type: 'node_failed',
      data: terminalData,
    };
    const rows: DagResumeEvent[] = [
      {
        step_name: path,
        event_type: 'node_failed',
        data: { cost_usd: 0.01, tokens: { input: 7, output: 3 } },
      },
      terminal,
      {
        step_name: path,
        event_type: eventType,
        data: { cost_usd: 0.02, tokens: { input: 14, output: 6 } },
      },
    ];
    const open = await foldDagResumeSnapshot(rows, 'run');
    expect(open.costUsd).toBeCloseTo(0.03);
    expect(open.tokens).toEqual({ input: 21, output: 9 });
    const closed = await foldDagResumeSnapshot(
      [
        ...rows,
        {
          ...terminal,
          event_type: 'node_completed',
          data: { ...terminalData, cost_usd: 0.02, tokens: { input: 14, output: 6 } },
        },
      ],
      'run'
    );
    expect(closed.costUsd).toBeCloseTo(0.03);
    expect(closed.tokens).toEqual(open.tokens);
  });
});
