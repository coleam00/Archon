// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { mkdir, readFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import * as pluginProcess from '@archon/paths/plugin-process';
import * as subprocess from '../../../subprocess';
import { recordNodeProcessTrees } from '../../../subprocess';
import {
  type MockWorkflowStore,
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  minimalConfig,
  spyOnNodeExec,
  nodeDockerCalls,
  dagOptions,
  makeWorkflowRun,
  readTranscript,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../event-emitter';
import type { DagNode, WorkflowDefinition } from '../../../schemas';
import { dagNodeSchema } from '../../../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../../../store';

describe('executeDagWorkflow -- exec timeout outcomes', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-exec-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it.each([
    ['bash', { id: 'slow', bash: 'sleep 30', timeout: 100, on_timeout: 'skip' }],
    [
      'script',
      {
        id: 'slow',
        script: 'await Bun.sleep(30_000)',
        runtime: 'bun',
        timeout: 100,
        on_timeout: 'skip',
      },
    ],
  ] as const)(
    'skips an opted-in %s timeout and resolves a downstream if_skipped binding',
    async (kind, producerInput) => {
      const store = createMockStore();
      const workflowRun = makeWorkflowRun(`exec-timeout-${kind}`);
      const emitted: WorkflowEmitterEvent[] = [];
      const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
        if (event.runId === workflowRun.id) emitted.push(event);
      });
      const consumer = dagNodeSchema.parse({
        id: 'consumer',
        script: 'console.log(process.env.INPUTS_VALUE)',
        runtime: 'bun',
        depends_on: ['slow', 'ready'],
        trigger_rule: 'none_failed_min_one_success',
        with: { value: { from: '$slow.output', if_skipped: 'fallback' } },
      });

      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflowRun,
            workflow: {
              name: `exec-timeout-${kind}`,
              nodes: [
                dagNodeSchema.parse({ id: 'ready', bash: 'echo ready' }),
                dagNodeSchema.parse(producerInput),
                consumer,
              ],
            },
          })
        );
      } finally {
        unsubscribe();
      }

      const events = store.createWorkflowEvent.mock.calls.map(
        ([event]) =>
          event as {
            event_type: string;
            step_name?: string;
            data?: Record<string, unknown>;
          }
      );
      const skipped = events.find(
        event => event.event_type === 'node_skipped' && event.step_name === 'slow'
      );
      const completed = events.find(
        event => event.event_type === 'node_completed' && event.step_name === 'consumer'
      );

      expect(skipped?.data).toMatchObject({
        reason: 'timeout',
        cause: { kind: 'timeout' },
        type: kind,
      });
      expect(completed?.data?.node_output).toBe('fallback');
      expect(events.some(event => event.event_type === 'node_failed')).toBe(false);
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: 'node_skipped',
          nodeId: 'slow',
          reason: 'timeout',
          cause: { kind: 'timeout' },
        })
      );
      expect(store.completeWorkflowRun).toHaveBeenCalled();
    },
    testTimeout(10000)
  );

  it('fails a bash timeout without the opt-in', async () => {
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('bash-timeout-default'),
        workflow: {
          name: 'bash-timeout-default',
          nodes: [dagNodeSchema.parse({ id: 'slow', bash: 'sleep 30', timeout: 100 })],
        },
      })
    );

    const events = store.createWorkflowEvent.mock.calls.map(([event]) => event);
    expect(events).toContainEqual(
      expect.objectContaining({
        event_type: 'node_failed',
        step_name: 'slow',
        data: expect.objectContaining({ error: "Bash node 'slow' timed out after 100ms" }),
      })
    );
    expect(events.some(event => event.event_type === 'node_skipped')).toBe(false);
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });

  it.each([
    // Captured output would otherwise replace the termination error in the message. The
    // root ignores SIGTERM, so only a SIGKILL fallback lets the node settle.
    [
      'Bash',
      {
        id: 'slow',
        bash: "trap '' TERM; echo started; exec sleep 30",
        timeout: 500,
        on_timeout: 'skip',
      },
    ],
    [
      'Script',
      {
        id: 'slow',
        script: 'console.log("started"); await Bun.sleep(30_000)',
        runtime: 'bun',
        timeout: 500,
        on_timeout: 'skip',
      },
    ],
  ] as const)(
    'fails an opted-in %s timeout whose process tree could not be ended',
    async (label, nodeInput) => {
      const store = createMockStore();
      const terminateSpy = spyOn(pluginProcess, 'terminateTree').mockRejectedValue(
        new Error('group refused the signal')
      );
      // POSIX ends the tree only for a recorded node; Windows ends it on every owner path.
      const trees = recordNodeProcessTrees();

      try {
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflowRun: makeWorkflowRun(`${label}-timeout-tree-survived`),
            workflow: {
              name: `${label}-timeout-tree-survived`,
              nodes: [dagNodeSchema.parse(nodeInput)],
            },
          })
        );
      } finally {
        trees.release();
        terminateSpy.mockRestore();
      }

      const events = store.createWorkflowEvent.mock.calls.map(([event]) => event);
      expect(events).toContainEqual(
        expect.objectContaining({
          event_type: 'node_failed',
          step_name: 'slow',
          data: expect.objectContaining({
            error: expect.stringMatching(
              new RegExp(
                `^${label} node 'slow' failed: .*could not terminate subprocess tree: group refused the signal`
              )
            ),
          }),
        })
      );
      expect(events.some(event => event.event_type === 'node_skipped')).toBe(false);
    },
    testTimeout(10000)
  );

  it('does not misclassify a non-timeout failure whose diagnostic mentions a timeout', async () => {
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('exec-timeout-lookalike'),
        workflow: {
          name: 'exec-timeout-lookalike',
          nodes: [
            dagNodeSchema.parse({
              id: 'failed',
              bash: 'echo "timed out" >&2; exit 1',
              on_timeout: 'skip',
            }),
          ],
        },
      })
    );

    const events = store.createWorkflowEvent.mock.calls.map(([event]) => event);
    expect(events.some(event => event.event_type === 'node_failed')).toBe(true);
    expect(events.some(event => event.event_type === 'node_skipped')).toBe(false);
  });
});

