import {
  testHome,
  mockStartRunLiveOwner,
  mockClaimDetachedRunProcessOwner,
  mockCreateWorkflowRun,
  spyOnJsonStdout,
  firstJsonPayload,
  type DetachedSpawnOptions,
  firstDetachedSpawnOptions,
  createDetachedChildFixture,
  finishStartupWindow,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { prepareWorkflowSource } from '@archon/workflows/run-source';
import { createRunAiConfigurationSnapshot } from '@archon/workflows/run-ai-configuration';
import { buildAiProfile } from '@archon/workflows/model-validation';
import type { PreparedRunAiConfiguration } from '@archon/workflows/run-preflight';
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, jest } from 'bun:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { DETACHED_RESUME_RECEIPT } from '../utils/detached-resume-receipt';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getArchonHome, isDocker } from '@archon/paths';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import {
  workflowApproveCommand,
  workflowRejectCommand,
  workflowResumeCommand,
} from './workflow-control';
import { workflowRunCommand } from './workflow-run-owned';
import { buildDetachedRunCmd, resolveDetachedRunEncryptionEnv } from './workflow-detach';
import { DETACHED_RUN_FAILED_EXIT_CODE } from '../utils/workflow-exit-code';

const git = await import('@archon/git');

describe('workflowRunCommand — detach', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    // A real detached launch resolves a project — the pre-flight refuses an isolating
    // run that has no project to isolate (#2872 R1), the same refusal the isolation
    // block makes. Tests that want that refusal override this per invocation.
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-detach',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  it.each([false, true])(
    'spawns a detached child with its pending run and branch (explicit project: %s)',
    async explicitProject => {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      });

      const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
      const child = createDetachedChildFixture();
      const workflowDb = await import('@archon/core/db/workflows');
      const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
        const created = (workflowDb.createWorkflowRun as ReturnType<typeof mock>).mock.calls.at(
          -1
        )?.[0];
        expect(created?.metadata.ai_configuration).toMatchObject({ version: 1 });
        return child.child;
      });
      const savedArgv = process.argv;
      process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
      if (explicitProject) {
        const codebaseDb = await import('@archon/core/db/codebases');
        (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
          id: 'cb-detach',
          name: 'test/repo',
          default_cwd: '/registered',
          kind: 'repo',
        });
        process.argv.push('--project', 'test/repo');
      }

      // Capture call data BEFORE mockRestore() — restoring a spy clears its recorded calls.
      let spawnCallCount = 0;
      let spawnCmd: string[] = [];
      let spawnOptions: DetachedSpawnOptions | undefined;
      try {
        const commandPromise = workflowRunCommand(
          createTestWorkflowHost(),
          '/test/path',
          'assist',
          'hello',
          { detach: true, codebaseId: explicitProject ? 'cb-detach' : undefined }
        );
        await finishStartupWindow(commandPromise, spawnSpy);
        spawnCallCount = spawnSpy.mock.calls.length;
        spawnOptions = firstDetachedSpawnOptions(spawnSpy);
        spawnCmd = (spawnOptions?.cmd ?? []).slice();
      } finally {
        process.argv = savedArgv;
        spawnSpy.mockRestore();
      }

      expect(spawnCallCount).toBe(1);
      // The actual Windows fix: the child must be spawned into its own process
      // group, or the launching shell's teardown kills it (~1s in).
      expect(spawnOptions?.detached).toBe(true);
      expect(spawnOptions?.windowsHide).toBe(true);
      expect(spawnOptions?.env?.ARCHON_DETACHED_RUN_OWNER).toBe('1');
      const created = (workflowDb.createWorkflowRun as ReturnType<typeof mock>).mock.calls.at(
        -1
      )?.[0];
      expect(spawnOptions?.env?.ARCHON_DETACHED_LAUNCH_TOKEN).toBe(
        created?.metadata.cli_detached_launch_token
      );
      expect(spawnOptions?.env?.ARCHON_DETACHED_LAUNCH_TOKEN).toBeTruthy();
      expect(spawnOptions?.env?.ARCHON_HOME).toBe(testHome);
      const logLine = consoleSpy.mock.calls.find((call: unknown[]) =>
        String(call[0]).startsWith('Child output: ')
      );
      const logPath = String(logLine?.[0]).slice('Child output: '.length);
      expect(dirname(logPath)).toBe(join(testHome, 'logs'));
      expect(readFileSync(logPath, 'utf8')).toContain('--- detached workflow invocation:');
      if (explicitProject) {
        expect(spawnCmd[spawnCmd.lastIndexOf('--project') + 1]).toBe('cb-detach');
        expect(mockCreateWorkflowRun.mock.calls.at(-1)?.[0]).toMatchObject({
          codebase_id: 'cb-detach',
        });
      } else {
        expect(spawnCmd).not.toContain('--project');
      }
      expect(spawnCmd).not.toContain('--detach');
      expect(spawnCmd).toContain('--branch');
      expect(spawnCmd).not.toContain('--conversation-id');
      expect(spawnCmd).toContain('--cwd');
      const cwdIdx = spawnCmd.indexOf('--cwd');
      expect(spawnCmd[cwdIdx + 1]).toBe('/test/path');
      expect(spawnOptions?.cwd).toBe('/test/path');
      // Generated branch is `assist-<timestamp>`
      const branchIdx = spawnCmd.indexOf('--branch');
      expect(spawnCmd[branchIdx + 1]).toMatch(/^assist-\d+$/);
      // executeWorkflow must NOT run in the detaching parent
      const execAfter = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
      expect(execAfter).toBe(execBefore);
      expect(child.unref).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^Transcript: .*\.jsonl$/));
    }
  );

  it('resolves an adopted run prefix before passing it to the detached child', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (git.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // The parent resolves the declared adoption before forking (#2872), so this test
    // now has to give it a project and a resolvable lane to pass through.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/test/worktree' },
      lane: {
        kind: 'reuse-worktree',
        environment: { id: 'env-detached', working_path: '/test/worktree' },
      },
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path/subdir',
        'assist',
        'hello',
        {
          detach: true,
          adoptRunId: '0b1ee8da',
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const adoptIndex = spawnCmd.indexOf('--adopt');
    expect(adoptIndex).toBeGreaterThan(-1);
    expect(spawnCmd[adoptIndex + 1]).toBe(adoptedRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(resolveWorkflowAdoption).toHaveBeenCalledWith(expect.objectContaining({ adoptedRunId }));
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: adoptedRunId })
    );
    expect(spawnCmd).not.toContain('--branch');
  });

  // #2872 — the launch printed `Started` and exited 0 while the child died on adoption
  // resolution, so no run row was ever created and the failure existed only inside the
  // detached child's log. The refusal has to reach the launching terminal.
  it('refuses an unresolvable --adopt synchronously instead of acking Started (#2872)', async () => {
    // Real timers: pre-fix this path spawns and waits out the startup window, so the
    // assertions below must be reachable rather than parked on an unadvanced fake timer.
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error(
        "Cannot adopt: no workflow run 'run-missing' exists. Check the id with `workflow runs`."
      )
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
          adoptRunId: 'run-missing',
        })
      ).rejects.toThrow(/Cannot adopt: no workflow run 'run-missing' exists/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('hands the detached child the sealed validated layer instead of a mutable path', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { unsealWorkflowRunConfig } = await import('@archon/core/config');
    const { workflowRunConfigMetadataSchema } = await import(
      '@archon/workflows/schemas/run-config'
    );
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    const savedArchonHome = process.env.ARCHON_HOME;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.ARCHON_HOME;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      '--config',
      '/caller/config.yaml',
      '--detach',
    ];

    let payload: string | undefined;
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        '',
        {
          detach: true,
          configPath: '/caller/config.yaml',
          detachedRunConfig: {
            source: { kind: 'cli', label: 'config.yaml' },
            layer: { docsPath: 'accepted', envVars: { SNAPSHOT: 'original' } },
          },
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      const payloadIndex = spawnOptions.cmd.indexOf('--internal-detached-run-config');
      payload = payloadIndex >= 0 ? spawnOptions.cmd[payloadIndex + 1] : undefined;
      expect(spawnOptions.env?.ARCHON_INTERNAL_DETACHED_RUN_CONFIG).toBeUndefined();
      expect(spawnOptions.env?.TOKEN_ENCRYPTION_KEY).toBe('ab'.repeat(32));
      expect(spawnOptions.env?.ARCHON_HOME).toBe('');
      expect(fs.readdirSync(join(testHome, 'logs'))).toHaveLength(1);
    } finally {
      process.argv = savedArgv;
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedArchonHome;
      spawnSpy.mockRestore();
    }

    expect(payload).toBeDefined();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    try {
      const metadata = workflowRunConfigMetadataSchema.parse(JSON.parse(payload ?? ''));
      expect(unsealWorkflowRunConfig(metadata)).toMatchObject({
        docsPath: 'accepted',
        envVars: { SNAPSHOT: 'original' },
      });
    } finally {
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    }
  });

  it('hands the detached child the layer another run started with, for --config-from-run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { sealWorkflowRunConfig, unsealWorkflowRunConfig } = await import('@archon/core/config');
    const { workflowRunConfigMetadataSchema } = await import(
      '@archon/workflows/schemas/run-config'
    );
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'paused-run',
      metadata: {
        run_config: sealWorkflowRunConfig(
          { docsPath: 'from-the-paused-run' },
          { kind: 'cli', label: 'config.claude.yaml' }
        ),
      },
    });
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      '--config-from-run',
      'paused-run',
      '--detach',
    ];

    let payload: string | undefined;
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        '',
        {
          detach: true,
          configFromRun: 'paused-run',
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      const payloadIndex = spawnOptions.cmd.indexOf('--internal-detached-run-config');
      payload = payloadIndex >= 0 ? spawnOptions.cmd[payloadIndex + 1] : undefined;
      expect(payload).toBeDefined();
      const metadata = workflowRunConfigMetadataSchema.parse(JSON.parse(payload ?? ''));
      expect(metadata.source).toEqual({
        kind: 'cli',
        label: 'run paused-run (config.claude.yaml)',
      });
      expect(unsealWorkflowRunConfig(metadata)).toEqual({ docsPath: 'from-the-paused-run' });
    } finally {
      process.argv = savedArgv;
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      spawnSpy.mockRestore();
    }
  });

  // #2213 — the headline `--json` claim. `writeJsonLine` (not console.log) is
  // what emits the payload, and it is only reached on this `--detach` branch,
  // so this is the only place the "stdout stays exactly the payload" guarantee
  // can actually be observed. Asserts the captured stdout still JSON.parse()s
  // while the warning went to stderr.
  it('keeps stdout a parseable JSON payload while warning on stderr', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // stdout: exactly one line, and it parses.
    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      action: string;
      workflow: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('run');
    expect(payload.workflow).toBe('assist');
    // The warning reached the user — on stderr, not in the payload.
    expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
    expect(JSON.stringify(payload)).not.toContain('unknown key');
    warnSpy.mockRestore();
  });

  it('does NOT pin a --branch on the detached child for a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Detach folder probe: exact miss, then path-prefix resolves a folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--branch'); // folder project → no worktree branch
    expect(spawnCmd).not.toContain('--conversation-id');
  });

  // #2872 — a continuation already owns a run row, so the ack names it without
  // creating anything. `wait <run-id>` behind `run --resume --detach` needs the id
  // just as much as behind a fresh launch.
  it('--resume --detach acks the continuation run id without creating a row', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-paused',
      workflow_name: 'assist',
      working_path: null,
    });
    mockCreateWorkflowRun.mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--resume',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          resume: true,
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed.runId).toBe('run-paused');
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  it('--detach --json emits a structured ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, action: 'run', detached: true, workflow: 'assist' });
    expect(parsed.conversationId).toBeNull();
    // #2872: the ack hands back the row this launch created, and the child is told to
    // execute that row rather than creating a second one.
    expect(parsed.runId).toBe('run-detached-created');
    expect(parsed.transcriptPath).toBe(
      join(tempHome, 'workspaces', 'test', 'repo', 'logs', 'run-detached-created.jsonl')
    );
    expect(typeof parsed.logPath).toBe('string');
    expect(parsed.logPath).not.toBe(parsed.transcriptPath);
    expect(mockCreateWorkflowRun).toHaveBeenCalled();
    const idIndex = spawnCmd.indexOf('--internal-detached-run-id');
    expect(idIndex).toBeGreaterThan(-1);
    expect(spawnCmd[idIndex + 1]).toBe('run-detached-created');
  });

  // #2872 R1 — the plain launch, with no --folder/--adopt/--supersedes/--resume, is the
  // most common invocation and had no pre-flight refusal at all: an isolating run with
  // no project to isolate sailed past, printed `Started`, and died on the identical
  // check in the child.
  it('refuses an isolating launch whose project lookup fails, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Cannot run workflow: project lookup failed/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('refuses an isolating launch outside a git repository, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockCreateWorkflowRun.mockClear();
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Cannot create worktree: not in a git repository/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    // Refused before the row exists, so there is nothing to leave behind.
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('still launches without a project when isolation is not wanted', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          noWorktree: true,
        }
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  // A one-node workflow that fails legitimately finishes inside the 500 ms startup
  // window on a fast machine. #2914 read the child's non-zero exit as a launch failure,
  // so the same command passed or failed depending on how quickly the machine got
  // through the run — locally it broke `bun run validate` outright. The child now names
  // its run's own failure, and only that reading acks it.
  it('acks a run whose workflow failed inside the startup window', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, DETACHED_RUN_FAILED_EXIT_CODE, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
    // The run recorded its own failure. A launcher that fails the row here would
    // overwrite the run's reason with a launch failure that never happened.
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  // #2872 — the parent is the row's only owner until the child claims it. A child that
  // never starts must not leave a `pending` row nobody can explain.
  it('fails the run row it created when the detached child dies during startup', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        { detach: true }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await expect(commandPromise).rejects.toThrow(/exit code 1/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-detached-created',
      expect.stringContaining('Detached launch failed'),
      { exitReason: 'launch_failed' }
    );
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('rejects an immediate non-zero child exit with the log tail and no success ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    const conversationId = 'cli-detached-failure';
    const logPath = join(tempHome, 'logs', `detached-run-${conversationId}.log`);
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          json: true,
          conversationId,
        }
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);

      await expect(commandPromise).rejects.toThrow(
        /exit code 1[\s\S]*database unavailable during startup/
      );
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(child.unref).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('writes a delimiter for every invocation sharing a conversation id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const tempHome = testHome;
    const conversationId = 'cli-shared-conversation';
    const firstChild = createDetachedChildFixture();
    const secondChild = createDetachedChildFixture();
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      });
    const spawnSpy = spyOn(Bun, 'spawn')
      .mockReturnValueOnce(firstChild.child)
      .mockReturnValueOnce(secondChild.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const firstRun = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          conversationId,
        }
      );
      await finishStartupWindow(firstRun, spawnSpy);
      const secondRun = workflowRunCommand(
        createTestWorkflowHost(),
        '/test/path',
        'assist',
        'hello',
        {
          detach: true,
          conversationId,
        }
      );
      await finishStartupWindow(secondRun, spawnSpy, 2);

      const log = readFileSync(
        join(tempHome, 'logs', `detached-run-${conversationId}.log`),
        'utf8'
      );
      const delimiters = log
        .split('\n')
        .filter(line => line.startsWith(`--- detached workflow invocation: ${conversationId} at `));
      expect(delimiters).toHaveLength(2);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
  });

  it('throws (no false success ack) when the detached child fails to spawn', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Node's spawn does not throw synchronously on a bad executable — the only
    // synchronous failure signal is an undefined pid.
    const child = createDetachedChildFixture(null);
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
          detach: true,
        })
      ).rejects.toThrow(/Failed to start detached workflow child/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    // The success ack must never have been printed.
    const logged: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).not.toContain("Started 'assist' in the background.");
  });
});

