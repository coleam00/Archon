import { expect, it, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  resolveTestWorkflow,
} from '../test-utils';
import { executeDagWorkflow } from '../../dag-executor';
import { checkComposedBlockBoundaries } from '../trigger-rule';
import { resolvedBodyNodes } from '../../graph-plan';
import { loopBodyScope } from '../loop-scope';
import { dryRunWorkflow } from '../../dry-run';
import { getWorkflowEventEmitter } from '../../event-emitter';
import type { DagNode, NodeOutput, SkipCause } from '../../schemas';
import { skipCauseSchema } from '../../schemas';
import { expandWorkflowIncludes } from '../../include-expander';
import type { IWorkflowStore } from '../../store';
import type { setupIncludeExpansionTests } from './composition-include-resume';

export function registerResultContractTests() {
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
      const metadata = (store.completeWorkflowRun as Mock<IWorkflowStore['completeWorkflowRun']>)
        .mock.calls[0]?.[2];
      expect(metadata).toMatchObject({
        summary_declared_output_paths: [['green'], ['note'], ['note', 'text']],
        summary_declared_fields: ['green', 'note'],
      });
    } finally {
      await removeTempTree(testDir);
    }
  });
}

export function registerIncludeGateTests(fixture: ReturnType<typeof setupIncludeExpansionTests>) {
  for (const value of ['go', '']) {
    it(`shares loop scope across include entries and descendants for previous value '${value}'`, async () => {
      const when = `$LOOP_PREV.work.output == '${value}'`;
      const workflow = fixture.loopGatedWorkflow(when);
      const { events } = await fixture.executeExpanded([...workflow.nodes], `loop-gated-${value}`);
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: fixture.testDir,
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
      const leaf = fixture.buildWf('leaf', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const block = fixture.buildWf('nested-block', [
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
      const parent = fixture.buildWf('nested-parent', [
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
      const outer = workflow.nodes[0];
      if (outer?.kind !== 'loop_group') throw new Error('expected outer loop group');
      const outerBody = resolvedBodyNodes(outer.loop_group);
      const inner = outerBody.find(node => node.id === 'inc__inner');
      if (inner?.kind !== 'loop_group') throw new Error('expected inner loop group');
      const innerBody = resolvedBodyNodes(inner.loop_group);
      const outerPrevious = new Map<string, NodeOutput>([
        ['work', { state: 'completed', output: value }],
      ]);
      const innerPrevious = new Map<string, NodeOutput>([
        ['work', { state: 'completed', output: 'wrong scope' }],
        ['innerWork', { state: 'completed', output: 'inner' }],
      ]);
      const loopBodyScopes = [
        loopBodyScope(outerBody, outerPrevious, '', fixture.testDir),
        loopBodyScope(innerBody, innerPrevious, '', fixture.testDir),
      ];
      const outputs = new Map<string, NodeOutput>([
        ['work', { state: 'completed', output: 'current' }],
        ['innerWork', { state: 'completed', output: 'current' }],
      ]);
      for (const node of innerBody.filter(node => node.id.startsWith('local__'))) {
        const options = { evaluateEntryBoundary: true, loopBodyScopes };
        expect(checkComposedBlockBoundaries(node, outputs, undefined, options)).toEqual({
          decision: 'run',
        });
        outerPrevious.set('work', { state: 'completed', output: 'stop' });
        expect(checkComposedBlockBoundaries(node, outputs, undefined, options)).toEqual({
          decision: 'skip',
          cause: { kind: 'condition', expr: when },
        });
        outerPrevious.set('work', { state: 'completed', output: value });
      }
      const { events } = await fixture.executeExpanded([...workflow.nodes], `nested-${value}`);
      expect(events.filter(e => e.event_type === 'node_failed')).toEqual([]);
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: fixture.testDir,
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

  it.each(['', 'go', 'stop'])(
    'checks cached include entries against their owning previous output %j',
    previous => {
      const when = "$LOOP_PREV.work.output == 'go'";
      const group = fixture.loopGatedWorkflow(when).nodes[0];
      if (group?.kind !== 'loop_group') throw new Error('expected loop group');
      const body = resolvedBodyNodes(group.loop_group);
      const previousOutputs = new Map<string, NodeOutput>(
        previous ? [['work', { state: 'completed', output: previous }]] : []
      );
      const scope = loopBodyScope(body, previousOutputs, '', fixture.testDir);
      // Current output deliberately disagrees with the preceding iteration.
      const outputs = new Map<string, NodeOutput>([
        ['work', { state: 'completed', output: previous === 'go' ? 'stop' : 'go' }],
      ]);
      for (const id of ['inc__entry', 'inc__tail']) {
        const node = body.find(node => node.id === id);
        if (!node) throw new Error(`expected expanded ${id}`);
        expect(
          checkComposedBlockBoundaries(node, outputs, undefined, {
            evaluateEntryBoundary: true,
            loopBodyScopes: [scope],
          })
        ).toEqual(
          previous === 'go'
            ? { decision: 'run' }
            : { decision: 'skip', cause: { kind: 'condition', expr: when } }
        );
      }
    }
  );

  it('rejects a loop reference in an include boundary without loop context', () => {
    const when = "$LOOP_PREV.work.output == 'go'";
    const workflow = fixture.loopGatedWorkflow(when);
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('false-condition'),
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
    const { events } = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('skipped-dependency'),
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
    const conditionRun = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('false-condition'),
      'inc-condition-cause'
    );
    const conditionSkip = conditionRun.events.find(
      event => event.event_type === 'node_skipped' && event.step_name === 'review__required'
    );
    expect(conditionSkip?.data?.cause).toEqual({
      kind: 'condition',
      expr: "$gate.output == 'run'",
    });

    const dependencyRun = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('skipped-dependency'),
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
        ...fixture.buildWf('deliver-block', [
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
      const action = fixture.buildWf('action-block', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'tail', bash: 'echo tail', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const parent = fixture.buildWf('direct-joins', [
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
      const initial = await fixture.executeExpanded(nodes, `direct-joins-${mode}`);
      const resumed = await fixture.executeExpanded(
        nodes,
        `direct-joins-${mode}-resumed`,
        new Map([['pr', { output: 'ready' }]])
      );
      const dryRun = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: fixture.testDir,
        stubs: {
          pr: 'ready',
          'deliver__gate-input': 'ready',
          'flip-ready': 'fallback',
          report: 'fallback',
          action__entry: 'entry',
          action__tail: 'tail',
        },
      });
      const cause: SkipCause = {
        kind: mode === 'failed' ? 'upstream_failed' : 'upstream_skipped',
        origin: 'deliver__gate-validated',
      };
      const runs = [initial, resumed];
      if (mode === 'failed') {
        runs.push(
          await fixture.executeExpanded(
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
      for (const run of runs) fixture.assertJoinProvenance(run, mode, cause);
      for (const id of ['flip-ready', 'action__entry', 'action__tail']) {
        expect(dryRun.trace.find(entry => entry.nodeId === id)).toMatchObject(
          mode === 'failed' ? { state: 'skipped', cause } : { state: 'stubbed' }
        );
      }
    }
  );

  it('recomputes the same skip provenance on resume', async () => {
    const nodes = fixture.expandedGatedParentNodes('skipped-dependency');
    const initial = await fixture.executeExpanded(nodes, 'inc-resume-cause-initial');
    const resumed = await fixture.executeExpanded(
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
        cwd: fixture.testDir,
        workflowRun: makeWorkflowRun('skip-cause-parity'),
        workflow: { name: 'skip-cause-parity', nodes },
      })
    );
    const executorCauses = fixture
      .eventList(mockDeps)
      .filter(event => event.event_type === 'node_skipped')
      .map(event => [event.step_name, skipCauseSchema.parse(event.data?.cause)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    const dryRun = await dryRunWorkflow({
      workflow: resolveTestWorkflow({ name: 'skip-cause-parity', nodes }),
      userMessage: '',
      cwd: fixture.testDir,
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
          cwd: fixture.testDir,
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
    const { events, output } = await fixture.executeExpanded(
      fixture.expandedGatedParentNodes('active'),
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
}
