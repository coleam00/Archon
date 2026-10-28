import { createEscalationStore } from '../../../pause-test-utils';
import { expect, it, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockSendQueryDag,
  persistedEvents,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { DagNode } from '../../../../schemas';
import { dagNodeSchema } from '../../../../schemas';
import type { IWorkflowStore } from '../../../../store';
import { waitCompletionEvents } from '../../../../store';
import { foldDagResumeSnapshot } from '../../../../dag-resume-snapshot';
import type { WorkflowEventRow } from '../../../../schemas/workflow-event';
import type { setupAddressableTests } from './sessions-owner-branches';

export function registerOwnerResumeTests(fixture: ReturnType<typeof setupAddressableTests>) {
  it('finishes a same-body consumer after approval through an ownerless wrapper', async () => {
    fixture.mockSameBodySessions(2);
    const body = fixture.sameBodyWorkflow(true);
    const group = body[0];
    if (group?.kind !== 'loop_group') throw new Error('missing group');
    group.loop_group.max_iterations = 1;
    group.loop_group.until_bash = 'exit 0';
    const nodes: DagNode[] = [
      {
        id: 'wrapper',
        kind: 'loop_group',
        provider: 'claude',
        loop_group: {
          max_iterations: 2,
          until_bash: 'test $group.output = B2',
          fresh_context: true,
          nodes: body,
        },
      },
    ];
    const firstStore = createEscalationStore('addressable-run');
    await fixture.runAddressableWorkflow(nodes, firstStore);
    expect(firstStore.getState().status).toBe('paused');
    expect(fixture.sameBodyConsumerCalls()).toEqual([['A1', true]]);
    expect(firstStore.failWorkflowRun).not.toHaveBeenCalled();
    expect(persistedEvents(firstStore)).not.toContainEqual(
      expect.objectContaining({
        event_type: 'node_completed',
        step_name: 'wrapper',
      })
    );
    const metadata = JSON.parse(JSON.stringify(firstStore.getState().metadata));
    expect(metadata.approval.execution.invocation.loopPath[0]).toEqual({
      groupId: 'wrapper',
      iteration: 2,
    });
    expect(metadata.approval.bodySessionCursorAncestry[JSON.stringify(['wrapper', []])]).toEqual(
      {}
    );
    metadata.approval.resolved = 'approved';
    const resumedStore = createEscalationStore('addressable-run');
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        cwd: fixture.testDir,
        workflow: { name: 'addressable', nodes },
        workflowRun: makeWorkflowRun('addressable-run', { metadata }),
      })
    );
    expect(resumedStore.failWorkflowRun).not.toHaveBeenCalled();
    expect(resumedStore.completeWorkflowRun).toHaveBeenCalled();
    expect(persistedEvents(resumedStore)).toContainEqual(
      expect.objectContaining({
        event_type: 'node_completed',
        step_name: 'wrapper.group.b',
        data: expect.objectContaining({
          invocation: expect.objectContaining({
            loopPath: [
              { groupId: 'wrapper', iteration: 2 },
              { groupId: 'group', iteration: 1 },
            ],
          }),
        }),
      })
    );
    expect(fixture.sameBodyConsumerCalls()).toEqual([
      ['A1', true],
      ['A3', true],
    ]);
  });

  for (const { source, feedback, nested } of [
    { source: 'prompt', feedback: false, nested: false },
    { source: 'prompt', feedback: true, nested: false },
    { source: 'command', feedback: false, nested: false },
    { source: 'command', feedback: true, nested: false },
    { source: 'prompt', feedback: false, nested: true },
  ] as const) {
    it(`forks each interactive same-body ${source} source after its own approval (feedback: ${feedback}, nested: ${nested})`, async () => {
      const body = fixture.sameBodyWorkflow(false);
      const nodes: DagNode[] = nested
        ? [
            {
              id: 'wrapper',
              kind: 'loop_group',
              provider: 'claude',
              loop_group: {
                max_iterations: 1,
                until_bash: 'exit 0',
                fresh_context: true,
                nodes: body,
              },
            },
          ]
        : body;
      const group = body[0];
      if (group?.kind !== 'loop_group') throw new Error('missing group');
      if (source === 'command') {
        const commandsDir = join(fixture.testDir, '.archon', 'commands');
        await mkdir(commandsDir, { recursive: true });
        await writeFile(join(commandsDir, 'source.md'), 'a');
      }
      group.loop_group.nodes[0] = dagNodeSchema.parse({
        id: 'a',
        loop: {
          ...(source === 'prompt' ? { prompt: 'a' } : { command: 'source' }),
          max_iterations: 2,
          until: 'DONE',
          interactive: true,
          gate_message: 'Continue?',
        },
      });
      let aRuns = 0;
      let bRuns = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session) {
        const sessionId = prompt === 'b' ? `B${++bRuns}` : (session ?? `A${++aRuns}`);
        yield { type: 'agent_message_chunk', text: prompt === 'b' ? sessionId : 'DONE' };
        yield { type: 'result', sessionId, ...(session ? { resumed: true } : {}) };
      });
      const loopPath = (iteration: number) => [
        ...(nested ? [{ groupId: 'wrapper', iteration: 1 }] : []),
        { groupId: 'group', iteration },
      ];
      let store = createEscalationStore('addressable-run');
      await fixture.runAddressableWorkflow(nodes, store);
      async function approve(feedbackGiven = false): Promise<void> {
        const metadata = JSON.parse(JSON.stringify(store.getState().metadata));
        metadata.approval.resolved = 'approved';
        metadata.loop_feedback_given = feedbackGiven;
        metadata.loop_user_input = feedbackGiven ? 'Refine it.' : '';
        store = createEscalationStore('addressable-run');
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: fixture.testDir,
            workflow: { name: 'addressable', nodes },
            workflowRun: makeWorkflowRun('addressable-run', { metadata }),
          })
        );
      }
      expect(store.getState().status).toBe('paused');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(fixture.sameBodyConsumerCalls()).toEqual([]);
      expect(persistedEvents(store)).not.toContainEqual(
        expect.objectContaining({
          event_type: 'node_completed',
          step_name: nested ? 'wrapper.group' : 'group',
        })
      );
      const firstApproval = store.getState().metadata.approval;
      expect(firstApproval).toMatchObject({
        iteration: 1,
        sessionId: 'A1',
        execution: { invocation: { loopPath: loopPath(1) } },
        bodySessionCursorAncestry: nested
          ? {
              [JSON.stringify(['wrapper', []])]: {},
              [JSON.stringify(['wrapper.group', [{ groupId: 'wrapper', iteration: 1 }]])]: {},
            }
          : { [JSON.stringify(['group', []])]: {} },
      });
      await approve(feedback);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.getState().status).toBe('paused');
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(aRuns).toBe(2);
      expect(mockSendQueryDag.mock.calls.filter(c => c[0] !== 'b').map(c => c[2])).toEqual(
        feedback ? [undefined, 'A1', undefined] : [undefined, undefined]
      );
      expect(fixture.sameBodyConsumerCalls()).toEqual([['A1', true]]);
      expect(store.getState().metadata.approval).toMatchObject({
        iteration: 1,
        sessionId: 'A2',
        execution: { invocation: { loopPath: loopPath(2) } },
      });
      await approve();
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).toHaveBeenCalled();
      expect(aRuns).toBe(2);
      expect(fixture.sameBodyConsumerCalls()).toEqual([
        ['A1', true],
        ['A2', true],
      ]);
      expect(persistedEvents(store)).toContainEqual(
        expect.objectContaining({
          event_type: 'node_completed',
          step_name: nested ? 'wrapper.group.a' : 'group.a',
          data: expect.objectContaining({
            invocation: expect.objectContaining({
              loopPath: loopPath(2),
            }),
          }),
        })
      );
    });
  }

  it('restores same-body ancestry across terminal duration waits in both iterations', async () => {
    fixture.mockSameBodySessions();
    const nodes = fixture.sameBodyWorkflow(false);
    const group = nodes[0];
    if (group?.kind !== 'loop_group') throw new Error('missing group');
    group.loop_group.nodes.push(
      dagNodeSchema.parse({
        id: 'pause',
        depends_on: ['b'],
        wait: { duration_ms: 3600000 },
      })
    );
    let store = createEscalationStore('addressable-run');
    const history: WorkflowEventRow[] = [];
    await fixture.runAddressableWorkflow(nodes, store);
    for (const iteration of [1, 2]) {
      expect(store.getState().status).toBe('paused');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      const metadata = JSON.parse(JSON.stringify(store.getState().metadata));
      expect(metadata.wait).toMatchObject({
        iteration,
        bodySessionCursors: {},
        bodySessionCursorAncestry: { [JSON.stringify(['group', []])]: {} },
      });
      expect(fixture.sameBodyConsumerCalls()).toEqual(
        iteration === 1
          ? [['A1', true]]
          : [
              ['A1', true],
              ['A2', true],
            ]
      );
      metadata.wait.resumeAt = '2020-01-01T00:00:00.000Z';
      const completedWaits = store.clearWorkflowWaitContext.mock.calls.map(
        ([id, , completion]) => waitCompletionEvents(id, completion).node
      );
      history.push(
        ...[...completedWaits, ...persistedEvents(store)].map((event, index) => ({
          ...event,
          step_name: event.step_name ?? null,
          data: event.data ?? {},
          id: String(history.length + index),
          step_index: null,
          created_at: new Date().toISOString(),
        }))
      );
      store = createEscalationStore('addressable-run');
      store.listEventsForRuns.mockImplementation(
        async (_ids, types) =>
          new Map([
            [
              'addressable-run',
              history.filter(row => !types || types.some(type => type === row.event_type)),
            ],
          ])
      );
      const snapshot = await foldDagResumeSnapshot(history, 'addressable-run');
      expect(snapshot.completedNodeOutputs.has('group.pause')).toBe(false);
      store.getDagResumeSnapshot.mockResolvedValue(snapshot);
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: fixture.testDir,
          workflow: { name: 'addressable', nodes },
          workflowRun: makeWorkflowRun('addressable-run', { metadata }),
          priorCompletedNodes: new Map([
            ['group.a', { output: `A${iteration}`, sessionId: `A${iteration}` }],
            ['group.b', { output: `B${iteration}`, sessionId: `B${iteration}` }],
          ]),
        })
      );
    }
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(fixture.sameBodyConsumerCalls()).toEqual([
      ['A1', true],
      ['A2', true],
    ]);
  });

  it('refuses missing, malformed, or foreign owner pause state before dispatch', async () => {
    for (const bodySessionCursors of [
      undefined,
      { owner: { sessionId: 'O' } },
      { stranger: { sessionId: 'O', provider: 'claude' } },
    ]) {
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: fixture.testDir,
          workflow: { name: 'addressable', nodes: fixture.ownerWorkflow() },
          workflowRun: makeWorkflowRun('addressable-run', {
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'corrections',
                iteration: 1,
                message: 'Review',
                bodySessionCursors,
              },
            },
          }),
          priorCompletedNodes: new Map([['source', { output: 'source' }]]),
        })
      );
      expect(store.failWorkflowRun).toHaveBeenCalled();
    }
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('keeps separate parallel owner branches and preserves a cursor across a skipped turn', async () => {
    const nodes = fixture.ownerWorkflow();
    const group = nodes[1];
    if (group?.kind !== 'loop_group') throw new Error('missing group');
    group.loop_group.until_bash = 'test $review.output.done = true';
    group.loop_group.nodes = [
      dagNodeSchema.parse({
        id: 'a',
        prompt: 'a',
        context: { resume: 'source' },
        when: '$LOOP_PREV.review.output.skip != true',
      }),
      dagNodeSchema.parse({ id: 'b', prompt: 'b', context: { resume: 'source' } }),
      dagNodeSchema.parse({
        id: 'review',
        prompt: 'review',
        context: 'fresh',
        depends_on: ['a', 'b'],
        trigger_rule: 'all_done',
        output_format: {
          type: 'object',
          properties: { done: { type: 'boolean' }, skip: { type: 'boolean' } },
          required: ['done', 'skip'],
        },
      }),
    ];
    let reviews = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session) {
      if (prompt === 'review') reviews++;
      const output = { done: reviews === 3, skip: reviews === 1 };
      yield {
        type: 'agent_message_chunk',
        text: prompt === 'review' ? JSON.stringify(output) : prompt,
      };
      yield {
        type: 'result',
        sessionId:
          prompt === 'source' ? 'S' : prompt === 'a' ? 'A' : prompt === 'b' ? 'B' : `R${reviews}`,
        ...(prompt === 'review' ? { structuredOutput: output } : {}),
        ...(session ? { resumed: true } : {}),
      };
    });
    const store = await fixture.runAddressableWorkflow(nodes);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'a').map(c => c[2])).toEqual([
      'S',
      'A',
    ]);
    expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'b').map(c => c[2])).toEqual([
      'S',
      'B',
      'B',
    ]);
  });

  it('scopes nested sources and owner cursors to each enclosing invocation', async () => {
    let round = 0;
    let reviews = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      if (prompt === 'local') round++;
      if (prompt === 'review') reviews++;
      const output = prompt === 'local' ? { round } : { done: reviews % 2 === 0 };
      yield {
        type: 'agent_message_chunk',
        text: options?.outputFormat ? JSON.stringify(output) : prompt,
      };
      yield {
        type: 'result',
        sessionId:
          prompt === 'local' ? `L${round}` : prompt === 'owner' ? `O${round}` : `R${reviews}`,
        ...(options?.outputFormat ? { structuredOutput: output } : {}),
        ...(session ? { resumed: true } : {}),
      };
    });
    const outer = dagNodeSchema.parse({
      id: 'outer',
      loop_group: {
        max_iterations: 2,
        fresh_context: true,
        until_bash: 'test $local.output.round = 2',
        nodes: [
          {
            id: 'local',
            prompt: 'local',
            output_format: {
              type: 'object',
              properties: { round: { type: 'integer' } },
              required: ['round'],
            },
          },
          {
            id: 'inner',
            depends_on: ['local'],
            loop_group: {
              max_iterations: 2,
              until_bash: 'test $review.output.done = true',
              nodes: [
                { id: 'owner', prompt: 'owner', context: { resume: 'local' } },
                {
                  id: 'review',
                  prompt: 'review',
                  context: 'fresh',
                  depends_on: ['owner'],
                  output_format: {
                    type: 'object',
                    properties: { done: { type: 'boolean' } },
                    required: ['done'],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    if (outer.kind !== 'loop_group') throw new Error('missing outer group');
    const store = await fixture.runAddressableWorkflow([outer]);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalled();
    expect(
      mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner').map(c => [c[2], c[3]?.forkSession])
    ).toEqual([
      ['L1', true],
      ['O1', false],
      ['L2', true],
      ['O2', false],
    ]);
    expect(
      (
        store.upsertWorkflowRunNodeSession as Mock<IWorkflowStore['upsertWorkflowRunNodeSession']>
      ).mock.calls.map(c => c[0].node_id)
    ).toEqual(['outer.local', 'outer.local']);
  });

  it('keeps the Pi work session rather than a later repair session', async () => {
    const nodes = fixture.ownerWorkflow('pi');
    const group = nodes[1];
    if (group?.kind !== 'loop_group') throw new Error('missing group');
    const owner = group.loop_group.nodes[0];
    if (owner?.kind !== 'agent') throw new Error('missing owner');
    owner.output_format = {
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
    };
    let ownerPass = 0;
    let reviews = 0;
    function ownerSessionId(): string {
      if (ownerPass <= 2) return `O${ownerPass}`;
      return ownerPass === 4 ? 'repair' : 'O2';
    }
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      const isOwner = prompt.startsWith('owner');
      if (isOwner) ownerPass++;
      if (prompt === 'review') reviews++;
      const valid = !isOwner || ownerPass % 2 === 0 || ownerPass === 5;
      const output = valid ? { done: reviews === 3 } : { wrong: true };
      yield {
        type: 'agent_message_chunk',
        text: options?.outputFormat ? JSON.stringify(output) : prompt,
      };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'S' : isOwner ? ownerSessionId() : `R${reviews}`,
        ...(options?.outputFormat ? { structuredOutput: output } : {}),
        ...(session ? { resumed: true } : {}),
      };
    });
    const store = await fixture.runAddressableWorkflow(nodes);
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(
      mockSendQueryDag.mock.calls
        .filter(c => c[0].startsWith('owner'))
        .map(c => [c[2], c[3]?.forkSession])
    ).toEqual([
      ['S', true],
      ['S', true],
      ['O2', false],
      [undefined, false],
      ['O2', false],
    ]);
  });

  for (const failure of ['cold', 'missing', 'replacement']) {
    it(`fails owner continuation on ${failure} rather than replaying the source`, async () => {
      let owners = 0;
      function ownerSessionId(): string | undefined {
        if (owners === 2 && failure === 'missing') return undefined;
        return owners === 2 && failure === 'replacement' ? 'replacement' : 'O';
      }
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
        if (prompt === 'owner') owners++;
        yield {
          type: 'agent_message_chunk',
          text: prompt === 'review' ? '{"done":false}' : prompt,
        };
        yield {
          type: 'result',
          sessionId: prompt === 'source' ? 'S' : prompt === 'owner' ? ownerSessionId() : 'R',
          ...(options?.outputFormat ? { structuredOutput: { done: false } } : {}),
          ...(session ? { resumed: !(owners === 2 && failure === 'cold') } : {}),
        };
      });
      const store = await fixture.runAddressableWorkflow(fixture.ownerWorkflow());
      expect(store.failWorkflowRun).toHaveBeenCalled();
      expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner').map(c => c[2])).toEqual([
        'S',
        'O',
      ]);
    });
  }
}