// ---------------------------------------------------------------------------
// #2872 — the detached child executes the run its launcher created. Without this
// the child wrote a SECOND row, so the id the parent acked named nothing.
// ---------------------------------------------------------------------------

describe('workflowRunCommand — detached child adopts the pre-created run (#2872)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  const preCreatedRow = {
    origin: { conversationId: 'conv-1' },
    id: 'run-precreated',
    workflow_name: 'plan',
    conversation_id: 'conv-1',
    status: 'pending',
    working_path: null,
    started_at: new Date(),
    metadata: { cli_detached_launch_token: 'launch-token' },
  };

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    process.env.ARCHON_DETACHED_LAUNCH_TOKEN = 'launch-token';
    mockStartRunLiveOwner.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
    delete process.env.ARCHON_DETACHED_LAUNCH_TOKEN;
  });

  it('executes the launcher’s row and files its capture under that id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    const snapshot = createRunAiConfigurationSnapshot(
      providerRegistry,
      {
        assistant: 'codex',
        commands: {},
        assistants: { claude: {}, codex: { model: 'launch-model' } },
      },
      buildAiProfile('codex'),
      {}
    );
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      metadata: { ...preCreatedRow.metadata, ai_configuration: snapshot },
    });
    (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
      detachedRunId: 'run-precreated',
      conversationId: 'cli-123',
      noWorktree: true,
    });

    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'run-precreated' })
    );
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7] as {
      preCreatedRun?: { id: string };
      preparedAiConfiguration?: PreparedRunAiConfiguration;
      priorCompletedNodes?: unknown;
    };
    expect(opts.preCreatedRun?.id).toBe('run-precreated');
    expect(opts.preparedAiConfiguration?.config.assistant).toBe('codex');
    expect(opts.preparedAiConfiguration?.config.assistants.codex.model).toBe('launch-model');
    // A fresh pre-created row is NOT a resume: prior state would make the executor
    // skip nodes that never ran.
    expect(opts.priorCompletedNodes).toBeUndefined();
    // The live-owner endpoint is keyed on the run this process owns, and only a
    // detached child exposes active stop.
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('run-precreated', {
      detachedProcessPid: process.pid,
    });
  });

  // #2872 R2 — everything between the handover and the executor claiming the row can
  // throw, and the launcher is gone by then. Without this the row sits `pending`
  // forever and the reason lives only in the child's log: the same silent failure,
  // moved one process later.
  it('fails the handed-over row when it throws before the executor claims it', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    // No project resolves, so the isolation gate throws after the row was handed over.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-precreated',
      expect.stringContaining('Detached run failed to start'),
      { exitReason: 'launch_failed', pendingLaunchToken: 'launch-token' }
    );
  });

  it('leaves a row the executor already claimed to its own lifecycle', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      failed: false,
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-precreated',
      expect.stringContaining('Detached run failed to start'),
      { exitReason: 'launch_failed', pendingLaunchToken: 'launch-token' }
    );
  });

  // #2872 R3 — the flag names a row this process will execute AS. Both halves are
  // checked: that this really is a detached child, and that the row is claimable.
  it('refuses the flag outside a detached child', async () => {
    delete process.env.ARCHON_DETACHED_RUN_OWNER;

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
      })
    ).rejects.toThrow(/set by a detached launch for its own child/);
  });

  it.each(['', 'another-launch'])(
    'refuses a same-workflow row from another handoff: %s',
    async token => {
      process.env.ARCHON_DETACHED_LAUNCH_TOKEN = token;
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
      (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
      if (token) {
        (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
          failed: false,
        });
      }
      const { executeWorkflow } = await import('@archon/workflows/executor');
      (executeWorkflow as ReturnType<typeof mock>).mockClear();
      (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
          detachedRunId: preCreatedRow.id,
        })
      ).rejects.toThrow('detached launch identity does not match');
      if (token) {
        expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
          preCreatedRow.id,
          expect.stringContaining('detached launch identity does not match'),
          { exitReason: 'launch_failed', pendingLaunchToken: token }
        );
      } else {
        expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
      }
      expect(prepareWorkflowSource).not.toHaveBeenCalled();
      expect(executeWorkflow).not.toHaveBeenCalled();
    }
  );

  it('refuses a row that is not awaiting its first execution', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      status: 'completed',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/it is completed, not a run awaiting its first execution/);
  });

  it('refuses a row belonging to a different workflow', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      workflow_name: 'something-else',
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/belongs to workflow 'something-else', not 'plan'/);
  });

  it.each(['unowned', 'claim refused', 'different launch', 'owned'] as const)(
    'checks the handoff after a pre-admission error: %s',
    async mode => {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
      if (mode === 'unowned') delete process.env.ARCHON_DETACHED_RUN_OWNER;
      if (mode === 'claim refused') {
        mockClaimDetachedRunProcessOwner.mockRejectedValueOnce(new Error('claim refused'));
      }
      if (mode === 'different launch') {
        (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
          failed: false,
        });
      }
      await expect(
        workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
          detachedRunId: preCreatedRow.id,
          modelAssignments: ['invalid-assignment'],
        })
      ).rejects.toThrow();
      if (mode !== 'unowned') {
        expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
          preCreatedRow.id,
          expect.stringContaining('Detached run failed to start'),
          { exitReason: 'launch_failed', pendingLaunchToken: 'launch-token' }
        );
      } else {
        expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
      }
    }
  );

  it('fails loudly when the row its launcher promised is gone', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'plan', 'hello', {
        detachedRunId: 'run-vanished',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/cannot find the run 'run-vanished'/);
  });
});

