// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { dagNodeSchema } from '../../../schemas';
import type {
  ExecutionOutput,
  NodeInvocation,
  NodeExecutionRecord,
} from '../../../schemas/node-execution';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import {
  newNodeInvocation,
  startNodeExecution,
  finishNodeExecution,
} from '../../../node-execution';
import { serializeNodeStateRecord } from '../../../node-record-serialization';
import { formatPersistedNodeOutput, persistedExecutionOutput } from '../../node-output';
import { createRunToolCallAttention } from '../../../tool-call-attention';
import { liveSourceRoots } from '../../../workflow-source';
import type { LoopGroupRun } from './loop-group-state';
import { completeEscalatedResume } from './resume';
import { createMockStore, createMockDeps, dagOptions, makeWorkflowRun } from '../../test-utils';
import { restorePreviousIteration } from './previous-iteration';
import { NODE_STATE_EVENT_TYPES } from '../../../store';

const body = (() => {
  const parsed = dagNodeSchema.parse({ id: 'work', bash: 'echo work' });
  if (parsed.kind !== 'exec') throw new Error('Expected exec');
  return parsed;
})();
const node = (() => {
  const parsed = dagNodeSchema.parse({
    id: 'grp',
    loop_group: {
      max_iterations: 3,
      until_bash: 'true',
      nodes: [{ id: 'work', bash: 'echo work' }],
    },
  });
  if (parsed.kind !== 'loop_group') throw new Error('Expected loop group');
  return parsed;
})();
const outer = [{ groupId: 'outer', iteration: 2 }];
const lineage = [...outer, { groupId: 'grp', iteration: 1 }];

function event(
  loopPath: NodeInvocation['loopPath'] = lineage,
  lifecycle: NodeExecutionRecord['lifecycle'] = { status: 'completed' },
  output: ExecutionOutput = { text: 'first', structured: { value: 'first' } },
  path = 'outer.grp.work'
): WorkflowEventRow {
  const start = startNodeExecution({
    runId: 'run',
    path,
    node: body,
    invocation: newNodeInvocation(loopPath),
  });
  const record =
    lifecycle.status === 'started' ? start : finishNodeExecution(start, lifecycle, { output });
  const serialized = serializeNodeStateRecord(record);
  return {
    ...serialized,
    id: record.attempt.id,
    step_index: null,
    created_at: new Date().toISOString(),
  };
}

function fixture(rows: WorkflowEventRow[], iteration = 2) {
  const listEventsForRuns = mock(async () => new Map([['run', rows]]));
  return {
    run: {
      node,
      bodyNodes: [body],
      bodyStepNamePrefix: 'outer.grp.',
      ctx: {
        workflowRun: makeWorkflowRun('run'),
        loopGroupPath: outer,
        deps: { store: { listEventsForRuns } },
      },
      resume: { resumeIteration: iteration },
    },
    listEventsForRuns,
  };
}

test('selects the exact preceding lineage and direct path', async () => {
  const { run } = fixture([
    event(),
    event(
      [
        { groupId: 'outer', iteration: 1 },
        { groupId: 'grp', iteration: 1 },
      ],
      undefined,
      { text: 'wrong outer', structured: { value: 'wrong' } }
    ),
    event([...outer, { groupId: 'grp', iteration: 2 }], undefined, {
      text: 'current',
      structured: { value: 'current' },
    }),
    event(
      [...lineage, { groupId: 'nested', iteration: 1 }],
      undefined,
      undefined,
      'outer.grp.work.descendant'
    ),
  ]);
  expect((await restorePreviousIteration(run)).get('work')).toMatchObject({
    state: 'completed',
    output: 'first',
    structuredOutput: { value: 'first' },
  });
});

test('iteration one is known empty without persistence', async () => {
  const { run, listEventsForRuns } = fixture([], 1);
  expect((await restorePreviousIteration(run)).size).toBe(0);
  expect(listEventsForRuns).not.toHaveBeenCalled();
});

for (const eventType of [
  'node_skipped_prior_success',
  'node_always_run_reset',
  'node_prior_cache_invalidated',
] as const) {
  test(`${eventType} does not replace execution history or require lineage`, async () => {
    const cacheRow = { ...event(), event_type: eventType, data: {} };
    const { run } = fixture([cacheRow, event(), cacheRow]);
    expect((await restorePreviousIteration(run)).get('work')?.output).toBe('first');
    await expect(restorePreviousIteration(fixture([cacheRow]).run)).rejects.toThrow(
      'completed history unavailable'
    );
  });
}

