import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolveWorkflow } from './graph-plan';
import { captureWorkflowSource } from './workflow-source';
import { TerminalStatusWriteError } from './terminal-status-write';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type {
  IWorkflowEngine,
  WorkflowEngineSubmitInput,
  WorkflowResumeInput,
} from './engine-port';
import type { DagResumeSnapshot, IWorkflowStore } from './store';
import type { ResolvedWorkflow, WorkflowDefinition, WorkflowRun } from './schemas';

const trackTempRoot = trackTempRoots();

export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(`Workflow run is not resumable (id: ${runId}, status: ${currentStatus}).`);
    this.name = 'WorkflowNotResumableError';
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function emptySnapshot(): DagResumeSnapshot {
  return {
    completedNodeOutputs: new Map(),
    fanOutSnapshots: new Map(),
    unresolvedNodeStarts: new Set<string>(),
    tokens: { input: 0, output: 0 },
    costUsd: 0,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'test message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    adopted_from_run_id: null,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): ResolvedWorkflow {
  return resolveWorkflow({
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', kind: 'agent', source: { kind: 'inline', prompt: 'Do something' } }],
    ...overrides,
  });
}

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  const noop = async (): Promise<void> => undefined;
  return {
    getActiveWorkflowRunByPath: async () => null,
    findChildRuns: async () => [],
    getRunAncestry: async () => [],
    createWorkflowRun: async () => makeRun(),
    updateWorkflowRun: noop,
    failWorkflowRun: noop,
    getWorkflowRun: async () => ({ ...makeRun(), status: 'completed' as const }),
    getWorkflowRunStatus: async () => 'completed' as const,
    createWorkflowEvent: noop,
    persistWorkflowEvent: noop,
    persistWorkflowEventIfRunning: async () => ({ persisted: true }),
    findResumableRun: async () => null,
    getDagResumeSnapshot: async () => emptySnapshot(),
    resumeWorkflowRun: async () => makeRun(),
    recoverCancelledFanOutRun: async () => makeRun(),
    getCodebase: async () => null,
    getCodebaseEnvVars: async () => ({}),
    updateWorkflowActivity: noop,
    completeWorkflowRun: noop,
    pauseWorkflowRun: noop,
    pauseWorkflowRunForWait: noop,
    failPausedAttentionWait: async () => ({ failed: true }),
    clearWorkflowWaitContext: async (id, _wait, completion) => ({
      cleared: true as const,
      nodeEvent: {
        workflow_run_id: id,
        event_type: 'node_completed' as const,
        step_name: completion.stepName,
      },
    }),
    rewriteApprovalContext: async () => ({ resolved: true }),
    claimWriteback: async () => ({ claimed: true }),
    releaseWritebackClaim: noop,
    cancelWorkflowRun: async () => ({ cancelled: false }),
    cancelFanOutRun: async () => ({ cancelled: false }),
    getWorkflowNodeSession: async () => null,
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowRunNodeSession: noop,
    upsertWorkflowNodeSession: noop,
    deleteWorkflowNodeSessions: async () => ({ deleted: 0 }),
    ...overrides,
  } as IWorkflowStore;
}

function makePlatform(onSendMessage?: (id: string) => void): IWorkflowPlatform {
  return {
    sendMessage: async (id: string): Promise<void> => onSendMessage?.(id),
    getPlatformType: () => 'test' as const,
  } as unknown as IWorkflowPlatform;
}

function defaultConfig(): WorkflowConfig {
  return {
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    baseBranch: '',
    commands: { folder: '' },
  };
}

function makeDeps(
  store: IWorkflowStore = makeStore(),
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps {
  return {
    store,
    loadConfig: async () => defaultConfig(),
    getAgentProvider: () => ({ run: async (): Promise<void> => undefined }),
    ...overrides,
  } as WorkflowDeps;
}

function callInput(): Omit<WorkflowEngineSubmitInput, 'options'> {
  return {
    platform: makePlatform(),
    conversationId: 'conv-1',
    cwd: '/tmp/ops',
    workflow: makeWorkflow(),
    userMessage: 'hello',
    conversationDbId: 'db-conv-1',
  };
}

function resumeCallInput(): Omit<WorkflowResumeInput, 'run' | 'cursor' | 'options'> {
  const { workflow, ...input } = callInput();
  return { ...input, legacyWorkflow: workflow };
}

function resumableStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return makeStore({
    getDagResumeSnapshot: async () => ({
      ...emptySnapshot(),
      completedNodeOutputs: new Map([['node1', { output: 'out1' }]]),
    }),
    ...overrides,
  });
}

