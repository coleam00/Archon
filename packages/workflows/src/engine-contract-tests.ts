import { type ProviderRegistry, requireProvider } from '@archon/provider-contract';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { TerminalStatusWriteError } from './terminal-status-write';
import type { WorkflowConfig, WorkflowDeps } from './deps';
import {
  RESUME_FORBIDDEN_OPTIONS,
  type IWorkflowEngine,
  type WorkflowResumeInput,
} from './engine-port';
import { WorkflowNotResumableError, type IWorkflowStore } from './store';
export { WorkflowNotResumableError } from './store';
import type { ResolvedWorkflow } from './schemas';
import {
  emptySnapshot,
  captureRejection,
  makeRun,
  makeWorkflow,
  makeStore,
  makePlatform,
  defaultConfig,
  makeDeps,
  callInput,
  resumeCallInput,
  resumableStore,
  capturedRun,
} from './engine-contract-fixtures';

interface WorkflowEngineContractObservations {
  executedWorkflow: () => ResolvedWorkflow | undefined;
}

export function runWorkflowEngineContractTests(
  providers: ProviderRegistry,
  makeEngine: (deps: WorkflowDeps) => IWorkflowEngine,
  observations: WorkflowEngineContractObservations
): void {
  describe('IWorkflowEngine contract', () => {
    // Registered here, in the calling test file's scope: a hook registered while this shared
    // module is first imported would clean up after one importing file only.
    const trackTempRoot = trackTempRoots();

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
      const deps = makeDeps(providers, store, {
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
      expect(createdRuns[0]?.origin).toEqual({ conversationId: 'db-conv-1' });
      expect(messages).toContain('conv-1');
      expect(configLoads).toBe(1);
    });

    it('submits and resumes without conversation or user provenance', async () => {
      const originless = makeRun({ origin: null, conversation_id: null, user_id: null });
      const created: Parameters<IWorkflowStore['createWorkflowRun']>[0][] = [];
      const store = resumableStore({
        createWorkflowRun: async input => {
          created.push(input);
          return originless;
        },
        resumeWorkflowRun: async () => originless,
        getWorkflowRun: async () => ({ ...originless, status: 'completed' }),
      });
      const engine = makeEngine(makeDeps(providers, store));
      const input = callInput();
      delete input.origin;
      expect(await engine.submit(input)).toMatchObject({ success: true });
      expect(created[0]?.origin).toBeUndefined();
      const resumeInput = resumeCallInput();
      delete resumeInput.origin;
      const admission = await engine.resume({
        ...resumeInput,
        run: { ...originless, status: 'paused' },
      });
      expect(admission.accepted).toBe(true);
      if (!admission.accepted) throw new Error('expected resume');
      expect(await admission.settled).toMatchObject({ success: true });
      expect(created).toHaveLength(1);
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
      const result = await makeEngine(makeDeps(providers, store)).submit({
        ...callInput(),
        options: { preCreatedRun: pending },
      });
      expect(result).toMatchObject({ success: true, workflowRunId: 'pending-run' });
      expect(created).toBe(0);
    });

    it('refuses a fresh execution whose pending claim was already consumed', async () => {
      const pending = makeRun({ id: 'pending-run', status: 'pending' });
      const store = makeStore({ claimPendingWorkflowRun: async () => null });
      const result = await makeEngine(makeDeps(providers, store)).submit({
        ...callInput(),
        options: { preCreatedRun: pending },
      });
      expect(result).toEqual({
        success: false,
        workflowRunId: pending.id,
        error:
          'Workflow run is no longer pending, no longer owns its admitted resource, or its worktree was released',
      });
    });

    for (const committed of [false, true]) {
      it(`reports an uncertain pending claim without changing ownership (committed=${String(committed)})`, async () => {
        const pending = makeRun({ id: 'pending-run', status: 'pending' });
        let durableStatus = 'pending';
        let terminalWrites = 0;
        let executions = 0;
        const messages: string[] = [];
        const store = makeStore({
          claimPendingWorkflowRun: async () => {
            if (committed) durableStatus = 'running';
            throw new Error('database connection lost');
          },
          failWorkflowRun: async () => {
            terminalWrites += 1;
            return { failed: true };
          },
        });
        const result = await makeEngine(
          makeDeps(providers, store, {
            getAgentProvider: () => {
              return {
                getType: (): 'claude' => 'claude',
                getCapabilities: (): import('@archon/provider-contract').ProviderCapabilities =>
                  requireProvider(providers, 'claude').capabilities,
                checkCredential: async (): Promise<
                  import('@archon/provider-contract').CredentialStatus
                > => ({ state: 'not_checked', source: 'native' }),
                sendQuery: (): never => {
                  executions += 1;
                  throw new Error('must not execute');
                },
              };
            },
          })
        ).submit({
          ...callInput(),
          platform: {
            ...makePlatform(),
            sendMessage: async (_id, message) => {
              messages.push(message);
            },
          },
          options: { preCreatedRun: pending },
        });
        expect(result).toEqual({
          success: false,
          workflowRunId: pending.id,
          error: 'Unable to confirm workflow execution claim; inspect the run before retrying',
        });
        expect(durableStatus).toBe(committed ? 'running' : 'pending');
        expect(terminalWrites).toBe(0);
        expect(executions).toBe(0);
        expect(messages.join(' ')).toContain('inspect');
      });
    }

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
        makeDeps(providers, store, {
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
      expect(error instanceof Error ? error.message : String(error)).toBe(
        'Fresh execution requires a pending pre-created run; use resume instead.'
      );
      expect(created).toBe(0);
      expect(configLoads).toBe(0);
    });

    it('prepares the admitted row before execution and uses its returned context', async () => {
      const resumed = makeRun({ status: 'running' });
      const entered = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<void>();
      let executionCwd: string | undefined;
      let executionCodebase: string | undefined;
      const store = resumableStore({
        getCodebase: async id => {
          executionCodebase = id;
          return null;
        },
        resumeWorkflowRun: async () => resumed,
        getWorkflowRun: async () => ({ ...resumed, status: 'completed' }),
      });
      const engine = makeEngine(
        makeDeps(providers, store, {
          loadConfig: async cwd => {
            executionCwd = cwd;
            return defaultConfig();
          },
        })
      );
      const pending = engine.resume({
        ...resumeCallInput(),
        run: makeRun({ status: 'paused' }),
        options: { codebaseId: 'caller-codebase' },
        prepareExecution: async run => {
          expect(run).toEqual(resumed);
          entered.resolve();
          await ready.promise;
          return { cwd: '/prepared', options: { codebaseId: 'prepared-codebase' } };
        },
      });
      await entered.promise;
      expect(executionCwd).toBeUndefined();
      ready.resolve();
      const admission = await pending;
      if (!admission.accepted) throw new Error('Expected admission');
      await admission.settled;
      expect(executionCwd).toBe('/prepared');
      expect(executionCodebase).toBe('prepared-codebase');
    });

    it.each(['setup', ...RESUME_FORBIDDEN_OPTIONS])(
      'fails the admitted run when prepared %s is rejected',
      async field => {
        let failure: { id: string; error: string } | undefined;
        let executed = false;
        const resumed = makeRun({ status: 'running' });
        const store = resumableStore({
          resumeWorkflowRun: async () => resumed,
          failWorkflowRun: async (id, error) => {
            failure = { id, error };
            return { failed: true };
          },
        });
        const engine = makeEngine(
          makeDeps(providers, store, {
            loadConfig: async () => {
              executed = true;
              return defaultConfig();
            },
          })
        );
        const error = await captureRejection(
          engine.resume({
            ...resumeCallInput(),
            run: makeRun({ status: 'paused' }),
            prepareExecution: async () => {
              if (field === 'setup') throw new Error('setup rejected');
              return { cwd: '/prepared', options: { [field]: {} } };
            },
          })
        );
        expect(error).toBeInstanceOf(Error);
        expect(executed).toBe(false);
        expect(failure).toEqual({
          id: resumed.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );

    it('surfaces a failed terminal write after preparation rejection without executing', async () => {
      const persistError = new Error('failure write refused');
      let failureWrites = 0;
      let executed = false;
      const store = resumableStore({
        failWorkflowRun: async () => {
          failureWrites++;
          throw persistError;
        },
      });
      const engine = makeEngine(
        makeDeps(providers, store, {
          loadConfig: async () => {
            executed = true;
            return defaultConfig();
          },
        })
      );
      const error = await captureRejection(
        engine.resume({
          ...resumeCallInput(),
          run: makeRun({ status: 'paused' }),
          prepareExecution: async () => {
            throw new Error('setup rejected');
          },
        })
      );
      expect(error).toBeInstanceOf(TerminalStatusWriteError);
      expect(error).toMatchObject({ cause: persistError });
      expect(failureWrites).toBe(1);
      expect(executed).toBe(false);
    });

    it('returns admission before execution settles', async () => {
      const config = Promise.withResolvers<WorkflowConfig>();
      const resumed = makeRun({ id: 'accepted-run', status: 'running' });
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRun: async () => ({ ...resumed, status: 'completed' as const }),
      });
      const engine = makeEngine(makeDeps(providers, store, { loadConfig: () => config.promise }));
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
      const admission = await makeEngine(makeDeps(providers, store)).resume({
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
      const run = await capturedRun(
        trackTempRoot,
        `
name: test-workflow
description: Captured
nodes:
  - id: captured-node
    prompt: Run the captured graph
`
      );
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

      const admission = await makeEngine(makeDeps(providers, store)).resume({
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
        makeEngine(makeDeps(providers, store)).resume({ ...resumeCallInput(), run })
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
        makeEngine(makeDeps(providers, store)).resume({
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
      const result = await makeEngine(makeDeps(providers, store)).resume({
        ...resumeCallInput(),
        run: makeRun({ id: 'empty-run', status: 'paused' }),
      });
      expect(result).toEqual({ accepted: false, reason: 'nothing-to-resume' });
      expect(claims).toBe(0);
    });

    it('claims a released run even when it has no completed nodes', async () => {
      let claims = 0;
      const resumed = makeRun({ id: 'released-run', status: 'running' });
      const store = makeStore({
        resumeWorkflowRun: async () => {
          claims += 1;
          return resumed;
        },
        getWorkflowRun: async () => ({ ...resumed, status: 'completed' as const }),
      });
      const admission = await makeEngine(makeDeps(providers, store)).resume({
        ...resumeCallInput(),
        run: makeRun({
          id: 'released-run',
          status: 'paused',
          metadata: {
            source_release: { nodeId: 'check', releasedAt: '2026-08-24T11:00:00.000Z' },
          },
        }),
      });
      expect(admission).toMatchObject({ accepted: true, runId: 'released-run' });
      if (!admission.accepted) throw new Error('expected resume admission');
      await admission.settled;
      expect(claims).toBe(1);
    });

    it('preserves hydration and lost-claim errors before admission', async () => {
      const hydrationError = new Error('snapshot read failed');
      const caughtHydrationError = await captureRejection(
        makeEngine(
          makeDeps(
            providers,
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
            providers,
            resumableStore({
              resumeWorkflowRun: async () => Promise.reject(claimError),
            })
          )
        ).resume({ ...resumeCallInput(), run: makeRun({ id: 'raced-run', status: 'failed' }) })
      );
      expect(caughtClaimError).toBe(claimError);
    });

    it.each([
      ['preparedAiConfiguration', { preparedAiConfiguration: {} }],
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
      const error = await captureRejection(makeEngine(makeDeps(providers, store)).resume(input));
      expect(error).toBeInstanceOf(Error);
      expect(reads).toBe(0);
      expect(claims).toBe(0);
    });

    it('records a post-claim failure and preserves the execution error', async () => {
      const cause = new Error('config failed');
      const config = Promise.withResolvers<WorkflowConfig>();
      const resumed = makeRun({ id: 'failed-run', status: 'running' });
      const failures: { id: string; message: string }[] = [];
      let durableStatus: import('./schemas').WorkflowRunStatus = 'running';
      const store = resumableStore({
        resumeWorkflowRun: async () => resumed,
        getWorkflowRunStatus: async () => durableStatus,
        failWorkflowRun: async (id, message) => {
          durableStatus = 'failed';
          failures.push({ id, message });
          return { failed: true };
        },
      });
      const admission = await makeEngine(
        makeDeps(providers, store, { loadConfig: () => config.promise })
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
      const config = Promise.withResolvers<WorkflowConfig>();
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
        makeDeps(providers, store, { loadConfig: () => config.promise })
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
          return { failed: true };
        },
      });
      const admission = await makeEngine(
        makeDeps(providers, store, { loadConfig: async () => Promise.reject(cause) })
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
