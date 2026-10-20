// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { settlingProvider } from '../test-settling-provider';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SendQueryOptions } from '@archon/provider-contract';
import {
  persistedEvents,
  mockArtifactHome,
  setMockArtifactHome,
  composeScope,
  type MockWorkflowStore,
  createMockStore,
  mockClaudeCapabilities,
  mockCodexCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  minimalConfig,
  type TestWorkflowDefinition,
  resolveTestWorkflow,
  dagOptions,
  ready,
  makeWorkflowRun,
} from './test-utils';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { executeDagWorkflow } from '../dag-executor';
import { checkComposedBlockBoundaries } from './trigger-rule';
import { resolvedBodyNodes } from '../graph-plan';
import { dryRunWorkflow } from '../dry-run';
import { getWorkflowEventEmitter } from '../event-emitter';
import type {
  DagNode,
  LoopGroupNode,
  SkipCause,
  WorkflowDefinition,
  ResolvedWorkflow,
} from '../schemas';
import { dagNodeSchema, skipCauseSchema } from '../schemas';
import { discoverWorkflows } from '../workflow-discovery';
import { expandWorkflowIncludes } from '../include-expander';
import type { WorkflowDeps, WorkflowConfig } from '../deps';
import type { IWorkflowStore, PersistedNodeOutput } from '../store';
import {
  buildAiProfile,
  isLiteralSpec,
  resolveModelSpec,
  selectModelRef,
  type ModelAliasPreset,
  type RawTiersConfig,
} from '../model-validation';

it('a sub-run stamps its result contract with the legacy root fields older parents read', async () => {
  const testDir = join(
    tmpdir(),
    `dag-subrun-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(testDir, { recursive: true });
  try {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        cwd: testDir,
        workflow: {
          name: 'child',
          returns: 'r',
          nodes: [
            {
              id: 'r',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"green":true,"note":{"text":"x"}}'`,
              output_format: {
                type: 'object',
                properties: {
                  green: { type: 'boolean' },
                  note: { type: 'object', properties: { text: { type: 'string' } } },
                },
                required: ['green'],
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('child-run', { parent_run_id: 'parent-run' }),
      })
    );
    const metadata = (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>).mock
      .calls[0]?.[2];
    expect(metadata).toMatchObject({
      summary_declared_output_paths: [['green'], ['note'], ['note', 'text']],
      summary_declared_fields: ['green', 'note'],
    });
  } finally {
    await removeTempTree(testDir);
  }
});