describe('executeDagWorkflow -- subprocess calls honor the node timeout', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-until-bash-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  // Spy on the module boundary runSubprocess calls (@archon/git's execFileAsync), the same
  // way the script-injection tests above do.
  function spyOnExec() {
    return spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
  }

  function untilBashTimeout(execSpy: ReturnType<typeof spyOnExec>): number | undefined {
    const call = execSpy.mock.calls.find(c => (c[1] as string[])[0] === '-c') as
      | [string, string[], { timeout?: number }]
      | undefined;
    expect(call).toBeDefined();
    return call?.[2]?.timeout;
  }

  it('applies the node timeout to a loop until_bash subprocess', async () => {
    const node = dagNodeSchema.parse({
      id: 'my-loop',
      timeout: 600_000,
      loop: { prompt: 'Do a task.', until: 'NEVER_EMITTED', until_bash: 'true', max_iterations: 1 },
    });

    const execSpy = spyOnExec();
    try {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'working on it' };
        yield { type: 'result', sessionId: 'loop-timeout-session' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'dag-loop-timeout', nodes: [node] },
          workflowRun: makeWorkflowRun(),
        })
      );

      expect(untilBashTimeout(execSpy)).toBe(600_000);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('passes no deadline when a loop node declares no timeout', async () => {
    const node = dagNodeSchema.parse({
      id: 'my-loop-no-timeout',
      loop: { prompt: 'Do a task.', until: 'NEVER_EMITTED', until_bash: 'true', max_iterations: 1 },
    });

    const execSpy = spyOnExec();
    try {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'working on it' };
        yield { type: 'result', sessionId: 'loop-default-timeout-session' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'dag-loop-default-timeout', nodes: [node] },
          workflowRun: makeWorkflowRun(),
        })
      );

      expect(untilBashTimeout(execSpy)).toBeUndefined();
    } finally {
      execSpy.mockRestore();
    }
  });

  // The loop_group predicate call site (groupBashPath). The body node is AI-only (prompt),
  // not bash, so the ONLY execFileAsync call here is the until_bash invocation itself.
  it('applies the node timeout to a loop_group until_bash subprocess', async () => {
    const node = dagNodeSchema.parse({
      id: 'my-group',
      timeout: 600_000,
      loop_group: {
        until: 'NEVER_EMITTED',
        until_bash: 'true',
        max_iterations: 1,
        nodes: [{ id: 'work', prompt: 'Do a task.', depends_on: [] }],
      },
    });

    const execSpy = spyOnExec();
    try {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'working on it' };
        yield { type: 'result', sessionId: 'group-timeout-session' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'dag-group-timeout', nodes: [node] },
          workflowRun: makeWorkflowRun('lg-timeout'),
        })
      );

      expect(untilBashTimeout(execSpy)).toBe(600_000);
    } finally {
      execSpy.mockRestore();
    }
  });

  // A node that declares no timeout reaches runSubprocess with no deadline. Spying there
  // rather than at execFileAsync keeps the check platform-independent: on Windows bash and
  // script nodes spawn through execOwnedProcessGroup. The loop until_bash site is covered
  // above and the resumed loop_group probe in the '#2707 step 3' escalation block.
  it.each([
    ['bash node', { id: 'b', bash: 'echo UNDECLARED' }],
    ['script node', { id: 's', script: 'console.log("UNDECLARED")', runtime: 'bun' }],
    [
      'loop_group until_bash',
      {
        id: 'g',
        loop_group: {
          until: 'NEVER_EMITTED',
          until_bash: 'echo UNDECLARED',
          max_iterations: 1,
          nodes: [{ id: 'work', prompt: 'Do a task.', depends_on: [] }],
        },
      },
    ],
  ])('passes no deadline for an undeclared %s', async (_site, raw) => {
    const node = dagNodeSchema.parse(raw);

    const runSpy = spyOn(subprocess, 'runSubprocess').mockResolvedValue({
      stdout: '',
      stderr: '',
      credentialValues: [],
    });
    try {
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'working on it' };
        yield { type: 'result', sessionId: 'undeclared-timeout-session' };
      });

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform: createMockPlatform(),
          cwd: testDir,
          workflow: { name: 'dag-undeclared-timeout', nodes: [node] },
          workflowRun: makeWorkflowRun(),
        })
      );

      const call = runSpy.mock.calls.find(c =>
        (c[3].input ?? c[2].join(' ')).includes('UNDECLARED')
      );
      expect(call).toBeDefined();
      expect(call?.[3].timeout).toBeUndefined();
    } finally {
      runSpy.mockRestore();
    }
  });
});

