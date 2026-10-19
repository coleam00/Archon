/**
 * Tests for `workflow run`: selection, admission, launch, execution, and the wait loop.
 */
import {
  mockLogger,
  mockRunLiveOwnerClose,
  mockAssertDetachedRunProcessOwner,
  mockStartRunLiveOwner,
  mockFolderBackendPrepare,
  mockResolveFolderBackend,
  mockDiscoverWorkflowsWithConfig,
  capturedSourceOwnerCalls,
  CAPTURED_SOURCE_ROOTS,
  mockResolveContinuationWorkflow,
  mockArtifactsRoot,
  mockGetCurrentBranchStrict,
  createTestWorkflowHost,
  setMockDetachedStopRequested,
} from '../test-support/workflow-command-harness';
import { prepareWorkflowSource } from '@archon/workflows/run-source';
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import type { AdoptionLane } from '@archon/core/operations/workflow-adoption';
import { toBranchName } from '@archon/git';
import { WorkflowResourceBusyError } from '@archon/workflows/store';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
  DETACHED_RESUME_RECEIPT,
  DETACHED_RESUME_RECEIPT_ENV,
  DETACHED_RESUME_RECEIPT_FD,
} from '../utils/detached-resume-receipt';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { makeTestResolvedWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand — --input declared inputs (#2554)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Stub discovery with one workflow declaring a required + a defaulted input. */
  async function stubInputWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'review-block',
            inputs: { diff: { required: true }, style: { default: 'strict' } },
          },
          'project'
        ),
      ],
      errors: [],
    });
  }

  it('runs a required-input workflow when --input supplies the value', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      noWorktree: true,
      inputs: ['diff=D1'],
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Only the supplied value is threaded through; `style` stays a derived default.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('still refuses a required-input workflow when nothing is supplied, before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
      })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a malformed --input assignment before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff'],
      })
    ).rejects.toThrow(/expected 'name=value'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('passes gate-resolved inputs to dryRunWorkflow (#2610)', async () => {
    // Only the SUPPLIED entries travel: the simulator derives declared defaults
    // itself, mirroring the executor's `defaultRunInputs` merge at run start.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      dryRun: true,
      inputs: ['diff=D1'],
    });

    expect(dryRun.dryRunWorkflow).toHaveBeenCalledTimes(1);
    const opts = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0][0] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('fails a dry run of a required-input workflow at the gate, like a real run', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
      })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('reports the incompatible flag, not an input error, for --dry-run --resume --input', async () => {
    // The incompatible-flags check must stay ahead of the input gate: with --input no
    // longer in that list, only ordering keeps the triple reporting the flag conflict.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--dry-run cannot be combined with --resume/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name on a dry run at the gate', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        dryRun: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('does not re-gate a --resume of a required-input workflow', async () => {
    // The gate is deliberately skipped on resume: the run row already carries inputs
    // validated at creation, and a resume supplies nothing. A refactor that hoists
    // `resolveTopLevelInputs` out of the `if (!options.resume)` guard would make every
    // CLI resume of a required-input workflow throw instead — this is what catches it.
    // (The `--input` + `--resume` test below cannot: it fails on the mutual-exclusion
    // check before ever reaching the gate.)
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { hydrateResumableRun } = await import('@archon/workflows/run-resume');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    await stubInputWorkflow();

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
    // working_path null keeps the resume on the caller cwd, skipping the existsSync probe.
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'review-block',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-prior',
    });

    // No --input, and the workflow declares a required one: this must NOT throw.
    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
      resume: true,
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // The resume branch carries the row's own inputs; it never re-stamps from a flag.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toBeUndefined();
  });

  it('rejects --input combined with --resume rather than silently ignoring it', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // Flag validation runs after name resolution (as every other flag check does),
    // so discovery still has to resolve for the conflict to be reached.
    await stubInputWorkflow();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'review-block', 'go', {
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--resume and --input are mutually exclusive/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

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

describe('workflowRunCommand — sparse model bindings (#2481)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes one sparse tier and alias map to the executor', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-models',
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
      noWorktree: true,
      modelAssignments: ['large=openai/gpt-5.6', '@planner=codex/gpt-5.6-sol'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      modelOverrideLayer?: unknown;
    };
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });
  });

  it('rejects bare and duplicate mappings before execution', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['openai/gpt-5.6'],
      })
    ).rejects.toThrow(/Expected/);
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=   '],
      })
    ).rejects.toThrow(/Expected/);
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=x', 'large=y'],
      })
    ).rejects.toThrow(/Duplicate/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('refuses new model bindings on resume', async () => {
    await stubWorkflow();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        resume: true,
        modelAssignments: ['large=openai/gpt-5.6'],
      })
    ).rejects.toThrow(/--resume and --model/);
  });
});