describe('workflowApproveCommand / workflowRejectCommand / workflowResumeCommand — detach', () => {
  const trackTempRoot = trackTempRoots();
  let consoleSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // working_path is deliberately a distro-style path: the child must spawn with
  // the PARENT's cwd (it re-resolves by run-id), because a container run's
  // working_path is unreachable on the host and would ENOENT the spawn.
  const pausedRun = {
    origin: { conversationId: 'conv-123' },
    id: 'run-123',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/distro/only/path',
    conversation_id: 'conv-123',
    user_message: 'hello',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  };

  it('approve --detach spawns a detached child (minus --detach) without changing run state in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', 'ship it', '--detach'];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      // Signature: (runId, comment, json, cwd, detach) — detach is the 5th arg,
      // layered after upstream's cwd.
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        'ship it',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.detached).toBe(true);
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('approve');
    expect(spawnCmd).toContain('run-123');
    // Parent cwd, never the run's working_path (see pausedRun comment above).
    expect(spawnOptions?.cwd).toBe(process.cwd());
    expect(spawnCmd).not.toContain('/distro/only/path');
    // ZERO state mutation in the detaching parent — the child owns the approve
    // (a parent-side approve would record the decision twice).
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'approve' for run run-123 in the background.");
    expect(consoleSpy).toHaveBeenCalledWith(
      `Child output: ${join(testHome, 'logs', 'detached-run-run-123.log')}`
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('approve --detach --json emits a structured ack on stdout without approving', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // The ack goes through writeJsonLine (flushed stdout), not console.log — a
    // console.log ack can be truncated on a pipe (#2384).
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-123',
      action: 'approve',
      detached: true,
      workflowName: 'assist',
    });
    expect(parsed.logPath).toBe(join(testHome, 'logs', 'detached-run-run-123.log'));
  });

  it('--detach --json spawns a child WITHOUT --json (so it continues) and says so in the ack', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // Both flags are stripped: the child runs the ordinary inline path, which
    // auto-resumes. That is deliberate — --detach exists to host that execution.
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--json');
    // ...so the ack must tell the caller it does NOT own continuation.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, detached: true, continues: true });
  });

  it('threads a caller-supplied --cwd to the child instead of the parent process.cwd()', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'approve',
      'run-123',
      '--cwd',
      '/caller/repo',
      '--detach',
    ];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        '/caller/repo',
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.cwd).toBe('/caller/repo');
    // buildDetachedRunCmd appends --cwd LAST (parser is last-wins), so the
    // appended value is what the child actually resolves.
    const lastCwdIdx = spawnCmd.lastIndexOf('--cwd');
    expect(spawnCmd[lastCwdIdx + 1]).toBe('/caller/repo');
  });

  it('approve --detach rejects an immediate non-zero child exit instead of acking success', async () => {
    // The parent awaits spawnDetachedWorkflowRun's startup window (#2279). Without
    // that await the failure arrives as an unhandled rejection AFTER `{ok:true}`
    // has already been printed — the exact hole --detach exists to close.
    const workflowDb = await import('@archon/core/db/workflows');
    const tempHome = testHome;
    const logPath = join(tempHome, 'logs', 'detached-run-run-123.log');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // --json turns the throw into the standard { ok: false } line; either way the
    // caller never sees a success ack for a child that died on startup.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toMatch(/exit code 1[\s\S]*database unavailable during startup/);
  });

  it('approve --detach refuses a non-paused run synchronously and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'running',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow("Cannot approve run with status 'running'");
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnCallCount).toBe(0);
  });

  it('approve --detach --json reports a refusal as { ok: false } and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'completed',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await workflowApproveCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        true,
        undefined,
        true
      );
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }

    expect(spawnCallCount).toBe(0);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toContain("Cannot approve run with status 'completed'");
  });

  it('approve --detach refuses a child_workflow-blocked parent and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow(
        'Approve or reject the child run instead. Approve it by run id: ' +
          '`archon workflow approve c-9`'
      );
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses an already-resolved gate and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: { approval: { nodeId: 'gate', message: 'Approve?', resolved: 'approved' } },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('was already approved and is awaiting resume');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a missing approval context and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('Workflow run is paused but missing approval context.');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a run with no recorded working path and spawns nothing', async () => {
    // The child always auto-resumes after approving, and a resume needs a working
    // path. Refuse in the parent rather than letting the child throw into its log.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('has no working path recorded');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('resume --detach refuses a run with no recorded working path and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow('has no working path recorded');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('resume --detach refuses a run whose worktree is gone and spawns nothing (#4090)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: join(tmpdir(), 'archon-removed-worktree-4090'),
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow('the working path from the run no longer exists');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'resume --detach reports an unreadable worktree as a filesystem error, not as removed (#4090)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-unreadable-worktree-'));
      const workingPath = join(root, 'worktree');
      mkdirSync(workingPath);
      chmodSync(root, 0o000);
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        ...pausedRun,
        status: 'failed',
        working_path: workingPath,
      });
      const child = createDetachedChildFixture();
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
      try {
        await expect(
          workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(spawnSpy.mock.calls.length).toBe(0);
      } finally {
        spawnSpy.mockRestore();
        chmodSync(root, 0o700);
        await removeTempTree(root);
      }
    }
  );

  it('reject --detach refuses a child_workflow-blocked parent but TOLERATES missing context', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const blockedChild = createDetachedChildFixture();
    let spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(blockedChild.child);
    try {
      await expect(
        workflowRejectCommand(
          createTestWorkflowHost(),
          'run-123',
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow(
        'Reject the child run instead, or abandon this run to discard the whole tree. ' +
          'Reject it by run id: `archon workflow reject c-9`'
      );
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }

    // reject has no nodeId requirement — a malformed context must still spawn.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    const child = createDetachedChildFixture();
    spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', '--detach'];
    try {
      const commandPromise = workflowRejectCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
  });

  it('reject --detach spawns a detached child (minus --detach) without changing run state in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', 'not good', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRejectCommand(
        createTestWorkflowHost(),
        'run-123',
        'not good',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('reject');
    expect(spawnCmd).toContain('run-123');
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'reject' for run run-123 in the background.");
  });

  it('resume --detach spawns a detached child (minus --detach) and does NOT execute in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // resume validates read-only via resumeWorkflowOp, which reads getWorkflowRun;
    // a failed run is resumable.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-detach-'))),
    });

    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = new childProcess.ChildProcess();
    const receipt = new PassThrough();
    Object.defineProperty(child, 'stdio', { value: [null, null, null, receipt] });
    Object.defineProperty(child, 'pid', { value: 12345 });
    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'resume', 'run-123', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowResumeCommand(
        createTestWorkflowHost(),
        'run-123',
        undefined,
        undefined,
        true
      );
      for (let attempt = 0; attempt < 200 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(501);
      await Promise.resolve();
      await Promise.resolve();
      expect(consoleSpy).not.toHaveBeenCalledWith(
        "Started 'resume' for run run-123 in the background."
      );
      receipt.write(DETACHED_RESUME_RECEIPT);
      await commandPromise;
      spawnCmd = [...(spawnSpy.mock.calls[0][1] ?? [])];
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      receipt.destroy();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('resume');
    expect(spawnCmd).toContain('run-123');
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
  });

  it('resume --detach fails fast with the executable when the child fails to spawn', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-detach-'))),
    });

    // Bun's failed spawn: no pid and no receipt pipe; the ENOENT arrives later as an event.
    const child = new childProcess.ChildProcess();
    Object.defineProperty(child, 'stdio', { value: [null, null, null, null] });
    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue(child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'resume', 'run-123', '--detach'];

    try {
      await expect(
        workflowResumeCommand(createTestWorkflowHost(), 'run-123', undefined, undefined, true)
      ).rejects.toThrow(/Failed to start detached workflow child \(executable: /);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).not.toHaveBeenCalledWith(
      "Started 'resume' for run run-123 in the background."
    );
  });
});

