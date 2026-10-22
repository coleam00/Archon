// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  composeScope,
  composeInnerStep,
  createMockStore,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
  runUsageWrites,
} from '../../test-utils';
import {
  startNodeExecution,
  finishNodeExecution,
  newNodeInvocation,
} from '../../../node-execution';
import { serializeNodeStateRecord } from '../../../node-record-serialization';
import { readNodeRecordEvent } from '../../../node-record-reader';
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { executeDagWorkflow } from '../../../dag-executor';
import { type RunChildWorkflowFn } from '../../child-run';
import type { WorkflowRun, WorkflowRunStatus } from '../../../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../../../store';
import { buildInstanceSnapshots, type FanOutInstanceSnapshot } from '../../../fan-out-identity';

describe('composed fan-out resume, claims and pauses (#2512)', () => {
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

  it('refuses unattributed historical usage inside an instance', async () => {
    await writeBlock(`name: compose-blk
description: child block
mutates_checkout: false
nodes:
  - id: child
    workflow: child-workflow
`);
    await writeBlock(
      'name: child-workflow\ndescription: child\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: echo done',
      'child-workflow'
    );
    const [instance] = buildInstanceSnapshots(['a']);
    const path = composeInnerStep(instance.identity, 'child');
    const store = createMockStore();
    await store.persistWorkflowEvent({
      workflow_run_id: 'parent',
      step_name: path,
      event_type: 'node_failed',
      data: {
        type: 'workflow',
        error: 'old failure',
        cost_usd: 0.02,
        tokens: { input: 14, output: 6 },
      },
    });
    store.getDagResumeSnapshot.mockImplementation(async runId =>
      foldDagResumeSnapshot(persistedEvents(store), runId)
    );
    const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
      childRunId: 'child',
      status: 'completed',
      costUsd: 0.03,
      tokens: { input: 21, output: 9 },
    }));
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('parent'),
        priorUsage: await store.getDagResumeSnapshot('parent'),
        runChildWorkflow,
        workflow: {
          name: 'parent',
          nodes: [
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              fan_out: { items: '["a"]', as: 'item', max_parallel: 1, join: 'all_success' },
            },
          ],
        },
      })
    );
    expect(runChildWorkflow).not.toHaveBeenCalled();
    expect(eventsOf(store)).toContainEqual({
      event_type: 'node_failed',
      step_name: path,
      data: expect.objectContaining({
        failure_kind: 'config',
        error: expect.stringContaining('historical child usage'),
      }),
    });
    const final = await store.getDagResumeSnapshot('parent');
    expect(final.costUsd).toBeCloseTo(0.02);
    expect(final.tokens).toEqual({ input: 14, output: 6 });
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: 0.02,
      total_tokens_in: 14,
      total_tokens_out: 6,
    });
  });

  // all_done tolerates a failed instance; one that cannot read its prior usage must still block.
  it('blocks the join and retains paid usage when an instance cannot read its prior usage', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: composed child\nmutates_checkout: false\nnodes:\n  - id: child\n    workflow: child-workflow'
    );
    await writeBlock(
      'name: child-workflow\ndescription: child\nnodes:\n  - id: work\n    bash: echo child',
      'child-workflow'
    );
    const store = createMockStore();
    const [, unreadable] = buildInstanceSnapshots(['paid', 'unreadable']);
    await store.persistWorkflowEvent({
      workflow_run_id: 'parent',
      step_name: composeInnerStep(unreadable.identity, 'child'),
      event_type: 'node_failed',
      data: {
        type: 'workflow',
        error: 'interrupted',
        child_run_id: 'unreadable-child',
        cost_usd: 0.01,
        tokens: { input: 7, output: 3 },
      },
    });
    store.getDagResumeSnapshot.mockImplementation(async runId =>
      foldDagResumeSnapshot(persistedEvents(store), runId)
    );
    const cause = new Error('instance usage unavailable');
    let reads = 0;
    const listEvents = store.listWorkflowEvents.getMockImplementation();
    if (!listEvents) throw new Error('missing event reader');
    store.listWorkflowEvents.mockImplementation(async () => {
      if (++reads === 2) throw cause;
      return listEvents('parent');
    });
    const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
      childRunId: 'paid-child',
      status: 'completed',
      output: 'paid',
      costUsd: 0.03,
      tokens: { input: 21, output: 9 },
    }));
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('parent'),
        priorUsage: await store.getDagResumeSnapshot('parent'),
        runChildWorkflow,
        workflow: {
          name: 'parent',
          nodes: [
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              fan_out: {
                items: '["paid","unreadable"]',
                as: 'item',
                max_parallel: 1,
                join: 'all_done',
              },
            },
          ],
        },
      })
    );
    expect(reads).toBe(2);
    expect(runChildWorkflow).toHaveBeenCalledTimes(1);
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: expect.closeTo(0.04, 8),
      total_tokens_in: 28,
      total_tokens_out: 12,
    });
    const events = eventsOf(store);
    expect(
      events.some(event => event.step_name === `${composeScope()}__${unreadable.identity}`)
    ).toBe(false);
    expect(
      events.filter(event => event.step_name === 'fan').map(event => event.event_type)
    ).toEqual(['node_started', 'node_failed']);
    expect(
      events.find(event => event.step_name === 'fan' && event.event_type === 'node_failed')?.data
        .error
    ).toContain(cause.message);
    const folded = await store.getDagResumeSnapshot('parent');
    expect(folded.costUsd).toBeCloseTo(0.04);
    expect(folded.tokens).toMatchObject({ input: 28, output: 12 });
  });

  async function assertRecoveredInstanceUsage(
    store: ReturnType<typeof createMockStore>,
    instance: FanOutInstanceSnapshot,
    priorScope: string,
    path: string
  ): Promise<void> {
    const paidSibling = priorScope === 'paid sibling' || priorScope === 'unknown sibling';
    const unknownTokens = priorScope === 'unknown sibling';
    const totalCost = paidSibling ? 0.07 : 0.03;
    const totalTokens = paidSibling ? { input: 49, output: 21 } : { input: 21, output: 9 };
    const completed = eventsOf(store).find(
      event => event.step_name === path && event.event_type === 'node_completed'
    );
    expect(completed?.data.cost_usd).toBeCloseTo(0.02);
    expect(completed?.data.tokens).toMatchObject({ input: 14, output: 6 });
    const terminal = eventsOf(store).find(
      event =>
        event.step_name === `${composeScope()}__${instance.identity}` &&
        event.event_type === 'node_completed'
    );
    const segmentCost = priorScope === 'closed segment' ? 0.02 : totalCost;
    const segmentTokens = priorScope === 'closed segment' ? { input: 14, output: 6 } : totalTokens;
    expect(terminal?.data.cost_usd).toBeCloseTo(segmentCost);
    if (unknownTokens) {
      expect(
        terminal &&
          readNodeRecordEvent({ ...terminal, workflow_run_id: 'parent' })?.metadata?.spend.tokens
      ).toEqual({
        source: 'unavailable',
        reason: 'incomplete',
      });
      expect(terminal?.data.tokens).toBeUndefined();
    } else {
      expect(terminal?.data.tokens).toMatchObject(segmentTokens);
    }
    expect(runUsageWrites(store).at(-1)).toMatchObject({
      total_cost_usd: expect.closeTo(totalCost, 8),
      ...(unknownTokens
        ? { total_tokens_unknown: true, total_tokens_in: null, total_tokens_out: null }
        : {
            total_tokens_in: totalTokens.input,
            total_tokens_out: totalTokens.output,
          }),
    });
    const folded = await store.getDagResumeSnapshot('parent');
    expect(folded.costUsd).toBeCloseTo(totalCost);
    if (unknownTokens) {
      expect(folded.tokensUnknown).toBe(true);
      expect(folded.tokens).toBeUndefined();
    } else {
      expect(folded.tokens).toMatchObject(totalTokens);
    }
  }

  it.each(
    [false, true].flatMap(fanOut =>
      ['open child', 'paid sibling', 'unknown sibling', 'closed segment'].flatMap(priorScope =>
        (priorScope === 'closed segment' ? [false, true] : [false]).map(interrupt => ({
          fanOut,
          priorScope,
          interrupt,
        }))
      )
    )
  )(
    'preserves prior spend inside a composed instance (%j)',
    async ({ fanOut, priorScope, interrupt }) => {
      const paidSibling = priorScope === 'paid sibling' || priorScope === 'unknown sibling';
      const unknownTokens = priorScope === 'unknown sibling';
      await writeBlock(
        `name: compose-blk
description: child block
mutates_checkout: false
nodes:
${paidSibling ? '  - id: paid\n    prompt: Already paid.\n' : ''}  - id: child
    workflow: child-workflow
${fanOut ? "    fan_out:\n      items: '[1]'\n      as: item\n      join: all_success\n" : ''}`
      );
      await writeBlock(
        'name: child-workflow\ndescription: child\nnodes:\n  - id: work\n    bash: echo child',
        'child-workflow'
      );
      const [instance] = buildInstanceSnapshots(['a']);
      const path = composeInnerStep(instance.identity, 'child');
      const store = createMockStore();
      await store.persistWorkflowEvent({
        workflow_run_id: 'parent',
        step_name: path,
        event_type: 'node_failed',
        data: {
          type: 'workflow',
          error: 'interrupted child',
          cost_usd: 0.01,
          tokens: { input: 7, output: 3 },
          child_usage: [{ childRunId: 'child', costUsd: 0.01, tokens: { input: 7, output: 3 } }],
        },
      });
      if (paidSibling) {
        await store.persistWorkflowEvent(
          serializeNodeStateRecord(
            finishNodeExecution(
              startNodeExecution({
                invocation: newNodeInvocation(),
                runId: 'parent',
                path: composeInnerStep(instance.identity, 'paid'),
                node: {
                  kind: 'agent',
                  id: 'paid',
                  source: { kind: 'inline', prompt: 'Already paid.' },
                },
              }),
              { status: 'completed' },
              {
                output: { text: 'paid' },
                costUsd: 0.04,
                ...(unknownTokens
                  ? { tokensUnknown: true }
                  : { tokens: { input: 28, output: 12 } }),
              }
            )
          )
        );
      }
      if (priorScope === 'closed segment') {
        await store.persistWorkflowEvent({
          workflow_run_id: 'parent',
          step_name: `${composeScope()}__${instance.identity}`,
          event_type: 'node_failed',
          data: {
            type: 'compose_fan_out_instance',
            aggregate: true,
            error: 'child interrupted',
            cost_usd: 0.01,
            tokens: { input: 7, output: 3 },
          },
        });
      }
      store.getDagResumeSnapshot.mockImplementation(async runId =>
        foldDagResumeSnapshot(persistedEvents(store), runId)
      );
      const runChildWorkflow = mock<RunChildWorkflowFn>(async () => ({
        childRunId: 'child',
        status: 'completed',
        output: 'done',
        costUsd: 0.03,
        tokens: { input: 21, output: 9 },
      }));
      const cause = new Error('Unsupported parent status after child settlement');
      if (interrupt)
        store.getWorkflowRunStatus.mockImplementation(async () => {
          if (
            eventsOf(store).some(
              row => row.step_name === path && row.event_type === 'node_completed'
            )
          ) {
            throw cause;
          }
          return 'running';
        });
      const drive = executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun('parent'),
          priorUsage: await store.getDagResumeSnapshot('parent'),
          runChildWorkflow,
          workflow: {
            name: 'parent',
            nodes: [
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'compose-blk',
                fan_out: { items: '["a"]', as: 'item', max_parallel: 1, join: 'all_success' },
              },
            ],
          },
        })
      );
      if (interrupt) {
        await expect(drive).rejects.toMatchObject({ cause });
        expect(runUsageWrites(store).at(-1)).toMatchObject({
          total_cost_usd: expect.closeTo(0.03),
          total_tokens_in: 21,
          total_tokens_out: 9,
        });
        expect((await store.getDagResumeSnapshot('parent')).costUsd).toBeCloseTo(0.03);
        expect(
          eventsOf(store).filter(
            row =>
              row.step_name === `${composeScope()}__${instance.identity}` &&
              (row.event_type === 'node_completed' || row.event_type === 'node_failed')
          )
        ).toHaveLength(1);
      } else {
        await drive;
        await assertRecoveredInstanceUsage(store, instance, priorScope, path);
      }
    }
  );

  it('persists the instance snapshot before scheduling any body work', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: test block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo spent"'
    );
    const store = createMockStore();
    store.persistWorkflowEvent = mock(async event => {
      if (event.event_type === 'fan_out_instances') throw new Error('disk full');
      await store.createWorkflowEvent(event);
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
        workflowRun: makeWorkflowRun('compose-snapshot-fail-id'),
      })
    );

    expect(eventsOf(store).some(event => /__work$/.test(event.step_name))).toBe(false);
    expect(
      eventsOf(store).some(
        event =>
          event.event_type === 'node_failed' &&
          String(event.data.error).includes('persist its item snapshot')
      )
    ).toBe(true);
  });

  it('uses the durable item snapshot and resumes completed inner nodes', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: first',
        "    bash: 'echo fresh-first-$INPUTS.item'",
        '  - id: second',
        "    bash: 'echo $first.output-$INPUTS.item'",
        '    depends_on: [first]',
      ].join('\n')
    );
    const [snapshot] = buildInstanceSnapshots(['a']);
    const store = createMockStore();
    (store.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>).mockResolvedValue({
      completedNodeOutputs: new Map([
        [composeInnerStep(snapshot.identity, 'first'), { output: 'persisted-first' }],
      ]),
      fanOutSnapshots: new Map([[composeScope(), [snapshot]]]),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["changed"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-partial-resume-id'),
      })
    );

    const events = eventsOf(store);
    expect(
      events.some(
        event =>
          event.event_type === 'node_completed' &&
          /__first$/.test(event.step_name) &&
          event.data.node_output === 'fresh-first-a'
      )
    ).toBe(false);
    const wrapper = events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['persisted-first-a']);
  });

  it('resumes from the durable plan when the current item producer is malformed', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: test block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo done-$INPUTS.item"'
    );
    const snapshots = buildInstanceSnapshots(['a']);
    const store = createMockStore();
    (store.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>).mockResolvedValue({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map([[composeScope(), snapshots]]),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose',
        cwd: testDir,
        workflow: {
          name: 'compose-parent',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: 'echo not-json' },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-malformed-drift-id'),
      })
    );

    const wrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['done-a']);
  });

  it('uses the persisted resolved input map when upstream bindings change on resume', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'inputs:',
        '  item: { required: true }',
        '  seed: { required: true }',
        'nodes:',
        '  - id: work',
        "    bash: 'echo $INPUTS.seed:$INPUTS.item'",
      ].join('\n')
    );
    const [snapshot] = buildInstanceSnapshots(['a'], { seed: 'persisted' }, 'item');
    const store = createMockStore();
    (store.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>).mockResolvedValue({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map([[composeScope(), [snapshot!]]]),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
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
              id: 'changed-seed',
              kind: 'exec',
              runtime: 'sh',
              script: 'echo changed',
              always_run: true,
            },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list', 'changed-seed'],
              with: { seed: '$changed-seed.output' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-frozen-inputs-id'),
      })
    );

    const wrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual(['persisted:a']);
  });

  it('blocks automatic replay for an instance with a durable start and no terminal row', async () => {
    await writeBlock(
      'name: compose-blk\ndescription: test block\nmutates_checkout: false\nnodes:\n  - id: work\n    bash: "echo spent"'
    );
    const [snapshot] = buildInstanceSnapshots(['a']);
    const store = createMockStore();
    (store.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>).mockResolvedValue({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map([[composeScope(), [snapshot]]]),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set([`${composeScope()}__${snapshot.identity}`]),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
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
        workflowRun: makeWorkflowRun('compose-ambiguous-id'),
      })
    );

    expect(eventsOf(store).some(event => /__work$/.test(event.step_name))).toBe(false);
    expect(
      eventsOf(store).some(
        event =>
          event.event_type === 'node_failed' &&
          String(event.data.error).includes('durable start but no terminal event')
      )
    ).toBe(true);
  });

  it('does not reuse a composed child workflow from an earlier loop_group iteration', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: deterministic child block',
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

    const childRuns: WorkflowRun[] = [];
    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
      childRuns.push(
        makeWorkflowRun(`child-${String(childRuns.length + 1)}`, {
          workflow_name: args.childWorkflowName,
          status: 'completed',
          parent_run_id: args.parentRun.id,
          metadata: { parent_node_id: args.nodeId, summary: 'child-a' },
        })
      );
      return {
        childRunId: childRuns.at(-1)!.id,
        status: 'completed',
        output: 'child-a',
      };
    });
    const store = createMockStore();
    (store.findChildRuns as Mock<IWorkflowStore['findChildRuns']>).mockImplementation(
      async _parentRunId => childRuns
    );

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-child-loop',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-child-loop',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until_bash:
                  'n=$(cat .compose-child-loop 2>/dev/null || echo 0); ' +
                  'n=$((n + 1)); echo "$n" > .compose-child-loop; test "$n" -eq 2',
                max_iterations: 2,
                fresh_context: true,
                nodes: [
                  { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
                  {
                    id: 'fan',
                    kind: 'compose_fan_out',
                    include: 'compose-blk',
                    depends_on: ['list'],
                    fan_out: {
                      items: '$list.output',
                      as: 'item',
                      max_parallel: 1,
                      join: 'all_done',
                    },
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-child-loop-id'),
        execContext: { kind: 'host' },
        runChildWorkflow,
      })
    );

    expect(runChildWorkflow).toHaveBeenCalledTimes(2);
    const ownedNodeIds = runChildWorkflow.mock.calls.map(([args]) => args.nodeId);
    expect(new Set(ownedNodeIds).size).toBe(2);
  });

  it('does not reuse a composed child workflow fan-out from an earlier loop_group iteration', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: deterministic child fan-out block',
        'mutates_checkout: false',
        'inputs:',
        '  items: { required: true }',
        'nodes:',
        '  - id: child',
        '    workflow: child-workflow',
        '    fan_out:',
        "      items: '$INPUTS.items'",
        '      as: item',
        '      max_parallel: 1',
      ].join('\n')
    );
    await writeBlock(
      'name: child-workflow\ndescription: child\ninputs:\n  item: { required: true }\nnodes:\n  - id: work\n    bash: "echo child-$INPUTS.item"',
      'child-workflow'
    );

    const childRuns: WorkflowRun[] = [];
    const runChildWorkflow = mock<RunChildWorkflowFn>(async args => {
      childRuns.push(
        makeWorkflowRun(`child-fan-${String(childRuns.length + 1)}`, {
          workflow_name: args.childWorkflowName,
          status: 'completed',
          parent_run_id: args.parentRun.id,
          metadata: {
            parent_node_id: args.nodeId,
            child_index: args.childIndex,
            summary: 'child-a',
          },
        })
      );
      return {
        childRunId: childRuns.at(-1)!.id,
        status: 'completed',
        output: 'child-a',
      };
    });
    const store = createMockStore();
    (store.findChildRuns as Mock<IWorkflowStore['findChildRuns']>).mockImplementation(
      async _parentRunId => childRuns
    );

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-child-fan-loop',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-child-fan-loop',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until_bash:
                  'n=$(cat .compose-child-fan-loop 2>/dev/null || echo 0); ' +
                  'n=$((n + 1)); echo "$n" > .compose-child-fan-loop; test "$n" -eq 2',
                max_iterations: 2,
                fresh_context: true,
                nodes: [
                  { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '[["a"]]'` },
                  {
                    id: 'fan',
                    kind: 'compose_fan_out',
                    include: 'compose-blk',
                    depends_on: ['list'],
                    fan_out: {
                      items: '$list.output',
                      as: 'items',
                      max_parallel: 1,
                      join: 'all_done',
                    },
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-child-fan-loop-id'),
        execContext: { kind: 'host' },
        runChildWorkflow,
      })
    );

    expect(runChildWorkflow).toHaveBeenCalledTimes(2);
    const ownedNodeIds = runChildWorkflow.mock.calls.map(([args]) => args.nodeId);
    expect(new Set(ownedNodeIds).size).toBe(2);
  });

  it('does not start a later instance when its atomic running-state claim loses', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    bash: 'echo $INPUTS.item >> .compose-claimed-items; echo $INPUTS.item'",
      ].join('\n')
    );
    const store = createMockStore();
    let claimCount = 0;
    (
      store.persistWorkflowEventIfRunning as Mock<IWorkflowStore['persistWorkflowEventIfRunning']>
    ).mockImplementation(async data => {
      claimCount += 1;
      if (claimCount === 2) return { persisted: false };
      await store.persistWorkflowEvent(data);
      return { persisted: true };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-claim',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-claim',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-claim-id'),
      })
    );

    expect(claimCount).toBe(2);
    expect(await readFile(join(testDir, '.compose-claimed-items'), 'utf8')).toBe('a\n');
    const wrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(wrapper?.data.structured_output).toEqual([
      'a',
      {
        archon_failed: true,
        error: 'parent run is no longer running; instance was not started',
        status: 'cancelled',
      },
    ]);
  });

  it('finishes a claimed deterministic instance when the parent pauses between inner layers', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: two-layer deterministic block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: first',
        "    bash: 'echo $INPUTS.item >> .compose-paused-first; echo $INPUTS.item'",
        '  - id: second',
        '    depends_on: [first]',
        "    bash: 'echo $INPUTS.item >> .compose-paused-second; echo $INPUTS.item'",
      ].join('\n')
    );
    const store = createMockStore();
    let parentPaused = false;
    let claimCount = 0;
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mockImplementation(
      async data => {
        if (data.event_type === 'node_completed' && data.step_name?.endsWith('__first')) {
          parentPaused = true;
        }
      }
    );
    (store.getWorkflowRunStatus as Mock<IWorkflowStore['getWorkflowRunStatus']>).mockImplementation(
      async () => (parentPaused ? 'paused' : 'running')
    );
    (
      store.persistWorkflowEventIfRunning as Mock<IWorkflowStore['persistWorkflowEventIfRunning']>
    ).mockImplementation(async data => {
      claimCount += 1;
      if (parentPaused) return { persisted: false };
      await store.persistWorkflowEvent(data);
      return { persisted: true };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-sibling-pause',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-sibling-pause',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-sibling-pause-id'),
      })
    );

    expect(claimCount).toBe(2);
    expect(await readFile(join(testDir, '.compose-paused-first'), 'utf8')).toBe('a\n');
    expect(await readFile(join(testDir, '.compose-paused-second'), 'utf8')).toBe('a\n');
    const instanceTerminals = eventsOf(store).filter(
      event =>
        event.event_type === 'node_completed' && event.data.type === 'compose_fan_out_instance'
    );
    expect(instanceTerminals).toHaveLength(1);
    expect(
      eventsOf(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'fan'
      )
    ).toBe(false);
  });

  it('carries a claimed pause policy into a nested composed fan-out', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: nested fan block',
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
        'description: nested leaf',
        'mutates_checkout: false',
        'nodes:',
        '  - id: leaf',
        "    bash: 'echo $INPUTS.item >> .compose-paused-nested; echo $INPUTS.item'",
      ].join('\n'),
      'leaf-blk'
    );
    const store = createMockStore();
    let parentPaused = false;
    let pauseOnInnerList = true;
    let claimCount = 0;
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mockImplementation(
      async data => {
        if (
          pauseOnInnerList &&
          data.event_type === 'node_completed' &&
          data.step_name?.endsWith('__inner-list')
        ) {
          parentPaused = true;
        }
      }
    );
    (store.getWorkflowRunStatus as Mock<IWorkflowStore['getWorkflowRunStatus']>).mockImplementation(
      async () => (parentPaused ? 'paused' : 'running')
    );
    (
      store.persistWorkflowEventIfRunning as Mock<IWorkflowStore['persistWorkflowEventIfRunning']>
    ).mockImplementation(async (data, options) => {
      claimCount += 1;
      if (parentPaused && options?.allowPaused !== true) return { persisted: false };
      await store.persistWorkflowEvent(data);
      return { persisted: true };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-paused-nested',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-paused-nested',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-paused-nested-id'),
      })
    );

    expect(claimCount).toBe(3);
    expect(await readFile(join(testDir, '.compose-paused-nested'), 'utf8')).toBe('x\n');
    const firstPassEvents = eventsOf(store);
    expect(
      firstPassEvents.filter(
        event =>
          event.event_type === 'node_completed' && event.data.type === 'compose_fan_out_instance'
      )
    ).toHaveLength(2);
    const nestedWrapper = firstPassEvents.find(
      event => event.event_type === 'node_completed' && event.step_name.endsWith('__inner-fan')
    );
    expect(nestedWrapper?.data.structured_output).toEqual(['x']);
    const outerInstance = firstPassEvents.find(
      event =>
        event.event_type === 'node_completed' &&
        event.data.type === 'compose_fan_out_instance' &&
        !event.step_name.includes('__inner-fan__')
    );
    expect(outerInstance?.data.structured_output).toEqual(['x']);
    expect(
      firstPassEvents.some(
        event => event.event_type === 'node_completed' && event.step_name === 'fan'
      )
    ).toBe(false);

    const completedNodeOutputs = new Map<string, PersistedNodeOutput>();
    const fanOutSnapshots = new Map<string, FanOutInstanceSnapshot[]>();
    for (const event of firstPassEvents) {
      if (event.event_type === 'node_completed' && typeof event.data.node_output === 'string') {
        completedNodeOutputs.set(event.step_name, {
          output: event.data.node_output,
          ...(event.data.structured_output !== undefined
            ? { structuredOutput: event.data.structured_output }
            : {}),
        });
      }
      if (event.event_type === 'fan_out_instances' && Array.isArray(event.data.instances)) {
        fanOutSnapshots.set(event.step_name, event.data.instances as FanOutInstanceSnapshot[]);
      }
    }
    (store.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>).mockResolvedValue({
      completedNodeOutputs,
      failedNodes: new Map(),
      fanOutSnapshots,
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    });
    parentPaused = false;
    pauseOnInnerList = false;
    claimCount = 0;
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mockClear();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-paused-nested',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-paused-nested',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-paused-nested-id'),
      })
    );

    expect(claimCount).toBe(2);
    expect(await readFile(join(testDir, '.compose-paused-nested'), 'utf8')).toBe('x\nx\n');
    const finalWrapper = eventsOf(store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'fan'
    );
    expect(finalWrapper?.data.structured_output).toEqual([['x'], ['x']]);
  });

  it('carries a claimed pause policy into a deterministic loop_group body', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: loop group block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: group',
        '    loop_group:',
        "      until_bash: 'exit 0'",
        '      max_iterations: 1',
        '      nodes:',
        '        - id: first',
        "          bash: 'echo $INPUTS.item >> .compose-paused-loop-first'",
        '        - id: second',
        '          depends_on: [first]',
        "          bash: 'echo $INPUTS.item >> .compose-paused-loop-second; echo $INPUTS.item'",
      ].join('\n')
    );
    const store = createMockStore();
    let parentPaused = false;
    let claimCount = 0;
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mockImplementation(
      async data => {
        if (data.event_type === 'node_completed' && data.step_name?.endsWith('.first')) {
          parentPaused = true;
        }
      }
    );
    (store.getWorkflowRunStatus as Mock<IWorkflowStore['getWorkflowRunStatus']>).mockImplementation(
      async () => (parentPaused ? 'paused' : 'running')
    );
    (
      store.persistWorkflowEventIfRunning as Mock<IWorkflowStore['persistWorkflowEventIfRunning']>
    ).mockImplementation(async (data, options) => {
      claimCount += 1;
      if (parentPaused && options?.allowPaused !== true) return { persisted: false };
      await store.persistWorkflowEvent(data);
      return { persisted: true };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-paused-loop',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-paused-loop',
          nodes: [
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a","b"]'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              fan_out: { items: '$list.output', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-paused-loop-id'),
      })
    );

    expect(claimCount).toBe(2);
    expect(await readFile(join(testDir, '.compose-paused-loop-first'), 'utf8')).toBe('a\n');
    expect(await readFile(join(testDir, '.compose-paused-loop-second'), 'utf8')).toBe('a\n');
    expect(
      eventsOf(store).filter(
        event =>
          event.event_type === 'node_completed' && event.data.type === 'compose_fan_out_instance'
      )
    ).toHaveLength(1);
    expect(
      eventsOf(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'fan'
      )
    ).toBe(false);
  });

  it('does not persist an outer instance terminal when cancellation interrupts nested work', async () => {
    await writeBlock(
      [
        'name: compose-blk',
        'description: nested cancellation block',
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
        'description: two-layer nested leaf',
        'mutates_checkout: false',
        'nodes:',
        '  - id: leaf-first',
        "    bash: 'echo $INPUTS.item >> .compose-cancelled-nested-first'",
        '  - id: leaf-second',
        '    depends_on: [leaf-first]',
        "    bash: 'echo $INPUTS.item >> .compose-cancelled-nested-second'",
      ].join('\n'),
      'leaf-blk'
    );
    const store = createMockStore();
    let runStatus: WorkflowRunStatus = 'running';
    (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mockImplementation(
      async data => {
        if (data.event_type === 'node_completed' && data.step_name?.endsWith('__leaf-first')) {
          runStatus = 'cancelled';
        }
      }
    );
    (store.getWorkflowRunStatus as Mock<IWorkflowStore['getWorkflowRunStatus']>).mockImplementation(
      async () => runStatus
    );
    (
      store.persistWorkflowEventIfRunning as Mock<IWorkflowStore['persistWorkflowEventIfRunning']>
    ).mockImplementation(async (data, options) => {
      const claimable =
        runStatus === 'running' || (runStatus === 'paused' && options?.allowPaused === true);
      if (!claimable) return { persisted: false };
      await store.persistWorkflowEvent(data);
      return { persisted: true };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-compose-cancelled-nested',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-cancelled-nested',
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
        workflowRun: makeWorkflowRun('compose-cancelled-nested-id'),
      })
    );

    expect(await readFile(join(testDir, '.compose-cancelled-nested-first'), 'utf8')).toBe('x\n');
    await expect(
      readFile(join(testDir, '.compose-cancelled-nested-second'), 'utf8')
    ).rejects.toThrow();
    expect(
      eventsOf(store).some(
        event =>
          event.event_type === 'node_completed' && event.data.type === 'compose_fan_out_instance'
      )
    ).toBe(false);
    expect(
      eventsOf(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'fan'
      )
    ).toBe(false);
  });

  it('threads persisted prior completions by identity instead of re-executing them', async () => {
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
    const items = ['a', 'b'];
    const snapshots = buildInstanceSnapshots(items);
    const completedNodeOutputs = new Map<string, PersistedNodeOutput>();
    for (const snap of snapshots) {
      completedNodeOutputs.set(composeInnerStep(snap.identity, 'work'), {
        output: `prior-${String(snap.item)}`,
      });
    }
    const storeOverride = createMockStore();
    (
      storeOverride.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>
    ).mockImplementation(async _id => ({
      completedNodeOutputs,
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    }));

    const mockDeps = createMockDeps(storeOverride);
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
            { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '${JSON.stringify(items)}'` },
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'compose-blk',
              depends_on: ['list'],
              with: { item: 'x' },
              fan_out: { items: '$list.output', as: 'item', max_parallel: 2, join: 'all_done' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-resume-id'),
      })
    );

    const wrapper = eventsOf(storeOverride).find(
      e => e.event_type === 'node_completed' && e.step_name === 'fan'
    );
    expect(wrapper).toBeDefined();
    expect(wrapper?.data.structured_output).toEqual(['prior-a', 'prior-b']);
    // The body never re-ran: no fresh instance node_completed beyond the wrapper's.
    const freshInstanceCompletions = eventsOf(storeOverride).filter(
      e =>
        e.event_type === 'node_completed' &&
        e.step_name.startsWith(`${composeScope()}__`) &&
        e.step_name.endsWith('__work') &&
        String(e.data.node_output).startsWith('done-')
    );
    expect(freshInstanceCompletions).toHaveLength(0);
  });

  it('does not resume-skip instances inside a loop_group from another iteration’s rows', async () => {
    // Rows outside the engine-owned scope must not satisfy
    // iteration N's identity lookup: the whole-run snapshot has no iteration filter, so
    // the instance prefix carries the group + iteration disambiguator.
    await writeBlock(
      [
        'name: compose-blk',
        'description: test block',
        'mutates_checkout: false',
        'nodes:',
        '  - id: work',
        "    bash: 'echo DONE-$INPUTS.item'",
      ].join('\n')
    );
    const stale = new Map<string, PersistedNodeOutput>();
    for (const snap of buildInstanceSnapshots(['a'])) {
      stale.set(`fan__${snap.identity}__work`, { output: 'stale-never-executed' });
    }
    const storeOverride = createMockStore();
    (
      storeOverride.getDagResumeSnapshot as Mock<IWorkflowStore['getDagResumeSnapshot']>
    ).mockImplementation(async _id => ({
      completedNodeOutputs: stale,
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set(),
      budget: { workUnits: 0, spendUsd: 0 },
      costUsd: 0,
    }));

    const mockDeps = createMockDeps(storeOverride);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-compose-loop',
        cwd: testDir,
        workflow: {
          name: 'compose-parent-loop',
          nodes: [
            {
              id: 'grp',
              kind: 'loop_group',
              loop_group: {
                until_bash:
                  'n=$(cat .compose-loop-iteration 2>/dev/null || echo 0); ' +
                  'n=$((n + 1)); echo "$n" > .compose-loop-iteration; test "$n" -eq 2',
                max_iterations: 2,
                fresh_context: true,
                nodes: [
                  { id: 'list', kind: 'exec', runtime: 'sh', script: `echo '["a"]'` },
                  {
                    id: 'fan',
                    kind: 'compose_fan_out',
                    include: 'compose-blk',
                    depends_on: ['list'],
                    with: { item: 'x' },
                    fan_out: {
                      items: '$list.output',
                      as: 'item',
                      max_parallel: 1,
                      join: 'all_done',
                    },
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun: makeWorkflowRun('compose-loop-id'),
      })
    );

    const events = eventsOf(mockDeps.store);
    // The instance actually executed in BOTH iterations under iteration-scoped names.
    const [snapshot] = buildInstanceSnapshots(['a']);
    if (snapshot === undefined) throw new Error('expected one fan-out snapshot');
    const expectedSteps = new Set([
      `grp.${composeInnerStep(snapshot.identity, 'work', 'fan', [{ groupId: 'grp', iteration: 1 }])}`,
      `grp.${composeInnerStep(snapshot.identity, 'work', 'fan', [{ groupId: 'grp', iteration: 2 }])}`,
    ]);
    const instanceCompletions = events.filter(
      e => e.event_type === 'node_completed' && expectedSteps.has(e.step_name)
    );
    expect(instanceCompletions.length).toBe(2);
    expect(instanceCompletions.every(e => e.data.node_output === 'DONE-a')).toBe(true);
    expect(events.some(e => e.event_type === 'node_completed' && e.step_name === 'grp')).toBe(true);
    expect(events.some(e => String(e.data.error ?? '').length > 0)).toBe(false);
  });
});
