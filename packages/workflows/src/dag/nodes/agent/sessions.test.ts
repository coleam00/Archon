// @archon-test-isolated
import { createEscalationStore } from '../../pause-test-utils';
import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProviderRegistry } from '@archon/provider-contract';
import {
  type MockWorkflowStore,
  createMockStore,
  withProviderCapabilities,
  mockClaudeCapabilities,
  mockProviderRegistry,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  type MockWorkflowPlatform,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
  failedLoopIterations,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { writeNodeArtifact } from '../../../artifacts-index';
import type {
  DagNode,
  WorkflowRun,
  WorkflowRunNodeSession,
  WorkflowNodeSession,
} from '../../../schemas';
import { dagNodeSchema } from '../../../schemas';
import type { WorkflowDeps } from '../../../deps';
import type { IWorkflowStore, PersistedNodeOutput, WorkflowNodeSessionKey } from '../../../store';

describe('executeDagWorkflow -- persist_session', () => {
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

  it('persist_session: true with no prior row → fresh resumeSessionId, upsert on completion', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
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
        cwd: testDir,
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
        cwd: testDir,
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

  it('cold resume with prior scope artifacts → warning carries a by-reference pointer', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');
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
    armColdResume(store);
    const platform = createMockPlatform();

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
    const scopeDir = join(testDir, 'scope-artifacts');
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
    armColdResume(store);
    const platform = createMockPlatform();

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
    armColdResume(store);
    const platform = createMockPlatform();

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
        scopeArtifactsDir: join(testDir, 'scope-artifacts-never-created'),
      })
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map(c => String(c[1]));
    expect(messages.some(m => m.includes('could not resume the prior session'))).toBe(true);
    expect(messages.some(m => m.includes('available for recovery'))).toBe(false);
  });

  it('persist node with output_type mirrors its typed sidecar into the scope dir', async () => {
    const scopeDir = join(testDir, 'scope-artifacts');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
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
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
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
    const scopeDir = join(testDir, 'scope-artifacts');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
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
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
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
    const scopeDir = join(testDir, 'scope-artifacts');
    // Force the scope write to fail: a FILE where the nodes/ dir must go.
    await mkdir(scopeDir, { recursive: true });
    await writeFile(join(scopeDir, 'nodes'), 'not a directory', 'utf8');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
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
    const runCopy = await readFile(join(testDir, 'artifacts', 'nodes', 'planner.md'), 'utf8');
    expect(runCopy).toBe('AI response');
  });

  it('persist_session unset → no session is written', async () => {
    const store = createMockStore();
    const mockDeps = createMockDeps(store);

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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
        cwd: testDir,
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

    // Upsert threw, but the node executed (sendQuery ran) and the user was warned —
    // the failure did not abort the node.
    expect(mockSendQueryDag).toHaveBeenCalled();
    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const warned = sendMessage.mock.calls
      .map((call: unknown[]) => call[1] as string)
      .some(m => m.includes('Could not persist') && m.includes('planner'));
    expect(warned).toBe(true);
  });
});

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

