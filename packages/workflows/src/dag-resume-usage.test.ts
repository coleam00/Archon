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

describe('historical cost completeness', () => {
  const agentStart = (path: string) =>
    startNodeExecution({
      runId: 'run',
      path,
      node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'p' } },
      invocation: newNodeInvocation(),
      provider: 'claude',
    });
  const attempt = (path: string, costUsd?: number): DagResumeEvent[] => {
    const start = agentStart(path);
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
    'a metadata-free contribution with %s cost leaves a priced floor unproven',
    async (_, data) => {
      const snapshot = await foldDagResumeSnapshot(
        [
          { step_name: 'old', event_type: 'node_completed', data: { node_output: 'o', ...data } },
          ...attempt('later', 0.2),
        ],
        'run'
      );
      expect(snapshot.costUsd).toBeCloseTo(0.2);
      expect(snapshot.costComplete).toBeUndefined();
    }
  );

  it('proves a fully priced history, keeping reported zero distinct from absence', async () => {
    const priced = await foldDagResumeSnapshot([...attempt('a', 0.2), ...attempt('b', 0)], 'run');
    expect(priced.costUsd).toBeCloseTo(0.2);
    expect(priced.costComplete).toBe(true);

    const zero = await foldDagResumeSnapshot(attempt('a', 0), 'run');
    expect(zero.costUsd).toBe(0);
    expect(zero.costComplete).toBe(true);

    const unreported = await foldDagResumeSnapshot(attempt('a'), 'run');
    expect(unreported.costUsd).toBeUndefined();
    expect(unreported.costComplete).toBeUndefined();
  });

  it('reads nothing as completeness unknown', async () => {
    expect((await foldDagResumeSnapshot([], 'run')).costComplete).toBeUndefined();
  });

  const loopStart = { ...agentStart('loop'), node: { id: 'loop', kind: 'loop' as const } };
  it.each<[string, DagResumeEvent[]]>([
    ['an unparseable row', [{ step_name: 'bad', event_type: 'node_completed', data: '{not json' }]],
    ['a started attempt with no terminal row', [serializeNodeStateRecord(agentStart('open'))]],
    [
      'a loop row',
      [
        serializeNodeStateRecord(
          finishNodeExecution(loopStart, { status: 'completed' }, { costUsd: 0.1 })
        ),
      ],
    ],
  ])('%s leaves an otherwise priced history unproven', async (_, rows) => {
    const snapshot = await foldDagResumeSnapshot([...attempt('a', 0.2), ...rows], 'run');
    expect(snapshot.costUsd).toBeGreaterThanOrEqual(0.2);
    expect(snapshot.costComplete).toBeUndefined();
  });
});
