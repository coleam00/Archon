import { afterEach, beforeEach, expect, it, mock, type Mock } from 'bun:test';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ResultChunk } from '@archon/provider-contract';
import {
  createMockDeps,
  createMockPlatform,
  createMockStore,
  dagOptions,
  deliveredMessages,
  makeWorkflowRun,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  mockSendQueryDag,
} from '../../../test-utils';
import { executeDagWorkflow } from '../../../../dag-executor';
import { writeNodeArtifact } from '../../../../artifacts-index';

export function setupPersistTests() {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'My command prompt for $USER_MESSAGE');

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: 'new-session-id' };
    });
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  /** Run a `persist_session` planner whose resume of 'prior-session-id' is rejected with `rejection`. */
  async function runRejectedPersistedResume(rejection: ResultChunk) {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'persist-test',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'prior-session-id',
        last_run_id: 'prior-run',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const platform = createMockPlatform();

    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, resumeSessionId) {
      if (resumeSessionId !== undefined) {
        yield { ...rejection, sessionId: resumeSessionId, resumed: true };
        return;
      }
      yield { type: 'agent_message_chunk', text: 'fresh run' };
      yield { type: 'result', sessionId: 'fresh-id' };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        cwd: testDir,
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
    return { store, platform };
  }

  const executionError: ResultChunk = {
    type: 'result',
    isError: true,
    errorSubtype: 'error_during_execution',
    failure: { class: 'unknown', evidence: 'error_during_execution: evidence' },
  };

  // --- #1846: cross-invocation artifact scope + cold-resume pointer recovery ---

  /** Arm the mocks for a cold resume: a persisted prior session that the provider
   *  reports back as not resumed (fresh fallback). */
  function armColdResume(store: ReturnType<typeof createMockStore>): void {
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'persist-test',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'prior-session-id',
        last_run_id: 'prior-run',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    mockSendQueryDag.mockClear();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'cold run' };
      yield { type: 'result', sessionId: 'cold-id', resumed: false };
    });
  }
  return {
    get testDir() {
      return testDir;
    },
    runRejectedPersistedResume,
    executionError,
    armColdResume,
  };
}