describe('subprocess credential redaction', () => {
  const execContext = { kind: 'container' as const, containerId: 'cid-redaction' };
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-container-redaction-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('removes exact injected credentials from every rejection field before persistence', async () => {
    const openAiSecret = 'sk-openai-not-shaped';
    const otherInjectedSecret = 'credential-with-no-known-shape';
    const projectSecret = 'project-secret-with-no-known-shape';
    const databaseUrl = 'postgres://user:password@db.internal/archon';
    const fileDeliveredSecret = 'oauth-token-only-present-in-auth-file';
    const authorName = 'connected-author';
    const authorEmail = '42+connected-author@users.noreply.github.com';
    const logDir = join(testDir, 'logs');
    const workflowRun = makeWorkflowRun('container-redaction-run', {
      workflow_name: 'container-redaction',
      conversation_id: 'conv-container-redaction',
    });
    const store = createMockStore();
    const platform = createMockPlatform();
    let rejection:
      | (Error & {
          code: number;
          killed: boolean;
          cmd: string;
          spawnargs: string[];
          stdout: string;
          stderr: string;
        })
      | undefined;
    const execSpy = spyOn(git, 'execFileAsync').mockImplementation(
      async (command: string, args: string[]) => {
        const commandLine = [command, ...args].join(' ');
        rejection = Object.assign(
          new Error(`Command failed: ${commandLine}\nmessage echoed ${openAiSecret}`),
          {
            code: 1,
            killed: false,
            cmd: commandLine,
            spawnargs: args,
            stdout: `stdout echoed ${openAiSecret}, ${otherInjectedSecret}, ${projectSecret}, ${databaseUrl}, and ${fileDeliveredSecret}`,
            stderr: `stderr echoed ${openAiSecret}, ${otherInjectedSecret}, ${projectSecret}, ${databaseUrl}, and ${fileDeliveredSecret}`,
          }
        );
        throw rejection;
      }
    );

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          conversationId: workflowRun.conversation_id ?? workflowRun.id,
          cwd: testDir,
          workflow: {
            name: workflowRun.workflow_name,
            nodes: [{ id: 'fail', kind: 'exec', runtime: 'sh', script: 'exit 1' }],
          },
          workflowRun,
          logDir,
          config: {
            ...minimalConfig,
            // Secret-suffixed keys redact automatically; BASE_BRANCH is the visible control.
            envVars: {
              OPENAI_API_KEY: openAiSecret,
              CUSTOM_AUTH: otherInjectedSecret,
              PROJECT_SECRET: projectSecret,
              DATABASE_URL: databaseUrl,
              GIT_AUTHOR_NAME: authorName,
              GIT_AUTHOR_EMAIL: authorEmail,
              BASE_BRANCH: 'main',
            },
            protectedEnvKeys: [
              'OPENAI_API_KEY',
              'CUSTOM_AUTH',
              'DATABASE_URL',
              'GIT_AUTHOR_NAME',
              'GIT_AUTHOR_EMAIL',
            ],
            protectedCredentialValues: [fileDeliveredSecret],
          },
          execContext,
        })
      );

      const nodeCalls = nodeDockerCalls(execSpy.mock.calls);
      expect(nodeCalls).toHaveLength(1);
      const dockerArgs = nodeCalls[0]?.[1] ?? [];
      expect(dockerArgs.join(' ')).toContain(openAiSecret);
      expect(dockerArgs.join(' ')).toContain(otherInjectedSecret);
      expect(dockerArgs.join(' ')).toContain(projectSecret);
      expect(dockerArgs.join(' ')).toContain(databaseUrl);
      expect(dockerArgs).toContain(`GIT_AUTHOR_NAME=${authorName}`);
      expect(dockerArgs).toContain(`GIT_AUTHOR_EMAIL=${authorEmail}`);
      expect(dockerArgs.join(' ')).not.toContain('GIT_COMMITTER_');

      expect(rejection).toBeDefined();
      expect(rejection?.code).toBe(1);
      expect(rejection?.killed).toBe(false);
      const rejectionText = [
        rejection?.message,
        rejection?.stack,
        rejection?.cmd,
        rejection?.spawnargs.join(' '),
        rejection?.stdout,
        rejection?.stderr,
      ].join('\n');
      expect(rejectionText).not.toContain(authorName);
      expect(rejectionText).not.toContain(authorEmail);
      expect(rejectionText).not.toContain(openAiSecret);
      expect(rejectionText).not.toContain(otherInjectedSecret);
      expect(rejectionText).not.toContain(projectSecret);
      expect(rejectionText).not.toContain(databaseUrl);
      expect(rejectionText).not.toContain(fileDeliveredSecret);
      expect(rejection?.cmd).toContain('OPENAI_API_KEY=[REDACTED]');
      expect(rejection?.cmd).toContain('CUSTOM_AUTH=[REDACTED]');
      expect(rejection?.cmd).toContain('PROJECT_SECRET=[REDACTED]');
      expect(rejection?.cmd).toContain('DATABASE_URL=[REDACTED]');
      expect(rejection?.cmd).toContain('BASE_BRANCH=main');
      expect(rejection?.spawnargs.join(' ')).toContain('OPENAI_API_KEY=[REDACTED]');
      expect(rejection?.spawnargs.join(' ')).toContain('DATABASE_URL=[REDACTED]');
      expect(rejection?.spawnargs.join(' ')).toContain('BASE_BRANCH=main');

      const durableEventText = JSON.stringify(
        (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls
      );
      const durableMessageText = JSON.stringify(platform.sendMessage.mock.calls);
      const durableLogText = await readFile(join(logDir, `${workflowRun.id}.jsonl`), 'utf-8');
      for (const durableText of [durableEventText, durableMessageText, durableLogText]) {
        expect(durableText).not.toContain(openAiSecret);
        expect(durableText).not.toContain(otherInjectedSecret);
        expect(durableText).not.toContain(projectSecret);
        expect(durableText).not.toContain(databaseUrl);
        expect(durableText).not.toContain(fileDeliveredSecret);
      }
    } finally {
      execSpy.mockRestore();
    }
  });

  it('removes a protected credential echoed by a failed host subprocess', async () => {
    const protectedSecret = 'host-file-delivered-oauth-secret';
    const ambientSecret = 'host-ambient-anthropic-secret';
    const ambientDatabaseUrl = 'postgres://ambient:password@db.internal/archon';
    const originalAmbientSecret = process.env.ANTHROPIC_API_KEY;
    const originalAmbientDatabaseUrl = process.env.DATABASE_URL;
    process.env.ANTHROPIC_API_KEY = ambientSecret;
    process.env.DATABASE_URL = ambientDatabaseUrl;
    const logDir = join(testDir, 'host-logs');
    const workflowRun = makeWorkflowRun('host-redaction-run', {
      workflow_name: 'host-redaction',
      conversation_id: 'conv-host-redaction',
    });
    const store = createMockStore();
    const platform = createMockPlatform();
    let rejection:
      | (Error & { code: number; killed: boolean; cmd: string; stdout: string; stderr: string })
      | undefined;
    const execSpy = spyOnNodeExec().mockImplementation(async (command: string, args: string[]) => {
      const commandLine = [command, ...args].join(' ');
      rejection = Object.assign(
        new Error(
          `Command failed: ${commandLine}\nmessage echoed ${protectedSecret}, ${ambientSecret}, and ${ambientDatabaseUrl}`
        ),
        {
          code: 1,
          killed: false,
          cmd: commandLine,
          stdout: `stdout echoed ${protectedSecret}, ${ambientSecret}, and ${ambientDatabaseUrl}`,
          stderr: `stderr echoed ${protectedSecret}, ${ambientSecret}, and ${ambientDatabaseUrl}`,
        }
      );
      throw rejection;
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform,
          conversationId: workflowRun.conversation_id ?? workflowRun.id,
          cwd: testDir,
          workflow: {
            name: workflowRun.workflow_name,
            nodes: [{ id: 'fail', kind: 'exec', runtime: 'sh', script: 'exit 1' }],
          },
          workflowRun,
          artifactsDir: join(testDir, 'host-artifacts'),
          stateDir: join(testDir, 'host-state'),
          logDir,
          config: {
            ...minimalConfig,
            envVars: { CODEX_HOME: '/run/codex-home', BASE_BRANCH: 'main' },
            protectedEnvKeys: ['CODEX_HOME'],
            protectedCredentialValues: [protectedSecret],
          },
        })
      );

      expect(execSpy).toHaveBeenCalledTimes(1);
      expect(execSpy.mock.calls[0]?.[0]).not.toBe('docker');
      const rejectionText = [
        rejection?.message,
        rejection?.stack,
        rejection?.cmd,
        rejection?.stdout,
        rejection?.stderr,
      ].join('\n');
      expect(rejectionText).not.toContain(protectedSecret);
      expect(rejectionText).not.toContain(ambientSecret);
      expect(rejectionText).not.toContain(ambientDatabaseUrl);

      const durableEventText = JSON.stringify(
        (store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls
      );
      const durableMessageText = JSON.stringify(platform.sendMessage.mock.calls);
      const durableLogText = await readFile(join(logDir, `${workflowRun.id}.jsonl`), 'utf-8');
      for (const durableText of [durableEventText, durableMessageText, durableLogText]) {
        expect(durableText).not.toContain(protectedSecret);
        expect(durableText).not.toContain(ambientSecret);
        expect(durableText).not.toContain(ambientDatabaseUrl);
      }
    } finally {
      execSpy.mockRestore();
      if (originalAmbientSecret === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalAmbientSecret;
      }
      if (originalAmbientDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalAmbientDatabaseUrl;
      }
    }
  });

  it.each([
    [
      'bash',
      'sh',
      `printf 'node output\\n'; printf 'visible before %s visible after\\nsecond unchanged line\\n' "$NODE_SECRET" >&2`,
      'Bash',
    ],
    [
      'script',
      'bun',
      `console.log("node output"); console.error("visible before " + process.env.NODE_SECRET + " visible after\\nsecond unchanged line")`,
      'Script',
    ],
  ] as const)(
    "redacts a successful %s node's stderr broadcast exactly like its retained copy",
    async (_kind, runtime, script, nodeLabel) => {
      const secret = `successful-${runtime}-credential`;
      const nodeId = `${runtime}-leaky-stderr`;
      const workflowRun = makeWorkflowRun(`success-${runtime}-broadcast-redaction`, {
        workflow_name: `success-${runtime}-broadcast-redaction`,
        conversation_id: `conv-success-${runtime}-broadcast-redaction`,
      });
      const platform = createMockPlatform();
      const logDir = join(testDir, `success-${runtime}-broadcast-logs`);

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          conversationId: workflowRun.conversation_id ?? workflowRun.id,
          cwd: testDir,
          workflow: {
            name: workflowRun.workflow_name,
            nodes: [{ id: nodeId, kind: 'exec', runtime, script }],
          },
          workflowRun,
          artifactsDir: join(testDir, `success-${runtime}-broadcast-artifacts`),
          stateDir: join(testDir, `success-${runtime}-broadcast-state`),
          logDir,
          config: {
            ...minimalConfig,
            envVars: { NODE_SECRET: secret, BASE_BRANCH: 'main' },
          },
        })
      );

      const expectedStderr = 'visible before [REDACTED] visible after\nsecond unchanged line';
      const stderrMessages = platform.sendMessage.mock.calls
        .map(([, message]) => message)
        .filter(message => message.includes(`${nodeLabel} node '${nodeId}' stderr:`));
      expect(stderrMessages).toEqual([
        `${nodeLabel} node '${nodeId}' stderr:\n\`\`\`\n${expectedStderr}\n\`\`\``,
      ]);

      const row = (await readTranscript(logDir, workflowRun.id)).find(
        candidate => candidate.type === 'exec_output' && candidate.step === nodeId
      );
      expect(row?.stdout_tail).toBe('node output');
      expect(row?.stderr_tail).toBe(expectedStderr);
    }
  );

  it.each([
    [
      'bash',
      'sh',
      `printf 'failure before %s failure after\\nsecond unchanged failure line\\n' "$NODE_SECRET" >&2; exit 7`,
    ],
    [
      'script',
      'bun',
      `console.error("failure before " + process.env.NODE_SECRET + " failure after\\nsecond unchanged failure line"); process.exit(7)`,
    ],
  ] as const)(
    "keeps a failed %s node's stderr redacted when the workflow broadcasts its error",
    async (_kind, runtime, script) => {
      const secret = `failed-${runtime}-credential`;
      const nodeId = `${runtime}-failed-stderr`;
      const workflowRun = makeWorkflowRun(`failed-${runtime}-broadcast-redaction`, {
        workflow_name: `failed-${runtime}-broadcast-redaction`,
        conversation_id: `conv-failed-${runtime}-broadcast-redaction`,
      });
      const platform = createMockPlatform();
      const logDir = join(testDir, `failed-${runtime}-broadcast-logs`);

      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          platform,
          conversationId: workflowRun.conversation_id ?? workflowRun.id,
          cwd: testDir,
          workflow: {
            name: workflowRun.workflow_name,
            nodes: [
              { id: 'completed-first', kind: 'exec', runtime: 'sh', script: 'true' },
              {
                id: nodeId,
                kind: 'exec',
                runtime,
                script,
                depends_on: ['completed-first'],
              },
            ],
          },
          workflowRun,
          artifactsDir: join(testDir, `failed-${runtime}-broadcast-artifacts`),
          stateDir: join(testDir, `failed-${runtime}-broadcast-state`),
          logDir,
          config: {
            ...minimalConfig,
            envVars: { NODE_SECRET: secret, BASE_BRANCH: 'main' },
          },
        })
      );

      const expectedStderr =
        'failure before [REDACTED] failure after\nsecond unchanged failure line';
      const failureMessage = platform.sendMessage.mock.calls
        .map(([, message]) => message)
        .find(message => message.includes('completed with failures'));
      expect(failureMessage).toContain(expectedStderr);
      expect(JSON.stringify(platform.sendMessage.mock.calls)).not.toContain(secret);

      const row = (await readTranscript(logDir, workflowRun.id)).find(
        candidate => candidate.type === 'exec_output' && candidate.step === nodeId
      );
      expect(row?.stderr_tail).toBe(expectedStderr);
    }
  );

  it('redacts successful subprocess evidence while preserving raw stdout for dependent nodes', async () => {
    // The failure path has been redacting since #2431. Retention (#2967) writes on the
    // success path too, and a node that echoes a token while exiting 0 is the ordinary
    // case (`set -x`, a remote URL, a debug print) — so the evidence copy has to be
    // scrubbed with the SAME credential set, not a weaker one.
    const suffixNamedSecret = 'success-path-openai-secret';
    const explicitlyProtectedSecret = 'success-path-file-delivered-secret';
    const logDir = join(testDir, 'success-redaction-logs');
    const workflowRun = makeWorkflowRun('success-redaction-run', {
      workflow_name: 'success-redaction',
      conversation_id: 'conv-success-redaction',
    });
    const store = createMockStore();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: workflowRun.conversation_id ?? workflowRun.id,
        cwd: testDir,
        workflow: {
          name: workflowRun.workflow_name,
          nodes: [
            {
              id: 'leaky',
              kind: 'exec',
              runtime: 'sh',
              // Real subprocess, both streams, exit 0.
              script: 'printf "%s\\n" "$OPENAI_API_KEY"; printf "%s\\n" "$SIDECAR_AUTH" >&2',
            },
            {
              id: 'consumer',
              kind: 'exec',
              runtime: 'sh',
              script: 'value=$leaky.output; printf "%s" "$value"',
              depends_on: ['leaky'],
            },
          ],
        },
        workflowRun,
        artifactsDir: join(testDir, 'success-redaction-artifacts'),
        stateDir: join(testDir, 'success-redaction-state'),
        logDir,
        config: {
          ...minimalConfig,
          envVars: {
            OPENAI_API_KEY: suffixNamedSecret,
            SIDECAR_AUTH: explicitlyProtectedSecret,
            BASE_BRANCH: 'main',
          },
          protectedCredentialValues: [explicitlyProtectedSecret],
        },
      })
    );

    const transcriptText = await readFile(join(logDir, `${workflowRun.id}.jsonl`), 'utf-8');
    expect(transcriptText).not.toContain(suffixNamedSecret);
    expect(transcriptText).not.toContain(explicitlyProtectedSecret);

    // Not vacuous: the node really ran, really printed both secrets, and the retained
    // row really exists — the values were replaced, not merely absent.
    const row = (await readTranscript(logDir, workflowRun.id)).find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'leaky'
    );
    expect(row?.stdout_tail).toBe('[REDACTED]');
    expect(row?.stderr_tail).toBe('[REDACTED]');

    const stderrMessage = platform.sendMessage.mock.calls
      .map(([, message]) => message)
      .find(message => message.includes("Bash node 'leaky' stderr:"));
    expect(stderrMessage).toBe("Bash node 'leaky' stderr:\n```\n[REDACTED]\n```");

    const consumerEvent = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'consumer'
    );
    expect((consumerEvent?.[0].data as { node_output: string }).node_output).toBe(
      suffixNamedSecret
    );
  });
});