async function capturedRun(
  workflowYaml: string,
  overrides: Partial<WorkflowRun> = {}
): Promise<WorkflowRun> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-engine-capture-')));
  const source = join(root, 'source');
  await mkdir(join(source, '.archon', 'workflows'), { recursive: true });
  await writeFile(join(source, '.archon', 'workflows', 'test.yaml'), workflowYaml);
  const capture = await captureWorkflowSource({
    sourceRoot: source,
    captureRoot: join(root, 'capture'),
  });
  return makeRun({
    status: 'paused',
    metadata: {
      workflow_source: {
        version: 1,
        root: capture.anchor.root,
        origin: capture.origin,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: capture.manifest.source_config,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    },
    ...overrides,
  });
}

interface WorkflowEngineContractObservations {
  executedWorkflow: () => ResolvedWorkflow | undefined;
}

export function runWorkflowEngineContractTests(
  makeEngine: (deps: WorkflowDeps) => IWorkflowEngine,
  observations: WorkflowEngineContractObservations
): void {
  describe('IWorkflowEngine contract', () => {
    it('submits a fresh run with constructor-bound dependencies', async () => {
      const createdRuns: Record<string, unknown>[] = [];
      const messages: string[] = [];
      let configLoads = 0;
      const store = makeStore({
        createWorkflowRun: async input => {
          createdRuns.push(input);
          return makeRun();
        },
      });
      const deps = makeDeps(store, {
        loadConfig: async () => {
          configLoads += 1;
          return defaultConfig();
        },
      });
      const result = await makeEngine(deps).submit({
        ...callInput(),
        platform: makePlatform(id => messages.push(id)),
      });

      expect(result).toMatchObject({ success: true, workflowRunId: 'run-123' });
      expect(createdRuns).toHaveLength(1);
      expect(createdRuns[0]?.conversation_id).toBe('db-conv-1');
      expect(messages).toContain('conv-1');
      expect(configLoads).toBe(1);
    });

    it('allows a pending pre-created row on fresh submit', async () => {
      const pending = makeRun({ id: 'pending-run', status: 'pending' });
      let created = 0;
      const store = makeStore({
        createWorkflowRun: async () => {
          created += 1;
          return makeRun();
        },
        getWorkflowRun: async () => ({ ...pending, status: 'completed' as const }),
      });
      const result = await makeEngine(makeDeps(store)).submit({
        ...callInput(),
        options: { preCreatedRun: pending },
      });
      expect(result).toMatchObject({ success: true, workflowRunId: 'pending-run' });
      expect(created).toBe(0);
    });

    it('rejects a non-pending pre-created row before executor effects', async () => {
      let created = 0;
      let configLoads = 0;
      const store = makeStore({
        createWorkflowRun: async () => {
          created += 1;
          return makeRun();
        },
      });
      const engine = makeEngine(
        makeDeps(store, {
          loadConfig: async () => {
            configLoads += 1;
            return defaultConfig();
          },
        })
      );

      const error = await captureRejection(
        engine.submit({
          ...callInput(),
          options: { preCreatedRun: makeRun({ status: 'running' }) },
        })
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Fresh execution requires a pending pre-created run; use resume instead.'
      );
      expect(created).toBe(0);
      expect(configLoads).toBe(0);
    });

    it('returns admission before execution settles', async () => {
      const config = deferred<WorkflowConfig>();
      const resumed = makeRun({ id: 'accepted-run', status: 'running' });
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRun: async () => ({ ...resumed, status: 'completed' as const }),
      });
      const engine = makeEngine(makeDeps(store, { loadConfig: () => config.promise }));
      const admission = await engine.resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'accepted-run', status: 'paused' }),
      });
      expect(admission).toMatchObject({ accepted: true, runId: 'accepted-run' });
      if (!admission.accepted) throw new Error('expected resume admission');
      config.resolve(defaultConfig());
      const result = await admission.settled;
      expect(result).toMatchObject({
        success: true,
        workflowRunId: 'accepted-run',
      });
    });

    it('preserves a paused result', async () => {
      const resumed = makeRun({ id: 'paused-run', status: 'running' });
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRun: async () => ({ ...resumed, status: 'paused' as const }),
      });
      const admission = await makeEngine(makeDeps(store)).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'paused-run', status: 'paused' }),
      });
      if (!admission.accepted) throw new Error('expected resume admission');
      const result = await admission.settled;
      expect(result).toEqual({
        success: true,
        paused: true,
        workflowRunId: 'paused-run',
      });
    });

    it('executes the captured graph when the supplied same-name graph conflicts', async () => {
      const run = await capturedRun(`
name: test-workflow
description: Captured
nodes:
  - id: captured-node
    prompt: Run the captured graph
`);
      const resumed = { ...run, status: 'running' as const };
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRun: async () => ({ ...resumed, status: 'completed' as const }),
      });
      const conflicting = makeWorkflow({
        name: 'test-workflow',
        nodes: [
          { id: 'conflicting-node', kind: 'agent', source: { kind: 'inline', prompt: 'Wrong' } },
        ],
      });

      const admission = await makeEngine(makeDeps(store)).resume({
        ...resumeCallInput(),
        legacyWorkflow: conflicting,
        run,
      });
      if (!admission.accepted) throw new Error('expected resume admission');
      await admission.settled;

      expect(observations.executedWorkflow()?.nodes[0]?.id).toBe('captured-node');
    });

    it('rejects an unreadable captured graph before hydration or claim', async () => {
      let reads = 0;
      let claims = 0;
      const run = makeRun({
        status: 'paused',
        metadata: {
          workflow_source: {
            version: 1,
            root: join(tmpdir(), `missing-engine-capture-${process.pid}`),
            origin: '/missing-authoring-source',
            captured_at: '2026-09-21T00:00:00.000Z',
            digest: 'missing',
            file_count: 1,
            byte_count: 1,
          },
        },
      });
      const store = makeStore({
        getDagResumeSnapshot: async () => {
          reads += 1;
          return emptySnapshot();
        },
        resumeWorkflowRun: async () => {
          claims += 1;
          return makeRun();
        },
      });

      const error = await captureRejection(
        makeEngine(makeDeps(store)).resume({ ...resumeCallInput(), run })
      );
      expect(error).toBeInstanceOf(Error);
      expect(reads).toBe(0);
      expect(claims).toBe(0);
    });

    it.each([
      ['missing', undefined],
      ['mismatched', makeWorkflow({ name: 'other-workflow' })],
    ])('rejects a %s legacy fallback before hydration or claim', async (_case, legacyWorkflow) => {
      let reads = 0;
      let claims = 0;
      const store = makeStore({
        getDagResumeSnapshot: async () => {
          reads += 1;
          return emptySnapshot();
        },
        resumeWorkflowRun: async () => {
          claims += 1;
          return makeRun();
        },
      });
      const input = resumeCallInput();

      const error = await captureRejection(
        makeEngine(makeDeps(store)).resume({
          ...input,
          run: makeRun({ status: 'paused' }),
          legacyWorkflow,
        })
      );
      expect(error).toBeInstanceOf(Error);
      expect(reads).toBe(0);
      expect(claims).toBe(0);
    });

    it('declines an empty snapshot without claiming', async () => {
      let claims = 0;
      const store = makeStore({
        resumeWorkflowRun: async () => {
          claims += 1;
          return makeRun();
        },
      });
      const result = await makeEngine(makeDeps(store)).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'empty-run', status: 'paused' }),
      });
      expect(result).toEqual({ accepted: false, reason: 'nothing-to-resume' });
      expect(claims).toBe(0);
    });

    it('preserves hydration and lost-claim errors before admission', async () => {
      const hydrationError = new Error('snapshot read failed');
      const caughtHydrationError = await captureRejection(
        makeEngine(
          makeDeps(
            makeStore({
              getDagResumeSnapshot: async () => Promise.reject(hydrationError),
            })
          )
        ).resume({ ...resumeCallInput(), run: makeRun({ status: 'paused' }) })
      );
      expect(caughtHydrationError).toBe(hydrationError);

      const claimError = new WorkflowNotResumableError('raced-run', 'running');
      const caughtClaimError = await captureRejection(
        makeEngine(
          makeDeps(
            resumableStore({
              resumeWorkflowRun: async () => Promise.reject(claimError),
            })
          )
        ).resume({ ...resumeCallInput(), run: makeRun({ id: 'raced-run', status: 'failed' }) })
      );
      expect(caughtClaimError).toBe(claimError);
    });

    it.each([
      ['runConfig', { runConfig: { layer: {}, source: 'cli' } }],
      ['modelOverrideLayer', { modelOverrideLayer: { kind: 'raw', overrides: {} } }],
    ])('rejects resume option %s before hydration or claim', async (_field, options) => {
      let reads = 0;
      let claims = 0;
      const store = makeStore({
        getDagResumeSnapshot: async () => {
          reads += 1;
          return emptySnapshot();
        },
        resumeWorkflowRun: async () => {
          claims += 1;
          return makeRun();
        },
      });
      const input = {
        ...resumeCallInput(),
        run: makeRun({ status: 'paused' }),
        options,
      } as unknown as WorkflowResumeInput;
      const error = await captureRejection(makeEngine(makeDeps(store)).resume(input));
      expect(error).toBeInstanceOf(Error);
      expect(reads).toBe(0);
      expect(claims).toBe(0);
    });

    it('records a post-claim failure and preserves the execution error', async () => {
      const cause = new Error('config failed');
      const config = deferred<WorkflowConfig>();
      const resumed = makeRun({ id: 'failed-run', status: 'running' });
      const failures: { id: string; message: string }[] = [];
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRunStatus: async () => 'running',
        failWorkflowRun: async (id, message) => {
          failures.push({ id, message });
        },
      });
      const admission = await makeEngine(
        makeDeps(store, { loadConfig: () => config.promise })
      ).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'failed-run', status: 'paused' }),
      });
      if (!admission.accepted) throw new Error('expected resume admission');
      config.reject(cause);
      const caught = await captureRejection(admission.settled);
      expect(caught).toBe(cause);
      expect(failures).toEqual([{ id: 'failed-run', message: 'config failed' }]);
    });

    it('does not retry a failed terminal compensation write', async () => {
      const config = deferred<WorkflowConfig>();
      const writeError = new Error('database unavailable');
      const resumed = makeRun({ id: 'write-failed-run', status: 'running' });
      let writes = 0;
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRunStatus: async () => 'running',
        failWorkflowRun: async () => {
          writes += 1;
          throw writeError;
        },
      });
      const admission = await makeEngine(
        makeDeps(store, { loadConfig: () => config.promise })
      ).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'write-failed-run', status: 'paused' }),
      });
      if (!admission.accepted) throw new Error('expected resume admission');
      config.reject(new Error('config failed'));
      let caught: unknown;
      try {
        await admission.settled;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TerminalStatusWriteError);
      expect(caught).toMatchObject({ cause: writeError });
      expect(writes).toBe(1);
    });

    it('preserves an execution TerminalStatusWriteError without compensation', async () => {
      const cause = new TerminalStatusWriteError(new Error('terminal setup write failed'));
      const resumed = makeRun({ id: 'terminal-error-run', status: 'running' });
      let compensationWrites = 0;
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRunStatus: async () => 'running',
        failWorkflowRun: async () => {
          compensationWrites += 1;
        },
      });
      const admission = await makeEngine(
        makeDeps(store, { loadConfig: async () => Promise.reject(cause) })
      ).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'terminal-error-run', status: 'paused' }),
      });
      if (!admission.accepted) throw new Error('expected resume admission');

      const caught = await captureRejection(admission.settled);
      expect(caught).toBe(cause);
      expect(compensationWrites).toBe(0);
    });
  });
}