// ---------------------------------------------------------------------------
// Include expansion — the "zero new runtime machinery" proof.
//
// Expand a parent that `include:`s a child (via expandWorkflowIncludes, exactly
// as discovery does), then run the flattened definition through executeDagWorkflow.
// The executor never sees an include node; the namespaced nodes behave as ordinary
// top-level nodes for events, terminal-output selection, resume-skip, and always_run.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- flattened include expansion', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-include-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[]): WorkflowDefinition {
    return { name, description: name, nodes: nodes.map(n => dagNodeSchema.parse(n)) };
  }

  /**
   * Parent that includes a 2-node bash child (a -> b) and reads `$inc.output`.
   * Expands to: inc__a -> inc__b -> consumer(reads $inc__b.output). `alwaysRunA`
   * flags the child's entry node so resume re-executes it.
   */
  function expandedParentNodes(alwaysRunA = false): DagNode[] {
    const child = buildWf('inc-child', [
      { id: 'a', bash: 'echo AAA', ...(alwaysRunA ? { always_run: true } : {}) },
      { id: 'b', bash: 'echo BBB', depends_on: ['a'] },
    ]);
    const parent = buildWf('inc-parent', [
      { id: 'inc', include: 'inc-child' },
      { id: 'consumer', bash: 'echo $inc.output', depends_on: ['inc'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['inc-child', child],
        ['inc-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('inc-parent')!.nodes as DagNode[])];
  }

  function expandedGatedParentNodes(
    mode: 'false-condition' | 'skipped-dependency' | 'active',
    alwaysRunGateAndConsumer = false
  ): DagNode[] {
    const child = buildWf('review-block', [
      { id: 'entry', bash: 'echo started' },
      {
        id: 'optional',
        bash: 'echo optional',
        depends_on: ['entry'],
        when: "$entry.output == 'never'",
      },
      { id: 'required', bash: 'echo report', depends_on: ['entry'] },
      {
        id: 'synthesize',
        bash: 'echo synthesized',
        depends_on: ['optional', 'required'],
        trigger_rule: 'all_done',
      },
    ]);
    const gateNodes =
      mode === 'skipped-dependency'
        ? [
            { id: 'source', bash: 'echo ready' },
            {
              id: 'gate',
              bash: 'echo gate',
              depends_on: ['source'],
              when: "$source.output == 'never'",
            },
          ]
        : [
            {
              id: 'gate',
              bash: `echo ${mode === 'active' ? 'run' : 'skip'}`,
              ...(alwaysRunGateAndConsumer ? { always_run: true } : {}),
            },
          ];
    const parent = buildWf('gated-parent', [
      ...gateNodes,
      {
        id: 'review',
        include: 'review-block',
        depends_on: ['gate'],
        ...(mode === 'skipped-dependency' ? {} : { when: "$gate.output == 'run'" }),
      },
      {
        id: 'consumer',
        bash: 'echo $review.output',
        depends_on: ['review'],
        ...(alwaysRunGateAndConsumer ? { always_run: true } : {}),
      },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['review-block', child],
        ['gated-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('gated-parent')!.nodes as DagNode[])];
  }

  function expandedStructuredGateNodes(): DagNode[] {
    const child = buildWf('structured-gate-block', [{ id: 'entry', bash: 'echo started' }]);
    const parent = buildWf('structured-gate-parent', [
      { id: 'gate', bash: `printf '%s' '{"route":{"ready":true}}'` },
      {
        id: 'review',
        include: 'structured-gate-block',
        depends_on: ['gate'],
        when: "$gate.output.route == 'true'",
      },
      { id: 'consumer', bash: 'echo $review.output', depends_on: ['review'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['structured-gate-block', child],
        ['structured-gate-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('structured-gate-parent')!.nodes as DagNode[])];
  }

  function expandedMultiSinkDependencyNodes(
    entryTriggerRule: 'all_success' | 'one_success'
  ): DagNode[] {
    const upstream = buildWf('upstream', [
      { id: 'start', bash: 'echo start' },
      { id: 'good', bash: 'echo good', depends_on: ['start'] },
      {
        id: 'bad',
        bash: 'echo bad',
        depends_on: ['start'],
        when: "$start.output == 'never'",
      },
    ]);
    const downstream = buildWf('downstream', [
      { id: 'entry', bash: 'echo entry', trigger_rule: entryTriggerRule },
      {
        id: 'synthesize',
        bash: 'echo synthesized',
        depends_on: ['entry'],
        trigger_rule: 'all_done',
      },
    ]);
    const parent = buildWf('multi-sink-parent', [
      { id: 'up', include: 'upstream' },
      { id: 'down', include: 'downstream', depends_on: ['up'] },
      { id: 'consumer', bash: 'echo $down.output', depends_on: ['down'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['upstream', upstream],
        ['downstream', downstream],
        ['multi-sink-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('multi-sink-parent')!.nodes as DagNode[])];
  }

  function expandedMixedEntryTriggerNodes(): DagNode[] {
    const upstream = buildWf('upstream', [
      { id: 'start', bash: 'echo start' },
      { id: 'good', bash: 'echo good', depends_on: ['start'] },
      {
        id: 'bad',
        bash: 'echo bad',
        depends_on: ['start'],
        when: "$start.output == 'never'",
      },
    ]);
    const downstream = buildWf('downstream', [
      { id: 'strict', bash: 'echo strict', trigger_rule: 'all_success' },
      { id: 'lenient', bash: 'echo lenient', trigger_rule: 'one_success' },
    ]);
    const parent = buildWf('mixed-entry-parent', [
      { id: 'up', include: 'upstream' },
      { id: 'down', include: 'downstream', depends_on: ['up'] },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['upstream', upstream],
        ['downstream', downstream],
        ['mixed-entry-parent', parent],
      ])
    );
    expect(errors).toHaveLength(0);
    return [...(workflows.get('mixed-entry-parent')!.nodes as DagNode[])];
  }

  function eventList(
    deps: WorkflowDeps
  ): Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }> {
    return (deps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) =>
        call[0] as { event_type: string; step_name: string; data?: Record<string, unknown> }
    );
  }

  async function executeExpanded(
    nodes: DagNode[],
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<{
    events: Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }>;
    output: string | undefined;
  }> {
    const mockDeps = createMockDeps();
    const output = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'gated-parent', nodes },
        workflowRun: makeWorkflowRun(runId, { workflow_name: 'gated-parent' }),
        priorCompletedNodes,
      })
    );
    if (typeof output === 'object') throw new Error('Unexpected source release');
    return { events: eventList(mockDeps), output };
  }

  function loopGatedWorkflow(when: string): ResolvedWorkflow {
    const block = buildWf('block', [
      { id: 'entry', bash: 'echo entry' },
      { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
    ]);
    const parent = buildWf('loop-gated', [
      {
        id: 'cycle',
        loop_group: {
          until: 'DONE',
          max_iterations: 2,
          nodes: [
            { id: 'work', bash: 'echo go' },
            { id: 'inc', include: 'block', depends_on: ['work'], when },
            {
              id: 'end',
              bash: 'echo DONE',
              when: "$LOOP_PREV.work.output == 'go'",
              depends_on: ['inc'],
              trigger_rule: 'all_done',
            },
          ],
        },
      },
    ]);
    const expanded = expandWorkflowIncludes(
      new Map([
        ['block', block],
        ['loop-gated', parent],
      ])
    );
    expect(expanded.errors).toEqual([]);
    const workflow = expanded.workflows.get('loop-gated');
    if (!workflow) throw new Error('loop-gated did not expand');
    return workflow;
  }

  for (const value of ['go', '']) {
    it(`shares loop scope across include entries and descendants for previous value '${value}'`, async () => {
      const when = `$LOOP_PREV.work.output == '${value}'`;
      const workflow = loopGatedWorkflow(when);
      const { events } = await executeExpanded([...workflow.nodes], `loop-gated-${value}`);
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: testDir,
        stubs: { work: 'go', inc__entry: 'entry', inc__tail: 'tail', end: 'DONE' },
      });
      expect(dryRun.outcome).toBe('completed');
      for (const id of ['entry', 'tail']) {
        const expected: Array<'skipped' | 'completed'> =
          value === 'go' ? ['skipped', 'completed'] : ['completed', 'skipped'];
        const nodeEvents = events.filter(
          event =>
            event.step_name === `cycle.inc__${id}` &&
            ['node_completed', 'node_skipped'].includes(event.event_type)
        );
        expect(nodeEvents.map(event => event.event_type.replace('node_', ''))).toEqual(expected);
        expect(nodeEvents.find(event => event.event_type === 'node_skipped')?.data?.cause).toEqual({
          kind: 'condition',
          expr: when,
        });
        const trace = dryRun.trace.filter(entry => entry.nodeId === `inc__${id}`);
        expect(trace.map(entry => entry.state)).toEqual(
          expected.map(state => (state === 'completed' ? 'stubbed' : state))
        );
        expect(trace.find(entry => entry.state === 'skipped')?.cause).toEqual({
          kind: 'condition',
          expr: when,
        });
      }
    });
  }

  for (const value of ['go', '']) {
    it(`retains an inherited gate's outer scope inside a nested loop for '${value}'`, async () => {
      const leaf = buildWf('leaf', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const block = buildWf('nested-block', [
        {
          id: 'inner',
          loop_group: {
            max_iterations: 2,
            until: 'FIN',
            nodes: [
              { id: 'innerWork', bash: 'echo inner' },
              {
                id: 'local',
                include: 'leaf',
                when: "$LOOP_PREV.innerWork.output == 'inner'",
                depends_on: ['innerWork'],
              },
              {
                id: 'finish',
                bash: 'echo FIN',
                when: "$LOOP_PREV.innerWork.output == 'inner'",
                depends_on: ['local'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ]);
      const when = `$LOOP_PREV.work.output == '${value}'`;
      const parent = buildWf('nested-parent', [
        {
          id: 'outer',
          loop_group: {
            max_iterations: 2,
            until: 'DONE',
            nodes: [
              { id: 'work', bash: 'echo go' },
              { id: 'inc', include: 'nested-block', when, depends_on: ['work'] },
              {
                id: 'end',
                bash: 'echo DONE',
                when: "$LOOP_PREV.work.output == 'go'",
                depends_on: ['inc'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ]);
      const expanded = expandWorkflowIncludes(
        new Map([
          ['leaf', leaf],
          ['nested-block', block],
          ['nested-parent', parent],
        ])
      );
      expect(expanded.errors).toEqual([]);
      const workflow = expanded.workflows.get('nested-parent')!;
      const { events } = await executeExpanded([...workflow.nodes], `nested-${value}`);
      expect(events.filter(e => e.event_type === 'node_failed')).toEqual([]);
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: testDir,
        stubs: {
          work: 'go',
          innerWork: 'inner',
          local__entry: 'entry',
          local__tail: 'tail',
          finish: 'FIN',
          end: 'DONE',
        },
      });
      expect(dryRun.outcome).toBe('completed');
      for (const id of ['entry', 'tail']) {
        const leafEvents = events.filter(
          e =>
            e.step_name === `outer.inc__inner.local__${id}` &&
            ['node_completed', 'node_skipped'].includes(e.event_type)
        );
        expect(leafEvents.map(e => e.event_type)).toEqual(['node_skipped', 'node_completed']);
        expect(leafEvents[0]?.data?.cause).toEqual({
          kind: 'condition',
          expr: "$LOOP_PREV.innerWork.output == 'inner'",
        });
        expect(dryRun.trace.filter(e => e.nodeId === `local__${id}`).map(e => e.state)).toEqual([
          'skipped',
          'stubbed',
        ]);
      }
    });
  }

  for (const { enabled, force } of [
    { enabled: true, force: 'none' },
    { enabled: false, force: 'none' },
    { enabled: true, force: 'entry' },
    { enabled: true, force: 'group' },
    { enabled: true, force: 'nested' },
    { enabled: true, force: 'upstream' },
  ]) {
    it(`resumes an actual cached loop entry (gate=${String(enabled)}, always_run=${force})`, async () => {
      const marker = join(testDir, `entry-${String(enabled)}`);
      const retry = join(testDir, `retry-${String(enabled)}`);
      const when = "$LOOP_PREV.work.output == 'go' && $INPUTS.enabled == true";
      const block = buildWf('cached-block', [
        {
          id: 'entry',
          bash: `echo entry >> '${marker}'; echo entry`,
          always_run: force === 'entry',
        },
        {
          id: 'tail',
          bash:
            force === 'nested'
              ? `if [ ! -f '${retry}' ]; then touch '${retry}'; elif [ ! -f '${retry}-recovered' ]; then touch '${retry}-recovered'; exit 1; fi; echo tail`
              : `if [ ! -f '${retry}' ]; then touch '${retry}'; exit 1; fi; echo tail`,
          depends_on: ['entry'],
          trigger_rule: 'all_done',
        },
      ]);
      const parent = buildWf('cached-parent', [
        {
          id: 'cycle',
          always_run: force === 'group',
          loop_group: {
            max_iterations: 2,
            until: 'DONE',
            nodes: [
              {
                id: 'work',
                bash:
                  force === 'upstream'
                    ? `if [ -f '${retry}' ]; then echo changed; else echo go; fi`
                    : 'echo go',
                always_run: force === 'upstream',
              },
              { id: 'inc', include: 'cached-block', depends_on: ['work'], when },
              {
                id: 'end',
                bash: 'echo DONE',
                depends_on: ['inc'],
                trigger_rule: 'all_done',
                when: "$LOOP_PREV.work.output == 'go'",
              },
            ],
          },
        },
      ]);
      if (force === 'nested') {
        const outer = dagNodeSchema.parse({
          id: 'outer',
          loop_group: {
            max_iterations: 2,
            until: 'OUTERDONE',
            nodes: [
              { id: 'outerWork', bash: 'echo go' },
              {
                id: 'outerEnd',
                bash: 'echo OUTERDONE',
                depends_on: ['cycle'],
                trigger_rule: 'all_done',
                when: "$LOOP_PREV.outerWork.output == 'go'",
              },
            ],
          },
        });
        if (outer.kind !== 'loop_group') throw new Error('expected outer loop');
        outer.loop_group.nodes.splice(1, 0, { ...parent.nodes[0]!, depends_on: ['outerWork'] });
        parent.nodes = [outer];
      }
      const prefix = force === 'nested' ? 'outer.cycle' : 'cycle';
      const initialEntries = force === 'nested' ? 'entry\nentry\n' : 'entry\n';
      const expanded = expandWorkflowIncludes(
        new Map([
          ['cached-block', block],
          ['cached-parent', parent],
        ])
      );
      expect(expanded.errors).toEqual([]);
      const workflow = expanded.workflows.get('cached-parent')!;
      const workflowRun = makeWorkflowRun(`cached-loop-${String(enabled)}`, {
        workflow_name: workflow.name,
        metadata: { inputs: { enabled: 'true' } },
      });
      const deps = createMockDeps();
      await executeDagWorkflow(dagOptions({ deps, cwd: testDir, workflow, workflowRun }));
      const rows = persistedEvents(deps.store);
      expect(
        rows.some(e => e.event_type === 'node_failed' && e.step_name === `${prefix}.inc__tail`)
      ).toBe(true);
      expect(await readFile(marker, 'utf8')).toBe(initialEntries);
      const snapshot = await foldDagResumeSnapshot(rows, workflowRun.id);
      deps.store.listWorkflowEvents.mockResolvedValue(
        rows.map((e, index) => ({
          ...e,
          id: String(index),
          created_at: new Date().toISOString(),
          step_index: null,
          step_name: e.step_name ?? null,
          data: e.data ?? {},
        }))
      );
      deps.store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      const before = rows.length;
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflow,
          workflowRun: { ...workflowRun, metadata: { inputs: { enabled: String(enabled) } } },
          priorCompletedNodes: snapshot.completedNodeOutputs,
        })
      );
      const resumed = persistedEvents(deps.store).slice(before);
      expect(resumed.filter(e => e.event_type === 'node_failed')).toEqual([]);
      expect(await readFile(marker, 'utf8')).toBe(
        ['none', 'nested'].includes(force) ? initialEntries : 'entry\nentry\n'
      );
      if (enabled) {
        expect(
          resumed.some(
            e =>
              e.event_type === 'node_skipped_prior_success' &&
              e.step_name === `${prefix}.inc__entry`
          )
        ).toBe(['none', 'nested'].includes(force));
        expect(
          resumed.some(
            e => e.event_type === 'node_completed' && e.step_name === `${prefix}.inc__tail`
          )
        ).toBe(true);
      } else {
        for (const id of ['entry', 'tail']) {
          expect(
            resumed.find(
              e => e.event_type === 'node_skipped' && e.step_name === `${prefix}.inc__${id}`
            )?.data?.cause
          ).toEqual({ kind: 'condition', expr: when });
        }
      }
    });
  }

  for (const runtime of ['bash', 'script', 'legacy'] as const) {
    it(`restores historical ${runtime} spills after an equal-length later output`, async () => {
      const counter = join(testDir, 'counter');
      const retry = join(testDir, 'retry');
      const emit =
        runtime !== 'script'
          ? {
              bash: `if [ -f '${counter}' ]; then printf '%40000s' '' | tr ' ' B; else touch '${counter}'; printf '%40000s' '' | tr ' ' A; fi`,
            }
          : {
              script: `import { existsSync, writeFileSync } from 'node:fs'; const seen = existsSync('${counter}'); writeFileSync('${counter}', '1'); process.stdout.write((seen ? 'B' : 'A').repeat(40000));`,
              runtime: 'bun',
            };
      const workflow = resolveTestWorkflow(
        buildWf('historical-spill', [
          {
            id: 'cycle',
            loop_group: {
              max_iterations: 2,
              until: 'DONE',
              nodes: [
                { id: 'emit', ...emit },
                {
                  id: 'inspect',
                  bash: 'printf %.1s $LOOP_PREV.emit.output',
                  depends_on: ['emit'],
                  always_run: true,
                  when: "$LOOP_PREV.emit.output != ''",
                },
                {
                  id: 'tail',
                  bash: `if [ ! -f '${retry}' ]; then touch '${retry}'; exit 1; fi; echo DONE`,
                  depends_on: ['inspect'],
                },
              ],
            },
          },
        ])
      );
      const deps = createMockDeps();
      const workflowRun = makeWorkflowRun(`historical-${runtime}`);
      const options = dagOptions({ deps, cwd: testDir, workflow, workflowRun });
      await executeDagWorkflow(options);
      const rows = persistedEvents(deps.store);
      expect(rows.some(e => e.event_type === 'node_failed' && e.step_name === 'cycle.tail')).toBe(
        true
      );
      if (runtime === 'legacy') {
        const spillPath = join(testDir, 'cycle.emit.nodeoutput');
        await writeFile(spillPath, 'B'.repeat(40000));
        for (const row of rows) {
          if (row.data?.node_output_spill_path) row.data.node_output_spill_path = spillPath;
        }
      }
      const snapshot = await foldDagResumeSnapshot(rows, workflowRun.id);
      deps.store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      deps.store.listWorkflowEvents.mockResolvedValue(
        rows.map((e, index) => ({
          ...e,
          id: String(index),
          created_at: new Date().toISOString(),
          step_index: null,
          step_name: e.step_name ?? null,
          data: e.data ?? {},
        }))
      );
      const before = rows.length;
      await executeDagWorkflow({ ...options, priorCompletedNodes: snapshot.completedNodeOutputs });
      const resumed = persistedEvents(deps.store).slice(before);
      expect(
        resumed.find(e => e.event_type === 'node_completed' && e.step_name === 'cycle.inspect')
          ?.data?.node_output
      ).toBe(runtime === 'legacy' ? 'B' : 'A');
      expect(
        resumed.some(
          e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'cycle.emit'
        )
      ).toBe(runtime !== 'legacy');
    });
  }

  for (const nested of [false, true]) {
    it(`invalidates the body cache after an enclosing dependency changes (nested=${String(nested)})`, async () => {
      const changed = join(testDir, 'changed');
      const retry = join(testDir, 'retry');
      const nodes = [
        {
          id: 'source',
          always_run: true,
          bash: `if [ -f '${changed}' ]; then echo B; else echo A; fi`,
        },
        {
          id: 'cycle',
          depends_on: ['source'],
          loop_group: {
            max_iterations: 1,
            until: 'DONE',
            nodes: [
              { id: 'entry', bash: 'echo $source.output' },
              {
                id: 'tail',
                bash: `if [ ! -f '${retry}' ]; then touch '${retry}'; exit 1; fi; echo DONE`,
                depends_on: ['entry'],
              },
            ],
          },
        },
      ];
      const workflow = resolveTestWorkflow(
        buildWf(
          'changed-group-input',
          nested
            ? [{ id: 'outer', loop_group: { max_iterations: 1, until: 'DONE', nodes } }]
            : nodes
        )
      );
      const deps = createMockDeps();
      const workflowRun = makeWorkflowRun(`changed-group-${String(nested)}`);
      const options = dagOptions({ deps, cwd: testDir, workflow, workflowRun });
      await executeDagWorkflow(options);
      const rows = persistedEvents(deps.store);
      const snapshot = await foldDagResumeSnapshot(rows, workflowRun.id);
      deps.store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      deps.store.listWorkflowEvents.mockResolvedValue(
        rows.map((e, index) => ({
          ...e,
          id: String(index),
          created_at: new Date().toISOString(),
          step_index: null,
          step_name: e.step_name ?? null,
          data: e.data ?? {},
        }))
      );
      await writeFile(changed, '1');
      const before = rows.length;
      await executeDagWorkflow({ ...options, priorCompletedNodes: snapshot.completedNodeOutputs });
      const resumed = persistedEvents(deps.store).slice(before);
      const prefix = nested ? 'outer.' : '';
      expect(
        resumed.find(e => e.event_type === 'node_completed' && e.step_name === `${prefix}source`)
          ?.data?.node_output
      ).toBe('B');
      expect(
        resumed.find(
          e => e.event_type === 'node_completed' && e.step_name === `${prefix}cycle.entry`
        )?.data?.node_output
      ).toBe('B');
      expect(
        resumed.some(
          e =>
            e.event_type === 'node_skipped_prior_success' && e.step_name === `${prefix}cycle.entry`
        )
      ).toBe(false);
    });
  }

  for (const { skippedParallel, trailingSession } of [
    { skippedParallel: false, trailingSession: false },
    { skippedParallel: true, trailingSession: false },
    { skippedParallel: false, trailingSession: true },
  ]) {
    it(`restores layer session transitions on resume (skipped=${String(skippedParallel)}, trailingSession=${String(trailingSession)})`, async () => {
      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
      mockSendQueryDag.mockImplementation(async function* (prompt: string) {
        yield { type: 'agent_message_chunk', text: 'lead output' };
        yield { type: 'result', sessionId: prompt.toUpperCase() };
      });
      const retry = join(testDir, 'retry');
      const workflow = resolveTestWorkflow(
        buildWf('parallel-cursor', [
          {
            id: 'cycle',
            loop_group: {
              fresh_context: false,
              max_iterations: 2,
              until: 'DONE',
              nodes: [
                {
                  id: 'lead',
                  prompt: 'lead',
                  always_run: true,
                  depends_on: [],
                  trigger_rule: 'all_done',
                },
                ...['left', 'right'].map(id => ({
                  id,
                  bash: 'echo parallel',
                  depends_on: ['lead'],
                  ...(skippedParallel ? { when: 'false' } : {}),
                })),
                ...(trailingSession
                  ? [
                      {
                        id: 'follow',
                        prompt: 'follow',
                        depends_on: ['left', 'right'],
                        trigger_rule: 'all_done',
                        when: "$LOOP_PREV.lead.output == ''",
                      },
                    ]
                  : []),
                {
                  id: 'tail',
                  bash: `if [ ! -f '${retry}' ]; then touch '${retry}'; exit 1; fi; echo DONE`,
                  depends_on: trailingSession ? ['follow'] : ['left', 'right'],
                  trigger_rule: 'all_done',
                  when: "$LOOP_PREV.lead.output != ''",
                },
              ],
            },
          },
        ])
      );
      const deps = createMockDeps();
      const workflowRun = makeWorkflowRun('parallel-cursor');
      const options = dagOptions({ deps, cwd: testDir, workflow, workflowRun });
      await executeDagWorkflow(options);
      expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'lead').map(c => c[2])).toEqual([
        undefined,
        trailingSession ? 'FOLLOW' : undefined,
      ]);
      const rows = persistedEvents(deps.store);
      const snapshot = await foldDagResumeSnapshot(rows, workflowRun.id);
      deps.store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      deps.store.listWorkflowEvents.mockResolvedValue(
        rows.map((e, index) => ({
          ...e,
          id: String(index),
          created_at: new Date().toISOString(),
          step_index: null,
          step_name: e.step_name ?? null,
          data: e.data ?? {},
        }))
      );
      await executeDagWorkflow({ ...options, priorCompletedNodes: snapshot.completedNodeOutputs });
      expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'lead').map(c => c[2])).toEqual([
        undefined,
        trailingSession ? 'FOLLOW' : undefined,
        trailingSession ? 'FOLLOW' : undefined,
      ]);
    });
  }

  it('rejects a loop reference in an include boundary without loop context', () => {
    const when = "$LOOP_PREV.work.output == 'go'";
    const workflow = loopGatedWorkflow(when);
    const group = workflow.nodes[0];
    if (group?.kind !== 'loop_group') throw new Error('expected loop group');
    const entry = resolvedBodyNodes(group.loop_group).find(node => node.id === 'inc__entry');
    if (!entry) throw new Error('expected expanded entry');
    const outputs = new Map([['work', { state: 'completed' as const, output: 'current' }]]);
    expect(
      checkComposedBlockBoundaries(entry, outputs, undefined, {
        evaluateEntryBoundary: true,
      })
    ).toEqual({
      decision: 'skip',
      cause: { kind: 'condition_parse_error', expr: when },
    });
  });

  it('skips every composed node when the include condition is false', async () => {
    const { events } = await executeExpanded(
      expandedGatedParentNodes('false-condition'),
      'inc-false-condition'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual([
      'consumer',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['gate']);
  });

  it('skips every composed node when the include dependencies are ineligible', async () => {
    const { events } = await executeExpanded(
      expandedGatedParentNodes('skipped-dependency'),
      'inc-skipped-dependency'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual([
      'consumer',
      'gate',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['source']);
  });

  it('persists the cause from include conditions and include dependency rules', async () => {
    const conditionRun = await executeExpanded(
      expandedGatedParentNodes('false-condition'),
      'inc-condition-cause'
    );
    const conditionSkip = conditionRun.events.find(
      event => event.event_type === 'node_skipped' && event.step_name === 'review__required'
    );
    expect(conditionSkip?.data?.cause).toEqual({
      kind: 'condition',
      expr: "$gate.output == 'run'",
    });

    const dependencyRun = await executeExpanded(
      expandedGatedParentNodes('skipped-dependency'),
      'inc-dependency-cause'
    );
    const dependencySkip = dependencyRun.events.find(
      event => event.event_type === 'node_skipped' && event.step_name === 'review__required'
    );
    expect(dependencySkip?.data?.cause).toEqual({
      kind: 'upstream_skipped',
      origin: 'gate',
    });
  });

  it.each(['failed', 'condition'] as const)(
    '#3156: honors %s skip provenance through direct joins, include boundaries, and resume',
    async mode => {
      const deliver = {
        ...buildWf('deliver-block', [
          { id: 'gate-input', bash: 'printf ready' },
          {
            id: 'gate-validated',
            bash: 'exit 1',
            depends_on: ['gate-input'],
            ...(mode === 'condition' ? { when: "$gate-input.output == 'never'" } : {}),
          },
          { id: 'checks', bash: 'echo checks', depends_on: ['gate-validated'] },
          { id: 'result', bash: 'echo delivered', depends_on: ['checks'] },
        ]),
        returns: 'result',
      };
      const action = buildWf('action-block', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const parent = buildWf('direct-joins', [
        { id: 'pr', bash: 'printf ready' },
        { id: 'deliver', include: 'deliver-block', depends_on: ['pr'] },
        {
          id: 'flip-ready',
          script: 'console.log(process.env.INPUTS_DELIVERED)',
          runtime: 'bun',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'none_failed_min_one_success',
          with: { delivered: { from: '$deliver.output', if_skipped: 'fallback' } },
        },
        {
          id: 'action',
          include: 'action-block',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'none_failed_min_one_success',
        },
        {
          id: 'report',
          script: 'console.log(process.env.INPUTS_DELIVERED)',
          runtime: 'bun',
          depends_on: ['pr', 'deliver'],
          trigger_rule: 'all_done',
          with: { delivered: { from: '$deliver.output', if_skipped: 'fallback' } },
        },
      ]);
      const expanded = expandWorkflowIncludes(
        new Map([
          ['deliver-block', deliver],
          ['action-block', action],
          ['direct-joins', parent],
        ])
      );
      expect(expanded.errors).toEqual([]);
      const workflow = expanded.workflows.get('direct-joins');
      if (!workflow) throw new Error('direct-joins did not expand');
      const nodes = [...workflow.nodes];
      const initial = await executeExpanded(nodes, `direct-joins-${mode}`);
      const resumed = await executeExpanded(
        nodes,
        `direct-joins-${mode}-resumed`,
        new Map([['pr', { output: 'ready' }]])
      );
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: testDir,
        stubs: {
          pr: 'ready',
          'deliver__gate-input': 'ready',
          'flip-ready': 'fallback',
          report: 'fallback',
          action__entry: 'entry',
          action__tail: 'tail',
        },
      });
      const cause = {
        kind: mode === 'failed' ? 'upstream_failed' : 'upstream_skipped',
        origin: 'deliver__gate-validated',
      };
      const runs = [initial, resumed];
      if (mode === 'failed') {
        runs.push(
          await executeExpanded(
            nodes,
            'direct-joins-cached-before-upgrade',
            new Map([
              ['pr', { output: 'ready' }],
              ['flip-ready', { output: 'previously flipped' }],
              ['action__entry', { output: 'entry' }],
              ['action__tail', { output: 'tail' }],
            ])
          )
        );
      }
      for (const run of runs) {
        for (const id of ['deliver__checks', 'deliver__result']) {
          expect(
            run.events.find(event => event.step_name === id && event.event_type === 'node_skipped')
              ?.data?.cause
          ).toEqual(cause);
        }
        for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
          if (mode === 'failed') {
            expect(
              run.events.find(
                event => event.step_name === id && event.event_type === 'node_skipped'
              )?.data?.cause
            ).toEqual(cause);
            expect(
              run.events.some(
                event => event.step_name === id && event.event_type === 'node_started'
              )
            ).toBe(false);
          } else {
            expect(
              run.events.some(
                event => event.step_name === id && event.event_type === 'node_completed'
              )
            ).toBe(true);
          }
        }
        expect(
          run.events.find(
            event => event.step_name === 'report' && event.event_type === 'node_completed'
          )?.data?.node_output
        ).toContain('fallback');
      }
      for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
        expect(dryRun.trace.find(entry => entry.nodeId === id)).toMatchObject(
          mode === 'failed' ? { state: 'skipped', cause } : { state: 'stubbed' }
        );
      }
    }
  );

  it('recomputes the same skip provenance on resume', async () => {
    const nodes = expandedGatedParentNodes('skipped-dependency');
    const initial = await executeExpanded(nodes, 'inc-resume-cause-initial');
    const resumed = await executeExpanded(
      nodes,
      'inc-resume-cause-resumed',
      new Map([['source', { output: 'ready\n' }]])
    );
    const skipCauses = (
      events: Array<{ event_type: string; step_name: string; data?: Record<string, unknown> }>
    ): Array<readonly [string, SkipCause]> =>
      events
        .filter(event => event.event_type === 'node_skipped')
        .map(event => [event.step_name, skipCauseSchema.parse(event.data?.cause)] as const)
        .sort(([left], [right]) => left.localeCompare(right));

    expect(skipCauses(resumed.events)).toEqual(skipCauses(initial.events));
    expect(skipCauses(resumed.events)).toContainEqual([
      'consumer',
      { kind: 'upstream_skipped', origin: 'gate' },
    ]);
  });

  it('reports the same skip cause in dry-run and executor traces', async () => {
    const nodes: DagNode[] = [
      { id: 'source', kind: 'exec', runtime: 'sh', script: 'printf ready' },
      {
        id: 'branch',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo branch',
        depends_on: ['source'],
        when: "$source.output == 'never'",
      },
      {
        id: 'join',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo join',
        depends_on: ['branch'],
      },
    ];
    const mockDeps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflowRun: makeWorkflowRun('skip-cause-parity'),
        workflow: { name: 'skip-cause-parity', nodes },
      })
    );
    const executorCauses = eventList(mockDeps)
      .filter(event => event.event_type === 'node_skipped')
      .map(event => [event.step_name, skipCauseSchema.parse(event.data?.cause)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    const dryRun = await dryRunWorkflow({
      workflow: resolveTestWorkflow({ name: 'skip-cause-parity', nodes }),
      userMessage: '',
      cwd: testDir,
      stubs: { source: 'ready', branch: 'unused', join: 'unused' },
    });
    const dryRunCauses = dryRun.trace
      .filter(entry => entry.state === 'skipped')
      .map(entry => [entry.nodeId, entry.cause] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect(dryRunCauses).toEqual(executorCauses);
    expect(dryRunCauses).toEqual([
      ['branch', { kind: 'condition', expr: "$source.output == 'never'" }],
      ['join', { kind: 'upstream_skipped', origin: 'branch' }],
    ]);
  });

  it('emits the executor skip causes to live subscribers', async () => {
    const workflowRun = makeWorkflowRun('skip-cause-live');
    const emitted: Array<{ nodeId: string; cause: SkipCause }> = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      if (event.type === 'node_skipped' && event.runId === workflowRun.id) {
        emitted.push({ nodeId: event.nodeId, cause: event.cause });
      }
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflowRun,
          workflow: {
            name: 'skip-cause-live',
            nodes: [
              { id: 'source', kind: 'exec', runtime: 'sh', script: 'printf ready' },
              {
                id: 'branch',
                kind: 'exec',
                runtime: 'sh',
                script: 'echo branch',
                depends_on: ['source'],
                when: "$source.output == 'never'",
              },
              {
                id: 'join',
                kind: 'exec',
                runtime: 'sh',
                script: 'echo join',
                depends_on: ['branch'],
              },
            ],
          },
        })
      );
    } finally {
      unsubscribe();
    }

    expect(emitted).toEqual([
      {
        nodeId: 'branch',
        cause: { kind: 'condition', expr: "$source.output == 'never'" },
      },
      { nodeId: 'join', cause: { kind: 'upstream_skipped', origin: 'branch' } },
    ]);
  });

  it('keeps all_done active for intentionally skipped branches inside a running block', async () => {
    const { events, output } = await executeExpanded(
      expandedGatedParentNodes('active'),
      'inc-active-block'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['review__optional']);
    expect(completed).toEqual([
      'consumer',
      'gate',
      'review__entry',
      'review__required',
      'review__synthesize',
    ]);
    expect(output).toContain('synthesized');
  });

  it('keeps a block inactive when one sink of an included dependency is ineligible', async () => {
    const { events } = await executeExpanded(
      expandedMultiSinkDependencyNodes('all_success'),
      'inc-multi-sink-inactive'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['consumer', 'down__entry', 'down__synthesize', 'up__bad']);
    expect(completed).toEqual(['up__good', 'up__start']);
  });

  it('keeps a one_success block active when any sink of an included dependency succeeds', async () => {
    const { events } = await executeExpanded(
      expandedMultiSinkDependencyNodes('one_success'),
      'inc-multi-sink-active'
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();

    expect(skipped).toEqual(['up__bad']);
    expect(completed).toEqual([
      'consumer',
      'down__entry',
      'down__synthesize',
      'up__good',
      'up__start',
    ]);
  });

  it('resume discards cached block output when its include gate becomes inactive', async () => {
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['gate', { output: 'run' }],
      ['review__entry', { output: 'started' }],
      ['review__required', { output: 'report' }],
      ['review__synthesize', { output: 'old-sink' }],
      ['consumer', { output: 'old-consumer' }],
    ]);
    const { events } = await executeExpanded(
      expandedGatedParentNodes('false-condition', true),
      'inc-resume-inactive-block',
      priorCompletedNodes
    );

    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name)
      .sort();
    const completed = events
      .filter(event => event.event_type === 'node_completed')
      .map(event => event.step_name)
      .sort();
    const reused = events
      .filter(event => event.event_type === 'node_skipped_prior_success')
      .map(event => event.step_name);

    expect(skipped).toEqual([
      'consumer',
      'review__entry',
      'review__optional',
      'review__required',
      'review__synthesize',
    ]);
    expect(completed).toEqual(['gate']);
    expect(reused.filter(stepName => stepName.startsWith('review__'))).toEqual([]);
  });

  it("resume evaluates each cached block entry with that entry's trigger rule", async () => {
    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['up__start', { output: 'start' }],
      ['up__good', { output: 'good' }],
      ['down__strict', { output: 'old-strict' }],
      ['down__lenient', { output: 'old-lenient' }],
    ]);
    const { events } = await executeExpanded(
      expandedMixedEntryTriggerNodes(),
      'inc-resume-mixed-entry-rules',
      priorCompletedNodes
    );
    const skipped = events
      .filter(event => event.event_type === 'node_skipped')
      .map(event => event.step_name);
    const reused = events
      .filter(event => event.event_type === 'node_skipped_prior_success')
      .map(event => event.step_name);

    expect(skipped).toContain('down__strict');
    expect(reused).toContain('down__lenient');
    expect(reused).not.toContain('down__strict');
  });

  it('fails a cached block entry when its include gate reads a structured field', async () => {
    const { events } = await executeExpanded(
      expandedStructuredGateNodes(),
      'inc-resume-structured-gate',
      new Map([['review__entry', { output: 'prior entry' }]])
    );

    const entryEvents = events.filter(event => event.step_name === 'review__entry');
    expect(entryEvents).toHaveLength(1);
    expect(entryEvents[0]?.event_type).toBe('node_failed');
    expect(entryEvents[0]?.data?.error).toContain(
      "Condition reference '$gate.output.route' resolved to an object"
    );
    expect(
      events.some(
        event =>
          event.step_name === 'review__entry' && event.event_type === 'node_skipped_prior_success'
      )
    ).toBe(false);
  });

  it('emits namespaced step_names and resolves $inc.output to the child terminal node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-run-id', { workflow_name: 'inc-parent' });

    const terminalOutput = await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes() },
        workflowRun,
      })
    );

    const events = eventList(mockDeps);
    const completedStepNames = events
      .filter(e => e.event_type === 'node_completed')
      .map(e => e.step_name);
    // Included nodes surface as ordinary namespaced top-level nodes in the event log.
    expect(completedStepNames).toContain('inc__a');
    expect(completedStepNames).toContain('inc__b');
    expect(completedStepNames).toContain('consumer');
    // No include node ever reached the executor.
    expect(events.every(e => e.step_name !== 'inc')).toBe(true);

    // $inc.output was rewritten to the child terminal ($inc__b.output = "BBB"), so the
    // run's terminal output (consumer, the sole sink) carries it.
    expect(terminalOutput).toContain('BBB');
  });

  it('resume skips a completed namespaced node and re-runs the rest', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-resume-id', { workflow_name: 'inc-parent' });

    // Prior run completed the namespaced entry node inc__a.
    const prior = new Map([['inc__a', { output: 'AAA' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes() },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = eventList(mockDeps);
    // inc__a skipped as prior-success (its namespaced id matched the persisted map).
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(true);
    // Downstream namespaced node + consumer still executed.
    const completed = events.filter(e => e.event_type === 'node_completed').map(e => e.step_name);
    expect(completed).toContain('inc__b');
    expect(completed).toContain('consumer');
    expect(completed).not.toContain('inc__a');
  });

  it('always_run on an included node re-executes it on resume', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('inc-always-id', { workflow_name: 'inc-parent' });

    const prior = new Map([['inc__a', { output: 'AAA' }]]);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-inc',
        cwd: testDir,
        workflow: { name: 'inc-parent', nodes: expandedParentNodes(true) },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = eventList(mockDeps);
    // always_run survived inlining: inc__a is force-reset (re-executed), not skipped.
    expect(
      events.some(e => e.event_type === 'node_always_run_reset' && e.step_name === 'inc__a')
    ).toBe(true);
    expect(
      events.some(e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__a')
    ).toBe(false);
    expect(events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__a')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// "A workflow runs as authored" (#1764) — the composition invariant, measured.
//
// A workflow's node-affecting configuration is collapsed onto its own nodes at
// expansion and the workflow-level layer is removed, so a composed workflow resolves
// exactly what it would resolve standalone. These tests observe the SAME seat every
// other option test uses — the `sendQuery(prompt, cwd, resume, options)` call — and
// compare a block run standalone against the same block run inside a parent that
// declares different values.
//
// Two pass conditions per case, both required:
//   INVARIANT       composed === standalone
//   REGRESSION      raw standalone === collapsed standalone (nothing shipped moves)
// The invariant alone would pass a collapse bug that shifted BOTH sides equally.
// ---------------------------------------------------------------------------
describe('executeDagWorkflow -- a workflow runs as authored, standalone or composed', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-collapse-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  /** Per-node configuration as the provider actually received it. */
  interface EffectiveConfig {
    provider: string;
    model: unknown;
    effort: unknown;
    sandbox: unknown;
    betas: unknown;
    fallbackModel: unknown;
  }

  function wfDef(name: string, nodes: unknown[], workflowLevel: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...workflowLevel,
    };
  }

  const collapseConfig: WorkflowConfig & { assistant: string } = {
    assistant: 'claude',
    assistants: { claude: { model: 'claude-default' }, codex: { model: 'codex-default' } },
    commands: {},
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };

  /**
   * Run one workflow and return each node's effective configuration, keyed by the node's
   * id with any include namespace stripped — so a block's `scope` node is comparable
   * whether it ran standalone or as `blk__scope`.
   *
   * The workflow-level provider/model/preset derivation mirrors executor.ts (the ~15
   * lines above its `executeDagWorkflow` call). Every variant is scored through the same
   * mirror, so a mirror error cancels out instead of biasing one side.
   */
  async function effectiveConfigs(
    defs: readonly WorkflowDefinition[],
    runName: string,
    options: { expand?: boolean; profileProvider?: string; tiers?: RawTiersConfig } = {}
  ): Promise<Map<string, EffectiveConfig>> {
    let workflow: TestWorkflowDefinition;
    if (options.expand === false) {
      workflow = defs.find(d => d.name === runName)!;
    } else {
      const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
      expect(errors).toEqual([]);
      workflow = workflows.get(runName)!;
    }

    const aiProfile = buildAiProfile(options.profileProvider ?? collapseConfig.assistant, {
      ...(options.tiers ? { repoTiers: options.tiers } : {}),
    });

    // --- mirror of executor.ts's workflow-level resolution ---
    let workflowProvider: string = workflow.provider ?? collapseConfig.assistant;
    let workflowModel: string | undefined;
    let workflowPreset: ModelAliasPreset | undefined;
    if (workflow.model) {
      const spec = resolveModelSpec(aiProfile, selectModelRef(workflow.model, aiProfile));
      if (isLiteralSpec(spec)) {
        workflowModel = spec.literal;
      } else {
        workflowPreset = spec;
        workflowProvider = spec.provider;
        workflowModel = spec.model;
      }
    }
    workflowModel ??= collapseConfig.assistants[workflowProvider]?.model as string | undefined;
    // --- end mirror ---

    const seen: { provider: string; options: SendQueryOptions }[] = [];
    const deps: WorkflowDeps = {
      providers: providerRegistry,
      store: createMockStore(),
      getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
        (provider): ReturnType<WorkflowDeps['getAgentProvider']> => ({
          sendQuery: mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
            async function* (_prompt, _cwd, _resume, queryOptions) {
              if (!queryOptions) throw new Error('Expected provider query options');
              seen.push({ provider, options: queryOptions });
              yield { type: 'agent_message_chunk', text: 'ok' };
              yield { type: 'result', sessionId: `sid-${String(seen.length)}` };
              yield { type: 'settled' };
            }
          ),
          checkCredential: async () => ({
            state: 'not_checked' as const,
            source: 'native' as const,
          }),
          getType: (): string => provider,
          getCapabilities: provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
        })
      ),
      loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => collapseConfig),
    };

    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-collapse',
        cwd: testDir,
        workflow: ready(workflow),
        workflowRun: makeWorkflowRun(`collapse-${runName}`, { workflow_name: runName }),
        workflowProvider,
        workflowModel,
        config: collapseConfig,
        aiProfile,
        workflowPreset,
      })
    );

    const result = new Map<string, EffectiveConfig>();
    for (const { provider, options: queryOptions } of seen) {
      const nodeConfig = queryOptions.nodeConfig;
      if (!nodeConfig) throw new Error('Expected workflow node configuration');
      const rawId = String(nodeConfig.nodeId);
      const id = rawId.includes('__') ? rawId.slice(rawId.lastIndexOf('__') + 2) : rawId;
      result.set(id, {
        provider,
        model: queryOptions.model,
        effort: nodeConfig.effort,
        sandbox: nodeConfig.sandbox,
        betas: nodeConfig.betas,
        fallbackModel: nodeConfig.fallbackModel,
      });
    }
    return result;
  }

  /** The block under test: one node that declares nothing, one that overrides provider. */
  function richBlock(): WorkflowDefinition {
    return wfDef(
      'blk',
      [
        { id: 'scope', prompt: 'scope it' },
        { id: 'impl', prompt: 'implement', depends_on: ['scope'], provider: 'claude' },
      ],
      {
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        sandbox: { enabled: true },
        fallbackModel: 'gpt-5-mini',
      }
    );
  }

  it('AC1 — a configured block resolves identically composed and standalone', async () => {
    const block = richBlock();
    const parent = wfDef(
      'parent',
      [
        { id: 'setup', prompt: 'set up' },
        { id: 'review', include: 'blk', depends_on: ['setup'] },
      ],
      { provider: 'claude', model: 'claude-parent', effort: 'low' }
    );

    const standalone = await effectiveConfigs([block], 'blk');
    const composed = await effectiveConfigs([block, parent], 'parent');

    // INVARIANT: every node of the block resolved the same way in both runs.
    for (const id of ['scope', 'impl']) {
      expect(composed.get(id), `node '${id}' composed`).toEqual(standalone.get(id)!);
    }
    // The block really did declare something different from its parent — without this
    // the invariant could hold because everything collapsed to one provider.
    expect(standalone.get('scope')!.provider).toBe('codex');
    expect(standalone.get('scope')!.effort).toBe('high');
    // The parent's own node keeps the parent's configuration.
    expect(composed.get('setup')!.provider).toBe('claude');
    expect(composed.get('setup')!.effort).toBe('low');
  });

  it('REGRESSION — collapsing does not move a standalone run', async () => {
    const block = richBlock();
    const raw = await effectiveConfigs([block], 'blk', { expand: false });
    const collapsed = await effectiveConfigs([block], 'blk');
    expect(collapsed).toEqual(raw);
  });

  it('AC2 — a block declaring NOTHING resolves from config, not from the parent', async () => {
    // A bare include block, and the case naive push-down gets wrong: with
    // nothing of its own to push, the block's nodes would still inherit the parent's
    // workflow-level values unless that layer is REMOVED.
    const bare = wfDef('bare-blk', [{ id: 'work', prompt: 'work' }]);
    const parent = wfDef('parent', [{ id: 'inc', include: 'bare-blk' }], {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    const standalone = await effectiveConfigs([bare], 'bare-blk');
    const composed = await effectiveConfigs([bare, parent], 'parent');

    expect(composed.get('work')).toEqual(standalone.get('work')!);
    expect(composed.get('work')!.provider).toBe('claude'); // config.assistant
    expect(composed.get('work')!.model).toBe('claude-default');
    expect(composed.get('work')!.effort).toBeUndefined();
  });

  it('AC3 — three providers resolve independently in one run', async () => {
    const piBlock = wfDef('pi-blk', [{ id: 'run', prompt: 'pi work' }], { provider: 'pi' });
    const codexBlock = wfDef('codex-blk', [{ id: 'run', prompt: 'codex work' }], {
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    const parent = wfDef(
      'parent',
      [
        { id: 'own', prompt: 'parent work' },
        { id: 'a', include: 'pi-blk', depends_on: ['own'] },
        { id: 'b', include: 'codex-blk', depends_on: ['a'] },
      ],
      { provider: 'claude' }
    );

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['pi-blk', piBlock],
        ['codex-blk', codexBlock],
        ['parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    const expanded = workflows.get('parent')!;
    const byId = new Map(expanded.nodes.map(n => [n.id, n as DagNode]));
    expect(byId.get('own')?.provider).toBe('claude');
    expect(byId.get('a__run')?.provider).toBe('pi');
    expect(byId.get('b__run')?.provider).toBe('codex');
    expect(byId.get('b__run')?.model).toBe('gpt-5.6-sol');
  });

  it('AC3 — a tier keyword reproduces through the collapse', async () => {
    const tiers = {
      large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' as const },
    };
    const block = wfDef('tier-blk', [{ id: 'work', prompt: 'work' }], { model: 'large' });
    const parent = wfDef('parent', [{ id: 'inc', include: 'tier-blk' }], {
      provider: 'claude',
      model: 'claude-parent',
    });

    const standalone = await effectiveConfigs([block], 'tier-blk', { tiers });
    const composed = await effectiveConfigs([block, parent], 'parent', { tiers });

    expect(composed.get('work')).toEqual(standalone.get('work')!);
    // The tier resolved, rather than the raw keyword reaching the SDK.
    expect(standalone.get('work')!.provider).toBe('codex');
    expect(standalone.get('work')!.model).toBe('gpt-5.6-sol');
    expect(standalone.get('work')!.effort).toBe('xhigh');
  });

  it('AC1 — the collapse reaches loop_group bodies and depth-2 nesting', async () => {
    const inner = wfDef(
      'inner',
      [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 1,
            nodes: [{ id: 'body', prompt: 'body work' }],
          },
        },
      ],
      { provider: 'codex', model: 'gpt-5.6-sol' }
    );
    const mid = wfDef('mid', [{ id: 'in', include: 'inner' }], { provider: 'pi' });
    const top = wfDef('top', [{ id: 'm', include: 'mid' }], { provider: 'claude' });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['inner', inner],
        ['mid', mid],
        ['top', top],
      ])
    );
    expect(errors).toEqual([]);
    const group = workflows.get('top')!.nodes.find(n => n.id === 'm__in__group')! as LoopGroupNode;
    expect(group.provider).toBe('codex');
    // The body node carries the INNER file's provider, not mid's or top's.
    const body = group.loop_group?.nodes[0] as DagNode | undefined;
    expect(body?.provider).toBe('codex');
    expect(body?.model).toBe('gpt-5.6-sol');
  });
});

