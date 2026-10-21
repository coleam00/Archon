// @archon-test-isolated
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  makeRun,
  makeStore,
  mockEmitter,
  mockExecuteDagWorkflow,
  resetExecutorMocks,
  resumeOf,
  startWorkflow,
} from './executor/test-utils';
import { WORKFLOW_SOURCE_METADATA_KEY } from './schemas';
import type { IWorkflowStore } from './store';
import { TerminalStatusWriteError } from './terminal-status-write';
import { keepAwake } from './utils/keep-awake';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import {
  digestEntries,
  foldDigest,
  writeManifest,
  type WorkflowSourceManifest,
} from './workflow-source/manifest';

const trackTempRoot = trackTempRoots();
beforeEach(resetExecutorMocks);

async function sourceRun(withFile = false) {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'executor-source-')));
  const content = 'original';
  if (withFile) await writeFile(join(root, 'source.txt'), content);
  const manifest: WorkflowSourceManifest = {
    version: 1,
    engine_version: 'test',
    origin: root,
    captured_at: new Date().toISOString(),
    digest: foldDigest(await digestEntries(root)),
    file_count: withFile ? 1 : 0,
    byte_count: withFile ? Buffer.byteLength(content) : 0,
    scopes: [],
    source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
  };
  await writeManifest(root, manifest);
  const run = makeRun({
    metadata: {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root,
        origin: root,
        captured_at: manifest.captured_at,
        digest: manifest.digest,
        file_count: manifest.file_count,
        byte_count: manifest.byte_count,
      },
    },
  });
  const store = makeStore({
    getWorkflowRun: mock(async () => run),
    getWorkflowRunStatus: mock(async () => run.status),
    failWorkflowRun: mock<IWorkflowStore['failWorkflowRun']>(async (_id, error) => {
      run.status = 'failed';
      run.metadata.error = error;
      return { failed: true };
    }),
  });
  return { root, run, store };
}

type Rejection = 'release' | 'follow-up read' | 'source_config pin';
const rejections: Rejection[] = ['release', 'follow-up read', 'source_config pin'];

async function rejectingSource(operation: Rejection) {
  const fixture = await sourceRun();
  const { root, run, store } = fixture;
  const error = new Error(`${operation} unavailable`);
  const reached = mock(() => {
    expect(run.status).toBe('running');
    throw error;
  });
  if (operation === 'source_config pin') {
    store.updateWorkflowRun = mock(async (id, patch) => {
      if (patch.metadata?.[WORKFLOW_SOURCE_METADATA_KEY]) {
        expect(id).toBe(run.id);
        expect(patch.metadata[WORKFLOW_SOURCE_METADATA_KEY]).toMatchObject({
          source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
        });
        reached();
      }
    });
  } else {
    await rm(join(root, 'manifest.json'));
    store.releaseRunForUnreadableSource = mock(async () => {
      if (operation === 'release') reached();
      return { released: false };
    });
    if (operation === 'follow-up read') {
      // Only the follow-up read rejects; the executor's exit read sees the failed run.
      store.getWorkflowRun = mock<IWorkflowStore['getWorkflowRun']>(
        async () => run
      ).mockImplementationOnce(async id => {
        expect(id).toBe(run.id);
        expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
        return reached();
      });
    }
  }
  return { ...fixture, error, reached };
}

async function withKeepAwakeCheck(operation: () => Promise<void>) {
  const acquire = spyOn(keepAwake, 'acquire');
  const release = spyOn(keepAwake, 'release');
  try {
    await operation();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(keepAwake.activeCount()).toBe(0);
  } finally {
    acquire.mockRestore();
    release.mockRestore();
  }
}

describe('post-admission source store rejections', () => {
  it.each(rejections)('%s fails the owned run with the original diagnostic', async operation => {
    const { run, store, error, reached } = await rejectingSource(operation);
    await withKeepAwakeCheck(async () => {
      const result = await startWorkflow({ store, options: resumeOf(run) }).catch(
        (error: unknown) => error
      );
      expect(reached).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('failed');
      expect(result).toEqual({ success: false, workflowRunId: run.id, error: error.message });
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).toHaveBeenCalledWith(run.id, error.message, {
        exitReason: 'unhandled_error',
      });
      expect(run.metadata.error).toBe(error.message);
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });
  });

  it.each(rejections)('%s exposes both errors if the failure write rejects', async operation => {
    const { run, store, error, reached } = await rejectingSource(operation);
    const writeError = new Error('terminal write unavailable');
    store.failWorkflowRun = mock(async () => {
      throw writeError;
    });
    await withKeepAwakeCheck(async () => {
      const caught = await startWorkflow({ store, options: resumeOf(run) }).catch(
        (error: unknown) => error
      );
      expect(caught).toBeInstanceOf(TerminalStatusWriteError);
      if (!(caught instanceof TerminalStatusWriteError)) throw new Error('missing typed marker');
      expect(caught.message).toContain(error.message);
      expect(caught.message).toContain(writeError.message);
      expect(caught.cause).toBe(writeError);
      expect(reached).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.failWorkflowRun).toHaveBeenCalledWith(run.id, error.message, {
        exitReason: 'unhandled_error',
      });
      expect(run.status).toBe('running');
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'workflow_failed' })
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });
  });
});

describe('stopped source establishment', () => {
  it.each([true, false])('preserves a stopped source result when released=%s', async released => {
    const { root, run, store } = await sourceRun();
    await rm(join(root, 'manifest.json'));
    store.releaseRunForUnreadableSource = mock(async () => {
      if (released) run.status = 'paused';
      return { released };
    });
    await withKeepAwakeCheck(async () => {
      expect(await startWorkflow({ store, options: resumeOf(run) })).toEqual(
        released
          ? { success: true, paused: true, workflowRunId: run.id }
          : {
              success: false,
              workflowRunId: run.id,
              error: 'Workflow status changed before source release',
            }
      );
      expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
      expect(store.getWorkflowRun).toHaveBeenCalledTimes(released ? 0 : 1);
      expect(run.status).toBe(released ? 'paused' : 'running');
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
      expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    'fails closed on source drift, failure write rejects=%s',
    async rejects => {
      const { root, run, store } = await sourceRun(true);
      await writeFile(join(root, 'source.txt'), 'altered');
      const writeError = new Error('integrity failure write unavailable');
      if (rejects) {
        store.failWorkflowRun = mock(async () => {
          throw writeError;
        });
      }
      await withKeepAwakeCheck(async () => {
        const result = startWorkflow({ store, options: resumeOf(run) });
        if (rejects) {
          await expect(result).rejects.toMatchObject({
            name: 'TerminalStatusWriteError',
            cause: writeError,
          });
        } else {
          expect(await result).toMatchObject({
            success: false,
            workflowRunId: run.id,
            error: expect.stringContaining('missing or altered'),
          });
          expect(run.status).toBe('failed');
          expect(run.metadata.error).toContain('missing or altered');
        }
        expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
        expect(store.failWorkflowRun).toHaveBeenCalledWith(
          run.id,
          expect.stringContaining('missing or altered'),
          { exitReason: 'source_unavailable' }
        );
        expect(store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
        expect(store.getWorkflowRunStatus).not.toHaveBeenCalled();
        expect(mockEmitter.emit).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'workflow_failed' })
        );
        expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      });
    }
  );
});