describe('workflowRunCommand — sparse config file (#2482)', () => {
  let tempRoot: string;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'archon-cli-run-config-'));
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    await removeTempTree(tempRoot);
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes validated file content beside explicit model mappings', async () => {
    const path = join(tempRoot, 'config.minimax.yaml');
    appendFileSync(
      path,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH: "yes"\n'
    );
    await stubWorkflow();
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-config',
    });

    await workflowRunCommand(createTestWorkflowHost(), tempRoot, 'bench', 'go', {
      noWorktree: true,
      configPath: './config.minimax.yaml',
      modelAssignments: ['large=openai/gpt-5.6'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      runConfig?: unknown;
      modelOverrideLayer?: unknown;
    };
    expect(opts.runConfig).toEqual({
      source: { kind: 'cli', label: 'config.minimax.yaml' },
      layer: {
        tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
        envVars: { BENCH: 'yes' },
      },
    });
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  it('rejects an ineffective key before source capture or execution', async () => {
    const path = join(tempRoot, 'bad.yaml');
    appendFileSync(path, 'commands:\n  folder: custom\n');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        configPath: path,
      })
    ).rejects.toThrow("Run config key 'commands' cannot apply");
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('starts with the run config another run was started with', async () => {
    const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    try {
      const { sealWorkflowRunConfig } = await import('@archon/core/config/run-config');
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'paused-run',
        metadata: {
          run_config: sealWorkflowRunConfig(
            { tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } } },
            { kind: 'cli', label: 'config.claude.yaml' }
          ),
        },
      });
      await stubWorkflow();
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
        success: true,
        workflowRunId: 'continued',
      });

      await workflowRunCommand(createTestWorkflowHost(), tempRoot, 'bench', 'go', {
        noWorktree: true,
        configFromRun: 'paused-run',
      });

      const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
        runConfig?: unknown;
      };
      expect(opts.runConfig).toEqual({
        source: { kind: 'cli', label: 'run paused-run (config.claude.yaml)' },
        layer: { tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } } },
      });
    } finally {
      if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    }
  });

  it('refuses --config-from-run on a resume, before reading the named run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const reads = (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mock.calls.length;
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        resume: true,
        configFromRun: 'paused-run',
      })
    ).rejects.toThrow('--resume and --config-from-run are mutually exclusive.');
    expect((workflowDb.getWorkflowRun as ReturnType<typeof mock>).mock.calls).toHaveLength(reads);
  });

  it('refuses --config-from-run beside --config, and for a run that does not exist', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), tempRoot, 'bench', 'go', {
        configPath: join(tempRoot, 'config.yaml'),
        configFromRun: 'paused-run',
      })
    ).rejects.toThrow('--config and --config-from-run are mutually exclusive.');

    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    await expect(
      workflowRunCommand(createTestWorkflowHost(), tempRoot, 'bench', 'go', {
        configFromRun: 'missing-run',
      })
    ).rejects.toThrow("--config-from-run: no workflow run 'missing-run'.");
  });

  it('refuses config on resume without trying to read the path', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'bench', 'go', {
        resume: true,
        configPath: join(tempRoot, 'does-not-exist.yaml'),
      })
    ).rejects.toThrow(/--resume and --config/);
  });
});