// ---------------------------------------------------------------------------
// Composition boundaries at run time (#1764):
//   - a composed workflow's entry node starts a session as coldly as it would standalone
//   - a composed workflow's declared inputs reach its shell nodes, named script included
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- composed-workflow run-time boundaries', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-comp-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...extra,
    };
  }

  /** The `node_output` a completed node persisted, read from its node_completed event. */
  function nodeOutputOf(store: MockWorkflowStore, stepName: string): string | undefined {
    const event = store.createWorkflowEvent.mock.calls
      .map(c => c[0])
      .find(e => e.event_type === 'node_completed' && e.step_name === stepName);
    return (event?.data as { node_output?: string } | undefined)?.node_output;
  }

  async function runExpanded(
    defs: readonly WorkflowDefinition[],
    runName: string,
    deps = createMockDeps()
  ): Promise<void> {
    const { workflows, errors } = expandWorkflowIncludes(new Map(defs.map(d => [d.name, d])));
    expect(errors).toEqual([]);
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow: ready(workflows.get(runName)!),
        workflowRun: makeWorkflowRun(`comp-${runName}`, { workflow_name: runName }),
      })
    );
  }

  for (const kind of ['loop', 'loop_group'] as const) {
    for (const composed of [false, true]) {
      it(`#4164: ${kind}.until_bash receives ${composed ? 'composed' : 'run'} inputs`, async () => {
        const predicate = `[ "$INPUTS_TARGET" = "done" ] && [ "$INPUTS_PAYLOAD" = '$(touch injected); "quoted"' ] && [ "$ARGUMENTS" = "real-args" ]`;
        const block = buildWf(
          'input-loop',
          [
            kind === 'loop'
              ? { id: 'poll', loop: { prompt: 'work', until_bash: predicate, max_iterations: 2 } }
              : {
                  id: 'poll',
                  loop_group: {
                    until_bash: predicate,
                    max_iterations: 2,
                    nodes: [{ id: 'work', prompt: 'work' }],
                  },
                },
          ],
          { inputs: { target: { required: true }, payload: { required: true } } }
        );
        const parent = buildWf('input-parent', [
          {
            id: 'inc',
            include: 'input-loop',
            with: { target: 'done', payload: '$(touch injected); "quoted"' },
          },
        ]);
        const { workflows, errors } = expandWorkflowIncludes(
          new Map([
            ['input-loop', block],
            ['input-parent', parent],
          ])
        );
        expect(errors).toEqual([]);
        const store = createMockStore();
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflow: ready(composed ? workflows.get('input-parent')! : block),
            workflowRun: makeWorkflowRun('input-loop-run', {
              user_message: 'real-args',
              metadata: {
                inputs: {
                  target: composed ? 'wrong-run-value' : 'done',
                  payload: '$(touch injected); "quoted"',
                },
              },
            }),
            config: {
              ...minimalConfig,
              envVars: { INPUTS_TARGET: 'wrong-project-value', ARGUMENTS: 'hijacked' },
            },
          })
        );
        expect(mockSendQueryDag.mock.calls.length).toBe(1);
        expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
        expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
      });
    }
  }

  it("#4164: an included shell's $INPUTS macro reads the input as data", async () => {
    const payload = '$(touch injected); "quoted"';
    const block = buildWf(
      'macro-blk',
      [
        { id: 'echo', bash: "printf '%s' $INPUTS.payload" },
        {
          id: 'poll',
          depends_on: ['echo'],
          loop: { prompt: 'work', until_bash: '[ $INPUTS.target = done ]', max_iterations: 2 },
        },
      ],
      { inputs: { target: { required: true }, payload: { required: true } } }
    );
    const parent = buildWf('macro-parent', [
      { id: 'inc', include: 'macro-blk', with: { target: 'done', payload } },
    ]);
    const store = createMockStore();

    await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

    expect(nodeOutputOf(store, 'inc__echo')).toBe(payload);
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(store.completeWorkflowRun.mock.calls.length).toBe(1);
    expect(await Bun.file(join(testDir, 'injected')).exists()).toBe(false);
  });

  it("a script node's own with: binding beats a colliding composed and run input", async () => {
    const block = buildWf(
      'collide-blk',
      [
        {
          id: 'emit',
          runtime: 'bun',
          script: 'console.log(process.env.INPUTS_TARGET);',
          with: { target: 'local' },
        },
      ],
      { inputs: { target: { required: true } } }
    );
    const parent = buildWf('collide-parent', [
      { id: 'inc', include: 'collide-blk', with: { target: 'composed' } },
    ]);
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['collide-blk', block],
        ['collide-parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: ready(workflows.get('collide-parent')!),
        workflowRun: makeWorkflowRun('collide-run', { metadata: { inputs: { target: 'run' } } }),
      })
    );

    expect(nodeOutputOf(store, 'inc__emit')).toBe('local');
  });

  it('AC7 — a composed block entry starts a fresh session even after a same-provider node', async () => {
    const block = buildWf('sess-blk', [
      { id: 'first', prompt: 'block first' },
      { id: 'second', prompt: 'block second', depends_on: ['first'] },
    ]);
    const parent = buildWf('sess-parent', [
      { id: 'lead', prompt: 'parent lead' },
      { id: 'inc', include: 'sess-blk', depends_on: ['lead'] },
    ]);

    await runExpanded([block, parent], 'sess-parent');

    expect(mockSendQueryDag.mock.calls.length).toBe(3);
    // lead: nothing before it.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // inc__first: the block's entry — cold, exactly as it would be standalone, even
    // though `lead` just produced a resumable session on the same provider.
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
    // inc__second: inside the block, so the block's own thread continues.
    expect(mockSendQueryDag.mock.calls[2][2]).toBe('session-1');
  });

  it("AC7 — context: 'shared' on the entry node opts back into the parent's thread", async () => {
    const block = buildWf('sess-blk2', [{ id: 'first', prompt: 'block first', context: 'shared' }]);
    const parent = buildWf('sess-parent2', [
      { id: 'lead', prompt: 'parent lead' },
      { id: 'inc', include: 'sess-blk2', depends_on: ['lead'] },
    ]);

    await runExpanded([block, parent], 'sess-parent2');

    expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
  });

  it("AC8 — a composed block's declared inputs reach a NAMED script as INPUTS_* env vars", async () => {
    // The acceptance case the task exists for: a named script file is opaque, so the
    // load-time `$INPUTS` macro can never reach inside it. Env delivery is its only channel.
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, 'report.ts'),
      'console.log(`plan=${process.env.INPUTS_PLAN}|base=${process.env.INPUTS_BASE_BRANCH}`);\n'
    );

    const block = buildWf('script-blk', [{ id: 'run', script: 'report', runtime: 'bun' }], {
      inputs: { plan: { required: true }, 'base-branch': { default: 'dev' } },
    });
    const parent = buildWf('script-parent', [
      { id: 'inc', include: 'script-blk', with: { plan: 'ship it' } },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'script-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    // A hyphenated input name arrives UPPER_SNAKE; the default fills the unsupplied one.
    expect(output).toBe('plan=ship it|base=dev');
  });

  it('AC8 — the stamp survives two nesting levels and keeps the INNER names', async () => {
    const inner = buildWf('inner-blk', [{ id: 'run', bash: 'echo "[$INPUTS_PLAN]"' }], {
      inputs: { plan: { required: true } },
    });
    const mid = buildWf(
      'mid-blk',
      [{ id: 'in', include: 'inner-blk', with: { plan: '$INPUTS.topic' } }],
      {
        inputs: { topic: { required: true } },
      }
    );
    const top = buildWf('nest-parent', [
      { id: 'm', include: 'mid-blk', with: { topic: 'two levels' } },
    ]);

    const store = createMockStore();
    await runExpanded([inner, mid, top], 'nest-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'm__in__run');
    expect(output).toBe('[two levels]');
  });

  it('AC8 — a composed input value resolving a node ref is delivered, not shell-spliced', async () => {
    const block = buildWf('ref-blk', [{ id: 'run', bash: 'echo "<$INPUTS_PAYLOAD>"' }], {
      inputs: { payload: { required: true } },
    });
    const parent = buildWf('ref-parent', [
      { id: 'produce', bash: 'printf "%s" "a b; echo pwned"' },
      {
        id: 'inc',
        include: 'ref-blk',
        depends_on: ['produce'],
        with: { payload: '$produce.output' },
      },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'ref-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    // Delivered verbatim through the env bag — the `;` never reaches the shell as syntax.
    expect(output).toBe('<a b; echo pwned>');
  });

  it('AC8 — a project env var cannot shadow a composed input, and reserved keys still win', async () => {
    const block = buildWf('env-blk', [{ id: 'run', bash: 'echo "$INPUTS_PLAN|$ARGUMENTS"' }], {
      inputs: { plan: { required: true } },
    });
    const parent = buildWf('env-parent', [
      { id: 'inc', include: 'env-blk', with: { plan: 'from-with' } },
    ]);

    const store = createMockStore();
    const deps = createMockDeps(store);
    deps.loadConfig = mock<WorkflowDeps['loadConfig']>(async _cwd => ({
      ...minimalConfig,
      envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
    }));

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['env-blk', block],
        ['env-parent', parent],
      ])
    );
    expect(errors).toEqual([]);
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow: ready(workflows.get('env-parent')!),
        workflowRun: makeWorkflowRun('comp-env', {
          workflow_name: 'env-parent',
          user_message: 'real-args',
        }),
        config: {
          ...minimalConfig,
          envVars: { INPUTS_PLAN: 'from-project-env', ARGUMENTS: 'hijacked' },
        },
      })
    );

    const output = nodeOutputOf(store, 'inc__run');
    expect(output).toBe('from-with|real-args');
  });

  it('AC8 — the load-time macro still substitutes $INPUTS into an inline bash body', async () => {
    const block = buildWf('macro-blk', [{ id: 'run', bash: 'echo "$INPUTS.plan"' }], {
      inputs: { plan: { required: true } },
    });
    const parent = buildWf('macro-parent', [
      { id: 'inc', include: 'macro-blk', with: { plan: 'inline-value' } },
    ]);

    const store = createMockStore();
    await runExpanded([block, parent], 'macro-parent', createMockDeps(store));

    const output = nodeOutputOf(store, 'inc__run');
    expect(output).toBe('inline-value');
  });
});

