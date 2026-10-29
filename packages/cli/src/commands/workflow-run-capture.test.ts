import {
  mockFolderBackendPrepare,
  recordCapturedSourceCalls,
  CAPTURED_SOURCE_ROOTS,
  mockResolveContinuationWorkflow,
  mockArtifactsRoot,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { existsSync } from 'node:fs';

import { join } from 'node:path';

import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand — continuation and capture ownership (#2646)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockResolveContinuationWorkflow.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('keeps delayed ownership calls in their originating recorder', async () => {
    const { withCapturedSource } = await import('@archon/workflows/run-source');
    const resume = Promise.withResolvers<void>();
    const previous = await recordCapturedSourceCalls(async calls => ({
      calls,
      pending: withCapturedSource(async owner => {
        await resume.promise;
        owner.adopt();
      }),
    }));

    await withCapturedSource(async owner => owner.adopt());
    expect(previous.calls).toEqual([]);
    await recordCapturedSourceCalls(async calls => {
      await withCapturedSource(async owner => owner.adopt());
      resume.resolve();
      await previous.pending;
      expect(calls).not.toBe(previous.calls);
      expect(calls).toEqual(['adopt']);
      expect(previous.calls).toEqual(['adopt']);
    });
  });

  it('executes the graph the run froze on `run <name> --resume`, not the one in the checkout', () =>
    recordCapturedSourceCalls(async capturedSourceOwnerCalls => {
      // The name form names its run indirectly, so it used to reach the resumable row only
      // after the graph was already chosen from live discovery — while the executor still
      // fed that graph the frozen commands and scripts. Two vintages in one run, on the one
      // resume form that never carried a run object.
      const { executeWorkflow } = await import('@archon/workflows/executor');
      const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
      const conversationDb = await import('@archon/core/db/conversations');
      const codebaseDb = await import('@archon/core/db/codebases');
      const workflowDb = await import('@archon/core/db/workflows');
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

      const frozen = makeTestResolvedWorkflow({ name: 'review-block', description: 'frozen' });
      // What the checkout holds NOW: same name, edited since the run paused. Set as the
      // standing answer rather than a queued one — a continuation must never consume it, and
      // a queued value nothing consumes leaks into the next test.
      const discoverMock = discoverWorkflowsWithConfig as ReturnType<typeof mock>;
      discoverMock.mockClear();
      discoverMock.mockResolvedValue({
        workflows: [makeTestWorkflowWithSource({ name: 'review-block', description: 'edited' })],
        errors: [],
      });
      const frozenContinuation = {
        workflow: frozen,
        roots: CAPTURED_SOURCE_ROOTS,
        workflows: [{ workflow: frozen, source: 'project' as const }],
        errors: [],
      };
      mockResolveContinuationWorkflow
        .mockResolvedValueOnce(frozenContinuation)
        .mockResolvedValueOnce(frozenContinuation);
      (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-prior',
        working_path: null,
        workflow_name: 'review-block',
      });
      (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        preCreatedRun: { id: 'run-prior', workflow_name: 'review-block' },
        priorCompletedNodes: new Map([['node-a', 'done']]),
      });
      (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'conv-resume',
      });
      (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'cb-resume',
        default_cwd: '/repo/root',
        default_branch: 'develop',
      });
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'run-prior',
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
          resume: true,
        });
      } finally {
        discoverMock.mockResolvedValue({ workflows: [], errors: [] });
      }

      // Live discovery never even runs: the continuation carries the discovery it paid for.
      expect(discoverMock).not.toHaveBeenCalled();
      // Host preparation and engine admission both resolve this run's recorded source.
      expect(mockResolveContinuationWorkflow).toHaveBeenCalledTimes(2);
      const continuedRun = mockResolveContinuationWorkflow.mock.calls[0]?.[1] as unknown as {
        id: string;
      };
      expect(continuedRun.id).toBe('run-prior');
      // ...and its answer, not the edited checkout, is what runs.
      const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][4] as {
        description?: string;
      };
      expect(executed.description).toBe('frozen');
      // A continuation captures nothing: there is nothing new to freeze.
      expect(capturedSourceOwnerCalls).toEqual([]);
    }));

  it('hands the capture to the run that starts', () =>
    recordCapturedSourceCalls(async capturedSourceOwnerCalls => {
      // The wrapper only protects anything if the run path actually calls its owner. Assert
      // adoption: a dropped `adopt()` deletes a live run's source. Under #2690 the
      // run path passes `capturedSourceOwner` through and the (mocked) executor adopts;
      // the implementation override below mirrors that.
      const { executeWorkflow } = await import('@archon/workflows/executor');
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      });
      (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce((...args: unknown[]) => {
        const opts = args[7] as
          | {
              preparedSource?: unknown;
              capturedSourceOwner?: { adopt: () => void };
            }
          | undefined;
        if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
        return Promise.resolve({ success: true, workflowRunId: 'run-ok' });
      });

      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
        noWorktree: true,
      });
      expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'adopt']);
    }));

  it('reclaims the capture when no run starts', () =>
    recordCapturedSourceCalls(async capturedSourceOwnerCalls => {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [],
        errors: [],
      });

      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'go', {
          noWorktree: true,
        })
      ).rejects.toThrow('No workflows found');
      expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'reclaim:/test/capture']);
    }));

  it('reclaims the finalized container capture when backend preparation fails', () =>
    recordCapturedSourceCalls(async capturedSourceOwnerCalls => {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      const { finalizeWorkflowSource } = await import('@archon/workflows/run-source');
      const codebaseDb = await import('@archon/core/db/codebases');

      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      });
      (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'cb-folder',
        name: 'platform',
        default_cwd: '/test/path',
        default_branch: null,
        kind: 'folder',
      });
      (finalizeWorkflowSource as ReturnType<typeof mock>).mockResolvedValueOnce({
        runId: 'test-run-id',
        origin: '/test/path',
        manifest: {
          version: 1,
          engine_version: 'test',
          origin: '/test/path',
          captured_at: '2026-08-21T00:00:00.000Z',
          digest: 'test-digest',
          file_count: 0,
          byte_count: 0,
          scopes: [],
        },
        anchor: {
          root: '/test/finalized/workflow-source',
          digest: 'test-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
        roots: {
          project: '/test/finalized/workflow-source/project',
          globalWorkflows: '/test/finalized/workflow-source/global/workflows',
          globalCommands: '/test/finalized/workflow-source/global/commands',
          globalScripts: '/test/finalized/workflow-source/global/scripts',
          bundledWorkflows: '/test/finalized/workflow-source/bundled/workflows',
          bundledCommands: '/test/finalized/workflow-source/bundled/commands/defaults',
          kind: 'captured',
          anchor: {
            root: '/test/finalized/workflow-source',
            digest: 'test-digest',
            config: {
              load_default_workflows: true,
              load_default_commands: true,
            },
          },
        },
      });
      mockFolderBackendPrepare.mockRejectedValueOnce(new Error('container unavailable'));

      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
          container: true,
        })
      ).rejects.toThrow('container unavailable');

      expect(capturedSourceOwnerCalls).toEqual([
        'hold:/test/capture',
        'hold:/test/finalized/workflow-source',
        'reclaim:/test/finalized/workflow-source',
      ]);
    }));

  it('binds the run artifacts directory into the container, created on the host first', () =>
    recordCapturedSourceCalls(async () => {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      const codebaseDb = await import('@archon/core/db/codebases');

      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      });
      (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'cb-folder',
        name: 'platform',
        default_cwd: '/test/path',
        default_branch: null,
        kind: 'folder',
      });
      const expectedArtifacts = join(mockArtifactsRoot, 'artifacts', 'runs', 'test-run-id');
      // Ownership matters: a bind target Docker creates itself is root-owned on a rootful
      // daemon, so the directory must already exist when prepare() is reached.
      let existedAtPrepare: boolean | undefined;
      mockFolderBackendPrepare.mockImplementationOnce((req?: unknown) => {
        const artifactsMount = (req as { artifactsMount?: string } | undefined)?.artifactsMount;
        existedAtPrepare = artifactsMount !== undefined && existsSync(artifactsMount);
        return Promise.resolve({
          cwd: '/test/path',
          execContext: { kind: 'host' as const },
          envId: 'container-env-1',
          overlayMode: 'fuse' as const,
        });
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'go', {
        container: true,
      });

      expect(mockFolderBackendPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMount: '/test/capture',
          artifactsMount: expectedArtifacts,
        })
      );
      expect(existedAtPrepare).toBe(true);
    }));
});
