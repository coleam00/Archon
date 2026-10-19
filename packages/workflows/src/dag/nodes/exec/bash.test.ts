// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import { bashScriptCommand } from '../../bash-script';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  persistedEvents,
  minimalConfig,
  type TestWorkflowDefinition,
  stubMissingContainer,
  spyOnNodeExec,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import type { DagNode, ExecNode } from '../../../schemas';
import { CONTAINER_MARKER_PROBE } from '../../../checkout-observation';

describe('executeDagWorkflow -- bash nodes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('bash node executes and captures stdout as output', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: ExecNode = {
      id: 'stats',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo "hello world"',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash',
        cwd: testDir,
        workflow: { name: 'bash-exec-test', nodes: [bashNode] },
        workflowRun,
      })
    );

    // Bash node should NOT invoke AI client
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node stdout is available for downstream $nodeId.output substitution', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the downstream AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Process: $stats.output');

    const nodes: DagNode[] = [
      { id: 'stats', kind: 'exec', runtime: 'sh', script: 'echo "42 files"' },
      {
        id: 'process',
        kind: 'agent',
        source: { kind: 'command', name: 'my-cmd' },
        depends_on: ['stats'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash',
        cwd: testDir,
        workflow: { name: 'bash-subst-test', nodes },
        workflowRun,
      })
    );

    // AI client should have been called for the downstream node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
    // The prompt should contain the substituted bash output
    const prompt = mockSendQueryDag.mock.calls[0][0] as string;
    expect(prompt).toContain('42 files');
  });

  it('non-zero exit code results in failed state', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: ExecNode = {
      id: 'fail',
      kind: 'exec',
      runtime: 'sh',
      script: 'exit 1',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash',
        cwd: testDir,
        workflow: { name: 'bash-fail-test', nodes: [bashNode] },
        workflowRun,
      })
    );

    // The run handles the failure rather than throwing, and records which node
    // failed. Asserting the recorded step_name is what distinguishes "the node
    // under test failed" from "something failed" (#3167).
    const failedSteps = persistedEvents(mockDeps.store)
      .filter(event => event.event_type === 'node_failed')
      .map(event => event.step_name);
    expect(failedSteps).toEqual(['fail']);
  });

  it('failure message surfaces stderr and does not leak the "Command failed: bash -c <body>" prefix', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-1389-run-id', {
      workflow_name: 'bash-1389',
      conversation_id: 'conv-1389b',
      user_message: 'test',
    });

    // The marker appears only in the script body (never echoed to stdout or
    // stderr). If it shows up in errorMsg the "Command failed: bash -c <body>"
    // prefix line was not stripped. The stdout echo is separately asserted so a
    // regression that drops stdout from the diagnostics is caught.
    const bashNode: ExecNode = {
      id: 'fail-bash-1389',
      kind: 'exec',
      runtime: 'sh',
      script:
        'UNIQUE_CMDLINE_MARKER_1389=; echo "stdout context before failure"; echo "diagnostic from stderr" >&2; exit 1',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-1389b',
        cwd: testDir,
        workflow: { name: 'bash-1389', nodes: [bashNode] },
        workflowRun,
      })
    );

    const eventCalls = (mockDeps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls;
    const failedEvent = eventCalls.find(
      (call: unknown[]) =>
        (call[0] as { event_type: string }).event_type === 'node_failed' &&
        (call[0] as { step_name: string }).step_name === 'fail-bash-1389'
    );
    expect(failedEvent).toBeDefined();
    const errorMsg = (failedEvent![0] as { data: { error: string } }).data.error;
    expect(errorMsg).toContain("Bash node 'fail-bash-1389' failed");
    expect(errorMsg).toContain('[exit 1]');
    expect(errorMsg).not.toContain('Command failed:');
    expect(errorMsg).not.toContain('UNIQUE_CMDLINE_MARKER_1389');
    expect(errorMsg).toContain('diagnostic from stderr');
    expect(errorMsg).toContain('stdout context before failure');
    expect(errorMsg).toContain('[stderr]');
    expect(errorMsg).toContain('[stdout]');
  });

  const containerBashNodes: [string, TestWorkflowDefinition['nodes'][number]][] = [
    ['bash node', { id: 'shell', kind: 'exec', runtime: 'sh', script: 'echo not reached' }],
    [
      'loop until_bash',
      {
        id: 'shell',
        kind: 'loop',
        loop: {
          prompt: 'Work.',
          until: 'DONE',
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
        },
      },
    ],
    [
      'loop_group until_bash',
      {
        id: 'shell',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          until_bash: 'exit 0',
          max_iterations: 1,
          fresh_context: false,
          nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } }],
        },
      },
    ],
  ];
  const nulSource = 'exit 0\0exit 1';
  const invalidSourceNodes: [string, DagNode][] = [
    ['bash body', { id: 'shell', kind: 'exec', runtime: 'sh', script: nulSource }],
    [
      'loop completion',
      {
        id: 'shell',
        kind: 'loop',
        loop: {
          prompt: 'Work.',
          until_bash: nulSource,
          max_iterations: 2,
          fresh_context: false,
        },
      },
    ],
    [
      'group completion',
      {
        id: 'shell',
        kind: 'loop_group',
        loop_group: {
          until_bash: nulSource,
          max_iterations: 2,
          fresh_context: false,
          nodes: [{ id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Work.' } }],
        },
      },
    ],
  ];
  it.each(invalidSourceNodes)(
    '%s rejects invalid source without re-iterating',
    async (_label, node) => {
      const mockDeps = createMockDeps();
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          cwd: testDir,
          workflow: { name: 'invalid-source', nodes: [node] },
          workflowRun: makeWorkflowRun('invalid-source'),
        })
      );
      const failed = persistedEvents(mockDeps.store).find(
        event => event.event_type === 'node_failed' && event.step_name === 'shell'
      );
      expect(failed?.data?.error).toContain('NUL');
      expect(mockSendQueryDag.mock.calls.length).toBeLessThanOrEqual(1);
    }
  );

  it.each(
    containerBashNodes.flatMap(([label, node]) =>
      (['ENOENT', 'EACCES'] as const).map(code => [label, code, node] as const)
    )
  )('a container %s keeps Docker %s spawn attribution', async (_label, code, node) => {
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
          workflow: { name: 'container-bash-spawn', nodes: [node] },
          workflowRun: makeWorkflowRun('container-bash-spawn-run'),
          execContext: { kind: 'container', containerId: 'bash-container' },
        })
      );
    } finally {
      execSpy.mockRestore();
    }

    const failed = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_failed' && event.step_name === 'shell'
    );
    expect(failed?.data?.error).toContain(`spawn docker ${code}`);
    expect(failed?.data?.error).not.toContain('ARCHON_BASH_PATH');
    expect(failed?.data?.error).not.toContain('permission denied (check cwd permissions)');
  });

  it('variable substitution works in bash scripts', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    const bashNode: ExecNode = {
      id: 'vars',
      kind: 'exec',
      runtime: 'sh',
      script: 'echo "$ARGUMENTS"',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash',
        cwd: testDir,
        workflow: { name: 'bash-vars-test', nodes: [bashNode] },
        workflowRun,
      })
    );

    // Should complete without error (no AI calls)
    expect(mockSendQueryDag.mock.calls.length).toBe(0);
  });

  it('bash node in parallel layer executes correctly', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-test-run-id', {
      workflow_name: 'bash-test',
      conversation_id: 'conv-bash',
      user_message: 'bash test message',
    });

    // Write a command file for the AI node
    const commandsDir = join(testDir, '.archon', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'my-cmd.md'), 'Do something');

    const nodes: DagNode[] = [
      { id: 'bash-a', kind: 'exec', runtime: 'sh', script: 'echo "from bash"' },
      { id: 'ai-b', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash',
        cwd: testDir,
        workflow: { name: 'bash-parallel-test', nodes },
        workflowRun,
      })
    );

    // AI client called only for the AI node, not the bash node
    expect(mockSendQueryDag.mock.calls.length).toBe(1);
  });

  it('passes config.envVars to bash subprocesses', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-env-run-id');

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-bash-env',
        cwd: testDir,
        workflow: {
          name: 'bash-env-test',
          nodes: [{ id: 'stats', kind: 'exec', runtime: 'sh', script: 'echo ok' }],
        },
        workflowRun,
        config: { ...minimalConfig, envVars: { MY_SECRET: 'abc123' } },
      })
    );

    expect(execSpy).toHaveBeenCalledWith(
      git.resolveBashPath(),
      bashScriptCommand('echo ok').args,
      expect.objectContaining({
        env: expect.objectContaining({ MY_SECRET: 'abc123' }),
        input: 'echo ok',
      })
    );
    execSpy.mockRestore();
  });

  it('bash node output with shell metacharacters does not inject into downstream bash script', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('bash-injection-run-id', {
      workflow_name: 'bash-injection-test',
      conversation_id: 'conv-injection',
      user_message: 'test',
    });

    // upstream: outputs a value containing shell metacharacters
    // downstream: embeds $upstream.output literally in a bash script
    // If injection were present, the semicolon would split into two commands and INJECTED would print
    const nodes: DagNode[] = [
      { id: 'upstream', kind: 'exec', runtime: 'sh', script: 'printf "%s" "safe; echo INJECTED"' },
      {
        id: 'downstream',
        kind: 'exec',
        runtime: 'sh',
        script: 'result=$upstream.output; echo "got: $result"',
        depends_on: ['upstream'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-injection',
        cwd: testDir,
        workflow: { name: 'bash-injection-test', nodes },
        workflowRun,
      })
    );

    // No AI calls
    expect(mockSendQueryDag.mock.calls.length).toBe(0);

    // The downstream node received the upstream output as one literal value.
    // Under injection the `;` would split it, `echo INJECTED` would run as its
    // own command, and the recorded output would read `got: safe` — so pinning
    // the exact output is what proves the absence, not a message scan (#3167).
    const downstream = persistedEvents(mockDeps.store).find(
      event => event.event_type === 'node_completed' && event.step_name === 'downstream'
    );
    expect(downstream?.data?.node_output).toBe('got: safe; echo INJECTED');
  });

  it('passes user message through env vars, not string substitution, preventing shell injection', async () => {
    const execSpy = spyOnNodeExec().mockResolvedValue({ stdout: 'ok\n', stderr: '' });
    try {
      const mockDeps = createMockDeps();
      const platform = createMockPlatform();
      const workflowRun = makeWorkflowRun('bash-shell-safe-run-id', {
        workflow_name: 'bash-shell-safe',
        conversation_id: 'conv-shell-safe',
        user_message: '$(rm -rf /)',
      });

      const bashNode: ExecNode = {
        id: 'safe',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo $USER_MESSAGE',
      };

      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-shell-safe',
          cwd: testDir,
          workflow: { name: 'bash-shell-safe-test', nodes: [bashNode] },
          workflowRun,
        })
      );

      expect(execSpy).toHaveBeenCalledTimes(1);
      const firstCall = execSpy.mock.calls[0];

      expect(firstCall?.[2]?.input).toBe('echo $USER_MESSAGE');

      // The env must contain the user message
      const envArg = (firstCall?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(envArg?.USER_MESSAGE).toBe('$(rm -rf /)');
      expect(envArg?.ARGUMENTS).toBe('$(rm -rf /)');
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe('executeDagWorkflow -- env var injection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-env-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test', {
      flag: 'w',
    }).catch(async () => {
      await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
      await writeFile(join(testDir, '.archon', 'commands', 'my-cmd.md'), '# Test');
    });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
    await removeTempTree(testDir);
  });

  it('passes config.envVars as env to sendQuery for Claude node', async () => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun();

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        cwd: testDir,
        workflow: {
          name: 'dag-env-test',
          nodes: [{ id: 'task', kind: 'agent', source: { kind: 'command', name: 'my-cmd' } }],
        },
        workflowRun,
        config: {
          ...minimalConfig,
          envVars: {
            MY_SECRET: 'abc123',
            ANTHROPIC_API_KEY: 'acting-user-secret',
            GIT_AUTHOR_NAME: 'connected-author',
            GIT_AUTHOR_EMAIL: '42+connected-author@users.noreply.github.com',
          },
          protectedEnvKeys: ['ANTHROPIC_API_KEY', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'],
          userCredentialEnvKeys: ['ANTHROPIC_API_KEY'],
        },
      })
    );

    expect(mockSendQueryDag.mock.calls.length).toBeGreaterThan(0);
    const optionsArg = mockSendQueryDag.mock.calls[0][3] as Record<string, unknown>;
    expect(optionsArg?.env).toMatchObject({
      MY_SECRET: 'abc123',
      ANTHROPIC_API_KEY: 'acting-user-secret',
      GIT_AUTHOR_NAME: 'connected-author',
      GIT_AUTHOR_EMAIL: '42+connected-author@users.noreply.github.com',
    });
    expect(optionsArg?.userCredentialEnvKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(optionsArg?.protectedEnvKeys).toEqual([
      'ANTHROPIC_API_KEY',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
    ]);
  });

  describe('run identity', () => {
    const cliCommand = JSON.stringify(['/opt/archon/bin/archon']);
    let savedCliCommand: string | undefined;
    beforeEach(() => {
      savedCliCommand = process.env.ARCHON_CLI_COMMAND;
      process.env.ARCHON_CLI_COMMAND = cliCommand;
    });
    afterEach(() => {
      if (savedCliCommand === undefined) delete process.env.ARCHON_CLI_COMMAND;
      else process.env.ARCHON_CLI_COMMAND = savedCliCommand;
    });

    const shadowingEnv = {
      MY_VAR: 'keep-me',
      WORKFLOW_ID: 'project-run',
      ARCHON_NODE_EXECUTION: '{"runId":"project-run","path":"elsewhere"}',
      ARCHON_CLI_COMMAND: '["project-archon"]',
    };

    async function runIdentityEnv(
      node: TestWorkflowDefinition['nodes'][number],
      envVars: Record<string, string>
    ): Promise<{ env: Record<string, string>; execution: Record<string, unknown> }> {
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'dag-identity', nodes: [node] },
          workflowRun: makeWorkflowRun('identity-run'),
          config: { ...minimalConfig, envVars },
        })
      );
      const env = (mockSendQueryDag.mock.calls[0]?.[3] as { env: Record<string, string> }).env;
      return { env, execution: JSON.parse(env.ARCHON_NODE_EXECUTION ?? '') };
    }

    it("a prompt: node's environment carries its run, node and the CLI command", async () => {
      const { env, execution } = await runIdentityEnv(
        { id: 'notes', kind: 'agent', source: { kind: 'inline', prompt: 'Keep notes.' } },
        {}
      );
      expect(Object.keys(env).sort()).toEqual([
        'ARCHON_CLI_COMMAND',
        'ARCHON_NODE_EXECUTION',
        'WORKFLOW_ID',
      ]);
      expect(env.WORKFLOW_ID).toBe('identity-run');
      expect(env.ARCHON_CLI_COMMAND).toBe(cliCommand);
      expect(execution).toMatchObject({ runId: 'identity-run', path: 'notes' });
      expect(execution).toHaveProperty('invocation');
      expect(execution).toHaveProperty('attempt');
    });

    it('project env cannot shadow the identity of a prompt: node', async () => {
      const { env, execution } = await runIdentityEnv(
        { id: 'notes', kind: 'agent', source: { kind: 'inline', prompt: 'Keep notes.' } },
        shadowingEnv
      );
      expect(env.MY_VAR).toBe('keep-me');
      expect(env.WORKFLOW_ID).toBe('identity-run');
      expect(env.ARCHON_CLI_COMMAND).toBe(cliCommand);
      expect(execution).toMatchObject({ runId: 'identity-run', path: 'notes' });
    });

    it("a loop node's iterations carry the loop's run and node", async () => {
      mockSendQueryDag.mockImplementationOnce(async function* () {
        yield { type: 'result', sessionId: 's', text: '<promise>COMPLETE</promise>' };
      });
      const { env, execution } = await runIdentityEnv(
        {
          id: 'iterate',
          kind: 'loop',
          loop: { prompt: 'Work.', until: 'COMPLETE', max_iterations: 2, fresh_context: false },
        },
        shadowingEnv
      );
      expect(env.MY_VAR).toBe('keep-me');
      expect(env.WORKFLOW_ID).toBe('identity-run');
      expect(env.ARCHON_CLI_COMMAND).toBe(cliCommand);
      expect(execution).toMatchObject({ runId: 'identity-run', path: 'iterate' });
    });

    it('a container run owns ARCHON_CLI_COMMAND as empty, so project env cannot supply one', async () => {
      const execSpy = stubMissingContainer();
      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(createMockStore()),
            cwd: testDir,
            workflow: {
              name: 'dag-identity',
              nodes: [
                { id: 'notes', kind: 'agent', source: { kind: 'inline', prompt: 'Keep notes.' } },
              ],
            },
            workflowRun: makeWorkflowRun('identity-run'),
            config: { ...minimalConfig, envVars: shadowingEnv },
            execContext: { kind: 'container', containerId: 'identity-container' },
          })
        );
      } finally {
        execSpy.mockRestore();
      }
      const env = (mockSendQueryDag.mock.calls[0]?.[3] as { env: Record<string, string> }).env;
      expect(env.ARCHON_CLI_COMMAND).toBe('');
      expect(env.WORKFLOW_ID).toBe('identity-run');
      expect(JSON.parse(env.ARCHON_NODE_EXECUTION ?? '')).toMatchObject({
        runId: 'identity-run',
        path: 'notes',
      });
    });
  });
});