test('an explicit skip supersedes an older completed value', async () => {
  const { run } = fixture([
    event(),
    event(lineage, {
      status: 'skipped',
      reason: 'when_condition',
      cause: { kind: 'condition', expr: 'false' },
    }),
  ]);
  expect((await restorePreviousIteration(run)).size).toBe(0);
});

for (const lifecycle of [
  { status: 'started' },
  { status: 'suspended', point: 'approval' },
  { status: 'failed', error: 'failure' },
] satisfies NodeExecutionRecord['lifecycle'][]) {
  test(`later ${lifecycle.status} prevents reuse of older completion`, async () => {
    await expect(
      restorePreviousIteration(fixture([event(), event(lineage, lifecycle)]).run)
    ).rejects.toThrow('completed history unavailable');
  });
}

test('missing, legacy and invalid history fail instead of inventing emptiness', async () => {
  await expect(restorePreviousIteration(fixture([]).run)).rejects.toThrow(
    'completed history unavailable'
  );
  const legacy = { ...event(), data: { node_output: 'legacy' } };
  await expect(restorePreviousIteration(fixture([legacy]).run)).rejects.toThrow(
    'lineage unavailable'
  );
  const invalid = { ...event(), data: { invocation: {} } };
  await expect(restorePreviousIteration(fixture([invalid]).run)).rejects.toThrow(
    'invalid historical execution'
  );
});

for (const eventType of NODE_STATE_EVENT_TYPES.filter(
  type =>
    type !== 'node_skipped_prior_success' &&
    type !== 'node_always_run_reset' &&
    type !== 'node_prior_cache_invalidated'
)) {
  for (const data of [{ node_output: 'legacy' }, { invocation: {} }]) {
    test(`${eventType} with ${'invocation' in data ? 'invalid' : 'missing'} metadata is superseded only by later target evidence`, async () => {
      const opaque = { ...event(), event_type: eventType, data };
      const current = event([...outer, { groupId: 'grp', iteration: 2 }]);
      expect(
        (await restorePreviousIteration(fixture([opaque, event(), current]).run)).get('work')
          ?.output
      ).toBe('first');
      for (const rows of [[opaque], [opaque, current], [event(), opaque, current]]) {
        await expect(restorePreviousIteration(fixture(rows).run)).rejects.toThrow(
          'cannot restore iteration 1'
        );
      }
    });
  }
}

test('store failure surfaces', async () => {
  const { run, listEventsForRuns } = fixture([]);
  listEventsForRuns.mockRejectedValue(new Error('store unavailable'));
  await expect(restorePreviousIteration(run)).rejects.toThrow('store unavailable');
});

test('rehydrates only the selected spill and rejects missing or incomplete bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-history-'));
  try {
    const text = 'a'.repeat(40_000) + 'first-tail';
    const persisted = formatPersistedNodeOutput(text, root);
    const output = persistedExecutionOutput(persisted);
    const row = event(lineage, undefined, { ...output, structured: { value: 'first' } });
    const current = event([...outer, { groupId: 'grp', iteration: 2 }], undefined, {
      ...persistedExecutionOutput(
        formatPersistedNodeOutput('b'.repeat(40_000) + 'second-tail', root)
      ),
      structured: { value: 'second' },
    });
    expect((await restorePreviousIteration(fixture([row, current]).run)).get('work')?.output).toBe(
      text
    );
    if (!persisted.spillPath) throw new Error('No spill');
    await Bun.write(persisted.spillPath, 'short');
    await expect(restorePreviousIteration(fixture([row]).run)).rejects.toThrow(
      'full historical output unavailable'
    );
    await rm(persisted.spillPath);
    await expect(restorePreviousIteration(fixture([row]).run)).rejects.toThrow(
      'full historical output unavailable'
    );
    const noSpill = { ...row, data: { ...row.data, node_output_spill_path: undefined } };
    await expect(restorePreviousIteration(fixture([noSpill]).run)).rejects.toThrow(
      'full historical output unavailable'
    );
  } finally {
    await removeTempTree(root);
  }
});