describe('buildDetachedRunCmd', () => {
  for (const delimiter of [[], ['--', 'message']]) {
    it(`drops caller Bun configs before changing cwd with delimiter=${delimiter.length > 0}`, () => {
      const argv = ['bun', '/cli.ts', 'workflow', 'run', 'hold', '--detach', ...delimiter];
      for (const config of ['--config=./config.toml', '--config=/caller/config.toml']) {
        const source = buildDetachedRunCmd(false, '/bun', argv, '/project', [], [config]);
        expect(source.slice(0, 2)).toEqual(['/bun', '/cli.ts']);
        expect(source).not.toContain(config);
      }
    });

    it(`preserves the broker's Bun config with delimiter=${delimiter.length > 0}`, () => {
      const config = `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`;
      const argv = ['bun', '/cli.ts', 'workflow', 'run', 'hold', '--detach', ...delimiter];
      const runtimeArgs = [config, '--inspect'];
      const source = buildDetachedRunCmd(false, '/bun', argv, '/repo', [], runtimeArgs);
      expect(source.slice(0, 3)).toEqual(['/bun', config, '/cli.ts']);
      expect(source).not.toContain('--inspect');
      const binary = buildDetachedRunCmd(true, '/archon', argv, '/repo', [], runtimeArgs);
      expect(binary.slice(0, 3)).toEqual(['/archon', 'workflow', 'run']);
      expect(binary).not.toContain(config);
    });
  }

  // BUNDLED_IS_BINARY is a module-level const (mocked false), so the binary
  // branch is unreachable through spawnDetachedWorkflowRun — exercise both
  // branches directly via the pure builder.

  it('dev mode: keeps [execPath, entryScript], slices argv(2), drops --detach/--json', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      ['/path/to/bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123', '--conversation-id', 'cli-1']
    );

    expect(cmd[0]).toBe('/path/to/bun');
    expect(cmd[1]).toBe('/abs/cli.ts');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    expect(cmd).toContain('assist');
    // --cwd pinned absolute, then extra flags
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd).toContain('--branch');
    expect(cmd).toContain('--conversation-id');
  });

  // A Bun single-file executable's argv is NOT [binary, ...userArgs]. Bun
  // injects a virtual entry path at argv[1] and reports argv[0] as 'bun':
  //   ['bun', '/$bunfs/root/archon', 'workflow', 'run', ...]
  // Verified against a real `bun build --compile` artifact. The previous
  // fixture modelled a compiled argv with no argv[1] at all, which is why
  // #2248 (detached child dies with `Unknown command: B:/~BUN/root/...`)
  // shipped green.
  // `--input` is the first repeatable flag in the tree (#2554). Nothing here handles
  // repetition specially — argv is forwarded verbatim — so this pins the property a
  // future change to the argv rebuild could silently break, turning a detached run into
  // one that starts with its inputs missing instead of failing.
  it('forwards every repeated --input to the detached child', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      [
        '/path/to/bun',
        '/abs/cli.ts',
        'workflow',
        'run',
        'review-block',
        '--input',
        'diff=D1',
        '--input',
        'style=terse',
        '--detach',
      ],
      '/abs/cwd',
      []
    );

    expect(cmd.filter(arg => arg === '--input')).toHaveLength(2);
    expect(cmd).toContain('diff=D1');
    expect(cmd).toContain('style=terse');
    expect(cmd).not.toContain('--detach');
  });

  it('binary mode: uses [execPath] only (no duplicated entry arg), drops the Bun SFE virtual argv[1]', () => {
    const cmd = buildDetachedRunCmd(
      true,
      '/usr/local/bin/archon',
      ['bun', '/$bunfs/root/archon', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('/usr/local/bin/archon');
    // The binary path must appear exactly once — never duplicated as argv[1].
    expect(cmd.filter(arg => arg === '/usr/local/bin/archon')).toHaveLength(1);
    // The virtual entry path must never reach the child: cli.ts parses
    // process.argv.slice(2), so a leaked argv[1] becomes the child's command.
    expect(cmd.some(arg => arg.includes('$bunfs'))).toBe(false);
    expect(cmd[1]).toBe('workflow');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd.slice(cwdIdx + 2)).toEqual(['--branch', 'assist-123']);
  });

  it('binary mode: drops the Windows Bun SFE virtual argv[1] (#2248 repro)', () => {
    const cmd = buildDetachedRunCmd(
      true,
      'C:\\Users\\dev\\archon.exe',
      [
        'bun',
        'B:/~BUN/root/archon-windows-x64.exe',
        'workflow',
        'run',
        'assist',
        'hello',
        '--detach',
        '--json',
      ],
      'C:\\checkout',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('C:\\Users\\dev\\archon.exe');
    // The exact token that appeared as `Unknown command: ...` in the report.
    expect(cmd).not.toContain('B:/~BUN/root/archon-windows-x64.exe');
    expect(cmd[1]).toBe('workflow');
    expect(cmd[2]).toBe('run');
  });
});

