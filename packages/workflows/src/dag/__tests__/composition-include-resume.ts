import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { createMockDeps, createMockPlatform, dagOptions, makeWorkflowRun } from '../test-utils';
import { executeDagWorkflow } from '../../dag-executor';
import type { DagNode, ResolvedWorkflow, SkipCause, WorkflowDefinition } from '../../schemas';
import { dagNodeSchema } from '../../schemas';
import { expandWorkflowIncludes } from '../../include-expander';
import type { WorkflowDeps } from '../../deps';
import type { PersistedNodeOutput } from '../../store';

export function setupIncludeExpansionTests() {
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

  function assertJoinProvenance(
    run: Awaited<ReturnType<typeof executeExpanded>>,
    mode: 'failed' | 'condition',
    cause: SkipCause
  ): void {
    for (const id of ['deliver__checks', 'deliver__result']) {
      expect(
        run.events.find(event => event.step_name === id && event.event_type === 'node_skipped')
          ?.data?.cause
      ).toEqual(cause);
    }
    for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
      if (mode === 'failed') {
        expect(
          run.events.find(event => event.step_name === id && event.event_type === 'node_skipped')
            ?.data?.cause
        ).toEqual(cause);
        expect(
          run.events.some(event => event.step_name === id && event.event_type === 'node_started')
        ).toBe(false);
      } else {
        expect(
          run.events.some(event => event.step_name === id && event.event_type === 'node_completed')
        ).toBe(true);
      }
    }
    expect(
      run.events.find(
        event => event.step_name === 'report' && event.event_type === 'node_completed'
      )?.data?.node_output
    ).toContain('fallback');
  }
  return {
    get testDir() {
      return testDir;
    },
    buildWf,
    expandedParentNodes,
    expandedGatedParentNodes,
    expandedStructuredGateNodes,
    expandedMultiSinkDependencyNodes,
    expandedMixedEntryTriggerNodes,
    eventList,
    executeExpanded,
    loopGatedWorkflow,
    assertJoinProvenance,
  };
}

export function registerIncludeResumeTests(fixture: ReturnType<typeof setupIncludeExpansionTests>) {
  it('keeps a block inactive when one sink of an included dependency is ineligible', async () => {
    const { events } = await fixture.executeExpanded(
      fixture.expandedMultiSinkDependencyNodes('all_success'),
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedMultiSinkDependencyNodes('one_success'),
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('false-condition', true),
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedMixedEntryTriggerNodes(),
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedStructuredGateNodes(),
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
        cwd: fixture.testDir,
        workflow: { name: 'inc-parent', nodes: fixture.expandedParentNodes() },
        workflowRun,
      })
    );

    const events = fixture.eventList(mockDeps);
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
        cwd: fixture.testDir,
        workflow: { name: 'inc-parent', nodes: fixture.expandedParentNodes() },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = fixture.eventList(mockDeps);
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
        cwd: fixture.testDir,
        workflow: { name: 'inc-parent', nodes: fixture.expandedParentNodes(true) },
        workflowRun,
        priorCompletedNodes: prior,
      })
    );

    const events = fixture.eventList(mockDeps);
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
}