describe('workflowRunCommand — continuation and capture ownership (#2646)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    capturedSourceOwnerCalls.length = 0;
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockResolveContinuationWorkflow.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('executes the graph the run froze on `run <name> --resume`, not the one in the checkout', async () => {
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
  });

  it('hands the capture to the run that starts, and keeps holding it when none does', async () => {
    // The wrapper only protects anything if the run path actually calls its owner. Assert
    // both edges: a dropped `adopt()` deletes a live run's source, and a missing `hold()`
    // strands a full frozen tree under staged-source on every refusal. Under #2690 the
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

    capturedSourceOwnerCalls.length = 0;
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
  });

  it('reclaims the finalized container capture when backend preparation fails', async () => {
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
  });

  it('binds the run artifacts directory into the container, created on the host first', async () => {
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
        overlayMode: 'volume-copy' as const,
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
  });
});

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello')
    ).rejects.toThrow('No workflows found in .archon/workflows/');
  });

  it('logs effective discovery root and source breakdown for every run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'home-helper' }, 'global'),
        makeTestWorkflowWithSource({ name: 'project-flow' }, 'project'),
      ],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
      noWorktree: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/root workflows=3 bundled=1 global=1 project=1 installed=0'
    );
  });

  it('uses discoveryCwd in the discovery diagnostic when supplied', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/tmp/worktree', 'assist', 'hello', {
      noWorktree: true,
      discoveryCwd: '/repo/source',
    });

    // The source is captured from the discovery root; discovery then reads that capture,
    // so the call carries the target cwd plus the capture's roots.
    const sourceDiag = await import('@archon/workflows/run-source');
    expect(sourceDiag.prepareWorkflowSource as ReturnType<typeof mock>).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/repo/source' })
    );
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/path',
      expect.any(Function),
      providerRegistry,
      expect.objectContaining({ project: '/test/capture/project' })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/source workflows=1 bundled=0 global=0 project=1 installed=0'
    );
  });

  it('does not print discovery diagnostic in json mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        json: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  // #2213 — `--json` silences Pino entirely (cli.ts sets the level to 'silent'),
  // so stderr is the only channel left. Note this asserts only the CHANNEL
  // (console.warn, not console.log); the JSON payload itself goes through
  // `writeJsonLine` on the `--detach` branch, covered in the detach describe.
  it('warns on stderr about keys the engine drops, even in json mode', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project', [
            "Node 'plan': unknown key 'interactive' will be ignored.",
          ]),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          json: true,
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the warning.
      }

      expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
      expect(warnSpy).toHaveBeenCalledWith(
        "  - Node 'plan': unknown key 'interactive' will be ignored."
      );
      // Never on stdout — a --json caller must still get a parseable payload.
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow has no parse warnings', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project'),
          // A DIFFERENT workflow's warnings must not leak into this run.
          makeTestWorkflowWithSource({ name: 'other' }, 'project', ["dropped 'interactive'"]),
        ],
        errors: [],
      });

      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        noWorktree: true,
      });

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('the engine ignores'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #2781 — the deprecation notice rides the same stderr channel as the parse
  // warnings above, with the same --json-purity rationale.
  it('warns on stderr about a deprecated workflow', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            deprecated: { message: 'Switch to the sdlc pack instead.' },
          }),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the notice.
      }

      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow is not deprecated', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks silence.
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('will be removed in an upcoming release')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not print discovery diagnostic in quiet mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        quiet: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello')
    ).rejects.toThrow("Workflow 'nonexistent' not found");
  });

  it('should include available workflows in error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    const run = workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello');
    await expect(run).rejects.toThrow('Available workflows:');
    await expect(run).rejects.toThrow('- assist');
    await expect(run).rejects.toThrow('- plan');
  });

  it('should resolve workflow by suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'archon-plan', description: 'Plan' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // Should resolve successfully — "assist" suffix-matches "acme-assist"
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello');

    // Verify suffix matching tier was used
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'assist', matched: 'acme-assist' }),
      'workflow.resolve_suffix_match'
    );
  });

  it('should resolve workflow by substring match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'acme-smart-pr-review', description: 'Smart review' }),
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Help' }),
      ],
      errors: [],
    });

    // "smart" substring-matches only "acme-smart-pr-review"
    // Will fail downstream at executeWorkflow mock, but must NOT throw "not found"
    const error = await workflowRunCommand(
      createTestWorkflowHost(),
      '/test/path',
      'smart',
      'hello'
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('not found');
    expect((error as Error).message).not.toContain('Did you mean');
  });

  it('should prefer case-insensitive exact match over suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'acme-assist', description: 'Long' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // "ASSIST" case-insensitive matches "assist" at tier 2, should not reach suffix tier
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'ASSIST', 'hello');

    // Verify case-insensitive match was used, not suffix match
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'ASSIST', matched: 'assist' }),
      'workflow.resolve_case_insensitive_match'
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'workflow.resolve_suffix_match'
    );
  });

  it('should throw ambiguous error for multiple suffix matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review', description: 'Review' }),
        makeTestWorkflowWithSource({ name: 'custom-review', description: 'Custom review' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'review', 'hello')
    ).rejects.toThrow("Ambiguous workflow 'review'. Did you mean:");
  });

  it('should throw ambiguous error for multiple substring matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'acme-comprehensive-pr-review',
          description: 'Full review',
        }),
        makeTestWorkflowWithSource({ name: 'acme-smart-pr-review', description: 'Smart review' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'pr-review', 'hello')
    ).rejects.toThrow("Ambiguous workflow 'pr-review'. Did you mean:");
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Step failed: assist',
    });

    // Use --no-worktree since no codebase is available (isolation would error)
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).rejects.toThrow('Workflow failed: Step failed: assist');
  });
});