test('resumed completion preserves enclosing previous-output scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loop-outer-scope-'));
  try {
    const check = dagNodeSchema.parse({
      id: 'check',
      depends_on: ['work'],
      approval: { message: 'Continue?' },
    });
    if (check.kind !== 'gate') throw new Error('Expected gate');
    const group = dagNodeSchema.parse({
      id: 'grp',
      loop_group: {
        max_iterations: 2,
        until_bash:
          'test $work.output = second && test $LOOP_PREV.work.output.value = first && test $LOOP_PREV.outerWork.output = outer-first',
        nodes: [
          { id: 'work', bash: 'true' },
          { id: 'check', depends_on: ['work'], approval: { message: 'Continue?' } },
        ],
      },
    });
    if (group.kind !== 'loop_group') throw new Error('Expected group');
    const historicalGate = event(
      lineage,
      { status: 'skipped', reason: 'when_condition', cause: { kind: 'condition', expr: 'false' } },
      undefined,
      'outer.grp.check'
    );
    const { run: history } = fixture([event(), historicalGate]);
    const store = createMockStore();
    store.listEventsForRuns.mockImplementation(history.ctx.deps.store.listEventsForRuns);
    const options = dagOptions({
      deps: createMockDeps(store),
      cwd: root,
      workflowRun: makeWorkflowRun('run'),
      workflow: { name: 'scope', nodes: [group] },
    });
    const execution = startNodeExecution({
      runId: 'run',
      path: 'outer.grp',
      node: group,
      invocation: newNodeInvocation(outer),
    });
    const run: LoopGroupRun = {
      ...history,
      node: group,
      bodyNodes: [body, check],
      ctx: {
        ...options,
        toolAttention: createRunToolCallAttention({ store, runId: 'run' }),
        workflowName: 'scope',
        workflowSourceRoots: liveSourceRoots(root),
        execContext: { kind: 'host' },
        workflowLevelOptions: {},
        persistScope: undefined,
        workflowPersistSessions: false,
        scopeArtifactsDir: undefined,
        layers: [],
        nodeOutputs: new Map(),
        lastSequentialSession: undefined,
        warnedProviderConflicts: new Set(),
        totalCostUsd: undefined,
        totalTokens: undefined,
        stepNamePrefix: 'outer.',
        loopGroupPath: outer,
        loopBodyScopes: [
          {
            knownBodyIds: new Set(['outerWork', 'grp', 'work', 'check']),
            directBodyIds: new Set(['outerWork', 'grp']),
            loopPrevOutputs: new Map([
              ['outerWork', { state: 'completed', output: 'outer-first' }],
            ]),
            outputFileDir: root,
          },
        ],
      },
      stepName: 'outer.grp',
      directBodyIds: new Set(['work', 'check']),
      msgContext: { workflowId: 'run', nodeName: 'grp' },
      execution,
      progress: { usage: {}, lastStartedIteration: 2 },
      workflowProvider: undefined,
      workflowModel: undefined,
      workflowTier: undefined,
      workflowPreset: undefined,
      resume: {
        loopGateMeta: undefined,
        loopOwnedWaitMeta: undefined,
        isLegacyInteractiveLoopResume: false,
        isEscalatedGateResume: true,
        isEscalatedWaitResume: false,
        isLoopResume: true,
        bodySessionCursors: undefined,
        bodySessionCursorAncestry: new Map(),
        resumeIteration: 2,
        startIteration: 3,
        feedbackGiven: false,
        iterationLimit: 2,
        loopUserInput: '',
      },
    };
    const completed = await completeEscalatedResume(
      run,
      new Map([
        ['work', { state: 'completed', output: 'second' }],
        ['check', { state: 'completed', output: '{"decision":"approve"}' }],
      ])
    );
    expect(completed?.state).toBe('completed');
    expect(completed?.loopIterations).toBe(2);
  } finally {
    await removeTempTree(root);
  }
});

test('loaded producer definitions own contracts, otherwise persisted contracts survive', async () => {
  const row = event();
  row.data.declared_output_paths = [['legacy']];
  const { run } = fixture([row]);
  expect((await restorePreviousIteration(run)).get('work')).toMatchObject({
    declaredOutputPaths: [['legacy']],
  });
  const producer = dagNodeSchema.parse({
    id: 'work',
    bash: 'true',
    output_format: { type: 'object', properties: { value: { type: 'string' } } },
  });
  if (producer.kind !== 'exec') throw new Error('Expected exec');
  expect(
    (await restorePreviousIteration({ ...run, bodyNodes: [producer] })).get('work')
  ).toMatchObject({
    declaredOutputPaths: [['value']],
  });
});
