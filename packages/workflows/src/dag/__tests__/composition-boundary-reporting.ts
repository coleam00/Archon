import { expect, it, spyOn } from 'bun:test';
import { runInputsMetadata } from '../../schemas';
import { skipCauseSchema, nodeSkipReasonSchema } from '../../schemas/node-state';
import { readComposedMeta } from '../../compiled-command';
import { executeDagWorkflow } from '../../dag-executor';
import { dryRunWorkflow, formatDryRunTrace } from '../../dry-run';
import { expandWorkflowIncludes } from '../../include-expander';
import { resolvedBodyNodes } from '../../graph-plan';
import { getLog } from '../log';
import {
  resolveTestWorkflow,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  deliveredMessages,
  makeWorkflowRun,
} from '../test-utils';
import type { setupIncludeExpansionTests } from './composition-include-resume';

export function registerBoundaryReportingTests(
  fixture: ReturnType<typeof setupIncludeExpansionTests>
) {
  it('records and renders the same false include gate for every descendant', async () => {
    const nodes = fixture.expandedGatedParentNodes('false-condition');
    const { events } = await fixture.executeExpanded(nodes, 'false-boundary-rendering');
    const dry = await dryRunWorkflow({
      workflow: resolveTestWorkflow({ name: 'gated-parent', nodes }),
      userMessage: '',
      cwd: fixture.testDir,
      stubs: { gate: 'skip' },
    });
    expect(
      events.filter(e => e.event_type === 'node_skipped' && e.step_name.startsWith('review__'))
    ).toHaveLength(4);
    const skips = events.filter(e => e.event_type === 'node_skipped');
    expect(
      dry.trace
        .filter(e => e.state === 'skipped')
        .map(e => ({ id: e.nodeId, reason: e.reason, cause: e.cause }))
    ).toEqual(
      skips.map(e => ({
        id: e.step_name,
        reason: nodeSkipReasonSchema.parse(e.data?.reason),
        cause: skipCauseSchema.parse(e.data?.cause),
      }))
    );
    for (const skip of skips.filter(e => e.step_name.startsWith('review__')))
      expect(skip.data).toMatchObject({
        reason: 'when_condition',
        expr: "$gate.output == 'run'",
        cause: {
          kind: 'condition',
          expr: "$gate.output == 'run'",
          boundary: { includeId: 'review', workflow: 'review-block' },
        },
      });
    expect(formatDryRunTrace(dry)).toContain(
      "when_condition (condition: $gate.output == 'run' [include 'review', workflow 'review-block'])"
    );
  });

  for (const expr of [
    "$work.output = 'go'",
    "$work.output.absent == 'go'",
    "$LOOP_PREV.work.output == '' || $work.output.absent == 'go'",
  ]) {
    it(`reports divergent body gates once across peers, iterations, and same-run resume: ${expr}`, async () => {
      const block = fixture.buildWf('body-block', [
        { id: 'entry', bash: 'echo entry' },
        { id: 'left', bash: 'echo ran', depends_on: ['entry'] },
        { id: 'right', bash: 'echo ran', depends_on: ['entry'], trigger_rule: 'all_done' },
      ]);
      const parent = fixture.buildWf('boundary-reporting', [
        {
          id: 'cycle',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            on_exhausted: 'complete',
            nodes: [
              { id: 'work', bash: 'printf go' },
              {
                id: 'inc',
                include: 'body-block',
                depends_on: ['work'],
                when: "$work.output == 'go'",
              },
              {
                id: 'finish',
                bash: 'echo continue',
                depends_on: ['inc'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ]);
      const expansion = expandWorkflowIncludes(
        new Map([
          ['body-block', block],
          ['boundary-reporting', parent],
        ])
      );
      expect(expansion.errors).toEqual([]);
      const workflow = expansion.workflows.get('boundary-reporting')!;
      const group = workflow.nodes[0];
      if (group.kind !== 'loop_group') throw new Error('expected loop');
      for (const node of resolvedBodyNodes(group.loop_group)) {
        if (node.id !== 'inc__left' && node.id !== 'inc__right') continue;
        const boundary = readComposedMeta(node)?.boundaries?.[0];
        if (!boundary) throw new Error('expected boundary');
        boundary.when = expr;
      }
      const deps = createMockDeps();
      const platform = createMockPlatform();
      platform.sendMessage.mockImplementation(async (_conversation, message) => {
        if (message.startsWith("Include '")) {
          expect(
            fixture
              .eventList(deps)
              .some(
                e =>
                  e.event_type === 'node_skipped' && e.data?.reason === 'when_condition_parse_error'
              )
          ).toBe(true);
        }
      });
      const errors = spyOn(getLog(), 'error');
      try {
        const run = async (id: string, resume = false) =>
          executeDagWorkflow(
            dagOptions({
              deps,
              platform,
              cwd: fixture.testDir,
              workflow,
              workflowRun: makeWorkflowRun(id),
              priorCompletedNodes: resume ? new Map() : undefined,
            })
          );
        await run('boundary-error');
        const skips = fixture.eventList(deps).filter(e => e.event_type === 'node_skipped');
        expect(skips).toHaveLength(expr.startsWith('$LOOP_PREV') ? 4 : 6);
        for (const skip of skips)
          expect(skip.data).toMatchObject({
            reason: 'when_condition_parse_error',
            expr,
            cause: {
              kind: 'condition_parse_error',
              expr,
              boundary: { includeId: 'cycle.inc', workflow: 'body-block' },
            },
          });
        expect(
          fixture
            .eventList(deps)
            .filter(e => e.event_type === 'node_completed' && e.step_name === 'cycle.inc__entry')
        ).toHaveLength(3);
        expect(fixture.eventList(deps).filter(e => e.event_type === 'node_failed')).toEqual([]);
        const message = `Include 'cycle.inc' (workflow 'body-block'): cannot evaluate when: "${expr}" at node 'cycle.inc__left' — node skipped (fail-closed).`;
        expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toEqual([
          message,
        ]);
        const reports = () =>
          errors.mock.calls.filter(call => call[1] === 'dag_node_skipped_condition_parse_error');
        expect(reports()).toHaveLength(1);
        expect(reports()[0]?.[0]).toMatchObject({
          nodeId: 'cycle.inc__left',
          when: expr,
          boundary: { includeId: 'cycle.inc', workflow: 'body-block' },
        });
        if (expr.includes('absent'))
          expect(reports()[0]?.[0]).toHaveProperty('err', expect.any(Error));
        const dry = await dryRunWorkflow({
          workflow,
          userMessage: '',
          cwd: fixture.testDir,
          stubs: {
            work: 'go',
            inc__entry: 'entry',
            finish: 'continue',
            inc__left: 'ran',
            inc__right: 'ran',
          },
        });
        expect(
          dry.trace
            .filter(e => e.state === 'skipped')
            .map(e => ({ reason: e.reason, cause: e.cause }))
        ).toEqual(
          skips.map(e => ({
            reason: nodeSkipReasonSchema.parse(e.data?.reason),
            cause: skipCauseSchema.parse(e.data?.cause),
          }))
        );
        expect(formatDryRunTrace(dry)).toContain(
          `when_condition_parse_error (condition evaluation error: ${expr} [include 'cycle.inc', workflow 'body-block'])`
        );
        if (expr.includes('absent')) {
          const failedEvaluation = dry.trace.find(e => e.state === 'skipped');
          expect(failedEvaluation?.state === 'skipped' && failedEvaluation.diagnostic).toContain(
            'absent'
          );
          expect(formatDryRunTrace(dry)).toContain('diagnostic:');
          expect(formatDryRunTrace(dry)).not.toContain('condition parse error:');
        }
        await run('boundary-error', true);
        expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toEqual([
          message,
        ]);
        expect(reports()).toHaveLength(1);
        await run('fresh-boundary-error');
        expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toEqual([
          message,
          message,
        ]);
        expect(reports()).toHaveLength(2);
      } finally {
        errors.mockRestore();
      }
    });
  }

  for (const source of ['output', 'input'] as const) {
    for (const value of [{ ready: true }, ['go']]) {
      it(`reports a structured ${source} ${Array.isArray(value) ? 'array' : 'object'} gate only once`, async () => {
        const nodes = fixture.expandedGatedParentNodes('false-condition');
        const expr = source === 'input' ? "$INPUTS.route == 'go'" : "$gate.output.route == 'go'";
        for (const node of nodes) {
          for (const boundary of readComposedMeta(node)?.boundaries ?? []) boundary.when = expr;
        }
        const workflow = resolveTestWorkflow({
          name: 'structured-gate',
          nodes,
          inputs: { route: { default: value } },
        });
        const deps = createMockDeps();
        const platform = createMockPlatform();
        const errors = spyOn(getLog(), 'error');
        try {
          await executeDagWorkflow(
            dagOptions({
              deps,
              platform,
              cwd: fixture.testDir,
              workflow,
              workflowRun: {
                ...makeWorkflowRun('structured-gate'),
                metadata: runInputsMetadata({ route: value }),
              },
              priorCompletedNodes: new Map([
                ['gate', { state: 'completed', output: JSON.stringify({ route: value }) }],
              ]),
            })
          );
          expect(
            errors.mock.calls.filter(
              call =>
                call[1] === 'dag_node_skipped_condition_parse_error' ||
                call[1] === 'dag.condition_field_not_primitive'
            )
          ).toHaveLength(1);
          expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toHaveLength(
            1
          );
          const report = errors.mock.calls.find(
            call => call[1] === 'dag_node_skipped_condition_parse_error'
          )?.[0];
          expect(report).toHaveProperty(
            'err',
            expect.objectContaining({ message: expect.stringContaining('resolved to an') })
          );
          const ordinary = resolveTestWorkflow({
            name: 'ordinary-structured-gate',
            inputs: { route: { default: value } },
            nodes: fixture.buildWf('ordinary-nodes', [
              { id: 'gate', bash: 'echo unused' },
              { id: 'gated', bash: 'exit 99', depends_on: ['gate'], when: expr },
            ]).nodes,
          });
          errors.mockClear();
          const ordinaryDeps = createMockDeps();
          await executeDagWorkflow(
            dagOptions({
              deps: ordinaryDeps,
              platform,
              cwd: fixture.testDir,
              workflow: ordinary,
              workflowRun: {
                ...makeWorkflowRun('ordinary-structured'),
                metadata: runInputsMetadata({ route: value }),
              },
              priorCompletedNodes: new Map([
                ['gate', { output: JSON.stringify({ route: value }) }],
              ]),
            })
          );
          expect(
            fixture
              .eventList(ordinaryDeps)
              .find(e => e.event_type === 'node_failed' && e.step_name === 'gated')?.data?.error
          ).toContain('resolved to an');
          expect(
            errors.mock.calls.some(
              call => call[0] && typeof call[0] === 'object' && 'err' in call[0]
            )
          ).toBe(true);
          const dry = await dryRunWorkflow({
            workflow,
            userMessage: '',
            cwd: fixture.testDir,
            stubs: { gate: JSON.stringify({ route: value }) },
          });
          expect(formatDryRunTrace(dry)).toContain(
            `resolved to an ${Array.isArray(value) ? 'array' : 'object'}`
          );
          expect(formatDryRunTrace(dry)).toContain('condition evaluation error:');
        } finally {
          errors.mockRestore();
        }
      });
    }
  }

  it('keeps colliding authored boundary names distinct through reporting and resume', async () => {
    const leaf = fixture.buildWf('collision-leaf', [{ id: 'work', bash: 'exit 99' }]);
    const otherLeaf = fixture.buildWf('other-leaf', [{ id: 'other', bash: 'exit 99' }]);
    const middle = {
      ...fixture.buildWf('collision-middle', [
        {
          id: 'inner',
          include: 'collision-leaf',
          when: "$INPUTS.route == 'go'",
          with: { route: '$INPUTS.route' },
        },
      ]),
      inputs: { route: { required: true } },
    };
    const parent = fixture.buildWf('collision-parent', [
      { id: 'source', bash: 'printf go' },
      {
        id: 'outer__inner',
        include: 'other-leaf',
        depends_on: ['source'],
        when: "$source.output == 'go'",
      },
      { id: 'outer', include: 'collision-middle', with: { route: '$source.output' } },
    ]);
    const expanded = expandWorkflowIncludes(
      new Map([
        ['other-leaf', otherLeaf],
        ['collision-leaf', leaf],
        ['collision-middle', middle],
        ['collision-parent', parent],
      ])
    );
    expect(expanded.errors).toEqual([]);
    const workflow = expanded.workflows.get('collision-parent')!;
    for (const node of workflow.nodes) {
      for (const boundary of readComposedMeta(node)?.boundaries ?? [])
        boundary.when = "$source.output = 'go'";
    }
    const deps = createMockDeps();
    const platform = createMockPlatform();
    const run = () =>
      executeDagWorkflow(
        dagOptions({
          deps,
          platform,
          cwd: fixture.testDir,
          workflow,
          workflowRun: makeWorkflowRun('colliding-boundaries'),
          priorCompletedNodes: new Map(),
        })
      );
    await run();
    expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toHaveLength(2);
    const identities = fixture
      .eventList(deps)
      .filter(e => e.event_type === 'node_skipped')
      .map(e => skipCauseSchema.parse(e.data?.cause).boundary?.includeId);
    expect(new Set(identities)).toEqual(new Set(['outer%5F%5Finner', 'outer__inner']));
    await run();
    expect(deliveredMessages(platform).filter(m => m.startsWith("Include '"))).toHaveLength(2);
  });

  it('reports separate includes with identical malformed expressions once each, including entries', async () => {
    const block = fixture.buildWf('peers', [
      { id: 'a', bash: 'exit 99' },
      { id: 'b', bash: 'exit 99' },
      { id: 'tail', bash: 'exit 99', depends_on: ['a', 'b'], trigger_rule: 'all_done' },
    ]);
    const parent = fixture.buildWf('separate', [
      { id: 'source', bash: 'printf go' },
      ...['first', 'second'].map(id => ({
        id,
        include: 'peers',
        depends_on: ['source'],
        when: "$source.output == 'go'",
      })),
    ]);
    const expansion = expandWorkflowIncludes(
      new Map([
        ['peers', block],
        ['separate', parent],
      ])
    );
    expect(expansion.errors).toEqual([]);
    const workflow = expansion.workflows.get('separate')!;
    for (const node of workflow.nodes) {
      for (const boundary of readComposedMeta(node)?.boundaries ?? [])
        boundary.when = "$source.output = 'go'";
    }
    const deps = createMockDeps();
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps,
        platform,
        cwd: fixture.testDir,
        workflow,
        workflowRun: makeWorkflowRun('separate'),
      })
    );
    const messages = deliveredMessages(platform);
    for (const id of ['first', 'second'])
      expect(
        messages.filter(
          m =>
            m ===
            `Include '${id}' (workflow 'peers'): cannot evaluate when: "$source.output = 'go'" at node '${id}__a' — node skipped (fail-closed).`
        )
      ).toHaveLength(1);
    expect(fixture.eventList(deps).filter(e => e.event_type === 'node_skipped')).toHaveLength(6);
    expect(fixture.eventList(deps).filter(e => e.event_type === 'node_failed')).toEqual([]);
  });
}
