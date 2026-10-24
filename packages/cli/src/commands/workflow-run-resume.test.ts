import {
  mockRunLiveOwnerClose,
  mockStartRunLiveOwner,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';

import { WorkflowResourceBusyError } from '@archon/workflows/store';

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';

import * as fs from 'node:fs';
import {
  DETACHED_RESUME_RECEIPT,
  DETACHED_RESUME_RECEIPT_ENV,
  DETACHED_RESUME_RECEIPT_FD,
} from '../utils/detached-resume-receipt';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand — resume with nothing completed (#3154)', () => {
  let tempRoot: string;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'archon-cli-resume-empty-'));
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (hydrateResumableRun as ReturnType<typeof mock>).mockClear();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await removeTempTree(tempRoot);
  });

  /**
   * Stub discovery and a dead prior run. `status` drives the run's terminality
   * and `isolationEnvs` seeds the isolation records the resume path matches —
   * empty for an in-place prior run, the surviving worktree record by default.
   */
  async function stubFailedPriorRun(
    status: 'failed' | 'running' | 'paused' = 'failed',
    isolationEnvs: Array<Record<string, unknown>> = [
      {
        id: 'env-1',
        codebase_id: 'cb-resume',
        working_path: tempRoot,
        branch_name: 'fix/issue-3124',
      },
    ]
  ): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-ship' }, 'project')],
      errors: [],
    });
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'main',
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-dead',
      working_path: tempRoot,
      workflow_name: 'archon-ship',
      status,
    });
    (isolationDb.listByCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(isolationEnvs);
  }

  it('refuses and names the same-branch relaunch with --supersedes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun();
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();
    (hydrateResumableRun as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      expect(mockStartRunLiveOwner).toHaveBeenCalledWith('run-dead', {});
      return null;
    });

    const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const close = spyOn(fs, 'closeSync').mockImplementation(() => {});
    process.env[DETACHED_RESUME_RECEIPT_ENV] = '1';
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
          resume: true,
        })
      ).rejects.toThrow(
        /no completed nodes and no interactive-loop state[\s\S]*archon workflow run archon-ship --branch fix\/issue-3124 --supersedes run-dead/
      );

      expect(write).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
      write.mockRestore();
      close.mockRestore();
    }

    // The refusal is still a refusal: no run is started.
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it('suggests a fresh in-place relaunch when no isolation record matched', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('failed', []);
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    // An in-place relaunch cannot carry --branch: the prior run's branch is the
    // main checkout's own, so suggesting it would hand the operator a command
    // this same CLI refuses.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /^Cannot resume: the prior run for 'archon-ship' has no completed nodes and no interactive-loop state\.\nNothing can be skipped, so start a fresh run instead:\n  archon workflow run archon-ship --supersedes run-dead$/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('reports a resume refused for capacity as a busy resource, not lost state', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('paused');
    (hydrateResumableRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new WorkflowResourceBusyError('run-dead', { kind: 'run', id: 'holder-1' }, 'paused')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /^Cannot resume workflow 'archon-ship' now: Workflow run 'run-dead' cannot resume while resource owner 'holder-1' has priority\. It stays paused;/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('names the abandon step for a stale-running orphan before the relaunch', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun('running');
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    // --supersedes refuses a still-running run, so the message must first release it.
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
      })
    ).rejects.toThrow(
      /no completed nodes and no interactive-loop state[\s\S]*archon workflow abandon run-dead[\s\S]*archon workflow run archon-ship --branch fix\/issue-3124 --supersedes run-dead/
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  for (const brokenPipe of [false, true]) {
    it(`notifies accepted resume before settlement (broken pipe: ${String(brokenPipe)})`, async () => {
      const { executeWorkflow } = await import('@archon/workflows/executor');
      const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
      await stubFailedPriorRun();
      (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        preCreatedRun: { id: 'run-dead', workflow_name: 'archon-ship' },
        priorCompletedNodes: new Map([['triage', 'done']]),
      });
      let settleExecution!: (result: { success: boolean; workflowRunId: string }) => void;
      const execution = new Promise<{ success: boolean; workflowRunId: string }>(resolve => {
        settleExecution = resolve;
      });
      (executeWorkflow as ReturnType<typeof mock>).mockReturnValueOnce(execution);
      const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {
        if (brokenPipe) throw Object.assign(new Error('closed launcher'), { code: 'EPIPE' });
      });
      const close = spyOn(fs, 'closeSync').mockImplementation(() => {});
      process.env[DETACHED_RESUME_RECEIPT_ENV] = '1';
      try {
        let finished = false;
        const command = workflowRunCommand(
          createTestWorkflowHost(),
          '/repo/root',
          'archon-ship',
          'go',
          { resume: true }
        );
        void command.then(() => {
          finished = true;
        });
        for (let attempt = 0; attempt < 100 && write.mock.calls.length === 0; attempt++) {
          await Promise.resolve();
        }
        expect(write).toHaveBeenCalledWith(DETACHED_RESUME_RECEIPT_FD, DETACHED_RESUME_RECEIPT);
        expect(finished).toBe(false);
        expect(process.env[DETACHED_RESUME_RECEIPT_ENV]).toBeUndefined();
        settleExecution({ success: true, workflowRunId: 'run-dead' });
        await command;
        expect(finished).toBe(true);
        expect(write).toHaveBeenCalledTimes(1);
      } finally {
        settleExecution({ success: true, workflowRunId: 'run-dead' });
        Reflect.deleteProperty(process.env, DETACHED_RESUME_RECEIPT_ENV);
        write.mockRestore();
        close.mockRestore();
      }
    });
  }

  it('still resumes when the prior run has completed nodes', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    await stubFailedPriorRun();
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-dead', workflow_name: 'archon-ship' },
      priorCompletedNodes: new Map([['triage', 'done']]),
    });
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-dead',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
      resume: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });
});