describe('resolveDetachedRunEncryptionEnv', () => {
  it('pins both absence and a relative home before the child changes cwd', () => {
    expect(resolveDetachedRunEncryptionEnv({}, '/parent/repo')).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '',
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(
      resolveDetachedRunEncryptionEnv(
        { TOKEN_ENCRYPTION_KEY: 'install-key', ARCHON_HOME: './relative-home' },
        '/parent/repo'
      )
    ).toEqual({
      TOKEN_ENCRYPTION_KEY: 'install-key',
      ARCHON_HOME: resolve('/parent/repo', 'relative-home'),
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(resolveDetachedRunEncryptionEnv({ ARCHON_HOME: '~/.archon-custom' }, '/parent')).toEqual(
      {
        TOKEN_ENCRYPTION_KEY: '',
        ARCHON_HOME: join(homedir(), '.archon-custom'),
        ARCHON_DOCKER: '',
        WORKSPACE_PATH: '',
        HOME: '',
        USERPROFILE: '',
      }
    );
    const dockerHandoff = resolveDetachedRunEncryptionEnv(
      { ARCHON_DOCKER: 'true', ARCHON_HOME: '/ignored-custom-home' },
      '/parent'
    );
    expect(dockerHandoff).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '/.archon',
      ARCHON_DOCKER: 'true',
      WORKSPACE_PATH: '',
      HOME: '',
      USERPROFILE: '',
    });
    expect(isDocker(dockerHandoff)).toBe(true);
    expect(getArchonHome(dockerHandoff)).toBe('/.archon');
  });
});

