// @archon-test-isolated
import { describe, it, expect, afterEach, mock } from 'bun:test';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  type MockWorkflowEventCollector,
  createMockStore,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  mockLogger,
  stubMissingContainer,
  dagOptions,
  makeWorkflowRun,
  mockCodexCapabilities,
  mockProviderRegistry,
  withProviderCapabilities,
} from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { IWorkflowStore } from '../store';

// ---------------------------------------------------------------------------
// Container write-back gate + suspend-on-pause (Phase C)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- container write-back gate', () => {
  const CONTAINER_EXEC = { kind: 'container' as const, containerId: 'cid-1' };
  const wbTestDir = join(tmpdir(), `dag-wb-test-${Date.now()}`);
  // The executor creates `logs/` under the run's cwd, so this path becomes a real tree.
  afterEach(() => removeTempTree(wbTestDir));

  function makeWritebackBackend(over?: Partial<Record<string, unknown>>) {
    return {
      suspend: mock(async () => undefined),
      finalize: mock(async () => ({ requiresApproval: false as boolean })),
      applyChanges: mock(async () => ({
        filesApplied: 0,
        filesDeleted: 0,
        warnings: [] as string[],
      })),
      discardChanges: mock(async () => undefined),
      ...over,
    };
  }

  it.each(['status', 'full-row'] as const)(
    'propagates the post-DAG container %s read failure',
    async kind => {
      const store = createMockStore();
      const cause = new Error('Unreadable lifecycle');
      if (kind === 'status') {
        store.getWorkflowRunStatus.mockResolvedValueOnce('running').mockRejectedValue(cause);
      } else store.getWorkflowRun.mockRejectedValue(cause);
      const backend = makeWritebackBackend();
      await expect(
        executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: wbTestDir,
            workflow: {
              name: 'wb',
              nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
            },
            workflowRun: makeWorkflowRun('wb-run'),
            priorCompletedNodes: new Map([['a', { output: 'out' }]]),
            execContext: CONTAINER_EXEC,
            containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
          })
        )
      ).rejects.toMatchObject({ name: 'WorkflowStatusReadError', cause });
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(backend.applyChanges).not.toHaveBeenCalled();
      expect(backend.discardChanges).not.toHaveBeenCalled();
    }
  );

  /** Run a single pre-completed bash node under a container context so the gate runs. */
  async function runGate(opts: {
    backend: ReturnType<typeof makeWritebackBackend>;
    writeBack?: 'approve' | 'auto';
    runMetadata?: Record<string, unknown>;
    status?: 'running' | 'paused';
    claimed?: boolean;
    platform?: ReturnType<typeof createMockPlatform>;
  }): Promise<IWorkflowStore> {
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve(opts.status ?? ('running' as const)));
    store.getWorkflowRun = mock(() =>
      Promise.resolve(makeWorkflowRun('wb-run', { metadata: opts.runMetadata ?? {} }))
    );
    store.claimWriteback = mock(() => Promise.resolve({ claimed: opts.claimed ?? true }));
    const deps = createMockDeps(store);
    await executeDagWorkflow(
      dagOptions({
        deps,
        ...(opts.platform ? { platform: opts.platform } : {}),
        conversationId: 'conv-wb',
        cwd: wbTestDir,
        workflow: {
          name: 'wb',
          nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
        },
        workflowRun: makeWorkflowRun('wb-run'),
        priorCompletedNodes: new Map([['a', { output: 'out' }]]),
        execContext: CONTAINER_EXEC,
        containerCtx: {
          envId: 'env-x',
          writeBack: opts.writeBack ?? 'approve',
          backend: opts.backend,
        },
      })
    );
    return store;
  }

  it.each([
    ['fuse', 'created', { containerId: 'cid-1' }],
    ['native', 'created', { containerId: 'cid-1', overlayMode: 'native', gateBypassable: true }],
    ['fuse', 'resumed', { containerId: 'cid-1' }],
    ['native', 'resumed', { containerId: 'cid-1', overlayMode: 'native', gateBypassable: true }],
  ] as const)(
    'a %s-overlay container_%s event retains its security facts',
    async (overlayMode, lifecycle, expectedData) => {
      const store = createMockStore();
      const platform = createMockPlatform();
      const execSpy = stubMissingContainer();
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            platform,
            conversationId: 'conv-created',
            cwd: wbTestDir,
            workflow: {
              name: 'created',
              nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
            },
            workflowRun: makeWorkflowRun('created-run'),
            ...(lifecycle === 'resumed'
              ? { priorCompletedNodes: new Map([['a', { output: 'out' }]]) }
              : {}),
            execContext: CONTAINER_EXEC,
            containerCtx: {
              envId: 'env-x',
              writeBack: 'approve',
              backend: makeWritebackBackend(),
              overlayMode,
            },
          })
        );
      } finally {
        execSpy.mockRestore();
      }

      const created = persistedEvents(store).filter(
        event => event.event_type === `container_${lifecycle}`
      );
      expect(created.map(event => event.data)).toEqual([expectedData]);
      expect(
        platform.sendMessage.mock.calls.some(([, message]) =>
          message.includes('NATIVE overlay mode (CAP_SYS_ADMIN)')
        )
      ).toBe(overlayMode === 'native');
    }
  );

  it('empty diff → completes normally, no pause', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({ requiresApproval: false })),
    });
    const store = await runGate({ backend });
    expect(backend.finalize).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(backend.suspend).not.toHaveBeenCalled();
  });

  it('non-empty diff + approve policy → pauses (writeback) + suspends, does NOT complete', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const store = await runGate({ backend });
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    const pauseCall = (store.pauseWorkflowRun as ReturnType<typeof mock>).mock.calls[0];
    const pauseArg = pauseCall[1] as { nodeId: string; type: string };
    expect(pauseArg.nodeId).toBe('__writeback__');
    expect(pauseArg.type).toBe('writeback');
    // pending_writeback is folded into the SAME pause write (M3), not a 2nd update.
    const extraMeta = pauseCall[2] as { pending_writeback?: { envId: string } };
    expect(extraMeta.pending_writeback?.envId).toBe('env-x');
    // The request row commits with the pause, and is not written a second time beside it.
    expect(pauseCall[3]).toEqual({
      workflow_run_id: expect.any(String),
      event_type: 'writeback_requested',
      step_name: 'container',
      data: { total_count: 1 },
    });
    const writes = (store.createWorkflowEvent as MockWorkflowEventCollector).mock.calls;
    expect(writes.filter(([event]) => event.event_type === 'writeback_requested')).toHaveLength(1);
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('records an undelivered pause notice when the write-back gate message cannot be sent', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const platform = createMockPlatform();
    platform.sendMessage = mock(async (): Promise<void> => {
      throw new Error('401 unauthorized');
    });
    const store = await runGate({ backend, platform });
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'wb-run',
      event_type: 'pause_notice_undelivered',
      step_name: 'container',
      data: { nodeId: '__writeback__', occurrence: expect.any(String), platform: 'test' },
    });
  });

  it('a lost pause CAS during write-back stays fail-closed: throws, never suspends (#2489)', async () => {
    // Unlike the other four gate types, a lost pause here must NEVER be tolerated —
    // failClosed: true (dag-executor.ts raiseWriteBackGate) means this rejects
    // straight through instead of being treated as a legitimate external
    // transition, so the container teardown path preserves the overlay for retry.
    // backend.suspend never firing proves the entire downstream sequence
    // (suspend, then the user message) never runs — both are strictly sequential
    // awaits after the pause call, with nothing to catch a throw in between.
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
    });
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() => Promise.resolve(makeWorkflowRun('wb-run', { metadata: {} })));
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    store.pauseWorkflowRun = mock(() =>
      Promise.reject(new Error('Workflow run not found or not in running state (id: wb-run)'))
    );

    await expect(runGateWithStore(store, backend, 'approve')).rejects.toThrow(
      /not found or not in running state/
    );
    expect(backend.suspend).not.toHaveBeenCalled();
  });

  it('non-empty diff + auto policy → applies without pausing, then completes', async () => {
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
      applyChanges: mock(async () => ({ filesApplied: 1, filesDeleted: 0, warnings: [] })),
    });
    const store = await runGate({ backend, writeBack: 'auto' });
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(store.pauseWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // Helper: a writeback approval context resolved to a given decision.
  const wbApproval = (resolved: 'approved' | 'rejected' | null) => ({
    nodeId: '__writeback__',
    message: 'review',
    type: 'writeback' as const,
    resolved,
  });

  it('resume after approve → CLAIMS then applies overlay, marks resolved, completes', async () => {
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => ({ filesApplied: 3, filesDeleted: 1, warnings: [] })),
    });
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
    });
    // R2-F4: the apply is claimed BEFORE the live root is mutated.
    expect(store.claimWriteback).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled(); // resume path skips re-inspection
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // R2-F4 — a lost claim (concurrent/prior resume owns the apply, or a crash left it
  // claimed after a successful apply) must NOT re-apply; complete as applied.
  it('resume after approve with a LOST claim does NOT re-apply', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      claimed: false,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
    });
    expect(store.claimWriteback).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled(); // no double-apply
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('warns when an already-claimed write-back resolution cannot be recorded', async () => {
    const backend = makeWritebackBackend();
    const { store } = statefulGateStore({
      pending_writeback: { envId: 'env-x' },
      approval: wbApproval('approved'),
    });
    store.claimWriteback = mock(async () => ({ claimed: false }));
    const persistError = new Error('resolution store unavailable');
    const update = store.updateWorkflowRun;
    store.updateWorkflowRun = mock(async (id, updates) => {
      if (updates.metadata?.writeback_resolved === true) throw persistError;
      await update(id, updates);
    });
    const originalWarn = mockLogger.warn;
    const warn = mock((_data: unknown, _message?: string): void => undefined);
    mockLogger.warn = warn;
    try {
      await runGateWithStore(store, backend, 'approve');
      expect(warn).toHaveBeenCalledWith(
        {
          runId: 'wb-run',
          operation: 'updateWorkflowRun',
          err: persistError,
          recovery: expect.stringContaining('inspect the run and live-folder changes'),
        },
        'dag.writeback_resolution_persist_failed'
      );
      const warning = warn.mock.calls.find(
        ([, event]) => event === 'dag.writeback_resolution_persist_failed'
      );
      expect(warning?.[0]).toHaveProperty('err', persistError);
      expect((warning?.[0] as { err: unknown }).err).toBe(persistError);
      expect(store.claimWriteback).toHaveBeenCalledTimes(1);
      expect(backend.applyChanges).not.toHaveBeenCalled();
      expect(store.releaseWritebackClaim).not.toHaveBeenCalled();
      expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
    } finally {
      mockLogger.warn = originalWarn;
    }
  });

  // R2-F4 — a failed apply RELEASES the claim (so `workflow resume` can retry) and
  // propagates the error (run fails → volume preserved by H2).
  it('resume after approve with a FAILED apply releases the claim and rethrows', async () => {
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => {
        throw new Error('cp: No space left on device');
      }),
    });
    // executeDagWorkflow lets the apply error propagate; the outer executor marks the
    // run failed. Assert release was called and the error surfaced.
    let threw = false;
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() =>
      Promise.resolve(
        makeWorkflowRun('wb-run', {
          metadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('approved') },
        })
      )
    );
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-wb',
          cwd: wbTestDir,
          workflow: {
            name: 'wb',
            nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
          },
          workflowRun: makeWorkflowRun('wb-run'),
          priorCompletedNodes: new Map([['a', { output: 'out' }]]),
          execContext: CONTAINER_EXEC,
          containerCtx: { envId: 'env-x', writeBack: 'approve', backend },
        })
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(store.releaseWritebackClaim).toHaveBeenCalledTimes(1);
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  // A stateful store that accumulates metadata from updateWorkflowRun / pauseWorkflowRun,
  // so an apply-throw test can inspect the FINAL run metadata — the exact input the CLI
  // teardown's `hasUnresolvedWriteback` reads to decide preserve-vs-destroy.
  function statefulGateStore(initialMeta: Record<string, unknown>): {
    store: IWorkflowStore;
    metadata: Record<string, unknown>;
  } {
    const metadata: Record<string, unknown> = { ...initialMeta };
    const store = createMockStore();
    store.getWorkflowRunStatus = mock(() => Promise.resolve('running' as const));
    store.getWorkflowRun = mock(() => Promise.resolve(makeWorkflowRun('wb-run', { metadata })));
    store.claimWriteback = mock(() => Promise.resolve({ claimed: true }));
    store.updateWorkflowRun = mock(
      (_id: string, updates: { metadata?: Record<string, unknown> }) => {
        for (const [k, v] of Object.entries(updates.metadata ?? {})) {
          if (v === null) delete metadata[k];
          else metadata[k] = v;
        }
        return Promise.resolve();
      }
    );
    return { store, metadata };
  }

  /** The predicate the CLI teardown uses to PRESERVE the volume (mirror of hasUnresolvedWriteback). */
  const wouldPreserve = (m: Record<string, unknown>): boolean =>
    m.pending_writeback !== undefined && m.writeback_resolved !== true;

  async function runGateWithStore(
    store: IWorkflowStore,
    backend: ReturnType<typeof makeWritebackBackend>,
    writeBack: 'approve' | 'auto'
  ): Promise<void> {
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-wb',
        cwd: wbTestDir,
        workflow: {
          name: 'wb',
          nodes: [{ id: 'a', kind: 'exec', runtime: 'sh', script: 'echo hi' }],
        },
        workflowRun: makeWorkflowRun('wb-run'),
        priorCompletedNodes: new Map([['a', { output: 'out' }]]),
        execContext: CONTAINER_EXEC,
        containerCtx: { envId: 'env-x', writeBack, backend },
      })
    );
  }

  // N1/item-2 — an apply-throw in APPROVE mode leaves the run with pending_writeback set
  // and unresolved, so the teardown PRESERVES the volume (never destroy the only copy).
  it('apply-throw in approve mode leaves an unresolved write-back (teardown preserves)', async () => {
    const { store, metadata } = statefulGateStore({
      pending_writeback: { envId: 'env-x' },
      approval: wbApproval('approved'),
    });
    const backend = makeWritebackBackend({
      applyChanges: mock(async () => {
        throw new Error('cp: read-only file system');
      }),
    });
    await expect(runGateWithStore(store, backend, 'approve')).rejects.toThrow(/read-only/);
    expect(wouldPreserve(metadata)).toBe(true);
  });

  // N1 — an apply-throw in AUTO mode must ALSO leave pending_writeback set (auto sets the
  // preserve marker BEFORE mutating the live root), so the teardown preserves the volume.
  it('apply-throw in auto mode sets the preserve marker (teardown preserves)', async () => {
    const { store, metadata } = statefulGateStore({}); // fresh: no pending_writeback yet
    const backend = makeWritebackBackend({
      finalize: mock(async () => ({
        requiresApproval: true,
        changeSummary: {
          added: ['x.md'],
          modified: [],
          deleted: [],
          symlinks: [],
          skipped: [],
          totalCount: 1,
          truncated: false,
        },
      })),
      applyChanges: mock(async () => {
        throw new Error('cp: read-only file system');
      }),
    });
    await expect(runGateWithStore(store, backend, 'auto')).rejects.toThrow(/read-only/);
    expect(metadata.pending_writeback).toBeDefined(); // marker set before the throw
    expect(wouldPreserve(metadata)).toBe(true);
  });

  it('resume after reject → discards overlay (live root untouched), completes', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: { pending_writeback: { envId: 'env-x' }, approval: wbApproval('rejected') },
    });
    expect(backend.discardChanges).toHaveBeenCalledTimes(1);
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).toHaveBeenCalledTimes(1);
  });

  // H1 — FAIL CLOSED. A bare `/workflow resume` (no decision) reaches the still-open
  // gate: it must RE-PAUSE, never apply.
  it('resume with an UNRESOLVED gate re-pauses (fail closed), does NOT apply', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: {
        pending_writeback: {
          envId: 'env-x',
          summary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        },
        approval: wbApproval(null), // gate raised but not yet decided
      },
    });
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(backend.discardChanges).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1); // re-raised
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  // H1 — a STALE run-wide approval_response from an earlier mid-DAG approval node must
  // NOT auto-apply the write-back gate; only the gate's own approval.resolved counts.
  it('stale top-level approval_response does NOT apply the write-back overlay', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({
      backend,
      runMetadata: {
        pending_writeback: {
          envId: 'env-x',
          summary: {
            added: ['x'],
            modified: [],
            deleted: [],
            symlinks: [],
            skipped: [],
            totalCount: 1,
            truncated: false,
          },
        },
        approval: wbApproval(null),
        approval_response: 'approved', // stale from a prior gate — must be ignored
      },
    });
    expect(backend.applyChanges).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRun).toHaveBeenCalledTimes(1); // re-raised, not applied
  });

  it('mid-DAG pause suspends the container instead of completing', async () => {
    const backend = makeWritebackBackend();
    const store = await runGate({ backend, status: 'paused' });
    // A node paused the run → suspend fires right after the layer walk; the gate
    // + completion are never reached.
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    expect(backend.finalize).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('a docker-stop failure during suspend does NOT flip the paused run to failed', async () => {
    const backend = makeWritebackBackend({
      suspend: mock(async () => {
        throw new Error('Cannot connect to the Docker daemon');
      }),
    });
    // status 'paused' → the mid-DAG suspend path runs; a suspend throw is best-effort.
    const store = await runGate({ backend, status: 'paused' });
    expect(backend.suspend).toHaveBeenCalledTimes(1);
    // The run stays paused — suspend failure must not mark it failed or complete it.
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  // A run refused at preflight must not announce a container it will never use.
  it.each([
    [
      'a strict-schema violation',
      withProviderCapabilities(mockProviderRegistry, 'codex', {
        ...mockCodexCapabilities(),
        containerExec: true,
      }),
      /output_format schema strict-mode violation/,
    ],
    ['a container-incompatible provider', mockProviderRegistry, /cannot run inside a container/],
  ])('%s refuses the run before the container is announced', async (_, providers, refusal) => {
    const store = createMockStore();
    const platform = createMockPlatform();
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store, providers),
          platform,
          cwd: wbTestDir,
          workflow: {
            name: 'refused',
            nodes: [
              {
                id: 'work',
                kind: 'agent',
                source: { kind: 'inline', prompt: 'Do the work' },
                output_format: {
                  type: 'object',
                  properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
                  required: ['ready'],
                },
              },
            ],
          },
          workflowRun: makeWorkflowRun('refused-run'),
          workflowProvider: 'codex',
          execContext: CONTAINER_EXEC,
          containerCtx: {
            envId: 'env-x',
            writeBack: 'approve',
            backend: makeWritebackBackend(),
            overlayMode: 'native',
          },
        })
      )
    ).rejects.toThrow(refusal);

    expect(
      persistedEvents(store).filter(event => event.event_type.startsWith('container_'))
    ).toEqual([]);
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });
});