describe('executeDagWorkflow -- addressable session resume', () => {
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
        const store = await runAddressableWorkflow(ownerWorkflow(provider, fresh));
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
    const nodes = ownerWorkflow('claude', true);
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
    const store = await runAddressableWorkflow(nodes);
    const pause = (store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>).mock
      .calls[0]?.[1];
    expect(pause?.bodySessionCursors).toEqual({ owner: { sessionId: 'O', provider: 'claude' } });
    const resumedStore = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(resumedStore),
        conversationId: 'conv-addressable',
        cwd: testDir,
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
      const nodes = ownerWorkflow('claude', true);
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
      await runAddressableWorkflow(nodes, firstStore);
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
            cwd: testDir,
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
      const nodes = ownerWorkflow('claude', true);
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
      await runAddressableWorkflow(nodes, firstStore);
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
      const resume = async (state: Record<string, unknown>, failBeforeReplay = false) => {
        const resumedStore = createEscalationStore('addressable-run');
        if (failBeforeReplay) {
          const getStatus = resumedStore.getWorkflowRunStatus.getMockImplementation();
          let rejected = false;
          resumedStore.getWorkflowRunStatus.mockImplementation(async id => {
            if (
              !rejected &&
              persistedEvents(resumedStore).some(
                event => event.event_type === 'node_started' && event.step_name === 'outer'
              )
            ) {
              rejected = true;
              throw new Error('Enclosing replay status read failed');
            }
            return getStatus?.(id) ?? 'running';
          });
        }
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(resumedStore),
            cwd: testDir,
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
      expect(await failedLoopIterations('outer', () => resume(metadata, true))).toBe(1);
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

  it("forks each iteration's same-body consumer from that iteration's source", async () => {
    mockSameBodySessions();
    const store = await runAddressableWorkflow(sameBodyWorkflow(false));
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(sameBodyConsumerCalls()).toEqual([
      ['A1', true],
      ['A2', true],
    ]);
  });

  for (const missingSource of ['skipped', 'completed without a session'] as const) {
    it(`rejects a stale same-body session when iteration 2's source is ${missingSource}`, async () => {
      const nodes = sameBodyWorkflow(false);
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

      const store = await runAddressableWorkflow(nodes);
      expect(aRuns).toBe(missingSource === 'skipped' ? 1 : 2);
      expect(sameBodyConsumerCalls()).toEqual([['A1', true]]);
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
    mockSameBodySessions();
    const nodes = sameBodyWorkflow(true);
    const firstStore = createEscalationStore('addressable-run');
    await runAddressableWorkflow(nodes, firstStore);
    expect(firstStore.failWorkflowRun).not.toHaveBeenCalled();
    expect(sameBodyConsumerCalls()).toEqual([]);
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
        cwd: testDir,
        workflow: { name: 'addressable', nodes },
        workflowRun: makeWorkflowRun('addressable-run', { metadata }),
      })
    );
    expect(resumedStore.failWorkflowRun).not.toHaveBeenCalled();
    // The resumed iteration re-runs `a` (A2) and `b` forks that re-run, never the
    // pre-pause A1; iteration 2 forks its own A3.
    expect(sameBodyConsumerCalls()).toEqual([
      ['A2', true],
      ['A3', true],
    ]);
  });

  it('finishes a same-body consumer after approval through an ownerless wrapper', async () => {
    mockSameBodySessions(2);
    const body = sameBodyWorkflow(true);
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
    await runAddressableWorkflow(nodes, firstStore);
    expect(firstStore.getState().status).toBe('paused');
    expect(sameBodyConsumerCalls()).toEqual([['A1', true]]);
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
        cwd: testDir,
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
    expect(sameBodyConsumerCalls()).toEqual([
      ['A1', true],
      ['A3', true],
    ]);
  });

  for (const source of ['prompt', 'command'] as const) {
    for (const feedback of [false, true]) {
      it(`forks each interactive same-body ${source} source after its own approval (feedback: ${feedback})`, async () => {
        const nodes = sameBodyWorkflow(false);
        const group = nodes[0];
        if (group?.kind !== 'loop_group') throw new Error('missing group');
        if (source === 'command') {
          const commandsDir = join(testDir, '.archon', 'commands');
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
        let store = createEscalationStore('addressable-run');
        await runAddressableWorkflow(nodes, store);
        async function approve(feedbackGiven = false): Promise<void> {
          const metadata = JSON.parse(JSON.stringify(store.getState().metadata));
          metadata.approval.resolved = 'approved';
          metadata.loop_feedback_given = feedbackGiven;
          metadata.loop_user_input = feedbackGiven ? 'Refine it.' : '';
          store = createEscalationStore('addressable-run');
          await executeDagWorkflow(
            dagOptions({
              deps: createMockDeps(store),
              cwd: testDir,
              workflow: { name: 'addressable', nodes },
              workflowRun: makeWorkflowRun('addressable-run', { metadata }),
            })
          );
        }
        expect(store.getState().status).toBe('paused');
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(sameBodyConsumerCalls()).toEqual([]);
        expect(persistedEvents(store)).not.toContainEqual(
          expect.objectContaining({ event_type: 'node_completed', step_name: 'group' })
        );
        const firstApproval = store.getState().metadata.approval;
        expect(firstApproval).toMatchObject({
          iteration: 1,
          sessionId: 'A1',
          execution: { invocation: { loopPath: [{ groupId: 'group', iteration: 1 }] } },
          bodySessionCursorAncestry: { [JSON.stringify(['group', []])]: {} },
        });
        await approve(feedback);
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.getState().status).toBe('paused');
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        expect(aRuns).toBe(2);
        expect(mockSendQueryDag.mock.calls.filter(c => c[0] !== 'b').map(c => c[2])).toEqual(
          feedback ? [undefined, 'A1', undefined] : [undefined, undefined]
        );
        expect(sameBodyConsumerCalls()).toEqual([['A1', true]]);
        expect(store.getState().metadata.approval).toMatchObject({
          iteration: 1,
          sessionId: 'A2',
          execution: { invocation: { loopPath: [{ groupId: 'group', iteration: 2 }] } },
        });
        await approve();
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.completeWorkflowRun).toHaveBeenCalled();
        expect(aRuns).toBe(2);
        expect(sameBodyConsumerCalls()).toEqual([
          ['A1', true],
          ['A2', true],
        ]);
        expect(persistedEvents(store)).toContainEqual(
          expect.objectContaining({
            event_type: 'node_completed',
            step_name: 'group.a',
            data: expect.objectContaining({
              invocation: expect.objectContaining({
                loopPath: [{ groupId: 'group', iteration: 2 }],
              }),
            }),
          })
        );
      });
    }
  }

  it('restores same-body ancestry across terminal duration waits in both iterations', async () => {
    mockSameBodySessions();
    const nodes = sameBodyWorkflow(false);
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
    await runAddressableWorkflow(nodes, store);
    for (const iteration of [1, 2]) {
      expect(store.getState().status).toBe('paused');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      const metadata = JSON.parse(JSON.stringify(store.getState().metadata));
      expect(metadata.wait).toMatchObject({
        iteration,
        bodySessionCursors: {},
        bodySessionCursorAncestry: { [JSON.stringify(['group', []])]: {} },
      });
      expect(sameBodyConsumerCalls()).toEqual(
        iteration === 1
          ? [['A1', true]]
          : [
              ['A1', true],
              ['A2', true],
            ]
      );
      metadata.wait.resumeAt = '2020-01-01T00:00:00.000Z';
      store = createEscalationStore('addressable-run');
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
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
    expect(sameBodyConsumerCalls()).toEqual([
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
          cwd: testDir,
          workflow: { name: 'addressable', nodes: ownerWorkflow() },
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
    const nodes = ownerWorkflow();
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
    const store = await runAddressableWorkflow(nodes);
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
    const store = await runAddressableWorkflow([outer]);
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
    const nodes = ownerWorkflow('pi');
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
        sessionId:
          prompt === 'source'
            ? 'S'
            : isOwner
              ? ownerPass <= 2
                ? `O${ownerPass}`
                : ownerPass === 4
                  ? 'repair'
                  : 'O2'
              : `R${reviews}`,
        ...(options?.outputFormat ? { structuredOutput: output } : {}),
        ...(session ? { resumed: true } : {}),
      };
    });
    const store = await runAddressableWorkflow(nodes);
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
      mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, session, options) {
        if (prompt === 'owner') owners++;
        yield {
          type: 'agent_message_chunk',
          text: prompt === 'review' ? '{"done":false}' : prompt,
        };
        yield {
          type: 'result',
          sessionId:
            prompt === 'source'
              ? 'S'
              : prompt === 'owner'
                ? owners === 2 && failure === 'missing'
                  ? undefined
                  : owners === 2 && failure === 'replacement'
                    ? 'replacement'
                    : 'O'
                : 'R',
          ...(options?.outputFormat ? { structuredOutput: { done: false } } : {}),
          ...(session ? { resumed: !(owners === 2 && failure === 'cold') } : {}),
        };
      });
      const store = await runAddressableWorkflow(ownerWorkflow());
      expect(store.failWorkflowRun).toHaveBeenCalled();
      expect(mockSendQueryDag.mock.calls.filter(c => c[0] === 'owner').map(c => c[2])).toEqual([
        'S',
        'O',
      ]);
    });
  }

  it('forks interleaved writer and reviewer lineages from each named ancestor', async () => {
    const sessionsByPrompt: Record<string, string> = {
      writer1: 'session-writer-1',
      reviewer1: 'session-reviewer-1',
      writer2: 'session-writer-2',
      reviewer2: 'session-reviewer-2',
      writer3: 'session-writer-3',
    };
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: `done ${prompt}` };
      yield {
        type: 'result',
        sessionId: sessionsByPrompt[prompt],
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });

    const store = await runAddressableWorkflow([
      { id: 'writer1', kind: 'agent', source: { kind: 'inline', prompt: 'writer1' } },
      {
        id: 'reviewer1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'reviewer1' },
        context: 'fresh',
        depends_on: ['writer1'],
      },
      {
        id: 'writer2',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'writer2' },
        context: { resume: 'writer1' },
        depends_on: ['reviewer1'],
      },
      {
        id: 'reviewer2',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'reviewer2' },
        context: { resume: 'reviewer1' },
        depends_on: ['writer2'],
      },
      {
        id: 'writer3',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'writer3' },
        context: { resume: 'writer2' },
        depends_on: ['reviewer2'],
      },
    ]);

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual([
      undefined,
      undefined,
      'session-writer-1',
      'session-reviewer-1',
      'session-writer-2',
    ]);
    expect(mockSendQueryDag.mock.calls.slice(2).every(call => call[3]?.forkSession === true)).toBe(
      true
    );

    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string; data?: Record<string, unknown> }
    );
    const writer2Started = events.find(
      event => event.event_type === 'node_started' && event.step_name === 'writer2'
    );
    const writer2Completed = events.find(
      event => event.event_type === 'node_completed' && event.step_name === 'writer2'
    );
    expect(writer2Started?.data).toMatchObject({
      session_source_node_id: 'writer1',
      session_fork_requested: true,
    });
    expect(writer2Completed?.data).toMatchObject({
      session_source_node_id: 'writer1',
      session_forked: true,
    });
    // Each completed node names its own session in `session_id` and nowhere else.
    expect(
      events
        .filter(event => event.event_type === 'node_completed')
        .map(event => [event.step_name, event.data?.session_id])
    ).toEqual([
      ['writer1', 'session-writer-1'],
      ['reviewer1', 'session-reviewer-1'],
      ['writer2', 'session-writer-2'],
      ['reviewer2', 'session-reviewer-2'],
      ['writer3', 'session-writer-3'],
    ]);
    const serializedEvents = JSON.stringify(
      events.map(event => {
        const data = { ...event.data };
        delete data.session_id;
        return { ...event, data };
      })
    );
    for (const sessionId of Object.values(sessionsByPrompt)) {
      expect(serializedEvents).not.toContain(sessionId);
    }
  });

  it('forks parallel consumers from the same immutable source without replacing it', async () => {
    let sequence = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      sequence++;
      yield { type: 'agent_message_chunk', text: prompt };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'source-session' : `branch-${String(sequence)}`,
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });

    await runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'lens-a',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'lens-a' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
      {
        id: 'lens-b',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'lens-b' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
      {
        id: 'synthesis',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'synthesis' },
        context: { resume: 'source' },
        depends_on: ['lens-a', 'lens-b'],
      },
    ]);

    const namedCalls = mockSendQueryDag.mock.calls.filter(call => call[0] !== 'source');
    expect(namedCalls.map(call => call[2])).toEqual([
      'source-session',
      'source-session',
      'source-session',
    ]);
    expect(namedCalls.every(call => call[3]?.forkSession === true)).toBe(true);
  });

  it('reasks every named structured-output pass from the declared source', async () => {
    let consumerAttempts = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      if (prompt === 'source') {
        yield { type: 'agent_message_chunk', text: 'source output' };
        yield { type: 'result', sessionId: 'source-session' };
        return;
      }
      if (prompt === 'final') {
        yield { type: 'agent_message_chunk', text: 'final output' };
        yield { type: 'result', sessionId: 'final-branch', resumed: true };
        return;
      }
      consumerAttempts++;
      yield {
        type: 'result',
        sessionId: `consumer-branch-${String(consumerAttempts)}`,
        ...(resumeSessionId !== undefined ? { resumed: resumeSessionId === 'source-session' } : {}),
        structuredOutput: consumerAttempts === 1 ? { wrong: true } : { verdict: 'accepted branch' },
      };
    });

    await runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' }, provider: 'pi' },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        provider: 'pi',
        context: { resume: 'source' },
        depends_on: ['source'],
        output_format: {
          type: 'object',
          properties: { verdict: { type: 'string' } },
          required: ['verdict'],
        },
      },
      {
        id: 'final',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'final' },
        provider: 'pi',
        context: { resume: 'consumer' },
        depends_on: ['consumer'],
      },
    ]);

    expect(mockSendQueryDag.mock.calls.map(call => call[2])).toEqual([
      undefined,
      'source-session',
      'source-session',
      'consumer-branch-2',
    ]);
  });

  it('checkpoints a plain loop source and forks it for a named consumer', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      if (resumeSessionId === undefined) {
        yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
        yield { type: 'result', sessionId: 'loop-session' };
        return;
      }
      yield { type: 'agent_message_chunk', text: String(prompt) };
      yield { type: 'result', sessionId: 'consumer-branch', resumed: true };
    });

    const store = await runAddressableWorkflow([
      {
        id: 'loop-source',
        kind: 'loop',
        loop: { prompt: 'iterate', until: 'DONE', max_iterations: 1, fresh_context: false },
      },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'loop-source' },
        depends_on: ['loop-source'],
      },
    ]);

    expect(store.upsertWorkflowRunNodeSession).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: 'loop-source', provider_session_id: 'loop-session' })
    );
    expect(mockSendQueryDag.mock.calls[1]?.[2]).toBe('loop-session');
    expect(mockSendQueryDag.mock.calls[1]?.[3]?.forkSession).toBe(true);
  });

  it('hydrates a completed source handle and forks it after a cold resume', async () => {
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: 'resumed synthesis' };
      yield { type: 'result', sessionId: 'cold-branch', resumed: resumeSessionId !== undefined };
    });

    await runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'must be skipped' } },
        {
          id: 'synthesis',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'synthesize' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ],
      createMockStore(),
      new Map([['source', { output: 'prior output' }]]),
      [
        {
          workflow_run_id: 'addressable-run',
          node_id: 'source',
          provider: 'claude',
          provider_session_id: 'cold-source',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
      ]
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBe('cold-source');
    expect(mockSendQueryDag.mock.calls[0][3]?.forkSession).toBe(true);
  });

  it('gives a named source precedence over the consumer persisted-session lookup', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt, _cwd, resumeSessionId) {
      yield { type: 'agent_message_chunk', text: prompt };
      yield {
        type: 'result',
        sessionId: prompt === 'source' ? 'named-source' : 'named-branch',
        ...(resumeSessionId !== undefined ? { resumed: true } : {}),
      };
    });
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockResolvedValue([
      {
        workflow_name: 'addressable',
        node_id: 'consumer',
        scope_key: 'conv-dag',
        provider: 'claude',
        provider_session_id: 'persisted-consumer-session',
        last_run_id: 'old-run',
        created_at: '2026-08-19T00:00:00Z',
        updated_at: '2026-08-19T00:00:00Z',
      },
    ]);

    await runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          persist_session: true,
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag.mock.calls[1][2]).toBe('named-source');
    expect(store.upsertWorkflowNodeSession).toHaveBeenCalledWith(
      expect.objectContaining({ node_id: 'consumer', provider_session_id: 'named-branch' })
    );
  });

  it('fails before the consumer runs when the source completed without a session', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'source output' };
      yield { type: 'result' };
    });
    const store = await runAddressableWorkflow([
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
    ]);

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const failedEvents = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
      .map(
        call =>
          call[0] as { event_type: string; step_name?: string; data?: Record<string, unknown> }
      )
      .filter(event => event.event_type === 'node_failed' && event.step_name === 'consumer');
    expect(failedEvents[0]?.data).toMatchObject({ session_source_node_id: 'source' });
  });

  it('fails a named fork on cold fallback, a missing branch ID, or source ID reuse', async () => {
    const cases = [
      { name: 'cold fallback', sessionId: 'cold-branch', resumed: false },
      { name: 'missing branch', sessionId: undefined, resumed: true },
      { name: 'source reuse', sessionId: 'source-session', resumed: true },
    ];

    for (const failureCase of cases) {
      mockSendQueryDag.mockClear();
      mockSendQueryDag.mockImplementation(async function* (prompt) {
        yield { type: 'agent_message_chunk', text: prompt };
        if (prompt === 'source') {
          yield { type: 'result', sessionId: 'source-session' };
        } else {
          yield {
            type: 'result',
            sessionId: failureCase.sessionId,
            resumed: failureCase.resumed,
          };
        }
      });
      const store = await runAddressableWorkflow([
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ]);

      const completedConsumer = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls
        .map(call => call[0] as { event_type: string; step_name?: string })
        .some(event => event.event_type === 'node_completed' && event.step_name === 'consumer');
      expect({
        case: failureCase.name,
        workflowFailed: store.failWorkflowRun.mock.calls.length > 0,
        completedConsumer,
        consumerResumeId: mockSendQueryDag.mock.calls[1]?.[2],
      }).toEqual({
        case: failureCase.name,
        workflowFailed: true,
        completedConsumer: false,
        consumerResumeId: 'source-session',
      });
    }
  });

  it('fails before provider execution on runtime mismatch or missing fork capability', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'must not run' };
      yield { type: 'result', sessionId: 'unexpected' };
    });
    const priorCompleted = new Map([['source', { output: 'prior output' }]]);
    const priorSession = {
      workflow_run_id: 'addressable-run',
      node_id: 'source',
      provider: 'pi',
      provider_session_id: 'pi-source',
      created_at: '2026-08-19T00:00:00Z',
      updated_at: '2026-08-19T00:00:00Z',
    };
    const nodes: DagNode[] = [
      { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'skipped' } },
      {
        id: 'consumer',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'consumer' },
        context: { resume: 'source' },
        depends_on: ['source'],
      },
    ];

    const mismatchStore = await runAddressableWorkflow(nodes, createMockStore(), priorCompleted, [
      priorSession,
    ]);
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(mismatchStore.failWorkflowRun).toHaveBeenCalled();

    expect(mockGetAgentProviderDag).not.toHaveBeenCalled();
    const capabilityStore = await runAddressableWorkflow(
      nodes,
      createMockStore(),
      priorCompleted,
      [{ ...priorSession, provider: 'claude' }],
      withProviderCapabilities(mockProviderRegistry, 'claude', {
        ...mockClaudeCapabilities(),
        sessionFork: false,
      })
    );
    expect(mockGetAgentProviderDag).not.toHaveBeenCalled();
    expect(mockSendQueryDag).not.toHaveBeenCalled();
    expect(capabilityStore.failWorkflowRun).toHaveBeenCalled();
  });

  it('fails a required source before completion when its session checkpoint cannot be saved', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'source' };
      yield { type: 'result', sessionId: 'source-session' };
    });
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint failed'));

    await runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'source' },
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string }
    );
    expect(
      events.some(event => event.event_type === 'node_completed' && event.step_name === 'source')
    ).toBe(false);
    expect(
      events.some(event => event.event_type === 'node_failed' && event.step_name === 'source')
    ).toBe(true);
  });

  it('fails a required loop source before completion when its session checkpoint cannot be saved', async () => {
    mockSendQueryDag.mockImplementation(async function* (): ReturnType<typeof mockSendQueryDag> {
      yield { type: 'agent_message_chunk', text: '<promise>DONE</promise>' };
      yield { type: 'result', sessionId: 'loop-session' };
    });
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint failed'));

    await runAddressableWorkflow(
      [
        {
          id: 'loop-source',
          kind: 'loop',
          loop: { prompt: 'iterate', until: 'DONE', max_iterations: 1, fresh_context: false },
        },
        {
          id: 'consumer',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'consumer' },
          context: { resume: 'loop-source' },
          depends_on: ['loop-source'],
        },
      ],
      store
    );

    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      call => call[0] as { event_type: string; step_name?: string }
    );
    expect(
      events.some(
        event => event.event_type === 'node_completed' && event.step_name === 'loop-source'
      )
    ).toBe(false);
    expect(
      events.some(event => event.event_type === 'node_failed' && event.step_name === 'loop-source')
    ).toBe(true);
  });

  it('does not checkpoint sessions when the workflow has no named consumer', async () => {
    const store = createMockStore();
    (
      store.upsertWorkflowRunNodeSession as Mock<typeof store.upsertWorkflowRunNodeSession>
    ).mockRejectedValue(new Error('checkpoint must not run'));

    await runAddressableWorkflow(
      [
        { id: 'source', kind: 'agent', source: { kind: 'inline', prompt: 'source' } },
        {
          id: 'later',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'later' },
          depends_on: ['source'],
        },
      ],
      store
    );

    expect(store.upsertWorkflowRunNodeSession).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('executeDagWorkflow -- provider-boundary session threading (#1992)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-provbound-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
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
  });

  async function runWorkflow(
    conversationId: string,
    workflow: { name: string; nodes: DagNode[] },
    workflowRun: WorkflowRun
  ): Promise<WorkflowDeps> {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId,
        cwd: testDir,
        workflow,
        workflowRun,
      })
    );
    return mockDeps;
  }

  async function runTwoNodeWorkflow(secondNode: DagNode): Promise<void> {
    await runWorkflow(
      'conv-prov-bound',
      {
        name: 'dag-provider-boundary',
        nodes: [
          { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'First step' } },
          secondNode,
        ],
      },
      makeWorkflowRun('provider-boundary-run')
    );
  }

  it('sequential node on a DIFFERENT provider gets a fresh session (no cross-provider resume)', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'step done' };
      yield { type: 'result', sessionId: 'sess-a' };
    });

    await runTwoNodeWorkflow({
      id: 'b',
      kind: 'agent',
      source: { kind: 'inline', prompt: 'Second step' },
      depends_on: ['a'],
      provider: 'codex',
    });

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Node a (claude) ran fresh; node b (codex) must NOT inherit a's claude session id.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('sequential node on the SAME provider still threads the session', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'step done' };
      yield { type: 'result', sessionId: 'sess-a' };
    });

    await runTwoNodeWorkflow({
      id: 'b',
      kind: 'agent',
      source: { kind: 'inline', prompt: 'Second step' },
      depends_on: ['a'],
    });

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('sess-a');
  });

  it('node after a loop node on a DIFFERENT provider gets a fresh session', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('Iterate')) {
        yield { type: 'agent_message_chunk', text: 'all done <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sess' };
      } else {
        yield { type: 'agent_message_chunk', text: 'downstream done' };
        yield { type: 'result', sessionId: 'sess-after' };
      }
    });

    await runWorkflow(
      'conv-prov-bound-loop',
      {
        name: 'dag-provider-boundary-loop',
        nodes: [
          {
            id: 'work',
            kind: 'loop',
            loop: {
              fresh_context: false,
              prompt: 'Iterate until done.',
              until: 'COMPLETE',
              max_iterations: 3,
            },
          },
          {
            id: 'after',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'Summarize' },
            depends_on: ['work'],
            provider: 'codex',
          },
        ],
      },
      makeWorkflowRun('provider-boundary-loop-run')
    );

    // 1 loop iteration + 1 downstream call.
    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    // Downstream codex node must NOT resume the loop's claude session.
    expect(mockSendQueryDag.mock.calls[1][2]).toBeUndefined();
  });

  it('node after a loop node on the SAME provider still threads the loop session', async () => {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('Iterate')) {
        yield { type: 'agent_message_chunk', text: 'all done <promise>COMPLETE</promise>' };
        yield { type: 'result', sessionId: 'loop-sess' };
      } else {
        yield { type: 'agent_message_chunk', text: 'downstream done' };
        yield { type: 'result', sessionId: 'sess-after' };
      }
    });

    await runWorkflow(
      'conv-same-prov-loop',
      {
        name: 'dag-same-provider-loop',
        nodes: [
          {
            id: 'work',
            kind: 'loop',
            loop: {
              fresh_context: false,
              prompt: 'Iterate until done.',
              until: 'COMPLETE',
              max_iterations: 3,
            },
          },
          {
            id: 'after',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'Summarize' },
            depends_on: ['work'],
          },
        ],
      },
      makeWorkflowRun('same-provider-loop-run')
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(2);
    expect(mockSendQueryDag.mock.calls[1][2]).toBe('loop-sess');
  });

  it('loop_group body: provider boundaries stay fresh within and across iterations', async () => {
    // Body: x (claude) -> y (codex), fresh_context: false. y emits DONE on iteration 2.
    // No call may ever receive a resume id: x->y is a provider boundary within the
    // iteration, and each cross-iteration handoff (y's codex cursor into x, x's claude
    // cursor into y) is a provider boundary too.
    let yCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('analyze')) {
        yield { type: 'agent_message_chunk', text: 'analysis output' };
        yield { type: 'result', sessionId: 'sess-x' };
      } else {
        yCalls++;
        const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
        yield { type: 'agent_message_chunk', text: content };
        yield { type: 'result', sessionId: `sess-y-${yCalls}` };
      }
    });

    await runWorkflow(
      'conv-lg-prov',
      {
        name: 'lg-provider-boundary',
        nodes: [
          {
            id: 'fixer',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              fresh_context: false,
              nodes: [
                {
                  id: 'x',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'analyze the failure' },
                  depends_on: [],
                },
                {
                  id: 'y',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'apply the fix, emit DONE when green' },
                  depends_on: ['x'],
                  provider: 'codex',
                },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-provider-boundary')
    );

    // 2 iterations x 2 body nodes = 4 calls, every one fresh.
    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    for (const call of mockSendQueryDag.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });

  it('loop_group body: same-provider chain still threads within and across iterations', async () => {
    // Body: x -> y, both claude, fresh_context: false. Threading expectations:
    // iter1: x fresh, y resumes x's session; iter2 seeds y's iter-1 session into x,
    // then y resumes x's iter-2 session.
    let yCalls = 0;
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      if (prompt.includes('analyze')) {
        yield { type: 'agent_message_chunk', text: 'analysis output' };
        yield { type: 'result', sessionId: `sess-x-${String(yCalls + 1)}` };
      } else {
        yCalls++;
        const content = yCalls === 1 ? 'not finished yet' : 'finished\nDONE';
        yield { type: 'agent_message_chunk', text: content };
        yield { type: 'result', sessionId: `sess-y-${yCalls}` };
      }
    });

    await runWorkflow(
      'conv-lg-same',
      {
        name: 'lg-same-provider',
        nodes: [
          {
            id: 'fixer',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              fresh_context: false,
              nodes: [
                {
                  id: 'x',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'analyze the failure' },
                  depends_on: [],
                },
                {
                  id: 'y',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'apply the fix, emit DONE when green' },
                  depends_on: ['x'],
                },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-same-provider')
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(4);
    const resumeIds = mockSendQueryDag.mock.calls.map(call => call[2]);
    // iter1: x fresh, y resumes x. iter2: x resumes y's iter-1 session, y resumes x's.
    expect(resumeIds[0]).toBeUndefined();
    expect(resumeIds[1]).toBe('sess-x-1');
    expect(resumeIds[2]).toBe('sess-y-1');
    expect(resumeIds[3]).toBe('sess-x-2');
  });

  it('interactive loop_group resume without a provider tag (legacy pause) restores fresh', async () => {
    // A run paused BEFORE the provider tag existed has approval metadata with a bare
    // sessionId. Restoring it untagged could thread the session into a different
    // provider, so the resume starts fresh instead (safe degradation).
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'resumed and finished\nDONE' };
      yield { type: 'result', sessionId: 'legacy-resume-sess' };
    });

    await runWorkflow(
      'conv-lg-legacy',
      {
        name: 'lg-legacy-resume',
        nodes: [
          {
            id: 'refine',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 5,
              fresh_context: false,
              interactive: true,
              gate_message: 'Review.',
              nodes: [
                {
                  id: 'work',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'Refine the draft.' },
                  depends_on: [],
                },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-legacy-resume', {
        metadata: {
          approval: {
            type: 'interactive_loop',
            nodeId: 'refine',
            iteration: 1,
            sessionId: 'pre-tag-sess-1', // no sessionProvider — legacy pause
            message: 'Review.',
          },
          loop_user_input: 'continue',
        },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The untagged pre-pause session is NOT restored.
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
  });

  it('interactive loop_group gate with no live cursor pauses with EXPLICIT null session fields', async () => {
    // Body tail is a PARALLEL layer (two sibling nodes, nothing downstream), which
    // resets the sequential cursor before the gate. The pause payload states
    // sessionId/sessionProvider as explicit nulls rather than omitting them, so the
    // stored gate record says outright that this gate had no cursor. Readers accept
    // either shape (dag-executor restores only on `typeof … === 'string'`); this
    // pins the payload the gate writes, not a distinction the resume path makes.
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'checked, not done yet' };
      yield { type: 'result', sessionId: 'parallel-tail-sess' };
    });

    const mockDeps = await runWorkflow(
      'conv-lg-nullpause',
      {
        name: 'lg-null-pause',
        nodes: [
          {
            id: 'refine',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 5,
              fresh_context: false,
              interactive: true,
              gate_message: 'Review.',
              nodes: [
                {
                  id: 'lint',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'run lint checks' },
                  depends_on: [],
                },
                {
                  id: 'test',
                  kind: 'agent',
                  source: { kind: 'inline', prompt: 'run test checks' },
                  depends_on: [],
                },
              ],
            },
            depends_on: [],
          },
        ],
      },
      makeWorkflowRun('lg-null-pause')
    );

    const pauseCalls = (mockDeps.store.pauseWorkflowRun as Mock<IWorkflowStore['pauseWorkflowRun']>)
      .mock.calls;
    expect(pauseCalls.length).toBe(1);
    const pauseCtx = pauseCalls[0][1];
    // Keys present with explicit null — NOT omitted, NOT a live session pair.
    expect('sessionId' in pauseCtx).toBe(true);
    expect('sessionProvider' in pauseCtx).toBe(true);
    expect(pauseCtx.sessionId).toBeNull();
    expect(pauseCtx.sessionProvider).toBeNull();
  });
});
