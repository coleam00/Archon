import { createEscalationStore } from '../../../pause-test-utils';
import { afterEach, beforeEach, expect, it, mock, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProviderRegistry } from '@archon/provider-contract';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  failedLoopIterations,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockProviderRegistry,
  mockSendQueryDag,
  persistedEvents,
  type MockWorkflowStore,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { DagNode, WorkflowRunNodeSession } from '../../../../schemas';
import { dagNodeSchema } from '../../../../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../../../../store';
import { ParentStatusReadError } from '../../../../parent-status-read';

export function setupAddressableTests() {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-addressable-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
  });

  async function runAddressableWorkflow(
    nodes: DagNode[],
    store = createMockStore(),
    priorCompletedNodes?: Map<string, PersistedNodeOutput>,
    priorNodeSessions?: readonly WorkflowRunNodeSession[],
    providers: ProviderRegistry = mockProviderRegistry
  ): Promise<MockWorkflowStore> {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store, providers),
        conversationId: 'conv-addressable',
        cwd: testDir,
        workflow: { name: 'addressable', nodes },
        workflowRun: makeWorkflowRun('addressable-run'),
        priorCompletedNodes,
        priorNodeSessions,
      })
    );
    return store;
  }

  function ownerWorkflow(provider = 'claude', fresh_context = false): DagNode[] {
    return [
      { id: 'source', kind: 'agent', provider, source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'corrections',
        kind: 'loop_group',
        provider,
        depends_on: ['source'],
        loop_group: {
          max_iterations: 3,
          fresh_context,
          until_bash: 'test $review.output.done = true',
          nodes: [
            {
              id: 'owner',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'owner' },
              context: { resume: 'source' },
            },
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'review' },
              context: 'fresh',
              depends_on: ['owner'],
              output_format: {
                type: 'object',
                properties: { done: { type: 'boolean' } },
                required: ['done'],
                additionalProperties: false,
              },
            },
          ],
        },
      },
    ];
  }

  /** `b` resumes same-body `a`; `withNestedPause` puts a gated inner group between them. */
  function sameBodyWorkflow(withNestedPause: boolean): DagNode[] {
    const inner = dagNodeSchema.parse({
      id: 'inner',
      depends_on: ['a'],
      loop_group: {
        max_iterations: 2,
        until_bash: 'test $review.output.done = true',
        nodes: [
          {
            id: 'review',
            prompt: 'review',
            output_format: {
              type: 'object',
              properties: { done: { type: 'boolean' } },
              required: ['done'],
            },
          },
          {
            id: 'pause',
            depends_on: ['review'],
            when: '$review.output.done != true',
            approval: { message: 'Continue?' },
          },
        ],
      },
    });
    return [
      {
        id: 'group',
        kind: 'loop_group',
        provider: 'claude',
        loop_group: {
          max_iterations: 2,
          fresh_context: true,
          until_bash: 'test $b.output = B2',
          nodes: [
            { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'a' } },
            ...(withNestedPause ? [inner] : []),
            {
              id: 'b',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'b' },
              depends_on: [withNestedPause ? 'inner' : 'a'],
              context: { resume: 'a' },
            },
          ],
        },
      },
    ];
  }

  /** Each `a` run yields session A<n>, each `b` run B<n>; one review pauses. */
  function mockSameBodySessions(pauseReview = 1): void {
    let aRuns = 0;
    let bRuns = 0;
    let reviews = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      if (prompt === 'review') {
        const done = ++reviews !== pauseReview;
        yield { type: 'agent_message_chunk', text: JSON.stringify({ done }) };
        yield {
          type: 'result',
          sessionId: `R${reviews}`,
          ...(options?.outputFormat ? { structuredOutput: { done } } : {}),
        };
        return;
      }
      const sessionId = prompt === 'a' ? `A${++aRuns}` : `B${++bRuns}`;
      yield { type: 'agent_message_chunk', text: sessionId };
      yield { type: 'result', sessionId, ...(session ? { resumed: true } : {}) };
    });
  }

  function sameBodyConsumerCalls(): unknown[][] {
    return mockSendQueryDag.mock.calls
      .filter(c => c[0] === 'b')
      .map(c => [c[2], c[3]?.forkSession]);
  }
  return {
    get testDir() {
      return testDir;
    },
    runAddressableWorkflow,
    ownerWorkflow,
    sameBodyWorkflow,
    mockSameBodySessions,
    sameBodyConsumerCalls,
  };
}

