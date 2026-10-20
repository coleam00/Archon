// @archon-test-isolated
import {
  captureAdoptedRunDir,
  cwdPath,
  dagCall,
  makeRun,
  makeStore,
  makeWorkflow,
  mocked,
  mockEmitter,
  mockExecuteDagWorkflow,
  repoCodebase,
  resetExecutorMocks,
  resumeOf,
  startWorkflow,
  WS,
} from './executor/test-utils';
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import type { ExecuteWorkflowOptions } from './executor';
import { RUN_METADATA_KEYS } from './schemas';
import type { IWorkflowStore } from './store';
import { keepAwake } from './utils/keep-awake';

/** Where a run's artifacts live: adopted run dirs, the persisted output root and scope dirs. */

beforeEach(resetExecutorMocks);

const OUT_OF_TREE_ROOT = '/old-machine/.archon/workspaces/old/name';
const adopt: ExecuteWorkflowOptions = { adoptedFromRunId: 'prior-run', continuationMode: 'adopt' };

function adoptedRunEvents(store: IWorkflowStore): unknown[] {
  return mocked(store.createWorkflowEvent)
    .mock.calls.map(([event]) => event)
    .filter(event => event.event_type === 'workflow.run_adopted');
}

// $ADOPTED_RUN_DIR resolves through the shared persisted-output-root resolver (#2747, #3097).
// A root inside ARCHON_HOME is used as is; a relocated root is re-derived under the current
// ARCHON_HOME through the adopted run's codebase row rather than walked verbatim.
describe('adopted run dir', () => {
  const trustedRoot = join(WS, 'workspaces', 'acme', 'widget');
  const roots = [
    ['inside ARCHON_HOME', trustedRoot, null, trustedRoot],
    ['relocated', OUT_OF_TREE_ROOT, 'cb-adopted', join(WS, 'acme', 'widget')],
  ] as const;

  for (const [label, outputRoot, codebaseId, expectedRoot] of roots) {
    for (const resume of [false, true]) {
      it(`${resume ? 'resume' : 'fresh'}: resolves an adopted output root ${label}`, async () => {
        const store = makeStore({
          getWorkflowRun: mock(async (id: string) =>
            id === 'prior-run'
              ? makeRun({
                  id,
                  status: 'completed',
                  output_root: outputRoot,
                  codebase_id: codebaseId,
                })
              : makeRun({ status: 'completed' })
          ),
          getCodebase: mock(async (id: string) =>
            id === 'cb-adopted' ? { ...repoCodebase, id: 'cb-adopted' } : null
          ),
        });
        const adoptedRunDir = captureAdoptedRunDir();
        const result = await startWorkflow({
          store,
          cwd: '/tmp/ops',
          options: resume
            ? resumeOf(makeRun({ adopted_from_run_id: 'prior-run' }), [
                ['node1', { output: 'out' }],
              ])
            : adopt,
        });
        expect(result.success).toBe(true);
        expect(store.getWorkflowRun).toHaveBeenCalledWith('prior-run');
        // path.join uses the platform separator; the template's '/report.md' stays POSIX.
        expect(adoptedRunDir()).toBe(
          `Read ${join(expectedRoot, 'artifacts', 'runs', 'prior-run')}/report.md`
        );
        // The adoption announcement is creation-only — a resume must not re-emit it.
        expect(adoptedRunEvents(store)).toHaveLength(resume ? 0 : 1);
      });
    }
  }

  for (const resume of [false, true]) {
    for (const outputRoot of [null, OUT_OF_TREE_ROOT]) {
      it(`${resume ? 'resume' : 'fresh'}: fails the run when the adopted output root is ${outputRoot === null ? 'missing' : 'outside ARCHON_HOME'}`, async () => {
        const run = makeRun({ adopted_from_run_id: 'prior-run' });
        const failRun = mock<IWorkflowStore['failWorkflowRun']>(async (_id, error) => {
          run.status = 'failed';
          run.metadata.error = error;
          return { failed: true };
        });
        const store = makeStore({
          createWorkflowRun: mock(async () => run),
          getWorkflowRun: mock(async (id: string) =>
            id === 'prior-run' ? makeRun({ id, status: 'completed', output_root: outputRoot }) : run
          ),
          getWorkflowRunStatus: mock(async () => run.status),
          failWorkflowRun: failRun,
        });
        const acquireSpy = spyOn(keepAwake, 'acquire');
        const releaseSpy = spyOn(keepAwake, 'release');
        try {
          const result = await startWorkflow({
            store,
            cwd: '/tmp/ops',
            options: resume ? resumeOf(run) : adopt,
          });
          const message =
            outputRoot === null
              ? "Cannot adopt run 'prior-run': it has no persisted output root, so its artifact directory cannot be addressed."
              : "Cannot adopt run 'prior-run': its persisted output root is outside ARCHON_HOME and cannot be re-derived, so its artifact directory cannot be addressed.";
          expect(result).toEqual({ success: false, workflowRunId: run.id, error: message });
          expect(run.status).toBe('failed');
          expect(run.metadata.error).toBe(message);
          expect(failRun).toHaveBeenCalledTimes(1);
          expect(failRun).toHaveBeenCalledWith(run.id, message, { exitReason: 'unhandled_error' });
          expect(mockEmitter.emit).toHaveBeenCalledWith({
            type: 'workflow_failed',
            runId: run.id,
            workflowName: 'test-workflow',
            error: message,
          });
          expect(adoptedRunEvents(store)).toHaveLength(0);
          expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
          expect(acquireSpy).toHaveBeenCalledTimes(1);
          expect(releaseSpy).toHaveBeenCalledTimes(1);
          expect(keepAwake.activeCount()).toBe(0);
        } finally {
          acquireSpy.mockRestore();
          releaseSpy.mockRestore();
        }
      });
    }
  }

  it('surfaces a rejected adoption failure write without retrying or announcing failure', async () => {
    const writeError = new Error('terminal store unavailable');
    const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {
      throw writeError;
    });
    const store = makeStore({
      getWorkflowRun: mock(async () => makeRun({ output_root: null })),
      getWorkflowRunStatus: mock(async () => 'running' as const),
      failWorkflowRun: failRun,
    });
    await expect(startWorkflow({ store, cwd: '/tmp/ops', options: adopt })).rejects.toMatchObject({
      name: 'TerminalStatusWriteError',
      cause: writeError,
    });
    expect(failRun).toHaveBeenCalledTimes(1);
    expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
    expect(mockEmitter.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workflow_failed' })
    );
    expect(keepAwake.activeCount()).toBe(0);
  });
});