describe('workflowRunCommand — signal cleanup guard (#1123)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  function setupWorkflowMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });

    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });
  }

  /** Flush the cleanup handler's fire-and-forget promise chain. */
  async function settleCleanup(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** The SIGTERM listeners added since `baseline` (i.e. by the command under test). */
  function addedSigtermListeners(baseline: readonly unknown[]): Array<() => void> {
    return process.listeners('SIGTERM').filter(listener => !baseline.includes(listener)) as Array<
      () => void
    >;
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The cleanup chain ends in process.exit(1) — neuter it so invoking the
    // handler in-process doesn't kill the test runner.
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    setMockDetachedStopRequested(false);
    mockAssertDetachedRunProcessOwner.mockReset();
    mockAssertDetachedRunProcessOwner.mockImplementation(() => undefined);
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();

    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getActiveWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockReset();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('removes SIGTERM/SIGINT handlers once executeWorkflow settles (no leak, no stacking)', async () => {
    const sigtermBaseline = process.listenerCount('SIGTERM');
    const sigintBaseline = process.listenerCount('SIGINT');

    let duringRunSigterm = 0;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      duringRunSigterm = process.listenerCount('SIGTERM');
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {});
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    // A second invocation in the same process must not stack handlers either.
    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ success: true, workflowRunId: 'test-run-id' })
    );
  });

  it('does not fail the run when it is paused at a new gate at signal time', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    // The run this process drives has committed its pause at the next gate.
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('paused');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // The signal lands while the handler is still registered.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1', paused: true };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    // Paused-at-gate is an external transition the signal handler must respect.
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still fails the run on a genuine mid-run interrupt (legacy behavior)', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');
    const shutdownOrder: string[] = [];
    mockRunLiveOwnerClose.mockImplementationOnce(async () => {
      shutdownOrder.push('owner-close');
    });
    exitSpy.mockImplementationOnce((() => {
      shutdownOrder.push('exit');
    }) as never);

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: false, workflowRunId: 'run-1', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('Workflow failed');

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM' }
    );
    expect(shutdownOrder).toEqual(['owner-close', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets an exact-run cancel controller own the lifecycle transition', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    // A detached child learns its run from the row its launcher handed over (#2872) —
    // the only shape the CLI produces for a fresh detached run.
    (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'test-run-id',
      workflow_name: 'plan',
      status: 'pending',
      working_path: null,
      metadata: {},
    });

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    // Captured inside the run, once the signal handler has settled: the assertion is
    // that the SIGNAL path never consulted status, which a global "never called" no
    // longer isolates now that the startup-failure net reads it on the way out.
    let statusReadsAtSignalTime = -1;
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      setMockDetachedStopRequested(true);
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      statusReadsAtSignalTime = (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mock
        .calls.length;
      return { success: false, workflowRunId: 'test-run-id', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'test-run-id',
      })
    ).rejects.toThrow('Workflow failed');

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {
      detachedProcessPid: process.pid,
    });
    expect(statusReadsAtSignalTime).toBe(0);
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a detached marker when this process does not own its process group', async () => {
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    mockAssertDetachedRunProcessOwner.mockImplementationOnce(() => {
      throw new Error('does not own process group');
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {})
    ).rejects.toThrow('does not own process group');

    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(process.env.ARCHON_DETACHED_RUN_OWNER).toBeUndefined();
  });

  it('uses the source-reserved run id before workflow_started is emitted', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // No workflow_started event is needed: source capture reserved the exact id
      // before execution or its live-owner endpoint became visible.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {});

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)',
      { exitReason: 'process_terminated', signal: 'SIGTERM' }
    );
    expect(workflowsDb.getActiveWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('workflowRunCommand — adopt lane source recapture (#2660/#2747)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const trackTempRoot = trackTempRoots();

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function adoptedEnvironment(): import('@archon/isolation').IsolationEnvironmentRow {
    return {
      id: 'env-9',
      codebase_id: 'cb-adopt',
      workflow_type: 'task',
      workflow_id: 'adopt',
      provider: 'worktree',
      working_path: '/wt/adopted',
      branch_name: 'feature/adopted',
      status: 'active',
      metadata: {},
      created_at: new Date('2026-01-01'),
      created_by_platform: 'cli',
      created_by_user_id: null,
    };
  }

  function setupAdoptMocks(
    lane: Exclude<AdoptionLane, { kind: 'in-place' }> = {
      kind: 'reuse-worktree',
      environment: adoptedEnvironment(),
    }
  ): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const prepareMock = require('@archon/workflows/run-source').prepareWorkflowSource as ReturnType<
      typeof mock
    >;
    discoverMock.mockReset();
    prepareMock.mockClear();
    // First discovery runs against the invoking checkout; the second must run against
    // the adopted lane's worktree and resolve the branch's vintage of the workflow.
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Branch vintage' })],
        errors: [],
      });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-adopt',
      platform_type: 'cli',
      platform_conversation_id: 'cli-adopt',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValue(undefined);
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });

    if (lane.kind === 'reuse-worktree') {
      (
        require('@archon/core/db/isolation-environments').getById as ReturnType<typeof mock>
      ).mockResolvedValueOnce({
        ...lane.environment,
      });
    }
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: 'run-old' },
      lane,
    });
  }

  // Keep source-capture I/O real: equal run IDs replace one physical directory.
  // This exposes cleanup deleting the replacement even with the executor mocked.
  async function stageRealCapture(
    tempRoot: string,
    opts: { sourceRoot: string; runId?: string }
  ): Promise<WorkflowRunSource.PreparedWorkflowSource> {
    const runId = opts.runId ?? randomUUID();
    const captureRoot = join(tempRoot, 'staged-source', runId);
    await removeTempTree(captureRoot);
    mkdirSync(captureRoot, { recursive: true });
    const anchor = {
      root: captureRoot,
      digest: `digest-${opts.sourceRoot}`,
      config: { load_default_workflows: true, load_default_commands: true },
    };
    const manifest = {
      version: 1 as const,
      engine_version: 'test',
      origin: opts.sourceRoot,
      captured_at: new Date().toISOString(),
      digest: anchor.digest,
      file_count: 0,
      byte_count: 0,
      scopes: [],
      source_config: anchor.config,
    };
    writeFileSync(join(captureRoot, 'manifest.json'), JSON.stringify(manifest));
    const roots: WorkflowRunSource.WorkflowSourceRoots = {
      project: join(captureRoot, 'project'),
      globalWorkflows: join(captureRoot, 'global', 'workflows'),
      globalCommands: join(captureRoot, 'global', 'commands'),
      globalScripts: join(captureRoot, 'global', 'scripts'),
      bundledWorkflows: join(captureRoot, 'bundled', 'workflows'),
      bundledCommands: join(captureRoot, 'bundled', 'commands', 'defaults'),
      installed: { kind: 'captured', captureRoot },
      kind: 'captured',
      anchor,
    };
    return { runId, origin: opts.sourceRoot, manifest, anchor, roots };
  }

  it('adopts a normal run from a unique short run id prefix', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path/subdir', 'assist', 'hello', {
      adoptRunId: '0b1ee8da',
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-adopt');
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it('rejects an ambiguous adopted run prefix with its candidates', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: '0b1ee8da',
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
  });

  it('passes a full adopted run id through unchanged', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: adoptedRunId,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it.each(['missing', 'mismatched', 'replaced', 'switched', 'detached'] as const)(
    'refuses a %s adoption environment before lane capture or execution',
    async reason => {
      setupAdoptMocks();
      const isolationDb = await import('@archon/core/db/isolation-environments');
      const getById = isolationDb.getById as ReturnType<typeof mock>;
      getById.mockReset();
      if (reason === 'switched' || reason === 'detached') {
        mockGetCurrentBranchStrict.mockResolvedValueOnce(reason === 'switched' ? 'other' : null);
      }
      getById.mockResolvedValueOnce(
        reason === 'missing'
          ? null
          : reason === 'replaced'
            ? { ...adoptedEnvironment(), metadata: { worktree_registration_id: 'replacement' } }
            : {
                ...adoptedEnvironment(),
                working_path: reason === 'mismatched' ? '/foreign/worktree' : '/wt/adopted',
              }
      );
      (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
        })
      ).rejects.toThrow(
        reason === 'missing'
          ? 'Isolation environment env-9 not found'
          : reason === 'replaced'
            ? 'changed during adoption'
            : reason === 'switched' || reason === 'detached'
              ? 'expected branch'
              : 'does not match'
      );
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(isolationDb.updateMetadata).not.toHaveBeenCalled();
      const captures = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
      expect(
        captures.every(call => (call[1] as { sourceRoot: string }).sourceRoot === '/test/path')
      ).toBe(true);
    }
  );

  it('re-freezes workflow source from the inherited worktree on the reuse-worktree lane', async () => {
    setupAdoptMocks();
    const isolationDb = await import('@archon/core/db/isolation-environments');
    (isolationDb.updateMetadata as ReturnType<typeof mock>).mockClear();
    const { executeWorkflow } = await import('@archon/workflows/executor');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    const prepareCalls = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
    expect(prepareCalls).toHaveLength(2);
    expect((prepareCalls[0][1] as { sourceRoot: string }).sourceRoot).toBe('/test/path');
    expect((prepareCalls[1][1] as { sourceRoot: string }).sourceRoot).toBe('/wt/adopted');
    // The executor receives the branch-vintage graph, not the parent checkout's.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect((executed[4] as { description: string }).description).toBe('Branch vintage');
    expect(executed[3]).toBe('/wt/adopted');
    expect((isolationDb.updateMetadata as ReturnType<typeof mock>).mock.calls).toEqual([
      [
        'env-9',
        {
          adopted: true,
          worktree_registration_id: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          ),
        },
        expect.objectContaining({ id: 'env-9' }),
      ],
    ]);
  });

  it('checks out the exact adopted branch when the prior worktree is gone', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const create = mock(() =>
      Promise.resolve({
        provider: 'worktree' as const,
        id: '/wt/recreated',
        workingPath: '/wt/recreated',
        branchName: 'feature/live-pr',
        status: 'active' as const,
        createdAt: new Date(),
        metadata: { provenance: 'adopted', adopted: true },
      })
    );
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
      }),
      expect.any(Function)
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    const opts = executed.at(-1) as { adoptedFromRunId?: string };
    expect(opts.adoptedFromRunId).toBe('run-old');
  });

  it('preserves an explicit source when adoption recreates the prior branch checkout', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: toBranchName('feature/live-pr') },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create: mock(() =>
        Promise.resolve({
          provider: 'worktree' as const,
          id: '/wt/recreated',
          workingPath: '/wt/recreated',
          branchName: 'feature/live-pr',
          status: 'active' as const,
          createdAt: new Date(),
          metadata: { provenance: 'adopted', adopted: true },
        })
      ),
      healthCheck: mock(() => Promise.resolve(true)),
    });

    // Explicit selection matters even when it names the invoking checkout.
    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
      discoveryCwd: '/test/path',
    });

    expect(prepareWorkflowSource).toHaveBeenCalledTimes(1);
    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/test/path' })
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    expect((executed[4] as { description: string }).description).toBe('Parent vintage');
  });

  it('re-judges the declared-input gate against the branch vintage after recapture', async () => {
    // The parent checkout's YAML declares no inputs, so the invocation gate on entry
    // passes an input-less call; only the adopted branch's YAML requires one.
    setupAdoptMocks();
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            description: 'Branch vintage',
            inputs: { diff: { required: true } },
          }),
        ],
        errors: [],
      });
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        adoptRunId: 'run-old',
      })
    ).rejects.toThrow(/requires input/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it(
    'preserves the replacement capture when a detached child recaptures onto its own ' +
      'pre-created run id (real files, #3217)',
    async () => {
      // Both capture calls use the detached child's pre-created run ID.
      setupAdoptMocks();
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-detached-child',
        workflow_name: 'assist',
        status: 'pending',
      });
      const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

      const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-same-root-')));
      // Matches the mocked DETACHED_RUN_OWNER_ENV value the SUT reads from
      // '../utils/detached-run-control' (mocked at the top of this file).
      const ownerEnvVar = 'ARCHON_DETACHED_RUN_OWNER';
      const previousOwnerEnv = process.env[ownerEnvVar];
      process.env[ownerEnvVar] = '1';
      try {
        prepareMock
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          )
          .mockImplementationOnce((_deps: unknown, opts: { sourceRoot: string; runId?: string }) =>
            stageRealCapture(tempRoot, opts)
          );

        await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          adoptRunId: 'run-old',
          detachedRunId: 'run-detached-child',
        });

        const calls = prepareMock.mock.calls;
        expect(calls).toHaveLength(2);
        expect((calls[0][1] as { runId?: string }).runId).toBe('run-detached-child');
        expect((calls[1][1] as { runId?: string }).runId).toBe('run-detached-child');

        const replacementRoot = join(tempRoot, 'staged-source', 'run-detached-child');
        const manifestPath = join(replacementRoot, 'manifest.json');
        // The assertion the old code fails: the recapture's own cleanup deleted this
        // file right after writing it, because stale.anchor.root === replacement's.
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { origin: string };
        expect(manifest.origin).toBe('/wt/adopted');
      } finally {
        if (previousOwnerEnv === undefined) delete process.env[ownerEnvVar];
        else process.env[ownerEnvVar] = previousOwnerEnv;
      }
    }
  );

  it('still cleans up the superseded staged capture when the replacement lands at a different root', async () => {
    // Ordinary adoption uses separate roots and must reclaim the first capture.
    setupAdoptMocks();
    const prepareMock = prepareWorkflowSource as ReturnType<typeof mock>;

    const tempRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-recapture-distinctroot-')));
    const capturedRoots: string[] = [];
    prepareMock
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      )
      .mockImplementationOnce(
        async (_deps: unknown, opts: { sourceRoot: string; runId?: string }) => {
          const prepared = await stageRealCapture(tempRoot, opts);
          capturedRoots.push(prepared.anchor.root);
          return prepared;
        }
      );

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
      adoptRunId: 'run-old',
    });

    expect(capturedRoots).toHaveLength(2);
    const [originalRoot, replacementRoot] = capturedRoots;
    expect(originalRoot).not.toBe(replacementRoot);
    // The superseded original is reclaimed...
    expect(existsSync(originalRoot as string)).toBe(false);
    // ...and the replacement it was superseded BY survives.
    expect(existsSync(join(replacementRoot as string, 'manifest.json'))).toBe(true);
  });
});

