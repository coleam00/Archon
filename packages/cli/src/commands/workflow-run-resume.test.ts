import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { makeContinuationRun } from '../test-support/workflow-continuation-fixture';
import { createTestWorkflowHost } from '../test-support/workflow-command-harness';

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

describe('workflowRunCommand — resume of a prior run', () => {
  let tempRoot: string;
  let priorRun: WorkflowRun;
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
   * Stub discovery and a dead prior run whose worktree survives. `status` drives the
   * run's terminality; `running` is an ownerless run its killed process left behind.
   */
  async function stubFailedPriorRun(
    status: 'failed' | 'running' | 'paused' = 'failed'
  ): Promise<void> {
    const isolationEnvs = [
      {
        id: 'env-1',
        codebase_id: 'cb-resume',
        working_path: tempRoot,
        branch_name: 'fix/issue-3124',
      },
    ];
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-ship' }, 'project')],
      errors: [],
    });
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'main',
    });
    priorRun = makeContinuationRun({
      id: 'run-dead',
      working_path: tempRoot,
      workflow_name: 'archon-ship',
      codebase_id: null,
      status,
    });
    (isolationDb.listByCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(isolationEnvs);
  }

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
        continuationRun: priorRun,
      })
    ).rejects.toThrow(
      /^Cannot resume workflow 'archon-ship' now: Workflow run 'run-dead' cannot resume while resource owner 'holder-1' has priority\. It stays paused;/
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
          { resume: true, continuationRun: priorRun }
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

  for (const status of ['failed', 'running'] as const) {
    it(`restarts a ${status} run with no completed node in place, under its own id`, async () => {
      const { executeWorkflow } = await import('@archon/workflows/executor');
      await stubFailedPriorRun(status);
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'run-dead',
      });

      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'archon-ship', 'go', {
        resume: true,
        continuationRun: priorRun,
      });

      expect(executeWorkflow).toHaveBeenCalledTimes(1);
      const call = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      const opts = call.at(-1) as {
        preCreatedRun?: { id: string };
        priorCompletedNodes?: Map<string, unknown>;
      };
      expect(opts.preCreatedRun?.id).toBe('run-dead');
      expect(opts.priorCompletedNodes?.size).toBe(0);
    });
  }
});