// Supersession is metadata-only (#3064): no estate, so no output_root gate.
describe('supersession does not gate on output_root', () => {
  it('starts a superseding run whose superseded run has no output_root', async () => {
    const store = makeStore({
      getWorkflowRun: mock(async (id: string) =>
        id === 'superseded-run'
          ? makeRun({ id, status: 'failed' })
          : makeRun({ status: 'completed' })
      ),
    });
    const result = await startWorkflow({
      store,
      cwd: '/tmp/ops',
      options: { adoptedFromRunId: 'superseded-run', continuationMode: 'supersede' },
    });
    expect(result.success).toBe(true);
    // The stamp records the continuation mode so resume reads it.
    expect(store.createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ continuation: { mode: 'supersede' } }),
      })
    );
    expect(store.getWorkflowRun).not.toHaveBeenCalledWith('superseded-run');
    expect(adoptedRunEvents(store)).toHaveLength(1);
    const [event] = adoptedRunEvents(store) as { data: Record<string, unknown> }[];
    expect(event?.data).toMatchObject({ adopted_from_run_id: 'superseded-run', mode: 'supersede' });
  });

  it('resumes a superseding run without fetching the superseded run', async () => {
    const store = makeStore({ getWorkflowRun: mock(async () => makeRun({ status: 'completed' })) });
    const result = await startWorkflow({
      store,
      cwd: '/tmp/ops',
      options: resumeOf(
        makeRun({
          adopted_from_run_id: 'superseded-run',
          metadata: { continuation: { mode: 'supersede' } },
        }),
        [['node1', { output: 'out' }]]
      ),
    });
    expect(result.success).toBe(true);
    expect(store.getWorkflowRun).not.toHaveBeenCalledWith('superseded-run');
  });
});