// ---------------------------------------------------------------------------
// Governance and resume across the config collapse (#1764 Task 11).
//
// These assert EXISTING behaviour that the collapse must not disturb. A failure here is
// a finding about the change, not a licence to move the assertion.
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- composition governance survives the collapse', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-gov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'response' };
      yield { type: 'result', sessionId: 'session-1' };
    });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  function buildWf(name: string, nodes: unknown[], extra: object = {}): WorkflowDefinition {
    // Each node is already parsed (flat -> resolved) below — do NOT also route the
    // whole object through workflowDefinitionSchema.parse(): its `nodes` field
    // re-validates against the FLAT authored schema, which an already-resolved
    // DagNode (kind/source) no longer satisfies (#2486).
    return {
      name,
      description: name,
      nodes: nodes.map(n => dagNodeSchema.parse(n)),
      ...extra,
    };
  }

  it('AC13 — a run paused BEFORE the collapse resumes with collapsed config afterwards', async () => {
    // The snapshot is keyed by persisted `step_name`. The collapse rewrites node PAYLOADS,
    // never node IDS, so a map written by an older build still matches — and the nodes that
    // do re-run pick up the block's own provider rather than the parent's.
    const block = buildWf(
      'resume-blk',
      [
        { id: 'first', prompt: 'first' },
        { id: 'second', prompt: 'second', depends_on: ['first'] },
      ],
      { provider: 'codex', model: 'gpt-5.6-sol' }
    );
    const parent = buildWf('resume-parent', [{ id: 'inc', include: 'resume-blk' }], {
      provider: 'claude',
    });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['resume-blk', block],
        ['resume-parent', parent],
      ])
    );
    expect(errors).toEqual([]);

    // Written by a build that predates this change: bare namespaced ids, no payload.
    const prior = new Map([['inc__first', { output: 'FIRST OUTPUT' }]]);

    const store = createMockStore();
    const seen: string[] = [];
    const deps: WorkflowDeps = {
      providers: providerRegistry,
      store,
      getAgentProvider: mock<WorkflowDeps['getAgentProvider']>(
        (provider): ReturnType<WorkflowDeps['getAgentProvider']> => {
          seen.push(provider);
          return settlingProvider({
            sendQuery: mockSendQueryDag,
            checkCredential: async () => ({
              state: 'not_checked' as const,
              source: 'native' as const,
            }),
            getType: (): string => provider,
            getCapabilities: provider === 'codex' ? mockCodexCapabilities : mockClaudeCapabilities,
          });
        }
      ),
      loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => minimalConfig),
    };

    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-gov',
        cwd: testDir,
        workflow: ready(workflows.get('resume-parent')!),
        workflowRun: makeWorkflowRun('gov-resume', { workflow_name: 'resume-parent' }),
        priorCompletedNodes: prior,
      })
    );

    const events = store.createWorkflowEvent.mock.calls.map(call => call[0]);
    expect(
      events.some(
        e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'inc__first'
      )
    ).toBe(true);
    expect(
      events.some(e => e.event_type === 'node_completed' && e.step_name === 'inc__second')
    ).toBe(true);
    // The one node that re-ran used the BLOCK's provider, not the parent's.
    expect(seen).toEqual(['codex']);
  });

  it('AC12 — a composed approval pauses the PARENT run, with no child run id', async () => {
    const block = buildWf('gate-blk', [
      { id: 'plan', prompt: 'plan' },
      {
        id: 'gate',
        approval: { message: 'Approve?', capture_response: false },
        depends_on: ['plan'],
      },
    ]);
    const parent = buildWf('gate-parent', [{ id: 'inc', include: 'gate-blk' }], {
      interactive: true,
    });

    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['gate-blk', block],
        ['gate-parent', parent],
      ])
    );
    expect(errors).toEqual([]);

    const store = createMockStore();
    const runId = 'gov-gate-run';
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-gov',
        cwd: testDir,
        workflow: ready(workflows.get('gate-parent')!),
        workflowRun: makeWorkflowRun(runId, { workflow_name: 'gate-parent' }),
      })
    );

    const pauseCalls = store.pauseWorkflowRun.mock.calls;
    expect(pauseCalls.length).toBe(1);
    // One addressable run: the composition pauses the run that composed it. A `workflow:`
    // node would instead pause a second row the human approves by its own id.
    expect(pauseCalls[0][0]).toBe(runId);
    const ctx = pauseCalls[0][1];
    expect(ctx).toMatchObject({ type: 'approval', nodeId: 'inc__gate' });
    expect('childRunId' in ctx).toBe(false);
    expect(store.createWorkflowRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2453 — the composed proof. One run carries a result contract across every
// surface the earlier phases delivered: a `script:` node certifies its own stdout,
// the result points at a file instead of carrying it, an `include:` alias exposes
// that contract to the parent, `fan_out.items` consumes one of its declared fields
// as a real array, each instance certifies its own per-item result, and a cold
// resume reproduces all of it. This is the executable twin of the reference fixture
// `.archon/workflows/test-workflows/e2e-contract-fanout.yaml`.
// ---------------------------------------------------------------------------

describe('a result contract survives the whole composed path (#2453)', () => {
  let testDir: string;
  let outputRoot: string;
  let runArtifactsDir: string;
  const originalArtifactHome = mockArtifactHome;

  const RUN_ID = 'composed-contract-run';
  const UNITS = [
    { id: 'unit-a', title: 'first unit of work' },
    { id: 'unit-b', title: 'second unit of work' },
  ];
  const POINTER = { type: 'archon_artifact', run_id: RUN_ID, path: 'plan.md' };
  const PLAN_RESULT = { units: UNITS, plan: POINTER };
  // Each instance points at the per-item file it wrote. Instances run INSIDE this run,
  // so every pointer names this run — the only run a producer may name.
  const AGGREGATE = UNITS.map(unit => ({
    id: unit.id,
    ok: true,
    report: { type: 'archon_artifact', run_id: RUN_ID, path: `units/${unit.id}.md` },
  }));

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-composed-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    outputRoot = join(testDir, 'workspaces', '_cwd', 'proj');
    runArtifactsDir = join(outputRoot, 'artifacts', 'runs', RUN_ID);
    await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
    // The run's own artifacts directory, which the plan script writes into and its
    // pointer then names — the same directory the pointer gate resolves independently
    // from the run's persisted `output_root`.
    await mkdir(runArtifactsDir, { recursive: true });
    setMockArtifactHome(testDir);
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));

    // The block whose `returns:` node certifies the workflow's result. A deterministic
    // producer (Phase 2) writing the large artifact and returning a small value that
    // points at it (Phase 4).
    await writeFile(
      join(testDir, '.archon', 'workflows', 'plan-block.yaml'),
      `
name: plan-block
description: certifies a result carrying a unit list and a pointer at the full plan
mutates_checkout: false
returns: build
nodes:
  - id: build
    runtime: bun
    script: |
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'plan.md'), '# the full plan');
      console.log(
        JSON.stringify({
          units: ${JSON.stringify(UNITS)},
          plan: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'plan.md' },
        })
      );
    output_format:
      type: object
      properties:
        units:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              title: { type: string }
            required: [id, title]
        plan:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [units, plan]
`
    );

    // The per-item body. It owns its own contract, so the aggregate is an array of
    // validated objects rather than an array of prose — each pointing at a per-item file
    // the instance wrote, proved at that producer against the run it runs in.
    await writeFile(
      join(testDir, '.archon', 'workflows', 'unit-block.yaml'),
      `
name: unit-block
description: one instance per unit, certifying its own per-item result
mutates_checkout: false
inputs:
  unit:
    required: true
returns: check
nodes:
  - id: check
    runtime: bun
    script: |
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const unit = JSON.parse(process.env.INPUTS_UNIT);
      mkdirSync(join(process.env.ARTIFACTS_DIR, 'units'), { recursive: true });
      writeFileSync(join(process.env.ARTIFACTS_DIR, 'units', unit.id + '.md'), '# ' + unit.title);
      console.log(JSON.stringify({
        id: unit.id,
        ok: typeof unit.title === 'string',
        report: { type: 'archon_artifact', run_id: process.env.WORKFLOW_ID, path: 'units/' + unit.id + '.md' },
      }));
    output_format:
      type: object
      properties:
        id: { type: string }
        ok: { type: boolean }
        report:
          type: object
          properties:
            type: { const: archon_artifact }
            run_id: { type: string }
            path: { type: string }
          required: [type, run_id, path]
      required: [id, ok, report]
`
    );

    await writeFile(
      join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
      `
name: composed-parent
description: reads the included block's contract and fans a composed body out over it
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.units"
      as: unit
      max_parallel: 2
      join: all_success
  - id: report
    prompt: "aggregate=$work.output pointer=$plan.output.plan"
    depends_on: [work]
`
    );
  });

  afterEach(async () => {
    setMockArtifactHome(originalArtifactHome);
    await removeTempTree(testDir);
  });

  /** The flattened parent, exactly as discovery hands it to the executor. */
  async function expandedParent(): Promise<ResolvedWorkflow> {
    const discovered = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(discovered.errors).toEqual([]);
    const parent = discovered.workflows.find(w => w.workflow.name === 'composed-parent');
    if (!parent) throw new Error('composed-parent was not discovered');
    return parent.workflow;
  }

  async function runComposed(
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<{ events: PersistedEvent[]; prompts: string[] }> {
    const prompts: string[] = [];
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      prompts.push(prompt);
      yield { type: 'agent_message_chunk', text: 'reported' };
      yield { type: 'result', sessionId: 'sid-report' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2453-composed',
        cwd: testDir,
        workflow: await expandedParent(),
        workflowRun: makeWorkflowRun(RUN_ID, { output_root: outputRoot }),
        artifactsDir: runArtifactsDir,
        priorCompletedNodes,
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    return { events, prompts };
  }

  const completionOf = (events: PersistedEvent[], step: string): PersistedEvent | undefined =>
    events.find(e => e.event_type === 'node_completed' && e.step_name === step);

  it('certifies a script result, exposes it through an include alias, and fans out over a declared field', async () => {
    const { events, prompts } = await runComposed();

    // The alias resolved to the included block's selected node, which certified its
    // own stdout: canonical text plus the logical value, pointer intact.
    const plan = completionOf(events, 'plan__build');
    expect(plan?.data?.structured_output).toEqual(PLAN_RESULT);
    expect(String(plan?.data?.node_output)).toBe(JSON.stringify(PLAN_RESULT));

    // `fan_out.items` read the DECLARED `units` field as a real array — one instance
    // per element, each certifying its own result.
    const instances = events.filter(
      e =>
        e.event_type === 'node_completed' &&
        (e.step_name ?? '').startsWith(`${composeScope('work')}__`) &&
        (e.step_name ?? '').endsWith('__check')
    );
    expect(instances).toHaveLength(2);
    expect(instances.map(e => e.data?.structured_output)).toEqual(
      expect.arrayContaining(AGGREGATE)
    );

    // The wrapper aggregate is the ordered logical array, serialized exactly once, and
    // it relays each instance's pointer unrewritten: one per item, naming this run and
    // the relative path the instance wrote — a real file under this run's artifacts.
    const wrapper = completionOf(events, 'work');
    expect(wrapper?.data?.structured_output).toEqual(AGGREGATE);
    expect(JSON.parse(String(wrapper?.data?.node_output))).toEqual(AGGREGATE);
    for (const unit of UNITS) {
      expect(existsSync(join(runArtifactsDir, 'units', `${unit.id}.md`))).toBe(true);
    }

    // Downstream, the aggregate is one JSON array and the pointer is still a run id
    // plus a relative path — never expanded, never replaced by the file's contents.
    expect(prompts).toEqual([
      `aggregate=${JSON.stringify(AGGREGATE)} pointer=${JSON.stringify(POINTER)}`,
    ]);
  });

  it('reproduces the same downstream view after a cold resume', async () => {
    const fresh = await runComposed();
    const plan = completionOf(fresh.events, 'plan__build');

    // Only what an event row carries: the text and its logical sibling. Field
    // authorization is re-derived from the loaded block, which is what keeps
    // `$plan.output.units` a declared array rather than a lenient text parse.
    const resumed = await runComposed(
      new Map<string, PersistedNodeOutput>([
        [
          'plan__build',
          {
            output: String(plan?.data?.node_output),
            structuredOutput: plan?.data?.structured_output,
          },
        ],
      ])
    );

    expect(resumed.prompts).toEqual(fresh.prompts);
    expect(completionOf(resumed.events, 'work')?.data?.structured_output).toEqual(AGGREGATE);
    // The producer was not re-run; its contract rode the prior-success re-emit forward.
    expect(completionOf(resumed.events, 'plan__build')).toBeUndefined();
    const replayed = resumed.events.find(
      e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'plan__build'
    );
    expect(replayed?.data?.structured_output).toEqual(PLAN_RESULT);
  });

  it('rejects at load a fan-out that reads a field the contract never declared', async () => {
    await writeFile(
      join(testDir, '.archon', 'workflows', 'composed-parent.yaml'),
      `
name: composed-parent
description: fans out over a field the included block does not declare
mutates_checkout: false
nodes:
  - id: plan
    include: plan-block
  - id: work
    include: unit-block
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      as: unit
      max_parallel: 2
      join: all_success
`
    );

    const discovered = await discoverWorkflows(testDir, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    // The error names the include alias the author wrote, not the flattened sink id.
    expect(discovered.errors.map(e => e.error)).toEqual([
      expect.stringContaining("'$plan.output.tasks' references field 'tasks'"),
    ]);
    expect(discovered.errors[0]?.error).not.toContain('plan__build');
  });
});