describe('retained exec output', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-retained-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  /** Run one workflow against a fresh log dir and return its parsed transcript. */
  const runAndReadTranscript = async (
    runId: string,
    nodes: DagNode[]
  ): Promise<{
    logDir: string;
    rows: Array<Record<string, unknown>>;
    store: MockWorkflowStore;
  }> => {
    const logDir = join(testDir, `${runId}-logs`);
    const store = createMockStore();
    const workflowRun = makeWorkflowRun(runId);
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-retained',
        cwd: testDir,
        workflow: { name: runId, nodes },
        workflowRun,
        artifactsDir: join(testDir, `${runId}-artifacts`),
        stateDir: join(testDir, `${runId}-state`),
        logDir,
      })
    );
    return { logDir, rows: await readTranscript(logDir, workflowRun.id), store };
  };

  it('retains stdout and stderr as SEPARATE fields on a successful exec node', async () => {
    const { rows } = await runAndReadTranscript('retain-success', [
      {
        id: 'work',
        kind: 'exec',
        runtime: 'sh',
        script: 'printf "did the thing\\n"; printf "a warning\\n" >&2',
      },
    ]);

    const row = rows.find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'work'
    );
    expect(row).toBeDefined();
    expect(row?.content).toBe('<bash>');
    expect(row?.exit_code).toBe(0);
    // Separate, not merged: merging stderr into stdout is how a `git` warning becomes
    // the value a node returns — the bug #2967 exists to stop every node re-earning.
    expect(row?.stdout_tail).toBe('did the thing');
    expect(row?.stderr_tail).toBe('a warning');
  });

  it('retains the same evidence when the node FAILS, with its exit code', async () => {
    const { rows } = await runAndReadTranscript('retain-failure', [
      {
        id: 'work',
        kind: 'exec',
        runtime: 'sh',
        script: 'printf "got this far\\n"; printf "then broke\\n" >&2; exit 3',
      },
    ]);

    const row = rows.find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'work'
    );
    expect(row?.exit_code).toBe(3);
    expect(row?.stdout_tail).toBe('got this far');
    expect(row?.stderr_tail).toBe('then broke');
    // Symmetry is the point: the same row shape on both outcomes, next to the
    // lifecycle row that says which outcome it was.
    expect(
      rows.some(candidate => candidate.type === 'node_error' && candidate.step === 'work')
    ).toBe(true);
  });

  it('writes a row for a silent node, so an absent tail means "printed nothing"', async () => {
    const { rows } = await runAndReadTranscript('retain-silent', [
      { id: 'quiet', kind: 'exec', runtime: 'sh', script: 'true' },
    ]);

    const row = rows.find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'quiet'
    );
    expect(row).toBeDefined();
    expect(row?.exit_code).toBe(0);
    expect(row?.stdout_tail).toBeUndefined();
    expect(row?.stderr_tail).toBeUndefined();
  });

  it('caps each retained stream while the $node.output value channel stays complete', async () => {
    // The binding invariant: retention caps the EVIDENCE copy only. A node's output is
    // its contract with its consumers, and it must still arrive whole — well past both
    // the 2000-char retention budget and the 32KB persistence preview.
    const paddingBytes = 40_000;
    const { rows, store } = await runAndReadTranscript('retain-cap', [
      {
        id: 'producer',
        kind: 'exec',
        runtime: 'sh',
        script: `printf 'HEAD'; printf '%${String(paddingBytes)}s' '' | tr ' ' x; printf 'TAIL'`,
      },
      {
        id: 'consumer',
        kind: 'exec',
        runtime: 'sh',
        script: 'value=$producer.output; printf "%s" "${#value}"',
        depends_on: ['producer'],
      },
    ]);

    const producerRow = rows.find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'producer'
    );
    const stdoutTail = producerRow?.stdout_tail as string;
    // Tail-preserving and marked, so a reader can tell truncation from absence.
    expect(stdoutTail.startsWith('…[truncated to last 2000 chars]\n')).toBe(true);
    expect(stdoutTail.endsWith('TAIL')).toBe(true);
    expect(stdoutTail).not.toContain('HEAD');
    expect(stdoutTail.split('\n')[1].length).toBe(2000);

    // The value channel is untouched: the downstream consumer measured the WHOLE
    // 40,008-character output, not the 2000-char evidence tail nor a 32KB preview.
    const consumerEvent = (
      store.createWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>
    ).mock.calls.find(
      ([event]) => event.event_type === 'node_completed' && event.step_name === 'consumer'
    );
    expect((consumerEvent?.[0].data as { node_output: string }).node_output).toBe(
      String(paddingBytes + 8)
    );
  });

  it('retains an until_bash probe per iteration it runs in', async () => {
    // The probe is exactly the case the hand-rolled substitute could not cover: a
    // non-zero exit is TOLERATED ("not done yet"), so nothing else in the run records
    // why the loop kept going.
    const logDir = join(testDir, 'until-bash-logs');
    const counterPath = join(testDir, 'iterations');
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'working' };
      yield { type: 'result', sessionId: 's-1' };
    });
    const workflowRun = makeWorkflowRun('retain-until-bash');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-retained-probe',
        cwd: testDir,
        workflow: {
          name: 'retain-until-bash',
          nodes: [
            {
              id: 'poll',
              kind: 'loop',
              loop: {
                fresh_context: false,
                prompt: 'Keep working.',
                max_iterations: 2,
                // Iteration 1 prints and exits 1 (keep looping); iteration 2 exits 0.
                until_bash: `printf 'x' >> ${JSON.stringify(counterPath)}; printf 'checked\\n'; printf 'not ready\\n' >&2; test "$(wc -c < ${JSON.stringify(counterPath)} | tr -d ' ')" -ge 2`,
              },
            },
          ],
        },
        workflowRun,
        artifactsDir: join(testDir, 'until-bash-artifacts'),
        stateDir: join(testDir, 'until-bash-state'),
        logDir,
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const probeRows = rows.filter(candidate => candidate.type === 'exec_output');
    expect(probeRows.map(row => row.step)).toEqual(['poll-iteration-1', 'poll-iteration-2']);
    for (const row of probeRows) {
      expect(row.content).toBe('<until_bash>');
      expect(row.stdout_tail).toBe('checked');
      expect(row.stderr_tail).toBe('not ready');
    }
    // The tolerated non-zero exit is retained as such, not flattened into the success
    // shape — that difference IS the answer to "why did the loop run again?".
    expect(probeRows[0].exit_code).toBe(1);
    expect(probeRows[1].exit_code).toBe(0);
  });

  it("labels a script node's retained evidence as <script>, not <bash>", async () => {
    // Same seat, different node executor. The label is what tells a reader which
    // executor produced the row, so a copy-paste of the wrong constant is the failure
    // this catches.
    const { rows } = await runAndReadTranscript('retain-script', [
      {
        id: 'measure',
        kind: 'exec',
        runtime: 'bun',
        script: 'console.log("from bun"); console.error("bun warning");',
      },
    ]);

    const row = rows.find(
      candidate => candidate.type === 'exec_output' && candidate.step === 'measure'
    );
    expect(row?.content).toBe('<script>');
    expect(row?.exit_code).toBe(0);
    expect(row?.stdout_tail).toBe('from bun');
    expect(row?.stderr_tail).toBe('bun warning');
  });

  it("retains a loop_group's until_bash probe under the group's own iteration key", async () => {
    // loop_group resolves its own probe at a different call site than `loop:`, with its
    // own iteration variable — a site that writes no per-iteration transcript row of any
    // other kind, so this row is the only per-iteration evidence the group produces.
    const logDir = join(testDir, 'group-probe-logs');
    const counterPath = join(testDir, 'group-iterations');
    const workflowRun = makeWorkflowRun('retain-group-probe');

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        conversationId: 'conv-group-probe',
        cwd: testDir,
        workflow: {
          name: 'retain-group-probe',
          nodes: [
            {
              id: 'group',
              kind: 'loop_group',
              loop_group: {
                max_iterations: 2,
                fresh_context: false,
                until_bash: `printf 'x' >> ${JSON.stringify(counterPath)}; printf 'probe spoke\\n'; test "$(wc -c < ${JSON.stringify(counterPath)} | tr -d ' ')" -ge 2`,
                nodes: [
                  {
                    id: 'body',
                    kind: 'exec',
                    runtime: 'sh',
                    script: 'printf body',
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
          ],
        },
        workflowRun,
        artifactsDir: join(testDir, 'group-probe-artifacts'),
        stateDir: join(testDir, 'group-probe-state'),
        logDir,
      })
    );

    const rows = await readTranscript(logDir, workflowRun.id);
    const probeRows = rows.filter(
      candidate => candidate.type === 'exec_output' && candidate.content === '<until_bash>'
    );
    expect(probeRows.map(row => row.step)).toEqual(['group-iteration-1', 'group-iteration-2']);
    expect(probeRows.map(row => row.exit_code)).toEqual([1, 0]);
    for (const row of probeRows) expect(row.stdout_tail).toBe('probe spoke');

    // The group's body node is retained too, under its own bare id.
    expect(
      rows.filter(candidate => candidate.type === 'exec_output' && candidate.step === 'body')
    ).toHaveLength(2);
  });

  it('names the signal when a timed-out subprocess reports no exit code', async () => {
    // Node reports a timeout kill as `code: null` with the signal set. Falling back
    // straight to 'unknown' would erase the most operationally interesting failure —
    // and an `until_bash` probe has no sibling node_error row to say it timed out.
    const execSpy = spyOnNodeExec().mockImplementation(async () => {
      throw Object.assign(new Error('Command failed: bash -c sleep 999'), {
        code: null,
        signal: 'SIGTERM',
        killed: true,
        stdout: 'started work',
        stderr: '',
      });
    });

    try {
      const { rows } = await runAndReadTranscript('retain-timeout', [
        { id: 'slow', kind: 'exec', runtime: 'sh', script: 'sleep 999' },
      ]);
      const row = rows.find(
        candidate => candidate.type === 'exec_output' && candidate.step === 'slow'
      );
      expect(row?.exit_code).toBe('SIGTERM');
      expect(row?.stdout_tail).toBe('started work');
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe('exec result contracts (#2453)', () => {
  let testDir: string;

  type PersistedEvent = {
    event_type: string;
    step_name?: string;
    data?: Record<string, unknown>;
  };

  const RESULT = { ready: true, units: ['a', 'b'] };
  const RESULT_SCHEMA = {
    type: 'object',
    properties: { ready: { type: 'boolean' }, units: { type: 'array' } },
    required: ['ready', 'units'],
  };
  const RESULT_JSON = JSON.stringify(RESULT);

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `dag-exec-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
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

  /** Captures every consumer prompt so the downstream view of the certified value is observable. */
  function captureConsumerPrompts(into: string[]): void {
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      into.push(prompt);
      yield { type: 'agent_message_chunk', text: 'consumer done' };
      yield { type: 'result', sessionId: 'sid-cons' };
    });
  }

  async function runDag(
    workflow: WorkflowDefinition,
    runId: string,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<PersistedEvent[]> {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-2453',
        cwd: testDir,
        workflow,
        workflowRun: makeWorkflowRun(runId),
        ...(priorCompletedNodes !== undefined ? { priorCompletedNodes } : {}),
      })
    );
    return (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
  }

  /** producer (bash or script, emitting `stdout`) → consumer prompt reading `refs`. */
  function contractWorkflow(
    producer: Record<string, unknown>,
    refs = 'ready=[$producer.output.ready] units=[$producer.output.units] whole=[$producer.output]'
  ): WorkflowDefinition {
    return {
      name: 'exec-contract',
      description: 'a deterministic producer certifying its own result',
      nodes: [
        dagNodeSchema.parse({ id: 'producer', output_format: RESULT_SCHEMA, ...producer }),
        dagNodeSchema.parse({ id: 'consumer', prompt: refs, depends_on: ['producer'] }),
      ],
    };
  }

  // Single-quoted so the JSON's double quotes reach printf untouched; no fixture below
  // contains a single quote.
  const bashEmitting = (stdout: string): Record<string, unknown> => ({
    bash: `printf '%s' '${stdout}'`,
  });
  const scriptEmitting = (stdout: string): Record<string, unknown> => ({
    runtime: 'bun',
    script: `process.stdout.write(${JSON.stringify(stdout)});`,
  });

  const producerCompletion = (events: PersistedEvent[]): PersistedEvent | undefined =>
    events.find(e => e.event_type === 'node_completed' && e.step_name === 'producer');
  const producerFailure = (events: PersistedEvent[]): PersistedEvent | undefined =>
    events.find(e => e.event_type === 'node_failed' && e.step_name === 'producer');

  it.each([
    ['bash', bashEmitting],
    ['script', scriptEmitting],
  ] as const)(
    'a %s node certifies its stdout: canonical text, logical value, and strict field access',
    async (kind, emitting) => {
      const prompts: string[] = [];
      captureConsumerPrompts(prompts);

      // Padding whitespace proves the certified text is the canonical document, not raw stdout.
      const events = await runDag(
        contractWorkflow(emitting(`  ${RESULT_JSON}  `)),
        `contract-fresh-${kind}`
      );

      const completed = producerCompletion(events);
      expect(completed?.data?.structured_output).toEqual(RESULT);
      expect(String(completed?.data?.node_output)).toBe(RESULT_JSON);
      expect(prompts).toEqual([`ready=[true] units=[["a","b"]] whole=[${RESULT_JSON}]`]);
    }
  );

  it.each([
    ['bash', bashEmitting],
    ['script', scriptEmitting],
  ] as const)('a %s node emitting non-JSON stdout fails the node', async (kind, emitting) => {
    const prompts: string[] = [];
    captureConsumerPrompts(prompts);

    const events = await runDag(
      contractWorkflow(emitting('not json at all')),
      `contract-nonjson-${kind}`
    );

    const failed = producerFailure(events);
    expect(producerCompletion(events)).toBeUndefined();
    const error = String((failed?.data as { error?: string } | undefined)?.error);
    expect(error).toContain("node 'producer'");
    expect(error).toContain('must be a single JSON document');
    expect(error).toContain('not json at all');
    // The consumer depends on a failed producer, so it never runs.
    expect(prompts).toEqual([]);
  });

  it.each([
    ['bash', bashEmitting],
    ['script', scriptEmitting],
  ] as const)('a %s node whose JSON misses the schema fails the node', async (kind, emitting) => {
    const prompts: string[] = [];
    captureConsumerPrompts(prompts);

    const events = await runDag(
      contractWorkflow(emitting('{"ready":"yes"}')),
      `contract-mismatch-${kind}`
    );

    expect(producerCompletion(events)).toBeUndefined();
    const error = String((producerFailure(events)?.data as { error?: string } | undefined)?.error);
    expect(error).toContain('did not satisfy its declared output_format');
    // Both ajv failures are named: the wrong type AND the missing required field.
    expect(error).toContain('/ready');
    expect(error).toContain('units');
    expect(prompts).toEqual([]);
  });

  it('a stdout excerpt that mentions a timeout is still reported as a contract failure', async () => {
    const events = await runDag(
      contractWorkflow(bashEmitting('the job timed out')),
      'contract-timeout-lookalike'
    );
    const error = String((producerFailure(events)?.data as { error?: string } | undefined)?.error);
    expect(error).toContain('must be a single JSON document');
    expect(error).not.toContain('timed out after');
  });

  it('a contract failure is never retried, even under on_error: all', async () => {
    // The failure text quotes stdout, and stdout is whatever the script printed, so the
    // retry loop must not classify it: a transient-looking excerpt would re-run a script
    // whose stdout is deterministically wrong. The producer says so in the type instead.
    const attempts = join(testDir, 'contract-attempts.log').replace(/\\/g, '/');
    const events = await runDag(
      contractWorkflow({
        bash: `printf 'a' >> '${attempts}'; printf '%s' 'rate limit exceeded, timed out'`,
        // delay_ms sits at the schema minimum; it never elapses because no retry happens.
        retry: { max_attempts: 2, delay_ms: 1000, on_error: 'all' },
      }),
      'contract-no-retry'
    );

    expect(producerCompletion(events)).toBeUndefined();
    const error = String((producerFailure(events)?.data as { error?: string } | undefined)?.error);
    expect(error).toContain('must be a single JSON document');
    // on_error: all with max_attempts: 2 would otherwise run three times.
    expect((await readFile(attempts, 'utf8')).length).toBe(1);
  });

  it('a contract failure quotes stdout with credentials redacted', async () => {
    // The preview lands in node_failed.data.error, the one place a contract failure copies
    // stdout verbatim. It must redact against the same set the subprocess runner resolved.
    const secret = 'contract-preview-secret-value';
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowRun: makeWorkflowRun('contract-redaction'),
        workflow: {
          name: 'contract-redaction',
          nodes: [
            dagNodeSchema.parse({
              id: 'producer',
              output_format: RESULT_SCHEMA,
              bash: `printf '%s' 'token=${secret} and more text'`,
            }),
          ],
        },
        config: { ...minimalConfig, protectedCredentialValues: [secret] },
      })
    );
    const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      (call: unknown[]) => call[0] as PersistedEvent
    );
    const error = String((producerFailure(events)?.data as { error?: string } | undefined)?.error);
    expect(error).toContain('must be a single JSON document');
    expect(error).toContain('[REDACTED]');
    expect(error).not.toContain(secret);
  });

  it.each([
    ['bash', bashEmitting],
    ['script', scriptEmitting],
  ] as const)(
    'a %s contract failure redacts credentials quoted by the JSON parser',
    async (kind, emitting) => {
      const secret = 'SECRET_TOKEN_123';
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun(`contract-parser-redaction-${kind}`),
          workflow: contractWorkflow(emitting(`{"key":${secret}}`)),
          config: { ...minimalConfig, protectedCredentialValues: [secret] },
        })
      );
      const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
        (call: unknown[]) => call[0] as PersistedEvent
      );
      const error = String(producerFailure(events)?.data?.error);
      expect(error).toContain('must be a single JSON document');
      expect(error).toContain('[REDACTED]');
      expect(error).not.toContain(secret);
      expect(producerCompletion(events)).toBeUndefined();
      expect(mockSendQueryDag).not.toHaveBeenCalled();
    }
  );

  it.each(
    (
      [
        ['bash', bashEmitting],
        ['script', scriptEmitting],
      ] as const
    ).flatMap(([kind, emitting]) =>
      [
        ['SCHEMA_PATH_SECRET_123', 'SCHEMA_PATH_SECRET_123'],
        ['SCHEMA/PATH_SECRET_123', 'SCHEMA~1PATH_SECRET_123'],
        ['SCHEMA~PATH_SECRET_123', 'SCHEMA~0PATH_SECRET_123'],
        ['SCHEMA/PATH~SECRET_123', 'SCHEMA~1PATH~0SECRET_123'],
      ].map(([secret, pointerSecret]) => [kind, secret, pointerSecret, emitting] as const)
    )
  )(
    'a %s contract failure redacts credential %s in schema-error paths',
    async (kind, secret, pointerSecret, emitting) => {
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun(`contract-schema-redaction-${kind}`),
          workflow: contractWorkflow({
            ...emitting(JSON.stringify({ [secret]: 'invalid' })),
            output_format: { type: 'object', additionalProperties: { type: 'integer' } },
          }),
          config: { ...minimalConfig, protectedCredentialValues: [secret] },
        })
      );
      const events = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
        (call: unknown[]) => call[0] as PersistedEvent
      );
      const error = String(producerFailure(events)?.data?.error);
      expect(error).toContain('did not satisfy its declared output_format');
      expect(error).toContain('/[REDACTED]: must be integer');
      expect(error).not.toContain(secret);
      expect(error).not.toContain(pointerSecret);
      expect(producerCompletion(events)).toBeUndefined();
      expect(mockSendQueryDag).not.toHaveBeenCalled();
    }
  );

  it('a certified exec value survives cold resume identically', async () => {
    const freshPrompts: string[] = [];
    captureConsumerPrompts(freshPrompts);
    const fresh = await runDag(
      contractWorkflow(bashEmitting(RESULT_JSON)),
      'contract-resume-fresh'
    );
    const completed = producerCompletion(fresh);

    const resumedPrompts: string[] = [];
    captureConsumerPrompts(resumedPrompts);
    const resumed = await runDag(
      contractWorkflow(bashEmitting(RESULT_JSON)),
      'contract-resume-resumed',
      new Map<string, PersistedNodeOutput>([
        [
          'producer',
          {
            output: String(completed?.data?.node_output),
            structuredOutput: completed?.data?.structured_output,
          },
        ],
      ])
    );

    expect(resumedPrompts).toEqual(freshPrompts);
    // The re-emit copies the logical value forward so a SECOND resume still sees it.
    const replayed = resumed.find(e => e.event_type === 'node_skipped_prior_success');
    expect(replayed?.data?.structured_output).toEqual(RESULT);
  });

  it('a resumed contracted producer still rejects a field it never declared', async () => {
    // declaredFields is re-derived from the loaded definition on resume, so the typo
    // strictness a live run has must not degrade to the lenient schemaless branch.
    const prompts: string[] = [];
    captureConsumerPrompts(prompts);
    const events = await runDag(
      contractWorkflow(bashEmitting(RESULT_JSON), 'typo=[$producer.output.redy]'),
      'contract-resume-typo',
      new Map<string, PersistedNodeOutput>([
        ['producer', { output: RESULT_JSON, structuredOutput: RESULT }],
      ])
    );

    const consumerFailed = events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'consumer'
    );
    expect(String((consumerFailed?.data as { error?: string } | undefined)?.error)).toContain(
      'redy'
    );
    expect(prompts).toEqual([]);
  });

  it('a schemaless exec node still returns raw text and persists no logical value', async () => {
    const prompts: string[] = [];
    captureConsumerPrompts(prompts);

    const events = await runDag(
      {
        name: 'exec-schemaless',
        description: 'no declared contract, byte-identical behavior',
        nodes: [
          dagNodeSchema.parse({ id: 'producer', bash: "printf '%s' '  not json  '" }),
          dagNodeSchema.parse({
            id: 'consumer',
            prompt: 'raw=[$producer.output]',
            depends_on: ['producer'],
          }),
        ],
      },
      'contract-schemaless'
    );

    const completed = producerCompletion(events);
    expect(completed?.data?.structured_output).toBeUndefined();
    expect(String(completed?.data?.node_output)).toBe('  not json  ');
    expect(prompts).toEqual(['raw=[  not json  ]']);
  });
});