export function registerPersistenceTests(fixture: ReturnType<typeof setupPersistTests>) {
  it('persist_session: true with no prior row → fresh resumeSessionId, upsert on completion', async () => {
    const store = createMockStore();
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
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(store.listWorkflowNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'persist-test',
      scope_key: 'conv-dag',
    });

    const resumeSessionArg = mockSendQueryDag.mock.calls[0][2];
    expect(resumeSessionArg).toBeUndefined();

    expect(upsertMock).toHaveBeenCalledWith({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('persist_session: true with prior row → resumeSessionId loaded, upsert with new id', async () => {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'persist-test',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'prior-session-id',
        last_run_id: 'prior-run',
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
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(mockSendQueryDag.mock.calls[0][2]).toBe('prior-session-id');
    // A warm resume (resumed not false) runs the node exactly once — never replayed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock.mock.calls[0][0]).toEqual({
      workflow_name: 'persist-test',
      node_id: 'planner',
      scope_key: 'conv-dag',
      provider: 'claude',
      provider_session_id: 'new-session-id',
      last_run_id: 'dag-test-run-id',
    });
  });

  it('picks only the row matching both node id and provider from the scope snapshot', async () => {
    const row = (node_id: string, provider: string, provider_session_id: string) => ({
      workflow_name: 'persist-test',
      node_id,
      scope_key: 'conv-dag',
      provider,
      provider_session_id,
      last_run_id: 'prior-run',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    });
    const nonMatching = [
      row('reviewer', 'claude', 'reviewer-claude'),
      row('planner', 'codex', 'planner-codex'),
    ];
    const workflow = {
      name: 'persist-test',
      nodes: [
        {
          id: 'planner',
          kind: 'agent' as const,
          source: { kind: 'command' as const, name: 'my-cmd' },
          persist_session: true,
        },
      ],
    };

    const withMatch = createMockStore();
    withMatch.listWorkflowNodeSessions.mockResolvedValue([
      ...nonMatching,
      row('planner', 'claude', 'planner-claude'),
    ]);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(withMatch),
        cwd: fixture.testDir,
        workflow,
        workflowRun: makeWorkflowRun(),
      })
    );
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('planner-claude');

    mockSendQueryDag.mockClear();
    const withoutMatch = createMockStore();
    withoutMatch.listWorkflowNodeSessions.mockResolvedValue(nonMatching);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(withoutMatch),
        cwd: fixture.testDir,
        workflow,
        workflowRun: makeWorkflowRun(),
      })
    );
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    const eventTypes = withoutMatch.createWorkflowEvent.mock.calls.map(c => c[0].event_type);
    expect(eventTypes).not.toContain('node_session_resumed');
  });

  it('runs launched from one thread share the session even when each runs in its own conversation (#3585)', async () => {
    // Web dispatch runs every workflow in a fresh hidden worker conversation and records
    // the user's chat as parent_conversation_id. The scope must follow the chat.
    const store = createMockStore();
    const rows = new Map<string, string>();
    store.listWorkflowNodeSessions.mockImplementation(async scope => {
      const id = rows.get(scope.scope_key);
      return id === undefined
        ? []
        : [
            {
              ...scope,
              node_id: 'planner',
              provider: 'claude',
              provider_session_id: id,
              last_run_id: null,
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-01T00:00:00Z',
            },
          ];
    });
    store.upsertWorkflowNodeSession.mockImplementation(async params => {
      rows.set(params.scope_key, params.provider_session_id);
    });
    let sessionCount = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      sessionCount += 1;
      yield { type: 'agent_message_chunk', text: 'AI response' };
      yield { type: 'result', sessionId: `session-${sessionCount}` };
    });

    for (const [runId, workerConversation] of [
      ['run-1', 'worker-1'],
      ['run-2', 'worker-2'],
    ]) {
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
              },
            ],
          },
          workflowRun: makeWorkflowRun(runId, {
            conversation_id: workerConversation,
            parent_conversation_id: 'chat-1',
          }),
        })
      );
    }

    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('session-1');
    expect([...rows.entries()]).toEqual([['chat-1', 'session-2']]);
  });

  it('persist_session resume returns cold (resumed:false) → surfaced to user, no re-run, fresh id persisted', async () => {
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'persist-test',
        node_id: 'planner',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'prior-session-id',
        last_run_id: 'prior-run',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();

    mockSendQueryDag.mockClear();
    // The provider could not resume the prior session and ran cold (already a
    // clean fresh session). The executor must keep this run, not re-run it.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'cold run' };
      yield { type: 'result', sessionId: 'cold-id', resumed: false };
    });

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

    // Ran exactly once — a cold resume is NOT replayed (the cold run is already fresh).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('prior-session-id');
    // The cold resume was surfaced to the user — never silent.
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    // The cold run's own fresh session id is what gets persisted for next time.
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock.mock.calls[0][0]).toMatchObject({ provider_session_id: 'cold-id' });
  });

  it('persist_session resume rejected as stale → retried once fresh, completed, fresh id persisted', async () => {
    const { store, platform } = await fixture.runRejectedPersistedResume({
      ...fixture.executionError,
      sessionNotFound: true,
    });

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual([
      'prior-session-id',
      undefined,
    ]);
    const completed = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(call => call[0] as { event_type: string; step_name?: string })
      .some(event => event.event_type === 'node_completed' && event.step_name === 'planner');
    expect(completed).toBe(true);
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(c =>
      String(c[1])
    );
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    const upsertMock = store.upsertWorkflowNodeSession as Mock<
      typeof store.upsertWorkflowNodeSession
    >;
    expect(upsertMock.mock.calls[0][0]).toMatchObject({ provider_session_id: 'fresh-id' });
  });

  it('persist_session resume failing without a stale report is not retried fresh', async () => {
    const { store } = await fixture.runRejectedPersistedResume(fixture.executionError);

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual(['prior-session-id']);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('cold resume with prior scope artifacts → warning carries a by-reference pointer', async () => {
    const scopeDir = join(fixture.testDir, 'scope-artifacts');
    // A PRIOR invocation left a typed artifact in the stable scope dir.
    await writeNodeArtifact(
      scopeDir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'prior-run',
        producedAt: '2026-05-01T00:00:00Z',
      },
      'the prior plan'
    );
    const store = createMockStore();
    fixture.armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
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
        scopeArtifactsDir: scopeDir,
      })
    );

    // By reference: the message names the artifact file's path — never its content.
    expect(deliveredMessages(platform)).toContain(
      '⚠️ Node `planner`: could not resume the prior session — continued with a fresh ' +
        'session, so the earlier context was not restored.\n' +
        'Artifacts from the previous invocation are available for recovery (read on demand):\n' +
        `- plan (\`planner\`): ${join(scopeDir, 'nodes', 'planner.md')}`
    );
    // The #1842 invariant holds: the cold run is kept, never replayed.
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('cold resume with scope artifacts only from the CURRENT run → plain warning, no pointer', async () => {
    const scopeDir = join(fixture.testDir, 'scope-artifacts');
    // Only this run's own mirror exists — it recovers nothing.
    await writeNodeArtifact(
      scopeDir,
      {
        nodeId: 'planner',
        outputType: 'plan',
        runId: 'dag-test-run-id',
        producedAt: '2026-05-01T00:00:00Z',
      },
      'this run output'
    );
    const store = createMockStore();
    fixture.armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
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
        scopeArtifactsDir: scopeDir,
      })
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    expect(messages.some(m => m.includes('available for recovery'))).toBe(false);
  });

  it('cold resume with an empty/absent scope dir → plain warning, no pointer', async () => {
    const store = createMockStore();
    fixture.armColdResume(store);
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
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
        scopeArtifactsDir: join(fixture.testDir, 'scope-artifacts-never-created'),
      })
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    expect(messages.some(m => m.includes('available for recovery'))).toBe(false);
  });

  it('persist node with output_type mirrors its typed sidecar into the scope dir', async () => {
    const scopeDir = join(fixture.testDir, 'scope-artifacts');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
              output_type: 'plan',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
        scopeArtifactsDir: scopeDir,
      })
    );

    // Written to BOTH the per-run dir and the durable scope dir.
    const runCopy = await readFile(
      join(fixture.testDir, 'artifacts', 'nodes', 'planner.md'),
      'utf8'
    );
    const scopeCopy = await readFile(join(scopeDir, 'nodes', 'planner.md'), 'utf8');
    expect(runCopy).toBe('AI response');
    expect(scopeCopy).toBe('AI response');
    const scopeMeta = JSON.parse(
      await readFile(join(scopeDir, 'nodes', 'planner.meta.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(scopeMeta).toMatchObject({
      nodeId: 'planner',
      outputType: 'plan',
      runId: 'dag-test-run-id',
    });
  });

  it('non-persist node with output_type does NOT mirror into the scope dir', async () => {
    const scopeDir = join(fixture.testDir, 'scope-artifacts');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          // scope dir present (another node opted in), but THIS node doesn't persist.
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              output_type: 'plan',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
        scopeArtifactsDir: scopeDir,
      })
    );

    // Run-dir sidecar exists; the scope dir stays untouched.
    const runCopy = await readFile(
      join(fixture.testDir, 'artifacts', 'nodes', 'planner.md'),
      'utf8'
    );
    expect(runCopy).toBe('AI response');
    let scopeWrote = true;
    try {
      await readFile(join(scopeDir, 'nodes', 'planner.md'), 'utf8');
    } catch {
      scopeWrote = false;
    }
    expect(scopeWrote).toBe(false);
  });

  it('scope mirror write failure is non-fatal — node completes, run-dir sidecar intact', async () => {
    const scopeDir = join(fixture.testDir, 'scope-artifacts');
    // Force the scope write to fail: a FILE where the nodes/ dir must go.
    await mkdir(scopeDir, { recursive: true });
    await writeFile(join(scopeDir, 'nodes'), 'not a directory', 'utf8');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: fixture.testDir,
        workflow: {
          name: 'persist-test',
          nodes: [
            {
              id: 'planner',
              kind: 'agent',
              source: { kind: 'command', name: 'my-cmd' },
              persist_session: true,
              output_type: 'plan',
            },
          ],
        },
        workflowRun: makeWorkflowRun(),
        scopeArtifactsDir: scopeDir,
      })
    );

    // Node ran and the run-dir sidecar was still written (mirror is best-effort).
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const runCopy = await readFile(
      join(fixture.testDir, 'artifacts', 'nodes', 'planner.md'),
      'utf8'
    );
    expect(runCopy).toBe('AI response');
  });
}