// The persistence block distinguishes three identity outcomes (#2304). 'faulted' skips the
// output_root write and stamps `metadata.identity_unresolved`, so a later resume can
// self-heal; 'unregistered' and 'resolved' persist output_root.
describe('output_root persistence branching (#2304)', () => {
  const outputRootWrite = (store: IWorkflowStore) =>
    mocked(store.updateWorkflowRun).mock.calls.find(
      ([, patch]) => typeof patch.output_root === 'string'
    )?.[1];
  const startInRepo = (store: IWorkflowStore, codebaseId: string) =>
    startWorkflow({ store, cwd: '/repos/widget', options: { codebaseId } });

  it('does NOT write output_root when identity resolution faults; stamps the metadata flag instead', async () => {
    const store = makeStore({
      // Both attempts throw — the retry yields the same fault.
      getCodebase: mock(async () => {
        throw new Error('db down');
      }),
    });
    await startInRepo(store, 'cb-boom');
    expect(outputRootWrite(store)).toBeUndefined();
    const flagWrite = mocked(store.updateWorkflowRun).mock.calls.find(
      ([, patch]) => patch.metadata?.[RUN_METADATA_KEYS.identityUnresolved] === true
    );
    expect(flagWrite).toBeDefined();
    expect(flagWrite?.[1].output_root).toBeUndefined();
  });

  it('persists output_root for a registered codebase without touching metadata', async () => {
    const created = makeRun({ id: 'run-mirror', output_root: null });
    const store = makeStore({
      createWorkflowRun: mock(async () => created),
      getCodebase: mock(async () => repoCodebase),
    });
    await startInRepo(store, 'cb-repo');
    const patch = outputRootWrite(store);
    expect(typeof patch?.output_root).toBe('string');
    expect(patch?.metadata).toBeUndefined();
    // The identity flag is the faulted-only signal.
    expect(
      mocked(store.updateWorkflowRun).mock.calls.some(
        ([, update]) => update.metadata?.[RUN_METADATA_KEYS.identityUnresolved] !== undefined
      )
    ).toBe(false);
    // #2453 — the run that just recorded its root is the first reader of it, through the
    // artifact-pointer gate, so the in-memory row must carry it too.
    expect(created.output_root).toBe(patch?.output_root ?? null);
  });

  it('clears metadata.identity_unresolved in the same write when a faulted row heals', async () => {
    const store = makeStore({
      getCodebase: mock(async () => repoCodebase),
      createWorkflowRun: mock(async () =>
        makeRun({ metadata: { [RUN_METADATA_KEYS.identityUnresolved]: true } })
      ),
    });
    await startInRepo(store, 'cb-repo');
    const patch = outputRootWrite(store);
    expect(typeof patch?.output_root).toBe('string');
    // A flag left set would make every reader treat a resolved row as still faulted.
    expect(patch?.metadata).toEqual({ [RUN_METADATA_KEYS.identityUnresolved]: false });
  });
});

describe('scope artifacts dir threading (#1846)', () => {
  it('threads scopeArtifactsDir into executeDagWorkflow for persist_session workflows', async () => {
    await startWorkflow({
      workflow: makeWorkflow({
        nodes: [
          {
            id: 'node1',
            kind: 'agent',
            source: { kind: 'inline', prompt: 'Do something' },
            persist_session: true,
          },
        ],
      }),
    });
    // The root is the unregistered-cwd project (#2200); the scope is the workflow name and
    // the conversation id of the created row.
    expect(dagCall()?.scopeArtifactsDir).toBe(
      cwdPath('/tmp', 'artifacts', 'scopes', 'test-workflow', 'conv-1')
    );
  });

  it('passes undefined scopeArtifactsDir when the workflow uses no session persistence', async () => {
    await startWorkflow();
    expect(dagCall()?.scopeArtifactsDir).toBeUndefined();
  });
});
