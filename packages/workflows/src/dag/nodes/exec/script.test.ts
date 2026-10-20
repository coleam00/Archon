// @archon-test-isolated
import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { chmod, mkdir, writeFile, readFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import {
  type MockWorkflowStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  deliveredMessages,
  persistedEvents,
  minimalConfig,
  stubMissingContainer,
  spyOnNodeExec,
  nodeDockerCalls,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { type RunChildWorkflowFn } from '../../child-run';
import type { DagNode, ExecNode } from '../../../schemas';
import type { WorkflowConfig } from '../../../deps';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  type WorkflowSourceRoots,
} from '../../../workflow-source';
import * as sourceLoader from '../../../workflow-source/load';
import { WorkflowSourceUnavailableError } from '../../../workflow-source';
import { CONTAINER_MARKER_PROBE } from '../../../checkout-observation';

describe('executeDagWorkflow -- script node injection hardening (#2115)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-script-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
  });

  afterEach(async () => {
    // force: true already no-ops on a missing dir — any other failure (EBUSY/EPERM)
    // should surface, not be swallowed.
    await removeTempTree(testDir);
  });

  it('bun script delivers the user message via env var, never spliced into source', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const workflowRun = makeWorkflowRun('script-inject-bun', {
        workflow_name: 'script-inject',
        conversation_id: 'conv-script-inject',
        // If this were text-substituted into TS source the string literal would close
        // and execSync would run; delivered as an env var it stays inert data.
        user_message: '"); require("child_process").execSync("touch pwned"); //',
      });

      const scriptNode: ExecNode = {
        id: 'safe',
        kind: 'exec',
        script: 'console.log(process.env.ARGUMENTS)',
        runtime: 'bun',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          conversationId: 'conv-script-inject',
          cwd: testDir,
          workflow: { name: 'script-inject-test', nodes: [scriptNode] },
          workflowRun,
        })
      );

      expect(execSpy).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = execSpy.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      expect(cmd).toBe('bun');
      // Source is byte-identical to the author's body — the payload never appears in it.
      expect(args).toEqual(['--no-env-file', '-e', 'console.log(process.env.ARGUMENTS)']);
      expect(args.join(' ')).not.toContain('execSync');
      // The value reaches the script via env vars instead.
      expect(opts.env.ARGUMENTS).toBe(workflowRun.user_message);
      expect(opts.env.USER_MESSAGE).toBe(workflowRun.user_message);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('leaves a literal $ARGUMENTS in the script body inert (not substituted)', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const workflowRun = makeWorkflowRun('script-literal', {
        workflow_name: 'script-literal',
        conversation_id: 'conv-script-literal',
        user_message: '$(rm -rf /)',
      });

      const scriptNode: ExecNode = {
        id: 'legacy',
        kind: 'exec',
        script: 'console.log("value: $ARGUMENTS")',
        runtime: 'bun',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          conversationId: 'conv-script-literal',
          cwd: testDir,
          workflow: { name: 'script-literal-test', nodes: [scriptNode] },
          workflowRun,
        })
      );

      const [, args] = execSpy.mock.calls[0] as [string, string[], unknown];
      // The dangerous payload is NOT interpolated into the source; $ARGUMENTS stays literal.
      expect(args[2]).toBe('console.log("value: $ARGUMENTS")');
      expect(args[2]).not.toContain('rm -rf');
    } finally {
      execSpy.mockRestore();
    }
  });

  it('uv/python script delivers the user message and issue context via env vars', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const workflowRun = makeWorkflowRun('script-inject-uv', {
        workflow_name: 'script-inject-uv',
        conversation_id: 'conv-script-uv',
        user_message: 'py-message',
      });

      const scriptNode: ExecNode = {
        id: 'py',
        kind: 'exec',
        script: "import os; print(os.environ['ARGUMENTS'])",
        runtime: 'uv',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          conversationId: 'conv-script-uv',
          cwd: testDir,
          workflow: { name: 'script-uv-test', nodes: [scriptNode] },
          workflowRun,
          issueContext: 'ISSUE #42 body text',
        })
      );

      const [cmd, args, opts] = execSpy.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      expect(cmd).toBe('uv');
      expect(args).toEqual(['run', 'python', '-c', "import os; print(os.environ['ARGUMENTS'])"]);
      expect(opts.env.ARGUMENTS).toBe('py-message');
      expect(opts.env.CONTEXT).toBe('ISSUE #42 body text');
      expect(opts.env.EXTERNAL_CONTEXT).toBe('ISSUE #42 body text');
      expect(opts.env.ISSUE_CONTEXT).toBe('ISSUE #42 body text');
    } finally {
      execSpy.mockRestore();
    }
  });

  it('a configured project env var cannot shadow an engine-reserved value (#2115)', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const workflowRun = makeWorkflowRun('script-env-collision', {
        workflow_name: 'script-env-collision',
        conversation_id: 'conv-script-collision',
        user_message: 'the-real-arguments',
      });

      const scriptNode: ExecNode = {
        id: 'collide',
        kind: 'exec',
        script: 'console.log(process.env.ARGUMENTS)',
        runtime: 'bun',
      };

      // A codebase env var that (maliciously or by accident) reuses a reserved name,
      // alongside a legitimate non-reserved var that must still pass through.
      const configWithEnv: WorkflowConfig = {
        ...minimalConfig,
        envVars: { ARGUMENTS: 'PROJECT_OVERRIDE', CONTEXT: 'PROJECT_CTX', MY_VAR: 'keep-me' },
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          conversationId: 'conv-script-collision',
          cwd: testDir,
          workflow: { name: 'script-env-collision', nodes: [scriptNode] },
          workflowRun,
          config: configWithEnv,
          issueContext: 'ENGINE_CONTEXT',
        })
      );

      const [, , opts] = execSpy.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
      // Reserved workflow vars win over the colliding configured vars — the delivery
      // channel this PR establishes can't be shadowed by a project env var.
      expect(opts.env.ARGUMENTS).toBe('the-real-arguments');
      expect(opts.env.CONTEXT).toBe('ENGINE_CONTEXT');
      // Non-reserved configured vars still reach the subprocess.
      expect(opts.env.MY_VAR).toBe('keep-me');
    } finally {
      execSpy.mockRestore();
    }
  });

  it('still substitutes $nodeId.output raw into the script source (item 3 preserved)', async () => {
    // upstream bash → 'UPSTREAM_RAW'; downstream bun script assigns $upstream.output directly.
    const execSpy = spyOnNodeExec().mockImplementation(
      async (_cmd: string, args: string[]) =>
        args[0] === '-c'
          ? { stdout: 'UPSTREAM_RAW\n', stderr: '' } // bash upstream
          : { stdout: '', stderr: '' } // bun downstream
    );
    try {
      const workflowRun = makeWorkflowRun('script-nodeoutput', {
        workflow_name: 'script-nodeoutput',
        conversation_id: 'conv-script-nodeoutput',
        user_message: 'msg',
      });

      const nodes: DagNode[] = [
        { id: 'upstream', kind: 'exec', runtime: 'sh', script: 'printf UPSTREAM_RAW' },
        {
          id: 'downstream',
          kind: 'exec',
          script: 'const v = "$upstream.output"; console.log(v)',
          runtime: 'bun',
          depends_on: ['upstream'],
        },
      ];

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          conversationId: 'conv-script-nodeoutput',
          cwd: testDir,
          workflow: { name: 'script-nodeoutput-test', nodes },
          workflowRun,
        })
      );

      const scriptCall = execSpy.mock.calls.find(
        c => (c[0] as string) === 'bun' && (c[1] as string[]).includes('-e')
      ) as [string, string[], unknown] | undefined;
      expect(scriptCall).toBeDefined();
      // Raw (unquoted) node-output splice is intact — the direct-assignment pattern.
      expect(scriptCall?.[1][2]).toBe('const v = "UPSTREAM_RAW"; console.log(v)');
    } finally {
      execSpy.mockRestore();
    }
  });

  it('warns when a script body still uses a literal user-controlled variable', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('script-warn', {
        workflow_name: 'script-warn',
        conversation_id: 'conv-script-warn',
        user_message: 'hi',
      });

      const scriptNode: ExecNode = {
        id: 'legacy',
        kind: 'exec',
        script: 'console.log("$ARGUMENTS and $CONTEXT")',
        runtime: 'bun',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          conversationId: 'conv-script-warn',
          cwd: testDir,
          workflow: { name: 'script-warn-test', nodes: [scriptNode] },
          workflowRun,
        })
      );

      // The migration notice is itself the deliverable, and it names the
      // language-appropriate accessor for both referenced vars.
      expect(deliveredMessages(platform)).toContain(
        "Script node 'legacy': $ARGUMENTS, $CONTEXT are no longer substituted into script " +
          'source (security hardening, #2115). Read from the environment instead: ' +
          'process.env.ARGUMENTS, process.env.CONTEXT.'
      );
    } finally {
      execSpy.mockRestore();
    }
  });

  it('does not warn when the script reads values from the environment (correct form)', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('script-nowarn', {
        workflow_name: 'script-nowarn',
        conversation_id: 'conv-script-nowarn',
        user_message: 'hi',
      });

      const scriptNode: ExecNode = {
        id: 'modern',
        // Contains the substring "ARGUMENTS" but not the literal $ARGUMENTS ref.
        kind: 'exec',
        script: 'console.log(process.env.ARGUMENTS ?? "")',
        runtime: 'bun',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          conversationId: 'conv-script-nowarn',
          cwd: testDir,
          workflow: { name: 'script-nowarn-test', nodes: [scriptNode] },
          workflowRun,
        })
      );

      const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(
        (c: unknown[]) => c[1] as string
      );
      expect(messages.find(m => m.includes('no longer substituted'))).toBeUndefined();
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe('executeDagWorkflow -- script nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-script-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('inline bun script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    const scriptNode: ExecNode = {
      id: 'inline-bun',
      kind: 'exec',
      script: 'console.log("hello from bun")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-script',
        cwd: testDir,
        workflow: { name: 'script-inline-bun-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('refuses a second script before it starts when the work-unit budget is exhausted', async () => {
    const deps = createMockDeps();
    const marker = join(testDir, 'script-attempts');
    const script = `import { appendFile } from "node:fs/promises"; await appendFile(${JSON.stringify(marker)}, "ran\\n");`;
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflowRun: makeWorkflowRun('script-budget'),
        workflow: {
          name: 'script-budget',
          budget: { max_work_units: 1 },
          nodes: [
            { id: 'first', kind: 'exec', runtime: 'bun', script },
            { id: 'second', kind: 'exec', runtime: 'bun', script, depends_on: ['first'] },
          ],
        },
      })
    );

    expect(await readFile(marker, 'utf8')).toBe('ran\n');
    const events = persistedEvents(deps.store);
    expect(
      events.filter(event => event.event_type === 'node_started').map(event => event.step_name)
    ).toEqual(['first']);
    expect(events.filter(event => event.event_type === 'run_budget_work_unit')).toHaveLength(1);
    expect(events.find(event => event.event_type === 'run_budget_refused')?.data).toMatchObject({
      reason: 'work_units_exhausted',
      node: 'second',
    });
    expect(deps.store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('inline bun script output available for downstream substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-test-run-id', {
      workflow_name: 'script-test',
      conversation_id: 'conv-script',
      user_message: 'script test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'use-result.md'), 'Use: $compute.output');

    const nodes: DagNode[] = [
      { id: 'compute', kind: 'exec', script: 'console.log("42")', runtime: 'bun' },
      {
        id: 'use',
        kind: 'agent',
        source: { kind: 'command', name: 'use-result' },
        depends_on: ['compute'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-script',
        cwd: testDir,
        workflow: { name: 'script-subst-test', nodes },
        workflowRun,
      })
    );

    // AI client called for the downstream AI node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42');
  });

  it('inline uv script executes and captures stdout', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-uv-run-id', {
      workflow_name: 'script-uv-test',
      conversation_id: 'conv-script-uv',
      user_message: 'uv test message',
    });

    const scriptNode: ExecNode = {
      id: 'inline-uv',
      kind: 'exec',
      script: 'print("hello from python")',
      runtime: 'uv',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-script-uv',
        cwd: testDir,
        workflow: { name: 'script-inline-uv-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    // Script node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('named bun script executes from .archon/scripts/', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-named-run-id', {
      workflow_name: 'script-named-test',
      conversation_id: 'conv-named',
      user_message: 'named test',
    });

    // Create a named script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'greet.ts'), 'console.log("named script output")');

    const scriptNode: ExecNode = {
      id: 'run-greet',
      kind: 'exec',
      script: 'greet',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-named',
        cwd: testDir,
        workflow: { name: 'named-script-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it.each([
    [true, true, 'container'],
    [false, true, 'container'],
    [true, false, 'container'],
    [true, true, 'host'],
    [true, true, 'absent'],
    [true, true, 'no-backend'],
    [true, true, 'no-context'],
    [true, true, 'wrong-env'],
    [true, true, 'missing-env'],
    [true, true, 'host-record'],
    [true, true, 'missing-record'],
  ] as const)(
    'container source release won=%s matching container=%s execution=%s',
    async (released, matches, execution) => {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const marker = join(testDir, 'never-ran');
      const scripts = join(testDir, '.archon', 'scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(
        join(scripts, 'check.ts'),
        `await Bun.write(${JSON.stringify(marker)}, 'ran')`
      );
      const capture = await captureWorkflowSource({
        sourceRoot: testDir,
        captureRoot: join(testDir, 'capture'),
      });
      const fault = spyOn(sourceLoader, 'assertWorkflowSourceIntegrity').mockRejectedValue(
        new WorkflowSourceUnavailableError(join(testDir, 'capture'), new Error('read denied'))
      );
      const stop = mock(async () => undefined);
      const backend = {
        prepareSuspend: mock(async (_envId: string, containerId: string) => {
          if (containerId !== (matches ? 'cid' : 'other-container')) {
            throw new Error('Environment does not own execution container');
          }
          return stop;
        }),
        suspend: mock(async () => undefined),
        finalize: mock(async () => ({ requiresApproval: false })),
        applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
        discardChanges: mock(async () => undefined),
      };
      mockDeps.store.releaseRunForUnreadableSource.mockImplementation(
        async (_id, _release, beforePublish) => {
          if (released) await beforePublish?.();
          // Even another owner's paused status must not trigger generic suspension.
          mockDeps.store.getWorkflowRunStatus.mockResolvedValue('paused');
          return { released };
        }
      );
      try {
        const executing = executeDagWorkflow(
          dagOptions({
            deps: mockDeps,
            platform,
            cwd: testDir,
            workflow: {
              name: 'unreadable-container',
              nodes: [{ id: 'check', kind: 'exec', runtime: 'bun', script: 'check' }],
            },
            workflowRun: makeWorkflowRun('unreadable-container', {
              metadata:
                execution === 'missing-record'
                  ? {}
                  : execution === 'host-record'
                    ? { isolation: 'host' }
                    : {
                        isolation: 'container',
                        ...(execution === 'missing-env'
                          ? {}
                          : { isolation_env_id: execution === 'wrong-env' ? 'other-env' : 'env' }),
                      },
            }),
            workflowSourceRoots: capturedSourceRoots(capture.anchor),
            execContext:
              execution === 'host'
                ? { kind: 'host' }
                : execution === 'absent' || execution === 'no-context'
                  ? undefined
                  : { kind: 'container', containerId: 'cid' },
            containerCtx:
              execution === 'no-backend' || execution === 'no-context'
                ? undefined
                : { envId: 'env', writeBack: 'approve', backend },
          })
        );
        if (execution !== 'container') {
          await expect(executing).rejects.toThrow(
            execution === 'no-backend'
              ? 'Container execution requires a container backend context'
              : execution === 'host' || execution === 'absent' || execution === 'no-context'
                ? 'Container backend requires a container execution context'
                : 'Execution context does not match the recorded run isolation'
          );
          expect(mockDeps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
          expect(backend.prepareSuspend).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
          expect(backend.suspend).not.toHaveBeenCalled();
          expect(mockDeps.store.failWorkflowRun).not.toHaveBeenCalled();
          expect(mockDeps.store.completeWorkflowRun).not.toHaveBeenCalled();
          return;
        }
        expect(await executing).toEqual({ kind: 'source_release', released });
        expect(backend.prepareSuspend).toHaveBeenCalledWith('env', 'cid', 2_000);
        expect(stop).toHaveBeenCalledTimes(released && matches ? 1 : 0);
        const events = persistedEvents(mockDeps.store);
        expect(events.some(event => event.event_type === 'container_stopped')).toBe(
          released && matches
        );
        expect(backend.suspend).not.toHaveBeenCalled();
        expect(mockDeps.store.failWorkflowRun).not.toHaveBeenCalled();
        expect(mockDeps.store.completeWorkflowRun).not.toHaveBeenCalled();
        await expect(readFile(marker)).rejects.toThrow();
      } finally {
        fault.mockRestore();
      }
    }
  );

  describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a source this host cannot read (#4209)',
    () => {
      const checkNode: ExecNode = {
        id: 'run-check',
        kind: 'exec',
        runtime: 'bun',
        script: 'check',
      };

      async function scriptCapture(marker: string): Promise<{
        roots: WorkflowSourceRoots;
        captureRoot: string;
        makeUnreadable: () => Promise<void>;
        restore: () => Promise<void>;
      }> {
        const scriptsDir = join(testDir, '.archon', 'scripts');
        const captureRoot = join(testDir, 'capture');
        await mkdir(scriptsDir, { recursive: true });
        await writeFile(
          join(scriptsDir, 'check.ts'),
          `await Bun.write(${JSON.stringify(marker)}, "ran")`
        );
        const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
        const capturedScripts = join(captureRoot, 'project', '.archon', 'scripts');
        return {
          roots: capturedSourceRoots(capture.anchor),
          captureRoot,
          makeUnreadable: () => chmod(capturedScripts, 0o000),
          restore: () => chmod(capturedScripts, 0o755),
        };
      }

      function expectReleased(store: MockWorkflowStore, nodeId: string): void {
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        expect(store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
        expect(store.releaseRunForUnreadableSource.mock.calls[0]?.[1]).toMatchObject({ nodeId });
        const failed = persistedEvents(store).filter(
          event => event.event_type === 'node_failed' && event.step_name === nodeId
        );
        expect(failed).toHaveLength(1);
      }

      it('an unreadable captured scripts directory after admission leaves the run resumable, not failed', async () => {
        const mockDeps = createMockDeps();
        const marker = join(testDir, 'ran');
        const capture = await scriptCapture(marker);
        try {
          await capture.makeUnreadable();
          await executeDagWorkflow(
            dagOptions({
              deps: mockDeps,
              cwd: testDir,
              workflow: { name: 'source-unreadable', nodes: [checkNode] },
              workflowRun: makeWorkflowRun('source-unreadable-run', { status: 'paused' }),
              workflowSourceRoots: capture.roots,
            })
          );
        } finally {
          await capture.restore();
        }

        expectReleased(mockDeps.store, 'run-check');
        expect(mockDeps.store.releaseRunForUnreadableSource.mock.calls[0]?.[1].path).toStartWith(
          capture.captureRoot
        );
        await expect(readFile(marker, 'utf-8')).rejects.toThrow();
      });

      it('a released run completes when a later pass can read its source', async () => {
        const mockDeps = createMockDeps();
        const marker = join(testDir, 'ran');
        const capture = await scriptCapture(marker);
        const workflowRun = makeWorkflowRun('source-released-run', { status: 'paused' });
        const options = dagOptions({
          deps: mockDeps,
          cwd: testDir,
          workflow: { name: 'source-released', budget: { max_work_units: 1 }, nodes: [checkNode] },
          workflowRun,
          workflowSourceRoots: capture.roots,
        });
        mockDeps.store.getDagResumeSnapshot.mockImplementation(async id =>
          foldDagResumeSnapshot(persistedEvents(mockDeps.store), id)
        );
        try {
          await capture.makeUnreadable();
          await executeDagWorkflow(options);
        } finally {
          await capture.restore();
        }
        expectReleased(mockDeps.store, 'run-check');
        expect((await mockDeps.store.getDagResumeSnapshot(workflowRun.id)).budget.workUnits).toBe(
          0
        );

        // The next claim moves the row back to running.
        mockDeps.store.getWorkflowRunStatus.mockImplementation(async () => 'running');
        await executeDagWorkflow(options);

        expect(await readFile(marker, 'utf-8')).toBe('ran');
        expect(mockDeps.store.completeWorkflowRun).toHaveBeenCalledTimes(1);
        expect(mockDeps.store.failWorkflowRun).not.toHaveBeenCalled();
      });

      it('an operator transition that already moved the row wins over the release', async () => {
        const mockDeps = createMockDeps();
        mockDeps.store.releaseRunForUnreadableSource.mockImplementation(async () => {
          mockDeps.store.getWorkflowRunStatus.mockImplementation(async () => 'cancelled');
          return { released: false };
        });
        const platform = createMockPlatform();
        const capture = await scriptCapture(join(testDir, 'ran'));
        try {
          await capture.makeUnreadable();
          const result = await executeDagWorkflow(
            dagOptions({
              deps: mockDeps,
              platform,
              cwd: testDir,
              workflow: { name: 'source-release-lost', nodes: [checkNode] },
              workflowRun: makeWorkflowRun('source-release-lost-run'),
              workflowSourceRoots: capture.roots,
            })
          );
          expect(result).toEqual({ kind: 'source_release', released: false });
        } finally {
          await capture.restore();
        }

        expect(mockDeps.store.failWorkflowRun).not.toHaveBeenCalled();
        expect(
          deliveredMessages(platform).some(text => text.includes('Run paused, not failed'))
        ).toBe(false);
      });

      for (const fanOut of [
        undefined,
        { items: '[1]', max_parallel: 1, join: 'all_success' as const },
      ]) {
        it(`a sub-run system fault fails the parent instead of releasing it${fanOut ? ' (fan-out)' : ''}`, async () => {
          const mockDeps = createMockDeps();
          const runChildWorkflow = mock<RunChildWorkflowFn>(async () => {
            throw Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
              syscall: 'read',
            });
          });
          await executeDagWorkflow(
            dagOptions({
              deps: mockDeps,
              cwd: testDir,
              runChildWorkflow,
              workflow: {
                name: 'child-system-fault',
                nodes: [{ id: 'sub', kind: 'workflow', workflow: 'child', fan_out: fanOut }],
              },
              workflowRun: makeWorkflowRun('child-system-fault-run'),
            })
          );
          expect(runChildWorkflow).toHaveBeenCalledTimes(1);
          expect(mockDeps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
          expect(mockDeps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
        });
      }
    }
  );

  it('refuses a captured named script changed by an earlier node without consuming retries', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-capture-integrity-run');
    const scriptsDir = join(testDir, '.archon', 'scripts');
    const captureRoot = join(testDir, 'capture');
    const marker = join(testDir, 'changed-script-ran');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'check.ts'), 'console.log("original")');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    const capturedScript = join(captureRoot, 'project', '.archon', 'scripts', 'check.ts');

    const nodes: DagNode[] = [
      {
        id: 'change-capture',
        kind: 'exec',
        runtime: 'bun',
        script: `Bun.write(${JSON.stringify(capturedScript)}, ${JSON.stringify(
          `Bun.write(${JSON.stringify(marker)}, "ran")`
        )})`,
      },
      {
        id: 'run-check',
        kind: 'exec',
        runtime: 'bun',
        script: 'check',
        depends_on: ['change-capture'],
        retry: { max_attempts: 3, delay_ms: 0, on_error: 'all' },
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-capture-integrity',
        cwd: testDir,
        workflow: { name: 'capture-integrity', nodes },
        workflowRun,
        workflowSourceRoots: capturedSourceRoots(capture.anchor),
      })
    );

    await expect(readFile(marker, 'utf-8')).rejects.toThrow();
    const events = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const startedEvents = events.filter(
      (call: unknown[]) =>
        (call[0] as { event_type: string; step_name?: string }).event_type === 'node_started' &&
        (call[0] as { step_name?: string }).step_name === 'run-check'
    );
    const failedEvents = events.filter(
      (call: unknown[]) =>
        (call[0] as { event_type: string; step_name?: string }).event_type === 'node_failed' &&
        (call[0] as { step_name?: string }).step_name === 'run-check'
    );
    expect(startedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0][0] as { data: { error: string } }).data.error).toContain(
      'captured source has changed'
    );
    expect(mockDeps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockDeps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
  });

  it('refuses a replaced capture even when its new manifest is internally consistent', async () => {
    const mockDeps = createMockDeps();
    const scriptsDir = join(testDir, '.archon', 'scripts');
    const captureRoot = join(testDir, 'capture');
    const marker = join(testDir, 'replacement-script-ran');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'check.ts'), 'console.log("original")');
    const original = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    await writeFile(join(scriptsDir, 'check.ts'), `Bun.write(${JSON.stringify(marker)}, "ran")`);
    await captureWorkflowSource({ sourceRoot: testDir, captureRoot });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'replaced-capture',
          nodes: [{ id: 'run-check', kind: 'exec', runtime: 'bun', script: 'check' }],
        },
        workflowRun: makeWorkflowRun('replaced-capture-run'),
        workflowSourceRoots: capturedSourceRoots(original.anchor),
      })
    );

    await expect(readFile(marker, 'utf-8')).rejects.toThrow();
    const failed = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string; step_name?: string }).event_type === 'node_failed' &&
        (call[0] as { step_name?: string }).step_name === 'run-check'
    );
    expect((failed?.[0] as { data: { error: string } }).data.error).toContain(
      'capture has been replaced'
    );
  });

  it('refuses changed captured command text before an agent receives it', async () => {
    const mockDeps = createMockDeps();
    const commandsDir = join(testDir, '.archon', 'commands');
    const captureRoot = join(testDir, 'capture');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'review.md'), 'original prompt');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    const capturedCommand = join(captureRoot, 'project', '.archon', 'commands', 'review.md');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'changed-command',
          nodes: [
            {
              id: 'change-capture',
              kind: 'exec',
              runtime: 'bun',
              script: `Bun.write(${JSON.stringify(capturedCommand)}, "changed prompt")`,
            },
            {
              id: 'read-command',
              kind: 'agent',
              source: { kind: 'command', name: 'review' },
              depends_on: ['change-capture'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('changed-command-run'),
        workflowSourceRoots: capturedSourceRoots(capture.anchor),
      })
    );

    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const failed = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string; step_name?: string }).event_type === 'node_failed' &&
        (call[0] as { step_name?: string }).step_name === 'read-command'
    );
    expect((failed?.[0] as { data: { error: string } }).data.error).toContain(
      'captured source has changed'
    );
  });

  it('refuses a changed captured loop command before the first iteration', async () => {
    const mockDeps = createMockDeps();
    const commandsDir = join(testDir, '.archon', 'commands');
    const captureRoot = join(testDir, 'capture');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'iterate.md'), 'original loop prompt');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    const capturedCommand = join(captureRoot, 'project', '.archon', 'commands', 'iterate.md');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'changed-loop-command',
          nodes: [
            {
              id: 'change-capture',
              kind: 'exec',
              runtime: 'bun',
              script: `Bun.write(${JSON.stringify(capturedCommand)}, "changed loop prompt")`,
            },
            {
              id: 'iterate',
              kind: 'loop',
              depends_on: ['change-capture'],
              loop: {
                command: 'iterate',
                until: 'DONE',
                max_iterations: 1,
                fresh_context: false,
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('changed-loop-command-run'),
        workflowSourceRoots: capturedSourceRoots(capture.anchor),
      })
    );

    expect(mockSendQueryDag).not.toHaveBeenCalled();
    const failed = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string; step_name?: string }).event_type === 'node_failed' &&
        (call[0] as { step_name?: string }).step_name === 'iterate'
    );
    expect((failed?.[0] as { data: { error: string } }).data.error).toContain(
      'captured source has changed'
    );
  });

  it('does not dispatch a named script to a container after the host capture changes', async () => {
    const dockerSpy = stubMissingContainer();
    const scriptsDir = join(testDir, '.archon', 'scripts');
    const captureRoot = join(testDir, 'capture');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'check.ts'), 'console.log("original")');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    await writeFile(
      join(captureRoot, 'project', '.archon', 'scripts', 'check.ts'),
      'console.log("changed")'
    );

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflow: {
            name: 'container-capture-integrity',
            nodes: [{ id: 'run-check', kind: 'exec', runtime: 'bun', script: 'check' }],
          },
          workflowRun: makeWorkflowRun('container-capture-integrity-run'),
          workflowSourceRoots: capturedSourceRoots(capture.anchor),
          execContext: { kind: 'container', containerId: 'capture-integrity-container' },
        })
      );

      expect(nodeDockerCalls(dockerSpy.mock.calls)).toHaveLength(0);
    } finally {
      dockerSpy.mockRestore();
    }
  });

  it('disables Python bytecode caching for script subprocesses', async () => {
    // A named Python script runs from the frozen capture; a `__pycache__` written beside
    // an imported sibling would change the capture under the run. The flag rides the
    // same env both inline and named scripts receive, so an inline probe proves delivery.
    const marker = join(testDir, 'bytecode-flag');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'bytecode-flag',
          nodes: [
            {
              id: 'probe',
              kind: 'exec',
              runtime: 'bun',
              script: `Bun.write(${JSON.stringify(marker)}, process.env.PYTHONDONTWRITEBYTECODE ?? "unset")`,
            },
          ],
        },
        workflowRun: makeWorkflowRun('bytecode-flag-run'),
      })
    );

    expect(await readFile(marker, 'utf-8')).toBe('1');
  });

  it('keeps inline scripts in memory even when an unrelated captured file changes', async () => {
    const scriptsDir = join(testDir, '.archon', 'scripts');
    const captureRoot = join(testDir, 'capture');
    const marker = join(testDir, 'inline-script-ran');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'unused.ts'), 'console.log("original")');
    const capture = await captureWorkflowSource({ sourceRoot: testDir, captureRoot });
    await writeFile(
      join(captureRoot, 'project', '.archon', 'scripts', 'unused.ts'),
      'console.log("changed")'
    );

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: {
          name: 'inline-script-memory',
          nodes: [
            {
              id: 'inline',
              kind: 'exec',
              runtime: 'bun',
              script: `Bun.write(${JSON.stringify(marker)}, "ran")`,
            },
          ],
        },
        workflowRun: makeWorkflowRun('inline-script-memory-run'),
        workflowSourceRoots: capturedSourceRoots(capture.anchor),
      })
    );

    expect(await readFile(marker, 'utf-8')).toBe('ran');
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-fail-run-id', {
      workflow_name: 'script-fail-test',
      conversation_id: 'conv-fail',
      user_message: 'fail test',
    });

    const scriptNode: ExecNode = {
      id: 'fail-script',
      kind: 'exec',
      script: 'process.exit(1)',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-fail',
        cwd: testDir,
        workflow: { name: 'script-fail-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    expect(
      persistedEvents(mockDeps.store)
        .filter(event => event.event_type === 'node_failed')
        .map(event => event.step_name)
    ).toEqual(['fail-script']);
  });

  it('preserves a bun script failure whose stderr contains ENOENT', async () => {
    const mockDeps = createMockDeps();
    const missingPath = join(testDir, 'missing-input.txt');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'script-enoent-diagnostic',
          nodes: [
            {
              id: 'read-missing-input',
              kind: 'exec',
              runtime: 'bun',
              script: `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(missingPath)});`,
            },
          ],
        },
        workflowRun: makeWorkflowRun('script-enoent-diagnostic-run'),
      })
    );

    const failed = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'read-missing-input'
    );
    expect(failed?.data?.error).toContain('[exit 1]');
    expect(failed?.data?.error).toContain('ENOENT');
    expect(failed?.data?.error).toContain('missing-input.txt');
    expect(failed?.data?.error).not.toContain("'bun' executable not found in PATH");
  });

  it('preserves a script failure whose stderr contains EACCES', async () => {
    const mockDeps = createMockDeps();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: 'script-eacces-diagnostic',
          nodes: [
            {
              id: 'report-denied-operation',
              kind: 'exec',
              runtime: 'bun',
              script: 'process.stderr.write("EACCES: script operation denied\\n"); process.exit(7)',
            },
          ],
        },
        workflowRun: makeWorkflowRun('script-eacces-diagnostic-run'),
      })
    );

    const failed = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'report-denied-operation'
    );
    expect(failed?.data?.error).toBe(
      "Script node 'report-denied-operation' failed [exit 7]: EACCES: script operation denied"
    );
  });

  it.each([
    ['bun', 'console.log("not reached")'],
    ['uv', 'print("not reached")'],
  ] as const)('reports a genuinely missing %s runtime executable', async (runtime, script) => {
    const mockDeps = createMockDeps();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        cwd: testDir,
        workflow: {
          name: `missing-${runtime}-runtime`,
          nodes: [{ id: `missing-${runtime}`, kind: 'exec', runtime, script }],
        },
        workflowRun: makeWorkflowRun(`missing-${runtime}-runtime-run`),
        config: { ...minimalConfig, envVars: { PATH: '' } },
      })
    );

    const failed = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_failed' && event.step_name === `missing-${runtime}`
    );
    expect(failed?.data?.error).toBe(
      `Script node 'missing-${runtime}' failed: '${runtime}' executable not found in PATH`
    );
  });

  it.each([
    ['ENOENT', 'bun', 'console.log("not reached")'],
    ['ENOENT', 'uv', 'print("not reached")'],
    ['EACCES', 'bun', 'console.log("not reached")'],
  ] as const)(
    'preserves Docker %s spawn attribution for a container %s script',
    async (code, runtime, script) => {
      const mockDeps = createMockDeps();
      const execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (_command, args) => {
        if (args.at(-1) === CONTAINER_MARKER_PROBE) return { stdout: 'none\n', stderr: '' };
        throw Object.assign(new Error(`spawn docker ${code}`), { code });
      });

      try {
        await executeDagWorkflow(
          dagOptions({
            deps: mockDeps,
            cwd: testDir,
            workflow: {
              name: `container-${runtime}-${code.toLowerCase()}`,
              nodes: [{ id: `run-${runtime}`, kind: 'exec', runtime, script }],
            },
            workflowRun: makeWorkflowRun(`container-${runtime}-${code.toLowerCase()}-run`),
            execContext: { kind: 'container', containerId: 'script-container' },
          })
        );
      } finally {
        execSpy.mockRestore();
      }

      const failed = persistedEvents(mockDeps.store).find(
        event => event.event_type === 'node_failed' && event.step_name === `run-${runtime}`
      );
      expect(failed?.data?.error).toContain(`spawn docker ${code}`);
      expect(failed?.data?.error).not.toContain(`'${runtime}' executable not found in PATH`);
      expect(failed?.data?.error).not.toContain('permission denied (check cwd permissions)');
    }
  );

  it('failure message strips the "Command failed: bun -e <body>" prefix and stays small', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-1389-run-id', {
      workflow_name: 'script-1389',
      conversation_id: 'conv-1389s',
      user_message: 'test',
    });

    // 500 × 7 chars = 3.5 KB — larger than SUBPROCESS_ERROR_MAX_CHARS (2 KB),
    // so any leak of the full script body via err.message would violate the length
    // assertion below. Block-comment padding (no newlines) avoids Windows execFile
    // arg truncation at \n that would cause bun to exit 0 on the comment-only prefix.
    const paddingAboveMax = '/* p */'.repeat(500);
    const scriptNode: ExecNode = {
      id: 'fail-script-1389',
      kind: 'exec',
      script: `${paddingAboveMax} this is not valid javascript`,
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-1389s',
        cwd: testDir,
        workflow: { name: 'script-1389', nodes: [scriptNode] },
        workflowRun,
      })
    );

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'fail-script-1389'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain("Script node 'fail-script-1389' failed");
    expect(errorMsg).not.toContain('Command failed:');
    expect(errorMsg).not.toContain('padding line padding line padding line');
    // 2 KB diagnostic cap + label prefix + truncation marker should stay under
    // 2.1 KB. Bumping SUBPROCESS_ERROR_MAX_CHARS would trip this.
    expect(errorMsg.length).toBeLessThan(2100);
    // Bun emits `error: <description>\n    at [eval]:L:C` for parse failures —
    // the location marker is the strongest signal that the diagnostic survived.
    expect(errorMsg).toContain('[eval]');
  });

  it(
    'fails by default when the subprocess times out',
    async () => {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('script-timeout-run-id', {
        workflow_name: 'script-timeout-test',
        conversation_id: 'conv-timeout',
        user_message: 'timeout test',
      });

      const scriptNode: ExecNode = {
        id: 'slow-script',
        // Bun inline script that sleeps longer than the timeout
        kind: 'exec',
        script: 'await new Promise(r => setTimeout(r, 30000))',
        runtime: 'bun',
        timeout: 500,
      };

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-timeout',
          cwd: testDir,
          workflow: { name: 'script-timeout-test', nodes: [scriptNode] },
          workflowRun,
        })
      );

      const events = persistedEvents(mockDeps.store);
      const timedOut = events.filter(event => event.event_type === 'node_failed');
      expect(timedOut.map(event => event.step_name)).toEqual(['slow-script']);
      expect(timedOut[0]?.data?.error).toBe("Script node 'slow-script' timed out after 500ms");
      expect(
        events.some(
          event => event.event_type === 'node_skipped' && event.step_name === 'slow-script'
        )
      ).toBe(false);
    },
    testTimeout(10000)
  );

  it('stderr output is sent to the user', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-stderr-run-id', {
      workflow_name: 'script-stderr-test',
      conversation_id: 'conv-stderr',
      user_message: 'stderr test',
    });

    const scriptNode: ExecNode = {
      id: 'stderr-script',
      // Write to both stderr and stdout
      kind: 'exec',
      script: 'process.stderr.write("error detail\\n"); console.log("done")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-stderr',
        cwd: testDir,
        workflow: { name: 'script-stderr-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    expect(deliveredMessages(platform)).toContain(
      "Script node 'stderr-script' stderr:\n```\nerror detail\n```"
    );
  });

  it('$WORKFLOW_ID and $ARTIFACTS_DIR are substituted into script text', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('wf-subst-run-id', {
      workflow_name: 'script-subst-test',
      conversation_id: 'conv-subst',
      user_message: 'subst test',
    });

    const artifactsDir = join(testDir, 'artifacts');

    // Write a downstream command so we can inspect the substituted prompt
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'check-output.md'), 'Got: $script-out.output');

    const nodes: DagNode[] = [
      {
        id: 'script-out',
        // Print the run ID and artifacts dir — after substitution these are real values
        kind: 'exec',
        script: 'console.log("id=$WORKFLOW_ID artifacts=$ARTIFACTS_DIR")',
        runtime: 'bun',
      },
      {
        id: 'check',
        kind: 'agent',
        source: { kind: 'command', name: 'check-output' },
        depends_on: ['script-out'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-subst',
        cwd: testDir,
        workflow: { name: 'script-subst-vars', nodes },
        workflowRun,
        artifactsDir,
      })
    );

    // The downstream AI node should have received the substituted output
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    // The script output should contain the actual run ID (not the literal variable name)
    expect(prompt).toContain('wf-subst-run-id');
    expect(prompt).not.toContain('$WORKFLOW_ID');
  });

  it('STATE_DIR reaches script and bash subprocesses as an env var, not just as text', async () => {
    // The textual `$STATE_DIR` path is protected by the fail-fast in
    // workflow-variables (referenced-but-unresolved throws). The ENV-BAG path is
    // not: a dropped `STATE_DIR: stateDir` beside `ARTIFACTS_DIR` would be
    // silent, since a node reading `process.env.STATE_DIR` would just see
    // undefined. This locks both delivery channels.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('wf-statedir-env', {
      workflow_name: 'state-dir-env-test',
      conversation_id: 'conv-statedir',
      user_message: 'state dir env test',
    });

    const stateDir = join(testDir, 'state');
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, 'check-state.md'),
      'script=$from-script.output bash=$from-bash.output'
    );

    const nodes: DagNode[] = [
      // Both read the ENV var and neither contains the literal `$STATE_DIR`, so
      // the textual substitution path cannot make this pass. `${STATE_DIR}` in
      // the bash body survives substitution (the engine replaces the exact
      // string `$STATE_DIR`) and is expanded by the shell from the env bag —
      // which also keeps a Windows path out of the script text entirely.
      {
        id: 'from-script',
        kind: 'exec',
        script: 'console.log(process.env.STATE_DIR)',
        runtime: 'bun',
      },
      { id: 'from-bash', kind: 'exec', runtime: 'sh', script: 'printf %s "${STATE_DIR}"' },
      {
        id: 'check',
        kind: 'agent',
        source: { kind: 'command', name: 'check-state' },
        depends_on: ['from-script', 'from-bash'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-statedir',
        cwd: testDir,
        workflow: { name: 'state-dir-env', nodes },
        workflowRun,
        stateDir,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain(`script=${stateDir}`);
    expect(prompt).toContain(`bash=${stateDir}`);
  });

  it('WORKFLOW_ID reaches script and bash subprocesses as an env var, not just as text', async () => {
    // $WORKFLOW_ID substitutes into the body, so a node that spells it inline
    // always worked. A heredoc'd python/node block reads os.environ instead,
    // and found WORKFLOW_ID missing while ARTIFACTS_DIR/STATE_DIR/LOG_DIR beside
    // it were all present — an inconsistency that fails only at runtime, inside
    // the nested interpreter, with a bare KeyError.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const runId = 'wf-workflowid-env';
    const workflowRun = makeWorkflowRun(runId, {
      workflow_name: 'workflow-id-env-test',
      conversation_id: 'conv-wfid',
      user_message: 'workflow id env test',
    });

    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, 'check-wfid.md'),
      'script=$from-script.output bash=$from-bash.output'
    );

    const nodes: DagNode[] = [
      // Neither body contains the literal `$WORKFLOW_ID`, so the textual
      // substitution path cannot make this pass — only the env bag can.
      {
        id: 'from-script',
        kind: 'exec',
        script: 'console.log(process.env.WORKFLOW_ID)',
        runtime: 'bun',
      },
      { id: 'from-bash', kind: 'exec', runtime: 'sh', script: 'printf %s "${WORKFLOW_ID}"' },
      {
        id: 'check',
        kind: 'agent',
        source: { kind: 'command', name: 'check-wfid' },
        depends_on: ['from-script', 'from-bash'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-wfid',
        cwd: testDir,
        workflow: { name: 'workflow-id-env', nodes },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain(`script=${runId}`);
    expect(prompt).toContain(`bash=${runId}`);
  });

  it('ADOPTED_RUN_DIR reaches script and bash subprocesses as an env var (empty on non-adopting runs)', async () => {
    // ADOPTED_RUN_DIR (#3017) joins the deterministic-node env bag so packaged
    // script: files can read it from process.env / os.environ. On a non-adopting
    // run it is the empty string — a script can test for it without KeyError.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('wf-adopted-env', {
      workflow_name: 'adopted-env-test',
      conversation_id: 'conv-adopted',
      user_message: 'adopted env test',
    });

    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      join(commandsDir, 'check-adopted.md'),
      'script=$from-script.output bash=$from-bash.output'
    );

    const nodes: DagNode[] = [
      {
        id: 'from-script',
        kind: 'exec',
        script: 'console.log(process.env.ADOPTED_RUN_DIR)',
        runtime: 'bun',
      },
      { id: 'from-bash', kind: 'exec', runtime: 'sh', script: 'printf %s "${ADOPTED_RUN_DIR}"' },
      {
        id: 'check',
        kind: 'agent',
        source: { kind: 'command', name: 'check-adopted' },
        depends_on: ['from-script', 'from-bash'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-adopted',
        cwd: testDir,
        workflow: { name: 'adopted-env-test', nodes },
        workflowRun,
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    // Non-adopting run: both nodes produce the empty string.
    expect(prompt).toContain('script= bash=');
  });

  it('named script not found at runtime results in failed state and platform message', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-notfound-run-id', {
      workflow_name: 'script-notfound-test',
      conversation_id: 'conv-notfound',
      user_message: 'notfound test',
    });

    // Do NOT create .archon/scripts/missing.ts — the script should fail to resolve
    const scriptNode: ExecNode = {
      id: 'gone-script',
      kind: 'exec',
      script: 'missing',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-notfound',
        cwd: testDir,
        workflow: { name: 'script-notfound-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    const resolutionFailure =
      "Script node 'gone-script': named script 'missing' not found in .archon/scripts/ " +
      'or ~/.archon/scripts/';
    expect(deliveredMessages(platform)).toContain(resolutionFailure);
    const failed = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'gone-script'
    );
    expect(failed?.data?.error).toBe(resolutionFailure);
    expect(mockDeps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockDeps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
  });

  it('bun script node does not leak repo .env from execution cwd (#1135)', async () => {
    // Regression test: place a .env with a marker in the execution cwd.
    // The bun script must NOT see it because --no-env-file is passed.
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('env-leak-run-id', {
      workflow_name: 'env-leak-test',
      conversation_id: 'conv-env-leak',
      user_message: 'env leak test',
    });

    // Write a .env with a marker in the script execution cwd
    await writeFile(join(testDir, '.env'), 'LEAKED_REPO_SECRET=should_not_appear\n');

    const scriptNode: ExecNode = {
      id: 'env-check',
      kind: 'exec',
      script: 'console.log(process.env.LEAKED_REPO_SECRET ?? "CLEAN")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-env-leak',
        cwd: testDir,
        workflow: { name: 'env-leak-test', nodes: [scriptNode] },
        workflowRun,
      })
    );

    // The node output should be "CLEAN" — the repo .env was not loaded
    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const completedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_completed' &&
        (call[0] as { step_name: string }).step_name === 'env-check'
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent![0] as { data: { node_output: string } }).data.node_output).toBe(
      'CLEAN'
    );
  });

  it('passes config.envVars to script subprocesses', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('script-env-run-id');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-script-env',
        cwd: testDir,
        workflow: {
          name: 'script-env-test',
          nodes: [{ id: 'inline-bun', kind: 'exec', script: 'console.log("ok")', runtime: 'bun' }],
        },
        workflowRun,
        config: { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } },
      })
    );

    expect(execSpy).toHaveBeenCalledWith(
      'bun',
      ['--no-env-file', '-e', 'console.log("ok")'],
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
      })
    );
    execSpy.mockRestore();
  });
});
