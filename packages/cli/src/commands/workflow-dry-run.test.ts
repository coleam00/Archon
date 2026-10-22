import {
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand — dry-run', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stdoutSpy = spyOnJsonStdout();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.loadDryRunStubs as ReturnType<typeof mock>).mockClear();
    (dryRun.writeDryRunStubScaffold as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.formatDryRunTrace as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValue({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: null,
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
      summary: 'done',
    });
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('runs the simulator before real-run setup and writes one JSON document', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    const stubs = { plan: { approved: false }, implement: 'scaffold output' };
    (dryRun.loadDryRunStubs as ReturnType<typeof mock>).mockResolvedValueOnce(stubs);

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
      dryRun: true,
      stubsPath: 'fixtures.yaml',
      defaultStubs: true,
      execCode: true,
      pauseAtGates: true,
      json: true,
    });

    expect(dryRun.loadDryRunStubs).toHaveBeenCalledWith(join('/test/path', 'fixtures.yaml'));
    expect(dryRun.dryRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'hello',
        cwd: '/test/path',
        stubs,
        defaultStubs: true,
        execCode: true,
        pauseAtGates: true,
      })
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      workflow: 'plan',
      outcome: 'completed',
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('merges registered environment before run overrides and protects only effective DB values', async () => {
    const host = createTestWorkflowHost();
    const lookup = spyOn(host.records.codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
      id: 'cb-env',
      name: 'env',
      kind: 'repo',
      default_cwd: '/test/path',
      repository_url: null,
      default_branch: null,
      ai_assistant_type: null,
      commands: {},
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const env = spyOn(host.deps.store, 'getCodebaseEnvVars').mockResolvedValue({
      ARCHON_DB_DIAGNOSTIC: 'db-value',
      BENCH_MODE: 'db-mode',
    });
    const dir = mkdtempSync(join(tmpdir(), 'archon-cli-dry-run-env-'));
    const configPath = join(dir, 'config.yaml');
    appendFileSync(configPath, 'env:\n  BENCH_MODE: run-mode\n');
    try {
      expect(process.env.ARCHON_DB_DIAGNOSTIC).toBeUndefined();
      const core = await import('@archon/core');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        assistants: {},
        commands: {},
        envVars: { ARCHON_DB_DIAGNOSTIC: 'file-value', FILE_ONLY: 'kept' },
      });
      const dryRun = await import('@archon/workflows/dry-run');
      await workflowRunCommand(host, '/test/path', 'plan', '', {
        dryRun: true,
        execCode: true,
        json: true,
        configPath,
      });
      expect(env).toHaveBeenCalledWith('cb-env');
      expect(dryRun.dryRunWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            envVars: {
              ARCHON_DB_DIAGNOSTIC: 'db-value',
              BENCH_MODE: 'run-mode',
              FILE_ONLY: 'kept',
            },
            protectedCredentialValues: ['db-value'],
          }),
        })
      );
    } finally {
      lookup.mockRestore();
      env.mockRestore();
      await removeTempTree(dir);
    }
  });

  it('simulates stub-only runs without reading the registered environment', async () => {
    const host = createTestWorkflowHost();
    const lookup = spyOn(host.records.codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
      id: 'cb-env',
      name: 'env',
      kind: 'repo',
      default_cwd: '/test/path',
      repository_url: null,
      default_branch: null,
      ai_assistant_type: null,
      commands: {},
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const env = spyOn(host.deps.store, 'getCodebaseEnvVars').mockRejectedValue(
      new Error('store unavailable')
    );
    try {
      const dryRun = await import('@archon/workflows/dry-run');
      await workflowRunCommand(host, '/test/path', 'plan', '', { dryRun: true, json: true });
      expect(env).not.toHaveBeenCalled();
      expect(dryRun.dryRunWorkflow).toHaveBeenCalled();
      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({ outcome: 'completed' });
    } finally {
      lookup.mockRestore();
      env.mockRestore();
    }
  });

  it('emits authored outcome in JSON without using it as the exit verdict', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: 'failed',
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).resolves.toBeUndefined();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'completed',
      authoredOutcome: 'failed',
    });
  });

  it('layers acting-user preferences before resolving dry-run model bindings', async () => {
    const previousUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'dry-run-user';
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        tiers: {},
        aliases: {},
      });
      (core.getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValueOnce({
        defaultProvider: 'codex',
        aliases: {
          '@personal': { provider: 'claude', model: 'opus' },
          '@planner': { provider: 'pi', model: 'openai/gpt-5.6' },
        },
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        dryRun: true,
        modelAssignments: ['large=@personal', '@planner=openai/next-model'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        aiProfile: {
          defaultProvider: string;
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.aiProfile.defaultProvider).toBe('codex');
      expect(options.aiProfile.aliases.large).toEqual({ provider: 'claude', model: 'opus' });
      expect(options.aiProfile.aliases['@planner']).toEqual({
        provider: 'pi',
        model: 'openai/next-model',
      });
    } finally {
      if (previousUserId === undefined) Reflect.deleteProperty(process.env, 'ARCHON_USER_ID');
      else process.env.ARCHON_USER_ID = previousUserId;
    }
  });

  it('applies the config file and then replaces only the explicit model binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-cli-dry-run-config-'));
    const configPath = join(dir, 'config.minimax.yaml');
    appendFileSync(
      configPath,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH_MODE: "1"\n'
    );
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        assistants: { claude: {}, pi: {} },
        tiers: {
          small: { provider: 'claude', model: 'haiku' },
          medium: { provider: 'claude', model: 'sonnet' },
          large: { provider: 'claude', model: 'opus' },
        },
        aliases: {},
        envVars: { LOWER: 'kept' },
        commands: {},
      });

      await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        dryRun: true,
        configPath,
        modelAssignments: ['large=openai/gpt-5.6'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        config: { envVars?: Record<string, string> };
        aiProfile: {
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.config.envVars).toEqual({ LOWER: 'kept', BENCH_MODE: '1' });
      expect(options.aiProfile.aliases.large).toEqual({
        provider: 'pi',
        model: 'openai/gpt-5.6',
      });
      expect(options.aiProfile.aliases.small).toEqual({
        provider: 'claude',
        model: 'haiku',
      });
      expect(options.aiProfile.aliases.medium).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    } finally {
      await removeTempTree(dir);
    }
  });

  it('writes a scaffold from the discovered workflow and exits before simulation', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
      dryRun: true,
      stubsInitPath: 'fixtures/generated.yaml',
      json: true,
    });

    expect(dryRun.writeDryRunStubScaffold).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan' }),
      join('/test/path', 'fixtures/generated.yaml')
    );
    expect(dryRun.loadDryRunStubs).not.toHaveBeenCalled();
    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      workflow: 'plan',
      stubsPath: join('/test/path', 'fixtures/generated.yaml'),
      nodeCount: 2,
    });
  });

  it('writes the human trace through guaranteed stdout delivery', async () => {
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', { dryRun: true });

    expect(dryRun.formatDryRunTrace).toHaveBeenCalled();
    expect(firstJsonPayload(stdoutSpy)).toBe('DRY RUN TRACE');
  });

  it('fails the dry run when the config is unreadable instead of reporting against defaults', async () => {
    // `loadConfig` returns defaults when there is no config file, so a throw means a
    // MALFORMED one. Swallowing it would print a clean-looking trace claiming every node
    // resolves to the default assistant — a plausible report of a run that cannot happen.
    const dryRun = await import('@archon/workflows/dry-run');
    const core = await import('@archon/core');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (core.loadConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('bad yaml at .archon/config.yaml:7')
    );

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'go', { dryRun: true })
    ).rejects.toThrow(/bad yaml/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects dry-run-only and incompatible lifecycle flags', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        stubsPath: 'fixtures.yaml',
      })
    ).rejects.toThrow('--stubs requires --dry-run');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        stubsInitPath: 'fixtures.yaml',
      })
    ).rejects.toThrow('--stubs-init requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', { defaultStubs: true })
    ).rejects.toThrow('--default-stubs requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        detach: true,
      })
    ).rejects.toThrow('--dry-run cannot be combined with --detach');
  });

  it('rejects scaffold mode combined with simulation stub options', async () => {
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        stubsPath: 'overrides.yaml',
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --stubs');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        defaultStubs: true,
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --default-stubs');
  });

  it('emits failure JSON before returning a nonzero-worthy error', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      authoredOutcome: 'succeeded',
      trace: [],
      missingStubs: ['node'],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).rejects.toThrow('missing stubs: node');
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'failed',
      authoredOutcome: 'succeeded',
    });
  });

  it('names only blocking missing stubs, never one an all_done join tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join', 'node'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    // The join never blocked anything, so pointing the reader at it alongside the
    // real cause sends them to the wrong node (#2869). One call, one mocked result:
    // asserting the absence in a second call would read the default mock instead.
    const error = await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
      dryRun: true,
      json: true,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );
    expect(error?.message).toBe('Dry-run failed; missing stubs: node');
  });

  it('falls back to the generic message when every missing stub was tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', '', {
        dryRun: true,
        json: true,
      })
    ).rejects.toThrow('See the trace for details');
  });
});