export function registerOwnerBranchTests(fixture: ReturnType<typeof setupAddressableTests>) {
  for (const provider of ['claude', 'codex', 'pi']) {
    for (const fresh of [false, true]) {
      it(`keeps the ${provider} owner branch across fresh reviews (fresh_context=${String(fresh)})`, async () => {
        let reviews = 0;
        mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
          const done = prompt === 'review' && ++reviews === 3;
          yield {
            type: 'agent_message_chunk',
            text: prompt === 'review' ? JSON.stringify({ done }) : prompt,
          };
          yield {
            type: 'result',
            sessionId: prompt === 'source' ? 'S' : prompt === 'owner' ? 'O' : `R${reviews}`,
            ...(options?.outputFormat ? { structuredOutput: { done } } : {}),
            ...(session ? { resumed: true } : {}),
          };
        });
        const store = await fixture.runAddressableWorkflow(fixture.ownerWorkflow(provider, fresh));
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.completeWorkflowRun).toHaveBeenCalled();
        expect(mockSendQueryDag.mock.calls.map(c => c[2])).toEqual([
          undefined,
          'S',
          undefined,
          'O',
          undefined,
          'O',
          undefined,
        ]);
        expect(
          mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner').map(c => c[3]?.forkSession)
        ).toEqual([true, false, false]);
        const completed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
          .map(c => c[0])
          .filter(e => e.event_type === 'node_completed' && e.step_name === 'corrections.owner');
        expect(completed.map(e => e.data.session_id)).toEqual(['O', 'O', 'O']);
        expect(completed.map(e => e.data.session_forked)).toEqual([true, false, false]);
        expect(store.upsertWorkflowRunNodeSession).toHaveBeenCalledWith({
          workflow_run_id: 'addressable-run',
          node_id: 'source',
          provider,
          provider_session_id: 'S',
        });
      });
    }
  }

  it('restores private ownership from serialized interactive pause state in a new execution', async () => {
    const nodes = fixture.ownerWorkflow('claude', true);
    const group = nodes[1];
    if (!group || group.kind !== 'loop_group') throw new Error('missing group');
    group.loop_group.interactive = true;
    group.loop_group.gate_message = 'Review';
    let reviews = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
      const done = prompt === 'review' && ++reviews === 2;
      yield {
        type: 'agent_message_chunk',
        text: prompt === 'review' ? JSON.stringify({ done }) : prompt,
      };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'S' : prompt === 'owner' ? 'O' : `R${reviews}`,
        ...(options?.outputFormat ? { structuredOutput: { done } } : {}),
        ...(session ? { resumed: true } : {}),
      };
    });
    const store = await fixture.runAddressableWorkflow(nodes);
    const pause = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls[0]?.[1];
    expect(pause?.bodySessionCursors).toEqual({ owner: { sessionId: 'O', provider: 'claude' } });
    const resumedStore = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        conversationId: 'conv-addressable',
        cwd: fixture.testDir,
        workflow: { name: 'addressable', nodes },
        workflowRun: makeWorkflowRun('addressable-run', {
          metadata: { approval: JSON.parse(JSON.stringify(pause)) },
        }),
        priorCompletedNodes: new Map([['source', { output: 'source', sessionId: 'S' }]]),
        priorNodeSessions: [
          {
            workflow_run_id: 'addressable-run',
            node_id: 'source',
            provider: 'claude',
            provider_session_id: 'S',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      })
    );
    expect(resumedStore.failWorkflowRun).not.toHaveBeenCalled();
    expect(resumedStore.completeWorkflowRun).toHaveBeenCalled();
    expect(
      mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner').map(c => [c[2], c[3]?.forkSession])
    ).toEqual([
      ['S', true],
      ['O', false],
    ]);
    expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'review').map(c => c[2])).toEqual([
      undefined,
      undefined,
    ]);
  });

  for (const boundary of ['gate', 'time', 'event', 'attention'] as const) {
    it(`snapshots and restores the owner at a terminal ${boundary}, including repeated suspension`, async () => {
      const nodes = fixture.ownerWorkflow('claude', true);
      const group = nodes[1];
      if (group?.kind !== 'loop_group') throw new Error('missing group');
      group.loop_group.until_bash = 'exit 1';
      group.loop_group.nodes.push(
        dagNodeSchema.parse({
          id: 'pause',
          depends_on: ['review'],
          ...(boundary === 'gate'
            ? { approval: { message: 'Review' } }
            : {
                wait:
                  boundary === 'time'
                    ? { duration_ms: 3600000 }
                    : boundary === 'event'
                      ? { event: 'checks.complete', deadline_ms: 3600000 }
                      : { attention: 'Fix checks' },
              }),
        })
      );
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
        yield {
          type: 'agent_message_chunk',
          text: prompt === 'review' ? '{"done":false}' : prompt,
        };
        yield {
          type: 'result',
          sessionId: prompt === 'source' ? 'S' : prompt === 'owner' ? 'O' : 'R',
          ...(options?.outputFormat ? { structuredOutput: { done: false } } : {}),
          ...(session ? { resumed: true } : {}),
        };
      });
      const firstStore = createEscalationStore('addressable-run');
      await fixture.runAddressableWorkflow(nodes, firstStore);
      const metadata = JSON.parse(JSON.stringify(firstStore.getState().metadata));
      const paused = boundary === 'gate' ? metadata.approval : metadata.wait;
      expect(paused.bodySessionCursors).toEqual({ owner: { sessionId: 'O', provider: 'claude' } });
      if (boundary === 'gate') paused.resolved = 'approved';
      if (boundary === 'time') paused.resumeAt = '2020-01-01T00:00:00.000Z';
      if (boundary === 'event') paused.signaledAt = new Date().toISOString();
      const resume = async (state: Record<string, unknown>) => {
        const store = createEscalationStore('addressable-run');
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: fixture.testDir,
            workflow: { name: 'addressable', nodes },
            workflowRun: makeWorkflowRun('addressable-run', { metadata: state }),
            priorCompletedNodes: new Map([['source', { output: 'source', sessionId: 'S' }]]),
          })
        );
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        return store;
      };
      if (boundary === 'time' || boundary === 'event') {
        const pending = {
          ...metadata,
          wait: { ...paused, signaledAt: undefined, resumeAt: '2099-01-01T00:00:00.000Z' },
        };
        const stillWaiting = await resume(JSON.parse(JSON.stringify(pending)));
        expect(stillWaiting.getState().metadata.wait).toMatchObject({
          bodySessionCursors: paused.bodySessionCursors,
          iteration: 1,
        });
        expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner')).toHaveLength(1);
      }
      const secondStore = await resume(JSON.parse(JSON.stringify(metadata)));
      expect(
        mockSendQueryDag.mock.calls
          .filter(c => c[0] === 'owner')
          .map(c => [c[2], c[3]?.forkSession])
      ).toEqual([
        ['S', true],
        ['O', false],
      ]);
      const second =
        boundary === 'gate'
          ? secondStore.getState().metadata.approval
          : secondStore.getState().metadata.wait;
      expect(second).toMatchObject({ iteration: 2, bodySessionCursors: paused.bodySessionCursors });
    });
  }

  for (const boundary of ['gate', 'interactive'] as const) {
    it(`restores enclosing owners after a nested ${boundary} and scopes new inner invocations`, async () => {
      const nodes = fixture.ownerWorkflow('claude', true);
      const outer = nodes[1];
      if (outer?.kind !== 'loop_group') throw new Error('missing outer group');
      outer.id = 'outer';
      outer.loop_group.max_iterations = 2;
      outer.loop_group.until_bash = 'exit 1';
      outer.loop_group.nodes = [
        dagNodeSchema.parse({ id: 'owner', prompt: 'outer-owner', context: { resume: 'source' } }),
        dagNodeSchema.parse({
          id: 'inner',
          depends_on: ['owner'],
          loop_group: {
            max_iterations: 3,
            fresh_context: true,
            until_bash: 'test $review.output.done = true',
            ...(boundary === 'interactive' ? { interactive: true, gate_message: 'Review' } : {}),
            nodes: [
              { id: 'owner', prompt: 'inner-owner', context: { resume: 'source' } },
              {
                id: 'review',
                prompt: 'inner-review',
                context: 'fresh',
                depends_on: ['owner'],
                output_format: {
                  type: 'object',
                  properties: { done: { type: 'boolean' } },
                  required: ['done'],
                },
              },
              ...(boundary === 'gate'
                ? [
                    {
                      id: 'pause',
                      depends_on: ['review'],
                      when: '$review.output.done != true',
                      approval: { message: 'Review' },
                    },
                  ]
                : []),
            ],
          },
        }),
      ];
      let reviews = 0;
      let innerBranches = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
        const done = prompt === 'inner-review' && ++reviews === 2;
        if (prompt === 'inner-owner' && options?.forkSession) innerBranches++;
        yield {
          type: 'agent_message_chunk',
          text: prompt === 'inner-review' ? JSON.stringify({ done }) : prompt,
        };
        yield {
          type: 'result',
          sessionId:
            prompt === 'source'
              ? 'S'
              : prompt === 'outer-owner'
                ? 'O'
                : prompt === 'inner-owner'
                  ? `I${innerBranches}`
                  : `R${reviews}`,
          ...(options?.outputFormat ? { structuredOutput: { done } } : {}),
          ...(session ? { resumed: true } : {}),
        };
      });
      const firstStore = createEscalationStore('addressable-run');
      await fixture.runAddressableWorkflow(nodes, firstStore);
      expect(firstStore.failWorkflowRun).not.toHaveBeenCalled();
      const metadata = JSON.parse(JSON.stringify(firstStore.getState().metadata));
      const pause = metadata.approval;
      expect(pause.bodySessionCursorAncestry).toEqual({
        [JSON.stringify(['outer', []])]: { owner: { sessionId: 'O', provider: 'claude' } },
        [JSON.stringify(['outer.inner', [{ groupId: 'outer', iteration: 1 }]])]: {
          owner: { sessionId: 'I1', provider: 'claude' },
        },
      });
      pause.resolved = 'approved';
      const resume = async (
        state: Record<string, unknown>,
        resumedStore = createEscalationStore('addressable-run')
      ) => {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(resumedStore),
            cwd: fixture.testDir,
            workflow: { name: 'addressable', nodes },
            workflowRun: makeWorkflowRun('addressable-run', { metadata: state }),
            priorCompletedNodes: new Map([['source', { output: 'source', sessionId: 'S' }]]),
            priorNodeSessions: [
              {
                workflow_run_id: 'addressable-run',
                node_id: 'source',
                provider: 'claude',
                provider_session_id: 'S',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          })
        );
        return resumedStore;
      };
      const callsBeforeInvalidResume = mockSendQueryDag.mock.calls.length;
      let invalid: Awaited<ReturnType<typeof resume>> | undefined;
      expect(
        await failedLoopIterations('outer', async () => {
          invalid = await resume({
            ...metadata,
            approval: { ...pause, bodySessionCursorAncestry: undefined },
          });
        })
      ).toBe(1);
      expect(invalid?.failWorkflowRun).toHaveBeenCalled();
      expect(mockSendQueryDag.mock.calls).toHaveLength(callsBeforeInvalidResume);
      const interruptedStore = createEscalationStore('addressable-run');
      const statusReadError = new Error('Enclosing replay status read failed');
      const getStatus = interruptedStore.getWorkflowRunStatus.getMockImplementation();
      let rejected = false;
      interruptedStore.getWorkflowRunStatus.mockImplementation(async id => {
        if (
          !rejected &&
          persistedEvents(interruptedStore).some(
            event => event.event_type === 'node_started' && event.step_name === 'outer'
          )
        ) {
          rejected = true;
          throw statusReadError;
        }
        return getStatus?.(id) ?? 'running';
      });
      expect(
        await failedLoopIterations('outer', async () => {
          const interruption: unknown = await resume(metadata, interruptedStore).catch(
            (error: unknown) => error
          );
          expect(interruption).toBeInstanceOf(ParentStatusReadError);
          expect(interruption).toMatchObject({ workflowRunId: 'addressable-run', nodeId: 'outer' });
          expect(interruption instanceof Error ? interruption.cause : undefined).toBe(
            statusReadError
          );
        })
      ).toBeUndefined();
      expect(interruptedStore.failWorkflowRun).not.toHaveBeenCalled();
      expect(
        persistedEvents(interruptedStore).filter(event => event.event_type === 'node_failed')
      ).toEqual([]);
      expect(mockSendQueryDag.mock.calls).toHaveLength(callsBeforeInvalidResume);
      const resumedStore = await resume(metadata);
      expect(resumedStore.failWorkflowRun.mock.calls).toEqual([]);
      expect(
        mockSendQueryDag.mock.calls
          .filter(c => c[0] === 'outer-owner')
          .map(c => [c[2], c[3]?.forkSession])
      ).toEqual([
        ['S', true],
        ['O', false],
        ['O', false],
      ]);
      expect(
        mockSendQueryDag.mock.calls
          .filter(c => c[0] === 'inner-owner')
          .map(c => [c[2], c[3]?.forkSession])
      ).toEqual([
        ['S', true],
        ['I1', false],
        ['S', true],
      ]);
      expect(resumedStore.getState().metadata.approval).toMatchObject({
        bodySessionCursorAncestry: {
          [JSON.stringify(['outer', []])]: { owner: { sessionId: 'O', provider: 'claude' } },
          [JSON.stringify(['outer.inner', [{ groupId: 'outer', iteration: 2 }]])]: {
            owner: { sessionId: 'I2', provider: 'claude' },
          },
        },
      });
      const nextMetadata = JSON.parse(JSON.stringify(resumedStore.getState().metadata));
      nextMetadata.approval.resolved = 'approved';
      const thirdStore = await resume(nextMetadata);
      expect(thirdStore.failWorkflowRun).not.toHaveBeenCalled();
      expect(
        mockSendQueryDag.mock.calls
          .filter(c => c[0] === 'outer-owner')
          .map(c => [c[2], c[3]?.forkSession])
      ).toEqual([
        ['S', true],
        ['O', false],
        ['O', false],
        ['O', false],
      ]);
      expect(
        mockSendQueryDag.mock.calls
          .filter(c => c[0] === 'inner-owner')
          .map(c => [c[2], c[3]?.forkSession])
      ).toEqual([
        ['S', true],
        ['I1', false],
        ['S', true],
        ['I2', false],
      ]);
      expect(thirdStore.getState().metadata.approval).toMatchObject({
        iteration: 2,
        bodySessionCursorAncestry: {
          [JSON.stringify(['outer.inner', [{ groupId: 'outer', iteration: 2 }]])]: {
            owner: { sessionId: 'I2', provider: 'claude' },
          },
        },
      });
    });
  }

  it("forks each iteration's same-body consumer from that iteration's source", async () => {
    fixture.mockSameBodySessions();
    const store = await fixture.runAddressableWorkflow(fixture.sameBodyWorkflow(false));
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(fixture.sameBodyConsumerCalls()).toEqual([
      ['A1', true],
      ['A2', true],
    ]);
  });

  for (const missingSource of ['skipped', 'completed without a session'] as const) {
    it(`rejects a stale same-body session when iteration 2's source is ${missingSource}`, async () => {
      const nodes = fixture.sameBodyWorkflow(false);
      const group = nodes[0];
      if (group?.kind !== 'loop_group') throw new Error('missing group');
      const [source, consumer] = group.loop_group.nodes;
      if (!source || consumer?.kind !== 'agent') throw new Error('missing body agents');
      if (missingSource === 'skipped') source.when = '$LOOP_PREV.b.output.skip != true';
      consumer.trigger_rule = 'all_done';
      consumer.output_format = {
        type: 'object',
        properties: { skip: { type: 'boolean' } },
        required: ['skip'],
      };
      group.loop_group.until_bash = 'test $b.output.skip = false';

      let aRuns = 0;
      let bRuns = 0;
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session) {
        const sessionId = prompt === 'a' ? `A${++aRuns}` : `B${++bRuns}`;
        yield { type: 'agent_message_chunk', text: sessionId };
        yield {
          type: 'result',
          ...(prompt === 'a' && aRuns === 2 ? {} : { sessionId }),
          ...(prompt === 'b' ? { structuredOutput: { skip: true } } : {}),
          ...(session ? { resumed: true } : {}),
        };
      });

      const store = await fixture.runAddressableWorkflow(nodes);
      expect(aRuns).toBe(missingSource === 'skipped' ? 1 : 2);
      expect(fixture.sameBodyConsumerCalls()).toEqual([['A1', true]]);
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      const events = persistedEvents(store);
      expect(events).toContainEqual(
        expect.objectContaining({
          event_type: missingSource === 'skipped' ? 'node_skipped' : 'node_completed',
          step_name: 'group.a',
          data: expect.objectContaining({ iteration: 2 }),
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          event_type: 'node_failed',
          step_name: 'group.b',
          data: expect.objectContaining({
            invocation: expect.objectContaining({ loopPath: [{ groupId: 'group', iteration: 2 }] }),
            session_source_node_id: 'a',
            error:
              "Node 'b' cannot resume 'a': the completed source has no available provider session.",
          }),
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ event_type: 'node_failed', step_name: 'group' })
      );
    });
  }

  it("keeps a same-body consumer on its iteration's source across a nested pause", async () => {
    fixture.mockSameBodySessions();
    const nodes = fixture.sameBodyWorkflow(true);
    const firstStore = createEscalationStore('addressable-run');
    await fixture.runAddressableWorkflow(nodes, firstStore);
    expect(firstStore.failWorkflowRun).not.toHaveBeenCalled();
    expect(fixture.sameBodyConsumerCalls()).toEqual([]);
    const metadata = JSON.parse(JSON.stringify(firstStore.getState().metadata));
    // The group tracks ancestry so the pause resumes inside iteration 1, but never
    // persists the same-body consumer as an owner.
    expect(metadata.approval.bodySessionCursorAncestry).toEqual({
      [JSON.stringify(['group', []])]: {},
      [JSON.stringify(['group.inner', [{ groupId: 'group', iteration: 1 }]])]: {},
    });
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
    // The resumed iteration re-runs `a` (A2) and `b` forks that re-run, never the
    // pre-pause A1; iteration 2 forks its own A3.
    expect(fixture.sameBodyConsumerCalls()).toEqual([
      ['A2', true],
      ['A3', true],
    ]);
  });
}
