// @archon-test-isolated
import { readNodeRecordEvent } from '../../../node-record-reader';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { ParentStatusReadError } from '../../../parent-status-read';
import { workflowRunStatusSchema } from '../../../schemas/workflow-run';
import { TerminalStatusWriteError } from '../../../terminal-status-write';
import { NodeEventWriteError } from '../../../node-event-write';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  mockLogFn,
  composeScope,
  createMockStore,
  runUsageWrites,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  minimalConfig,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { type RunChildWorkflowFn } from '../../child-run';
import type { DagNode, WorkflowNodeSession } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';
import { captureWorkflowSource, capturedSourceRoots } from '../../../workflow-source';

describe('executeDagWorkflow -- composed fan-out (include + fan_out, #2512)', () => {
  let testDir: string;

  /** Write the composed block the fan-out targets into the project discovery root. */
  const writeBlock = async (yaml: string, name = 'compose-blk'): Promise<void> => {
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    await writeFile(join(testDir, '.archon', 'workflows', `${name}.yaml`), yaml);
  };

  const eventsOf = (store: ReturnType<typeof createMockStore>) =>
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls.map(
      call => ({
        event_type: call[0].event_type,
        step_name: call[0].step_name ?? '',
        data: call[0].data ?? {},
      })
    );

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-compose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  for (const scenario of ['parallel sibling', 'usage read failure', 'usage write failure']) {
    it(`preserves an unreadable parent after settling work (${scenario})`, async () => {
      await writeBlock(
        'name: compose-blk\ndescription: Paid work\nnodes:\n  - id: work\n    prompt: Work.'
      );
      const store = createMockStore();
      const runId = 'unreadable-parent';
      const cause = Object.assign(new Error('Unsupported workflow status: unsupported'), {
        name: 'WorkflowStatusReadError',
        workflowRunId: runId,
        rawStatus: 'unsupported',
      });
      let rejected = false;
      store.getWorkflowRunStatus.mockImplementation(async () => {
        const instanceSettled = persistedEvents(store).some(
          event =>
            event.event_type === 'node_completed' && event.data?.type === 'compose_fan_out_instance'
        );
        if (instanceSettled && !rejected) {
          rejected = true;
          throw cause;
        }
        return 'running';
      });
      const bookkeepingError = new Error('usage storage unavailable');
      store.getDagResumeSnapshot.mockImplementation(async () => {
        if (rejected && scenario === 'usage read failure') throw bookkeepingError;
        return foldDagResumeSnapshot(persistedEvents(store), runId);
      });
      if (scenario === 'usage write failure') {
        store.updateWorkflowRun.mockImplementation(async (_id, patch) => {
          if (patch.metadata?.total_cost_usd !== undefined) throw bookkeepingError;
        });
      }
      mockLogFn.mockClear();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Done.' };
        yield { type: 'result', sessionId: 'paid', cost: 0.02, tokens: { input: 2, output: 1 } };
      });
      const fan: DagNode = {
        id: 'fan',
        kind: 'compose_fan_out',
        include: 'compose-blk',
        fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_success' },
      };
      const nodes: DagNode[] = [fan];
      if (scenario === 'parallel sibling') {
        nodes.push({ id: 'peer', kind: 'agent', source: { kind: 'inline', prompt: 'Peer work.' } });
      }
      const error = await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: { name: 'unreadable-parent', nodes },
          workflowRun: makeWorkflowRun(runId),
        })
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ParentStatusReadError);
      if (!(error instanceof ParentStatusReadError))
        throw new Error('Expected status-read interruption');
      expect(error.cause).toBe(cause);
      expect(rejected).toBe(true);
      const events = persistedEvents(store);
      expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
      expect(events.filter(event => event.event_type === 'node_completed')).toHaveLength(
        scenario === 'parallel sibling' ? 3 : 2
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
      if (scenario === 'parallel sibling') {
        expect(runUsageWrites(store).at(-1)).toMatchObject({
          total_cost_usd: 0.04,
          total_tokens_in: 4,
          total_tokens_out: 2,
        });
      } else {
        expect(mockLogFn).toHaveBeenCalledWith(
          expect.objectContaining({ err: bookkeepingError, workflowRunId: runId }),
          scenario === 'usage read failure'
            ? 'dag.unwind_usage_refresh_failed'
            : 'dag.run_usage_persist_failed'
        );
      }
    });
  }

  it('keeps a failed child durable when its settled parent status is unreadable', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: work\nnodes:\n  - id: work\n    prompt: Work.'
    );
    const store = createMockStore();
    const cause = Object.assign(new Error('Unsupported workflow status: unsupported'), {
      name: 'WorkflowStatusReadError',
      rawStatus: 'unsupported',
    });
    store.getWorkflowRunStatus.mockImplementation(async () => {
      if (
        persistedEvents(store).some(
          event =>
            event.event_type === 'node_failed' && event.data?.type === 'compose_fan_out_instance'
        )
      )
        throw cause;
      return 'running';
    });
    mockSendQueryDag.mockImplementation(async function* () {
      throw new Error('Child work failed');
    });
    const error: unknown = await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'unreadable-parent',
          nodes: [
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_success' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('failed-child-unreadable-parent'),
      })
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ParentStatusReadError);
    if (!(error instanceof ParentStatusReadError))
      throw new Error('Expected lifecycle interruption');
    expect(error.cause).toBe(cause);
    const failures = persistedEvents(store).filter(event => event.event_type === 'node_failed');
    expect(failures).toHaveLength(2);
    expect(failures.some(event => event.data?.type === 'compose_fan_out_instance')).toBe(true);
    expect(failures.some(event => event.data?.error === 'Child work failed')).toBe(true);
    expect(
      persistedEvents(store)
        .filter(event => event.step_name === 'fan')
        .map(event => event.event_type)
    ).toEqual(['node_started']);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(store.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  for (const status of [...workflowRunStatusSchema.options, null]) {
    it(`keeps the supported post-instance parent status behavior (${status})`, async () => {
      await writeBlock(
        'name: compose-blk\ndescription: Paid work\nnodes:\n  - id: work\n    prompt: Work.'
      );
      const store = createMockStore();
      store.getWorkflowRunStatus.mockImplementation(async () => {
        const settled = persistedEvents(store).some(
          event =>
            event.event_type === 'node_completed' && event.data?.type === 'compose_fan_out_instance'
        );
        return settled ? status : 'running';
      });
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Done.' };
        yield { type: 'result', sessionId: 'paid', cost: 0.02, tokens: { input: 2, output: 1 } };
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'supported-parent',
            nodes: [
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_success' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('supported-parent'),
        })
      );
      const aggregate = persistedEvents(store).filter(
        event => event.step_name === 'fan' && event.event_type !== 'node_started'
      );
      expect(aggregate.map(event => event.event_type)).toEqual(
        status === 'running' ? ['node_completed'] : []
      );
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.02,
        total_tokens_in: 2,
        total_tokens_out: 1,
      });
    });
  }

  for (const kind of ['child', 'compose'] as const) {
    for (const unknownFirst of [true, false]) {
      it(`keeps ${kind} fan-out aggregate tokens unknown (unknown first: ${unknownFirst})`, async () => {
        await writeBlock(
          'name: compose-blk\ndescription: Token accounting\nnodes:\n  - id: work\n    prompt: Work.'
        );
        let calls = 0;
        const usage = { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 };
        mockSendQueryDag.mockImplementation(async function* () {
          calls++;
          yield { type: 'agent_message_chunk', text: 'Done.' };
          yield {
            type: 'result',
            sessionId: 's',
            cost: 0.1,
            ...((calls === 1) === unknownFirst ? { tokensUnknown: true } : { tokens: usage }),
          };
        });
        const runChildWorkflow = mock<RunChildWorkflowFn>(async args => ({
          childRunId: `child-${args.childIndex}`,
          status: 'completed',
          output: 'Done.',
          costUsd: 0.1,
          ...((args.childIndex === 0) === unknownFirst
            ? { tokensUnknown: true }
            : { tokens: usage }),
        }));
        const store = createMockStore();
        const fanOut = {
          items: '[1,2]',
          as: 'item',
          max_parallel: 1,
          join: 'all_success' as const,
        };
        const node: DagNode =
          kind === 'child'
            ? { id: 'fan', kind: 'workflow', workflow: 'compose-blk', fan_out: fanOut }
            : { id: 'fan', kind: 'compose_fan_out', include: 'compose-blk', fan_out: fanOut };
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            runChildWorkflow,
            workflow: { name: 'unknown-fan-out', nodes: [node] },
            workflowRun: makeWorkflowRun('unknown-fan-out-run'),
          })
        );
        expect(kind === 'child' ? runChildWorkflow.mock.calls.length : calls).toBe(2);
        const completed = persistedEvents(store).find(
          event => event.event_type === 'node_completed' && event.step_name === 'fan'
        );
        expect(completed?.data?.tokens).toBeUndefined();
        expect(completed?.data?.cost_usd).toBeCloseTo(0.2);
        const record = completed && readNodeRecordEvent({ ...completed, data: completed.data });
        expect(record?.metadata?.spend.tokens).toEqual({
          source: 'unavailable',
          reason: 'incomplete',
        });
        expect(runUsageWrites(store).at(-1)?.total_tokens_unknown).toBe(true);
        const snapshot = await foldDagResumeSnapshot(persistedEvents(store), 'unknown-fan-out-run');
        expect(snapshot.tokens).toBeUndefined();
        expect(snapshot.tokensUnknown).toBe(true);
        expect(snapshot.costUsd).toBeCloseTo(0.2);
      });
    }
  }

  // A cancel after the instance's paid query either stops the instance between its nodes
  // (no terminal state) or lands after it completed; both exits must keep its usage.
  for (const instanceStop of ['mid-instance', 'after-instance'] as const) {
    it(`keeps paid unknown-token work when a composed fan-out is cancelled (${instanceStop})`, async () => {
      await writeBlock(
        [
          'name: compose-blk',
          'description: Token accounting',
          'nodes:',
          '  - id: work',
          '    prompt: Work.',
          ...(instanceStop === 'mid-instance'
            ? ['  - id: more', '    prompt: More.', '    depends_on: [work]']
            : []),
        ].join('\n')
      );
      let calls = 0;
      let cancelled = false;
      mockSendQueryDag.mockImplementation(async function* () {
        calls++;
        yield { type: 'agent_message_chunk', text: 'Done.' };
        yield {
          type: 'result',
          sessionId: 's',
          cost: calls === 1 ? 0.1 : 0.2,
          ...(calls === 1
            ? { tokens: { input: 170, output: 20, cacheRead: 30, cacheWrite: 40 } }
            : { tokensUnknown: true }),
        };
        if (calls === 2) cancelled = true;
      });
      const store = createMockStore();
      store.getWorkflowRunStatus.mockImplementation(async () =>
        cancelled ? 'cancelled' : 'running'
      );
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'cancelled-compose',
            nodes: [
              { id: 'first', kind: 'agent', source: { kind: 'inline', prompt: 'First.' } },
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                depends_on: ['first'],
                fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_done' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('cancelled-compose-run'),
        })
      );

      expect(calls).toBe(2);
      const usage = runUsageWrites(store).at(-1);
      expect(usage?.total_cost_usd).toBeCloseTo(0.3);
      expect(usage?.total_tokens_unknown).toBe(true);
      expect(usage?.total_tokens_in).toBeNull();
    });
  }

  it('executes one instance per item inside the parent run and aggregates in input order', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    bash: 'echo done-$INPUTS.item'",
      ].join('\n')
    );
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('compose-run-id');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '${JSON.stringify(['a', 'b'])}'`,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              with: { item: 'unused' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun,
      })
    );

    const events = eventsOf(mockDeps.store);
    // One audit snapshot BEFORE any instance schedules.
    expect(events.some(e => e.event_type === 'fan_out_instances')).toBe(true);
    // Instance-qualified step names under the PARENT run id — no child runs exist.
    const instanceEvents = events.filter(
      e => e.step_name.startsWith(`${composeScope()}__`) && e.step_name.endsWith('__work')
    );
    expect(instanceEvents.length).toBeGreaterThanOrEqual(2);
    const instanceOutputs = instanceEvents
      .filter(e => e.event_type === 'node_completed')
      .map(e => e.data.node_output)
      .sort();
    expect(instanceOutputs).toEqual(['done-a', 'done-b']);
    // Ordered aggregate on the wrapper node.
    const wrapper = events.find(e => e.event_type === 'node_completed' && e.step_name === 'fan');
    expect(wrapper).toBeDefined();
    expect(wrapper?.data.structured_output).toEqual(['done-a', 'done-b']);
    expect(JSON.parse(String(wrapper?.data.node_output))).toEqual(['done-a', 'done-b']);
  });

  it('runs concurrent instances of a writing block in the shared checkout (#2777)', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: writes to the checkout',
        'nodes:',
        '  - id: work',
        "    bash: 'echo $INPUTS.item > out-$INPUTS.item.txt && echo wrote-$INPUTS.item'",
      ].join('\n')
    );
    const mockDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: createMockPlatform(),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_success' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-writing-run-id'),
      })
    );

    const wrapper = eventsOf(mockDeps.store).find(
      e => e.event_type === 'node_completed' && e.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['wrote-a', 'wrote-b']);
  });

  it('a persist_session node inside a composed body continues the scope session', async () => {
    // The parent has no persisted node of its own; only the fan-out's body persists.
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    prompt: 'work on $INPUTS.item'",
        '    persist_session: true',
      ].join('\n')
    );
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    let sessionCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      sessionCount += 1;
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: `session-${sessionCount}` };
    });
    // Body node ids are instance-namespaced, so the second run reads back exactly the
    // rows the first run wrote rather than a hand-built key.
    const store = createMockStore();
    const rows: WorkflowNodeSession[] = [];
    store.listWorkflowNodeSessions.mockImplementation(async () => [...rows]);
    store.upsertWorkflowNodeSession.mockImplementation(async params => {
      rows.push({
        ...params,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      });
    });

    for (const runId of ['run-1', 'run-2']) {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-compose',
          cwd: testDir,
          workflow: {
            name: 'compose-parent',
            nodes: [
              { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                depends_on: ['list'],
                with: { item: 'unused' },
                fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
              },
            ],
          },
          workflowRun: makeWorkflowRun(runId, { conversation_id: 'conv-compose' }),
        })
      );
    }

    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
  });

  it.each([
    ['alone', []],
    [
      'and an all_done node failed reading its output',
      [
        '  - id: record',
        "    bash: 'echo $work.output'",
        '    depends_on: [work]',
        '    trigger_rule: all_done',
      ],
    ],
  ])(
    'waits on the quota reset when a composed instance node reports quota_exhausted %s',
    async (_, reader) => {
      await writeBlock(
        [
          'name: compose-blk',
          'description: test block',
          'mutates_checkout: false',
          'nodes:',
          '  - id: work',
          "    prompt: 'work on $INPUTS.item'",
          ...reader,
        ].join('\n')
      );
      const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
      mockSendQueryDag.mockImplementation(async function* () {
        yield {
          type: 'result',
          isError: true,
          failure: { class: 'quota_exhausted', evidence: "You've hit your session limit", resetAt },
        };
      });
      const store = createMockStore();

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-compose',
          cwd: testDir,
          workflow: {
            name: 'compose-parent',
            nodes: [
              { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                depends_on: ['list'],
                with: { item: 'unused' },
                fan_out: {
                  items: '$list.output',
                  as: 'item',
                  max_parallel: 1,
                  join: 'all_success',
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('compose-quota-run'),
          config: { ...minimalConfig, workflows: { autoResumeOnQuotaReset: true } },
        })
      );

      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
        'compose-quota-run',
        expect.objectContaining({ kind: 'quota', nodeId: 'fan', resumeAt: resetAt }),
        { kind: 'started', stepName: 'fan' }
      );
    }
  );

  it('fails a composed instance that failed both on a usage limit and for another reason', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    prompt: 'work on $INPUTS.item'",
        '  - id: broken',
        "    bash: 'exit 3'",
      ].join('\n')
    );
    const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
    mockSendQueryDag.mockImplementation(async function* () {
      yield {
        type: 'result',
        isError: true,
        failure: { class: 'quota_exhausted', evidence: "You've hit your session limit", resetAt },
      };
    });
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              with: { item: 'unused' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_success' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-mixed-run'),
        config: { ...minimalConfig, workflows: { autoResumeOnQuotaReset: true } },
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('refuses runtime composed fan-out resolution after the capture changes', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: original block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo original"'
    );
    const captureRoot = join(testDir, 'capture');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    const capturedBlock = join(captureRoot, 'project', '.archon', 'workflows', 'compose-blk.yaml');
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'compose-capture-integrity',
          nodes: [
            {
              id: 'change-capture',
              kind: 'exec',
              runtime: 'bun',
              script: `Bun.write(${JSON.stringify(capturedBlock)}, ${JSON.stringify(
                'name: compose-blk\ndescription: changed block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo changed"'
              )})`,
            },
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '["a"]'`,
              depends_on: ['change-capture'],
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-capture-integrity-run'),
        workflowSourceRoots: capturedSourceRoots(capture.anchor),
      })
    );

    const events = eventsOf(store);
    const failed = events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'fan'
    );
    expect(String(failed?.data.error)).toContain('captured source has changed');
    expect(events.some(event => event.event_type === 'fan_out_instances')).toBe(false);
    expect(events.some(event => /__work$/.test(event.step_name))).toBe(false);
  });

  it('honors a declared non-sink return from every instance', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'returns: chosen',
        'nodes:',
        '  - id: chosen',
        "    bash: 'echo chosen-$INPUTS.item'",
        '  - id: later',
        "    bash: 'echo wrong-$INPUTS.item'",
        '    depends_on: [chosen]',
      ].join('\n')
    );
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-return-id'),
      })
    );

    const wrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['chosen-a']);
  });

  it('mixed composed rejections preserve terminal rollback after claimed work settles', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: body\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done"\n  - id: stop\n    cancel: stop\n    depends_on: [work]'
    );
    const store = createMockStore();
    const cause = new Error('cancel record failed');
    const nodeFailure = new Error('node storage offline');
    let workStarts = 0;
    let cancellationSettled = false;
    store.cancelWorkflowRun = mock(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      cancellationSettled = true;
      throw cause;
    });
    store.persistWorkflowEvent = mock(async event => {
      if (
        event.event_type === 'node_started' &&
        event.step_name?.endsWith('__work') &&
        ++workStarts === 1
      )
        throw nodeFailure;
      await store.createWorkflowEvent(event);
    });
    mockLogFn.mockClear();
    const pending = executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'mixed-composed',
          nodes: [
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              fan_out: { items: '["a","b"]', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('mixed-composed'),
      })
    );
    await expect(pending).rejects.toMatchObject({ name: 'TerminalStatusWriteError', cause });
    expect(workStarts).toBe(2);
    expect(cancellationSettled).toBe(true);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    expect(mockLogFn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ cause: nodeFailure }), workflowRunId: 'mixed-composed' },
      'dag.join_secondary_failure'
    );
  });

  it.each([false, true])(
    'rejects composed all_done after inner storage rejection (cancellation=%s)',
    async cancellation => {
      await writeBlock(
        `name: compose-blk\ndescription: body\nmutates_checkout: false\nnodes:\n  - id: work\n    ${cancellation ? 'cancel: stop' : 'bash: "echo done"'}`
      );
      const store = createMockStore();
      const cause = new Error('inner storage failed');
      if (cancellation)
        store.cancelWorkflowRun = mock(async () => {
          throw cause;
        });
      store.persistWorkflowEvent = mock(async event => {
        if (
          !cancellation &&
          event.event_type === 'node_completed' &&
          event.step_name?.endsWith('__work')
        ) {
          throw cause;
        }
        await store.createWorkflowEvent(event);
      });
      const error: unknown = await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflow: {
            name: 'composed-write-failure',
            nodes: [
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                fan_out: { items: '["a"]', as: 'item', max_parallel: 1, join: 'all_done' },
              },
            ],
          },
          workflowRun: makeWorkflowRun('composed-write-failure'),
        })
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(error).toBeInstanceOf(cancellation ? TerminalStatusWriteError : NodeEventWriteError);
      if (!(error instanceof Error)) throw new Error('Expected storage rejection');
      expect(error.cause).toBe(cause);
      expect(
        eventsOf(store).some(
          event => event.event_type === 'node_completed' && event.step_name === 'fan'
        )
      ).toBe(false);
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('forwards the parent child-workflow runner into each composed instance', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: child',
        '    workflow: child-workflow',
        '    with:',
        "      item: '$INPUTS.item'",
      ].join('\n')
    );
    await writeBlock(
      'name: child-workflow\ndescription: child\ninputs:\n  item: { required: true }\nnodes:\n  - id: work\n    bash: "echo child-$INPUTS.item"',
      'child-workflow'
    );
    const store = createMockStore();
    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
      expect(
        eventsOf(store)
          .filter(event => event.step_name === args.nodeId)
          .map(event => event.event_type)
      ).toEqual(['node_started']);
      return {
        childRunId: `child-${args.nodeId}`,
        status: 'completed',
        output: `child-${String(args.inputs?.item)}`,
      };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-child-id'),
        execContext: { kind: 'host' },
        runChildWorkflow,
      })
    );

    expect(runChildWorkflow).toHaveBeenCalledTimes(1);
    const wrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['child-a']);
  });

  it('completes with an empty aggregate for an empty item list', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: test block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo nope"'
    );
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '[]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 3, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-empty-id'),
      })
    );

    const wrapper = eventsOf(mockDeps.store).find(
      e => e.event_type === 'node_completed' && e.step_name === 'fan'
    );
    expect(wrapper).toBeDefined();
    expect(wrapper?.data.node_output).toBe('[]');
    // No instances were scheduled.
    expect(
      eventsOf(mockDeps.store).some(
        e => e.event_type === 'node_started' && e.step_name.startsWith(`${composeScope()}__`)
      )
    ).toBe(false);
  });

  it('rejects a gate inside the composed body before any instance spends', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    bash: 'echo hi'",
        '  - id: review-gate',
        '    approval:',
        '      message: hold on',
        '    depends_on: [work]',
      ].join('\n')
    );
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-gate-id'),
      })
    );

    const failed = eventsOf(mockDeps.store).find(
      e => e.event_type === 'node_failed' && e.step_name === 'fan'
    );
    expect(failed).toBeDefined();
    expect(String(failed?.data.error)).toContain('approval gate');
    // Nothing was scheduled: no snapshot, no instances.
    expect(eventsOf(mockDeps.store).some(e => e.event_type === 'fan_out_instances')).toBe(false);
    expect(eventsOf(mockDeps.store).some(e => e.step_name.startsWith(composeScope()))).toBe(false);
  });

  it('fails the node under join: all_success when an instance fails', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: test block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "exit 1"'
    );
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a", "b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_success' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-fail-id'),
      })
    );

    const failed = eventsOf(mockDeps.store).find(
      e => e.event_type === 'node_failed' && e.step_name === 'fan'
    );
    expect(failed).toBeDefined();
    expect(String(failed?.data.error)).toContain('all_success');
  });

  it('represents a partial failure as archon_failed markers under the default all_done join', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        '    bash: \'test "$INPUTS.item" = keep && echo ok || exit 1\'',
      ].join('\n')
    );
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '${JSON.stringify(['keep', 'drop'])}'`,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-partial-id'),
      })
    );

    const wrapper = eventsOf(mockDeps.store).find(
      e => e.event_type === 'node_completed' && e.step_name === 'fan'
    );
    expect(wrapper).toBeDefined();
    const aggregate = JSON.parse(String(wrapper?.data.node_output)) as Array<unknown>;
    expect(aggregate[0]).toBe('ok');
    expect((aggregate[1] as { archon_failed?: boolean })?.archon_failed).toBe(true);
  });

  it('resolves a nested deferred compose_fan_out inside the target block (#2512 instance expansion)', async () => {
    // The target block itself contains a deferred compose_fan_out whose include target is
    // a THIRD workflow: instance expansion must resolve it against the full discovered
    // name map, not just {synth, target}.
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: inner-list',
        '    bash: \'echo [\\"x\\"]\'',
        '  - id: inner-fan',
        '    kind: compose_fan_out',
        '    include: leaf-blk',
        '    depends_on: [inner-list]',
        '    fan_out:',
        "      items: '$inner-list.output'",
        '      as: item',
        '      max_parallel: 1',
      ].join('\n')
    );
    await writeBlock(
      [
        'name: leaf-blk',
        'description: leaf block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: leaf',
        "    bash: 'echo leaf-$INPUTS.item'",
      ].join('\n'),
      'leaf-blk'
    );

    const mockDeps = createMockDeps();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose-nested',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-nested',
          nodes: [
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '${JSON.stringify(['a', 'b'])}'`,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              with: { item: 'unused' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-nested-id'),
      })
    );

    const events = eventsOf(mockDeps.store);
    expect(events.some(e => String(e.data.error ?? '').includes('failed to compose'))).toBe(false);
    const wrapper = events.find(e => e.event_type === 'node_completed' && e.step_name === 'fan');
    expect(wrapper).toBeDefined();
    // Each outer instance ran its nested fan once → two leaf completions total.
    const leafOutputs = events
      .filter(e => e.event_type === 'node_completed' && /__leaf$/.test(e.step_name))
      .map(e => e.data.node_output)
      .sort();
    expect(leafOutputs).toEqual(['leaf-x', 'leaf-x']);
  });

  it('rejects an approval gate in a nested composed fan-out target before scheduling', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: outer block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: inner-list',
        '    bash: \'echo ["x"]\'',
        '  - id: inner-fan',
        '    kind: compose_fan_out',
        '    include: gated-leaf',
        '    depends_on: [inner-list]',
        '    fan_out:',
        "      items: '$inner-list.output'",
        '      as: item',
        '      max_parallel: 1',
      ].join('\n')
    );
    await writeBlock(
      [
        'name: gated-leaf',
        'description: nested gated block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: nested-review',
        '    approval:',
        '      message: Review this item?',
      ].join('\n'),
      'gated-leaf'
    );

    const mockDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-compose-nested-gate',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-nested-gate',
          nodes: [
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '${JSON.stringify(['a'])}'`,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-nested-gate-id'),
      })
    );

    const events = eventsOf(mockDeps.store);
    expect(events.some(event => event.event_type === 'fan_out_instances')).toBe(false);
    expect(
      events.some(
        event =>
          event.step_name === 'fan' &&
          event.event_type === 'node_failed' &&
          String(event.data.error).includes("'nested-review'")
      )
    ).toBe(true);
  });

  it('charges each model call once: leaf node_complete costs sum to the run total (#3508)', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    prompt: 'work on $INPUTS.item'",
      ].join('\n')
    );
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls += 1;
      yield { type: 'agent_message_chunk', text: 'done' };
      yield {
        type: 'result',
        sessionId: `session-${calls}`,
        cost: 0.02,
        tokens: { input: 10, output: 5 },
      };
    });
    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('compose-cost-run');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-compose-cost',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            {
              id: 'list',
              kind: 'exec',
              runtime: 'sh',
              script: `echo '${JSON.stringify(['a', 'b'])}'`,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              with: { item: 'unused' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun,
      })
    );

    expect(calls).toBe(2);
    const rows = await readTranscript(join(testDir, 'logs'), workflowRun.id);
    const completed = rows.filter(row => row.type === 'node_complete');
    const leaves = completed.filter(
      row => (row.execution as { path?: string } | undefined)?.path?.endsWith('__work') === true
    );

    // The two instance leaves are the only rows that report spend, so summing the
    // transcript's per-node costs reproduces the run total. The wrapper and the two
    // instance terminals restate that same spend and report none of their own.
    const wrapperRow = completed.find(row => row.step === 'fan');
    expect(leaves.map(row => row.cost_usd)).toEqual([0.02, 0.02]);
    expect(wrapperRow).toBeDefined();
    expect(wrapperRow).not.toHaveProperty('cost_usd');
    const instanceTerminals = completed.filter(
      row => (row.execution as { accounting?: string } | undefined)?.accounting === 'instance'
    );
    expect(instanceTerminals).toHaveLength(2);
    for (const row of instanceTerminals) expect(row).not.toHaveProperty('cost_usd');
    const reported = completed.reduce(
      (total, row) => total + (typeof row.cost_usd === 'number' ? row.cost_usd : 0),
      0
    );
    const runTotal = rows.find(row => row.type === 'workflow_complete')?.cost_usd;
    expect(runTotal).toBe(0.04);
    expect(reported).toBe(runTotal as number);
    expect(runUsageWrites(store).map(write => write.total_cost_usd)).toEqual([0.04]);

    // The durable rows are untouched: they still carry every number beside the
    // `aggregate` marker, so a resumed run still balances over them. The fold skips the
    // wrapper and treats each instance terminal as the authoritative row for its own
    // scope, dropping that instance's inner rows. This change is reporting-only.
    const durable = eventsOf(store).filter(e => e.event_type === 'node_completed');
    const wrapperEvent = durable.find(e => e.step_name === 'fan');
    expect(wrapperEvent?.data.cost_usd).toBe(0.04);
    expect(wrapperEvent?.data.aggregate).toBe(true);
    const instanceEvents = durable.filter(e => e.data.type === 'compose_fan_out_instance');
    expect(instanceEvents).toHaveLength(2);
    for (const event of instanceEvents) {
      expect(event.data.cost_usd).toBe(0.02);
      expect(event.data.aggregate).toBe(true);
    }
  });
});
