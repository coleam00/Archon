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
} from '../../test-utils';
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