describe('detached registration branch choice', () => {
  it('preserves a flag-looking positional message after the argument delimiter', () => {
    const cmd = buildDetachedRunCmd(
      true,
      '/archon',
      [
        '/archon',
        '/entry',
        'workflow',
        'run',
        'test',
        '--base-branch',
        'release',
        '--',
        '--base-branch',
      ],
      '/repo',
      ['--conversation-id', 'conv']
    );
    expect(cmd.slice(-2)).toEqual(['--', '--base-branch']);
    expect(cmd.indexOf('--conversation-id')).toBeLessThan(cmd.indexOf('--'));
  });
  for (const binary of [true, false]) {
    for (const choice of [['--base-branch', 'release'], ['--base-branch=release']]) {
      it(`consumes registration choice before the child in binary=${binary} syntax=${choice[0]}`, () => {
        const cmd = buildDetachedRunCmd(
          binary,
          '/bun',
          ['/bun', '/cli.ts', 'workflow', 'run', 'test', '--detach', ...choice, '--base', 'dev'],
          '/repo',
          []
        );
        expect(cmd).not.toContain('--base-branch');
        expect(cmd).not.toContain('--base-branch=release');
        expect(cmd).not.toContain('release');
        expect(cmd).toContain('--base');
        expect(cmd).toContain('dev');
      });
    }
  }
});
