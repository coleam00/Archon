import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeDagWorkflow } from '../../../../dag-executor';
import type { WorkflowNodeSession } from '../../../../schemas';
import type { WorkflowNodeSessionKey } from '../../../../store';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockProviderRegistry,
  mockSendQueryDag,
  persistedEvents,
  withProviderCapabilities,
  type MockWorkflowPlatform,
  type MockWorkflowStore,
} from '../../../test-utils';
import type { setupPersistTests } from './sessions-persistence';

export function registerPersistRecoveryTests(fixture: ReturnType<typeof setupPersistTests>) {
  it('persist_session unset → no session is written', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: fixture.testDir,
        workflow: {
          name: 'no-persist',
          nodes: [{ id: 'planner', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it('workflow.persist_sessions: true + node.persist_session: false → node opts out', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: fixture.testDir,
        workflow: {
          name: 'wf-default-on',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: false,
            },
          ],
          persist_sessions: true,
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it("node.context: 'fresh' bypasses cross-run session reuse even when persist_session: true", async () => {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'persist-test',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'prior-id',
        last_run_id: null,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
              context: 'fresh',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[0][3]?.purpose).toBeUndefined();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
  });

  it('persist_session: true on non-resume-capable provider → throws clear error', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(
      store,
      withProviderCapabilities(mockProviderRegistry, 'claude', {
        ...mockClaudeCapabilities(),
        sessionResume: false,
        sessionFork: false,
      })
    );
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    // executeDagWorkflow catches the per-node error and records it against the node.
    const failed = persistedEvents(store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'planner'
    );
    expect(failed?.data?.error).toBe(
      "Node 'planner' has persist_session: true but resolved provider 'claude' does not " +
        'support sessionResume. Remove persist_session, or use a provider with ' +
        'sessionResume capability.'
    );
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
    expect(mockGetAgentProviderDag).not.toHaveBeenCalled();
  });

  it('workflow.persist_sessions: true + node unset → node inherits persistence', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: fixture.testDir,
        workflow: {
          name: 'wf-inherit',
          nodes: [{ id: 'planner', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
          persist_sessions: true,
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock).toHaveBeenCalledWith({
      workflow_name: 'wf-inherit',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('a scoped run with no persisted node never reads the session store', async () => {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [{ id: 'planner', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );
    expect(mockSendQueryDag).toHaveBeenCalled();
    expect(store.listWorkflowNodeSessions).not.toHaveBeenCalled();
  });

  it('a failed session read with a persisted node that never dispatches does not reject unhandled', async () => {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockRejectedValue(new Error('DB timeout'));
    // Bun fails the test on an unhandled rejection; the node never awaits the read.
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
              when: '1 == 0',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.listWorkflowNodeSessions).toHaveBeenCalled();
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('persist_session lookup failure → node runs fresh and upserts (non-fatal)', async () => {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockRejectedValue(new Error('DB timeout'));
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    // Lookup threw → node still runs, with no resume session.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    // The successful node still persists its new session id.
    expect(store.upsertWorkflowNodeSession).toHaveBeenCalled();
    // The user is warned the session could not be loaded.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warned = sendMessage.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .some(m => m.includes('persisted session') && m.includes('planner'));
    expect(warned).toBe(true);
  });

  it('persist_session upsert failure → node still completes and user is warned (non-fatal)', async () => {
    const store = createMockStore();
    (
      store.upsertWorkflowNodeSession as Mock<typeof store.upsertWorkflowNodeSession>
    ).mockRejectedValue(new Error('write error'));
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    // Upsert threw, but the node executed (sendQuery ran) and the user was warned —
    // the failure did not abort the node.
    expect(mockSendQueryDag).toHaveBeenCalled();
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warned = sendMessage.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .some(m => m.includes('Could not persist') && m.includes('planner'));
    expect(warned).toBe(true);
  });
}

export function registerConcurrentPersistTests() {
  // #2667: two overlapping runs of one workflow in one scope share the persisted row. Each run
  // must take its own copy of the session as it stood when the run started.
  describe('executeDagWorkflow -- concurrent persist_session runs (#2667)', () => {
    let rootDir: string;

    /** Node-session store keyed exactly like the table's primary key. */
    function sessionTableStore(initial: string): {
      store: MockWorkflowStore;
      row: () => WorkflowNodeSession | undefined;
    } {
      const rows = new Map<string, WorkflowNodeSession>();
      const key = (k: WorkflowNodeSessionKey): string =>
        [k.workflow_name, k.node_id, k.scope_key, k.provider].join('|');
      const seed: WorkflowNodeSessionKey = {
        workflow_name: 'persist-race',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
      };
      rows.set(key(seed), {
        ...seed,
        provider_session_id: initial,
        last_run_id: 'earlier-run',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      });
      const store = createMockStore();
      store.listWorkflowNodeSessions.mockImplementation(async scope =>
        [...rows.values()].filter(
          row => row.workflow_name === scope.workflow_name && row.scope_key === scope.scope_key
        )
      );
      store.upsertWorkflowNodeSession.mockImplementation(async params => {
        rows.set(key(params), {
          ...params,
          created_at: '2026-10-03T00:00:00Z',
          updated_at: '2026-10-03T00:00:00Z',
        });
      });
      return { store, row: () => rows.get(key(seed)) };
    }

    /**
     * Starts run B, lets run A run to completion while B's first node is held open, then
     * releases B. Returns what each run's `planner` handed the provider.
     */
    async function raceTwoRuns(opts: {
      sessionFork: boolean;
      plannerSessionId: (run: 'a' | 'b') => string | undefined;
    }): Promise<{
      store: MockWorkflowStore;
      row: () => WorkflowNodeSession | undefined;
      plannerResume: Map<'a' | 'b', { resume: string | undefined; fork: boolean | undefined }>;
      platforms: Record<'a' | 'b', MockWorkflowPlatform>;
    }> {
      const { store, row } = sessionTableStore('S0');
      const cwds = { a: join(rootDir, 'a'), b: join(rootDir, 'b') } as const;
      for (const cwd of Object.values(cwds)) {
        await mkdir(join(cwd, '.archon', 'commands'), { recursive: true });
      }
      const runOf = (cwd: string): 'a' | 'b' => (cwd === cwds.a ? 'a' : 'b');
      let releaseB: () => void = () => {};
      const bHeld = new Promise<void>(resolve => {
        releaseB = resolve;
      });
      const plannerResume = new Map<
        'a' | 'b',
        { resume: string | undefined; fork: boolean | undefined }
      >();
      mockSendQueryDag.mockImplementation(async function* (prompt, cwd, resume, options) {
        const run = runOf(cwd);
        if (prompt.includes('warm up')) {
          if (run === 'b') await bHeld;
          yield { type: 'agent_message_chunk', text: 'warm' };
          yield { type: 'result', sessionId: `${run}-warmup` };
          return;
        }
        plannerResume.set(run, { resume, fork: options?.forkSession });
        yield { type: 'agent_message_chunk', text: 'planned' };
        const sessionId = opts.plannerSessionId(run);
        yield sessionId === undefined ? { type: 'result' } : { type: 'result', sessionId };
      });
      const deps = createMockDeps(
        store,
        withProviderCapabilities(mockProviderRegistry, 'claude', {
          ...mockClaudeCapabilities(),
          sessionFork: opts.sessionFork,
        })
      );
      const platforms = { a: createMockPlatform(), b: createMockPlatform() };
      const start = (run: 'a' | 'b'): Promise<unknown> =>
        executeDagWorkflow(
          dagOptions({
            deps,
            platform: platforms[run],
            cwd: cwds[run],
            workflow: {
              name: 'persist-race',
              nodes: [
                { id: 'warmup', kind: 'agent', source: { kind: 'inline', prompt: 'warm up' } },
                {
                  id: 'planner',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'plan it' },
                  depends_on: ['warmup'],
                  persist_session: true,
                },
              ],
            },
            workflowRun: makeWorkflowRun(`run-${run}`, { workflow_name: 'persist-race' }),
          })
        );

      const runB = start('b');
      await start('a');
      releaseB();
      await runB;
      return { store, row, plannerResume, platforms };
    }

    beforeEach(async () => {
      rootDir = join(
        tmpdir(),
        `dag-persist-race-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mockSendQueryDag.mockClear();
      mockGetAgentProviderDag.mockClear();
    });

    afterEach(async () => {
      await removeTempTree(rootDir);
    });

    it('each run forks the session the row held when that run started', async () => {
      const { row, plannerResume } = await raceTwoRuns({
        sessionFork: true,
        plannerSessionId: run => `${run}-planner`,
      });

      expect(plannerResume.get('a')).toEqual({ resume: 'S0', fork: true });
      // Run A finished `planner` while B was running; B still copies what existed at its start.
      expect(plannerResume.get('b')).toEqual({ resume: 'S0', fork: true });
      // B finished last, so the cursor advances to its session.
      expect(row()?.provider_session_id).toBe('b-planner');
      expect(row()?.last_run_id).toBe('run-b');
    });

    it('a provider without sessionFork never receives the persisted session', async () => {
      const { store, row, plannerResume, platforms } = await raceTwoRuns({
        sessionFork: false,
        plannerSessionId: run => `${run}-planner`,
      });

      // Each run's planner continues only its own run's conversation, never the persisted S0.
      expect(plannerResume.get('a')?.resume).toBe('a-warmup');
      expect(plannerResume.get('b')?.resume).toBe('b-warmup');
      const notContinued = store.createWorkflowEvent.mock.calls
        .map(([event]) => event)
        .filter(event => event.event_type === 'node_session_not_continued');
      expect(notContinued.map(event => event.workflow_run_id).sort()).toEqual(['run-a', 'run-b']);
      for (const event of notContinued) {
        expect(event.step_name).toBe('planner');
        expect(event.data).toEqual({
          provider: 'claude',
          scope_key: 'conv-dag',
          provider_session_id_preview: 'S0',
        });
      }
      for (const platform of Object.values(platforms)) {
        const told = platform.sendMessage.mock.calls.some(([, message]) =>
          message.includes('cannot fork')
        );
        expect(told).toBe(true);
      }
      expect(row()?.provider_session_id).toBe('b-planner');
    });

    it("a run that returns no session id leaves a sibling's newer cursor in place", async () => {
      const { row } = await raceTwoRuns({
        sessionFork: true,
        plannerSessionId: run => (run === 'a' ? 'a-planner' : undefined),
      });

      expect(row()?.provider_session_id).toBe('a-planner');
    });
  });
}
