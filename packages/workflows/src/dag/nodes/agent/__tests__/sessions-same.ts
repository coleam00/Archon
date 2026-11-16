import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ProviderRegistry } from '@archon/provider-contract';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  deliveredMessages,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockProviderRegistry,
  mockSendQueryDag,
  persistedEvents,
  withProviderCapabilities,
  type MockWorkflowStore,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import { createFileWorkflowStore } from '../../../../file-store/store';
import { createEscalationStore } from '../../../pause-test-utils';
import type { DagNode } from '../../../../schemas';
import { dagNodeSchema } from '../../../../schemas';
import type { IWorkflowStore } from '../../../../store';

/** One provider call: the prompt it ran, the session it resumed, and whether it forked. */
interface Call {
  prompt: string;
  resume: string | undefined;
  fork: boolean | undefined;
}

const noForkProviders = withProviderCapabilities(mockProviderRegistry, 'claude', {
  ...mockClaudeCapabilities(),
  sessionFork: false,
});

/** `context: same` (#5711): a node continues the session it last had. */
export function registerSameContextTests(): void {
  describe('context: same', () => {
    let testDir: string;
    let calls: Call[];

    beforeEach(async () => {
      testDir = join(tmpdir(), `dag-same-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(testDir, { recursive: true });
      calls = [];
      const counts = new Map<string, number>();
      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
      mockGetAgentProviderDag.mockImplementation(() => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      }));
      // Each call to prompt P yields session P<n>; `check` reports done on every third call.
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resume, options) {
        calls.push({ prompt, resume, fork: options?.forkSession });
        const n = (counts.get(prompt) ?? 0) + 1;
        counts.set(prompt, n);
        const sessionId = `${prompt}${n}`;
        if (prompt === 'check') {
          const done = n % 3 === 0;
          yield { type: 'agent_message_chunk', text: JSON.stringify({ done }) };
          yield {
            type: 'result',
            sessionId,
            ...(options?.outputFormat ? { structuredOutput: { done } } : {}),
          };
          return;
        }
        yield { type: 'agent_message_chunk', text: sessionId };
        yield { type: 'result', sessionId, ...(resume ? { resumed: true } : {}) };
      });
    });

    afterEach(async () => {
      await removeTempTree(testDir);
    });

    const callsTo = (prompt: string): Omit<Call, 'prompt'>[] =>
      calls.filter(c => c.prompt === prompt).map(({ resume, fork }) => ({ resume, fork }));

    const check: DagNode = {
      id: 'check',
      kind: 'agent',
      source: { kind: 'inline', prompt: 'check' },
      output_format: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done'],
        additionalProperties: false,
      },
    };

    /** A loop whose `build` (and optional parallel `review`) continue their own sessions. */
    function loopWorkflow(options: { freshContext?: boolean; parallelReview?: boolean } = {}) {
      const body: DagNode[] = [
        {
          id: 'build',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'build' },
          context: 'same',
        },
        ...(options.parallelReview
          ? [
              {
                id: 'review',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'review' },
                context: 'same',
              } satisfies DagNode,
            ]
          : []),
        { ...check, depends_on: options.parallelReview ? ['build', 'review'] : ['build'] },
      ];
      return [
        {
          id: 'group',
          kind: 'loop_group',
          loop_group: {
            max_iterations: 3,
            fresh_context: options.freshContext ?? false,
            until_bash: 'test $check.output.done = true',
            nodes: body,
          },
        },
      ] satisfies DagNode[];
    }

    async function run(
      nodes: DagNode[],
      options: {
        store?: IWorkflowStore;
        itemId?: string | null;
        workflowName?: string;
        runId?: string;
        providers?: ProviderRegistry;
      } = {}
    ) {
      const store = options.store ?? createMockStore();
      const platform = createMockPlatform();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store, options.providers ?? mockProviderRegistry),
          platform,
          cwd: testDir,
          workflow: { name: options.workflowName ?? 'same-test', nodes },
          workflowRun: makeWorkflowRun(options.runId ?? 'run-1', {
            item_id: options.itemId ?? null,
          }),
        })
      );
      return { store, platform };
    }

    /** A real store for node sessions, so rows written by one run are read by the next. */
    async function sessionStore(): Promise<MockWorkflowStore> {
      const files = await createFileWorkflowStore({ root: join(testDir, 'store') });
      const store = createMockStore();
      store.listWorkflowNodeSessions.mockImplementation(scope =>
        files.listWorkflowNodeSessions(scope)
      );
      store.upsertWorkflowNodeSession.mockImplementation(row =>
        files.upsertWorkflowNodeSession(row)
      );
      return store;
    }

    it('a loop body node continues its own previous round; round one starts fresh', async () => {
      await run(loopWorkflow());
      expect(callsTo('build')).toEqual([
        { resume: undefined, fork: undefined },
        { resume: 'build1', fork: false },
        { resume: 'build2', fork: false },
      ]);
      // A default-context sequential successor forks build's session as it always has; it
      // never continues it in place, so build's own session stays build's.
      expect(callsTo('check')).toEqual([
        { resume: 'build1', fork: true },
        { resume: 'build2', fork: true },
        { resume: 'build3', fork: true },
      ]);
    });

    it('fresh_context on the loop does not reset it', async () => {
      await run(loopWorkflow({ freshContext: true }));
      expect(callsTo('build').map(c => c.resume)).toEqual([undefined, 'build1', 'build2']);
    });

    it('each node in a parallel layer continues its own session', async () => {
      await run(loopWorkflow({ parallelReview: true }));
      expect(callsTo('build').map(c => c.resume)).toEqual([undefined, 'build1', 'build2']);
      expect(callsTo('review').map(c => c.resume)).toEqual([undefined, 'review1', 'review2']);
    });

    it('continues across runs on one item by forking, and only for that workflow, node and item', async () => {
      const store = await sessionStore();
      const build: DagNode[] = [
        {
          id: 'build',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'build' },
          context: 'same',
        },
      ];
      await run(build, { store, itemId: 'K', runId: 'run-1' });
      expect(
        await store.listWorkflowNodeSessions({ workflow_name: 'same-test', scope_key: 'item:K' })
      ).toEqual([
        expect.objectContaining({
          node_id: 'build',
          provider_session_id: 'build1',
          last_run_id: 'run-1',
        }),
      ]);

      await run(build, { store, itemId: 'K', runId: 'run-2' });
      expect(callsTo('build').at(-1)).toEqual({ resume: 'build1', fork: true });

      await run(build, { store, itemId: 'L', runId: 'run-3' });
      await run(build, { store, itemId: null, runId: 'run-4' });
      await run(build, { store, itemId: 'K', runId: 'run-5', workflowName: 'other-workflow' });
      await run(
        [
          {
            id: 'fix',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'build' },
            context: 'same',
          },
        ],
        { store, itemId: 'K', runId: 'run-6' }
      );
      expect(
        callsTo('build')
          .slice(2)
          .map(c => c.resume)
      ).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('a loop node forks the last round of the earlier run, then continues in place', async () => {
      const store = await sessionStore();
      await run(loopWorkflow(), { store, itemId: 'K', runId: 'run-1' });
      // Rows land under the run's workflow, not the loop group, at the node's qualified path.
      expect(
        await store.listWorkflowNodeSessions({ workflow_name: 'same-test', scope_key: 'item:K' })
      ).toEqual([
        expect.objectContaining({ node_id: 'group.build', provider_session_id: 'build3' }),
      ]);

      calls = [];
      await run(loopWorkflow(), { store, itemId: 'K', runId: 'run-2' });
      expect(callsTo('build').slice(0, 2)).toEqual([
        { resume: 'build3', fork: true },
        { resume: 'build4', fork: false },
      ]);
    });

    it('a provider that cannot fork starts fresh across runs and says so, but still continues between rounds', async () => {
      const store = await sessionStore();
      await run(loopWorkflow(), { store, itemId: 'K', providers: noForkProviders });
      calls = [];
      const { store: second, platform } = await run(loopWorkflow(), {
        store,
        itemId: 'K',
        runId: 'run-2',
        providers: noForkProviders,
      });
      expect(callsTo('build').map(c => c.resume)).toEqual([undefined, 'build4', 'build5']);
      expect(
        persistedEvents(second as MockWorkflowStore).find(
          e => e.event_type === 'node_session_not_continued'
        )?.data
      ).toMatchObject({ reason: 'no_fork', scope_key: 'item:K' });
      expect(deliveredMessages(platform).some(m => m.includes('cannot fork a session'))).toBe(true);
    });

    it.each([
      ['provider_changed', { provider: 'codex', model: 'sonnet' }, 'codex'],
      ['model_changed', { provider: 'claude', model: 'opus' }, 'opus'],
    ] as const)(
      'a session from another pair is not continued (%s)',
      async (reason, recorded, named) => {
        const store = createMockStore();
        store.listWorkflowNodeSessions.mockResolvedValue([
          {
            workflow_name: 'same-test',
            node_id: 'build',
            scope_key: 'item:K',
            ...recorded,
            provider_session_id: 'old-session',
            last_run_id: 'run-0',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          },
        ]);
        const { platform } = await run(
          [
            {
              id: 'build',
              kind: 'agent',
              model: 'sonnet',
              source: { kind: 'inline', prompt: 'build' },
              context: 'same',
            },
          ],
          { store, itemId: 'K' }
        );
        expect(callsTo('build')).toEqual([{ resume: undefined, fork: undefined }]);
        expect(
          persistedEvents(store).find(e => e.event_type === 'node_session_not_continued')?.data
        ).toMatchObject({
          reason,
          provider: 'claude',
          model: 'sonnet',
          recorded_provider: recorded.provider,
          recorded_model: recorded.model,
        });
        expect(
          deliveredMessages(platform).some(m => m.includes('started fresh') && m.includes(named))
        ).toBe(true);
        // The new session is recorded with the pair it ran on.
        expect(store.upsertWorkflowNodeSession).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'claude',
            model: 'sonnet',
            provider_session_id: 'build1',
          })
        );
      }
    );

    it('a gate pause inside the loop keeps the cursor, and the next round continues it', async () => {
      const nodes: DagNode[] = [
        {
          id: 'group',
          kind: 'loop_group',
          loop_group: {
            max_iterations: 2,
            fresh_context: false,
            until_bash: 'exit 1',
            nodes: [
              {
                id: 'build',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'build' },
                context: 'same',
              },
              dagNodeSchema.parse({
                id: 'pause',
                depends_on: ['build'],
                approval: { message: 'Continue?' },
              }),
            ],
          },
        },
      ];
      const firstStore = createEscalationStore('run-1');
      await run(nodes, { store: firstStore });
      expect(firstStore.getState().status).toBe('paused');
      const metadata = JSON.parse(JSON.stringify(firstStore.getState().metadata));
      expect(metadata.approval.bodySessionCursors).toEqual({
        build: { sessionId: 'build1', provider: 'claude' },
      });

      metadata.approval.resolved = 'approved';
      calls = [];
      const resumedStore = createEscalationStore('run-1');
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(resumedStore),
          cwd: testDir,
          workflow: { name: 'same-test', nodes },
          workflowRun: makeWorkflowRun('run-1', { metadata }),
        })
      );
      expect(callsTo('build')).toEqual([{ resume: 'build1', fork: false }]);
    });

    it('a failed lookup runs fresh and says so', async () => {
      const store = createMockStore();
      store.listWorkflowNodeSessions.mockRejectedValue(new Error('database is locked'));
      const { platform } = await run(
        [
          {
            id: 'build',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'build' },
            context: 'same',
          },
        ],
        { store, itemId: 'K' }
      );
      expect(callsTo('build')).toEqual([{ resume: undefined, fork: undefined }]);
      expect(
        deliveredMessages(platform).some(m => m.includes('Could not load the persisted session'))
      ).toBe(true);
    });
  });
}
