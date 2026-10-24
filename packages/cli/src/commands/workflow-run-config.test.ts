import { createTestWorkflowHost } from '../test-support/workflow-command-harness';
import { prepareWorkflowSource } from '@archon/workflows/run-source';

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';
import { resolveLaunchRunConfig } from './workflow-run-config';
import * as chatScope from '../workflow-scope';

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

  it.each(
    ['0b1ee8da-1111-2222-3333-444455556666', '0b1ee8da'].flatMap(configFromRun =>
      [{}, { detach: true }, { dryRun: true }, { stubsInitPath: 'stubs.yaml' }].map(options => ({
        configFromRun,
        ...options,
      }))
    )
  )('refuses foreign source config before reading it: %j', async options => {
    const scope = spyOn(chatScope, 'readChatProjectScope').mockReturnValue('selected-project');
    const host = createTestWorkflowHost();
    const workflowDb = await import('@archon/core/db/workflows');
    const find = workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>;
    find.mockResolvedValueOnce([]);
    const read = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
    read.mockClear();
    try {
      await expect(workflowRunCommand(host, tempRoot, 'bench', 'go', options)).rejects.toThrow(
        'selected project'
      );
      expect(find).toHaveBeenCalledWith(options.configFromRun, 'selected-project');
      expect(read).not.toHaveBeenCalled();
    } finally {
      scope.mockRestore();
    }
  });

  it.each(['0b1ee8da-1111-2222-3333-444455556666', '0b1ee8da'])(
    'copies config from a matching-project run %s',
    async configFromRun => {
      const scope = spyOn(chatScope, 'readChatProjectScope').mockReturnValue('selected-project');
      const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
      process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
      try {
        const id = '0b1ee8da-1111-2222-3333-444455556666';
        const { sealWorkflowRunConfig } = await import('@archon/core/config/run-config');
        const workflowDb = await import('@archon/core/db/workflows');
        const find = workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>;
        find.mockResolvedValueOnce([{ id }]);
        const read = workflowDb.getWorkflowRun as ReturnType<typeof mock>;
        read.mockResolvedValueOnce({
          id,
          metadata: {
            run_config: sealWorkflowRunConfig(
              { envVars: { PROJECT_TOKEN: 'selected-project-token' } },
              { kind: 'cli', label: 'config.yaml' }
            ),
          },
        });
        const config = await resolveLaunchRunConfig(
          createTestWorkflowHost(),
          { configFromRun },
          tempRoot,
          false
        );
        expect(find).toHaveBeenLastCalledWith(configFromRun, 'selected-project');
        expect(read).toHaveBeenLastCalledWith(id);
        expect(config?.layer.envVars).toEqual({ PROJECT_TOKEN: 'selected-project-token' });
      } finally {
        scope.mockRestore();
        if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
      }
    }
  );

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