const git = await import('@archon/git');

describe('workflow run credential launch refusal', () => {
  it.each(
    [false, true].flatMap(detach => [
      { detach, adopt: false },
      { detach, adopt: true },
    ])
  )('blocks before isolation, title generation and spawning (%j)', async ({ detach, adopt }) => {
    const adapter = await import('@archon/core/workflows/store-adapter');
    const original = adapter.createWorkflowDeps;
    const createDeps = spyOn(adapter, 'createWorkflowDeps').mockImplementation(() => ({
      ...original(),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderCredential: async (_userId, vendor) => ({
        kind: 'api_key',
        getStatus: async () =>
          adopt && vendor === 'anthropic'
            ? { state: 'usable', source: 'archon' }
            : {
                state: 'unusable',
                source: 'archon',
                evidence: 'stored credential unreadable',
              },
      }),
    }));
    const isolation = await import('@archon/isolation');
    const core = await import('@archon/core');
    const codebases = await import('@archon/core/db/codebases');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    mockDiscoverWorkflowsWithConfig.mockImplementation(async path => ({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'credential-run',
          provider: adopt && path === '/adopted/snapshot' ? 'codex' : 'claude',
        }),
      ],
      errors: [],
    }));
    const adoptedRunId = '11111111-1111-1111-1111-111111111111';
    if (adopt) {
      const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
      (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
        adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/old' },
        lane: { kind: 'checkout-branch', taskBranch: { kind: 'existing', branch: 'feature/dead' } },
      });
    }
    (codebases.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockClear();
    mockResolveFolderBackend.mockClear();
    const spawn = spyOn(Bun, 'spawn');
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'credential-run', 'go', {
          detach,
          ...(adopt ? { adoptRunId: adoptedRunId } : {}),
        })
      ).rejects.toThrow(
        `Credential preflight failed for provider '${adopt ? 'codex' : 'claude'}' (vendor '${adopt ? 'openai' : 'anthropic'}'): credential cannot be used: stored credential unreadable`
      );
      expect(isolation.getIsolationProvider).not.toHaveBeenCalled();
      expect(mockResolveFolderBackend).not.toHaveBeenCalled();
      expect(core.generateAndSetTitle).not.toHaveBeenCalled();
      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      createDeps.mockRestore();
    }
  });
});
