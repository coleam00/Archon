// @archon-test-isolated
import { describe, expect, test, spyOn } from 'bun:test';
import * as git from '@archon/git';
import { applyRunEnvironment } from './run-preflight';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { EXEC_NODE_ENVIRONMENT_NAMES } from './exec-environment';
import { join, sep } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';
import { inputEnvKey } from './schemas/node-bindings';

const { temporaryDirectory } = useDryRunFiles();

describe('dry-run code execution', () => {
  test('executes bash only with execCode and captures failures', async () => {
    const success = makeTestWorkflow({
      name: 'bash-ok',
      nodes: [{ id: 'code', bash: 'printf hello' }],
    });
    const successResult = await dryRunWorkflow({
      workflow: success,
      execCode: true,
    });
    expect(successResult).toMatchObject({ outcome: 'completed', summary: 'hello' });
    expect(successResult.trace[0]).toMatchObject({
      state: 'completed',
      reason: 'executed locally',
    });

    const failure = makeTestWorkflow({
      name: 'bash-fail',
      nodes: [{ id: 'code', bash: 'echo nope >&2; exit 7' }],
    });
    const failureResult = await dryRunWorkflow({
      workflow: failure,
      execCode: true,
    });
    expect(failureResult.outcome).toBe('failed');
    expect(failureResult.trace[0]).toMatchObject({
      state: 'failed',
      reason: "Bash node 'code' failed [exit 7]: nope",
    });
  });

  test.each([
    ['stdout only', 'printf stdout-tail', 'stdout-tail'],
    ['both streams', 'printf stdout-tail; printf stderr-tail >&2', 'stderr-tail'],
  ])('reports sanitized bash failures with %s', async (_name, output, diagnostic) => {
    const code = `# inline-body-marker\n${output}; exit 7`;
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({ name: 'bash-diagnostic', nodes: [{ id: 'code', bash: code }] }),
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.state).toBe('failed');
    const reason = result.trace[0]?.reason;
    expect(reason).toContain('stdout-tail');
    expect(reason).toContain(diagnostic);
    expect(reason).toContain('[exit 7]');
    expect(reason).not.toContain('inline-body-marker');
    expect(reason).not.toContain('Command failed:');
  });

  test('reports sanitized inline script failures with capped stream tails', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'script-diagnostic',
        nodes: [
          {
            id: 'code',
            runtime: 'bun',
            script: `// inline-body-marker
console.log('x'.repeat(5000) + 'stdout-tail');
console.error('y'.repeat(5000) + 'stderr-tail');
process.exit(9);`,
          },
        ],
      }),
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.state).toBe('failed');
    const reason = result.trace[0]?.reason;
    expect(reason).toContain("Script node 'code' failed [exit 9]");
    expect(reason).toContain('[stdout]');
    expect(reason).toContain('stdout-tail');
    expect(reason).toContain('[stderr]');
    expect(reason).toContain('stderr-tail');
    expect(reason).not.toContain('inline-body-marker');
    expect(reason).not.toContain('Command failed:');
    expect(reason?.length).toBeLessThan(2100);
  });

  test.each([
    ['silent Bash', 'sh', '# inline-body-marker\nexit 7'],
    ['whitespace Bash', 'sh', '# inline-body-marker\nprintf " "; exit 7'],
    ['silent Bun', 'bun', '// inline-body-marker\nprocess.exit(7);'],
    ['whitespace Bun', 'bun', '// inline-body-marker\nconsole.log(" "); process.exit(7);'],
    ['silent Python', 'uv', '# inline-body-marker\nimport sys\nsys.exit(7)'],
    ['whitespace Python', 'uv', '# inline-body-marker\nimport sys\nprint(" "); sys.exit(7)'],
  ] as const)('reports no diagnostic output for %s', async (_name, runtime, script) => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'silent-script',
        nodes: [{ id: 'code', ...(runtime === 'sh' ? { bash: script } : { runtime, script }) }],
      }),
      config: {
        assistant: undefined,
        assistants: { claude: {}, codex: {} },
        commands: {},
        protectedCredentialValues: ['failed'],
      },
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]).toMatchObject({
      state: 'failed',
      reason: `${runtime === 'sh' ? 'Bash' : 'Script'} node 'code' failed [exit 7]: no diagnostic output`,
    });
  });

  test.each(['bun', 'uv'] as const)(
    'suppresses the named %s invocation after redaction',
    async runtime => {
      const cwd = temporaryDirectory();
      const dir = join(cwd, '.archon', 'scripts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, runtime === 'bun' ? 'silent.ts' : 'silent.py'),
        runtime === 'bun'
          ? '// private-body\nprocess.exit(7);'
          : '# private-body\nimport sys\nsys.exit(7)'
      );
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'silent-named',
          nodes: [{ id: 'code', runtime, script: 'silent' }],
        }),
        cwd,
        config: {
          assistant: undefined,
          assistants: { claude: {}, codex: {} },
          commands: {},
          protectedCredentialValues: ['failed'],
        },
        execCode: true,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toBe(
        "Script node 'code' failed [exit 7]: no diagnostic output"
      );
    }
  );

  test.each([
    ['sh', 'ENOENT', 'bash executable not found'],
    ['sh', 'ENOTDIR', 'bash executable not found'],
    ['sh', 'EACCES', 'permission denied'],
    ['bun', 'ENOENT', "'bun' executable not found in PATH"],
    ['bun', 'EACCES', 'permission denied'],
    ['uv', 'ENOENT', "'uv' executable not found in PATH"],
    ['uv', 'EACCES', 'permission denied'],
  ] as const)('classifies %s spawn %s', async (runtime, code, diagnostic) => {
    const spawn = spyOn(git, 'execFileAsync').mockRejectedValueOnce(
      Object.assign(new Error('spawn failure'), { code })
    );
    try {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'spawn-error',
          nodes: [
            {
              id: 'code',
              ...(runtime === 'sh' ? { bash: 'exit 7' } : { runtime, script: 'exit(7);' }),
            },
          ],
        }),
        execCode: true,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain(diagnostic);
      expect(result.trace[0]?.reason).not.toContain('[exit');
    } finally {
      spawn.mockRestore();
    }
  });

  test('reports a missing script runtime as a spawn failure', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'missing-runtime',
        nodes: [{ id: 'code', runtime: 'bun', script: 'process.exit(7);' }],
      }),
      config: {
        assistant: undefined,
        assistants: { claude: {}, codex: {} },
        commands: {},
        envVars: { PATH: '' },
      },
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.reason).toBe(
      "Script node 'code' failed: 'bun' executable not found in PATH"
    );
  });

  test('reports a timeout even when the subprocess wrote diagnostics', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'timeout-diagnostic',
        nodes: [{ id: 'code', bash: 'printf waiting; while :; do :; done', timeout: 100 }],
      }),
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]).toMatchObject({
      state: 'failed',
      reason: "Bash node 'code' timed out after 100ms",
    });
  });

  test('reports subprocess self-termination with the platform exit semantics', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'signal-diagnostic',
        nodes: [{ id: 'code', runtime: 'bun', script: 'process.kill(process.pid, "SIGTERM");' }],
      }),
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.state).toBe('failed');
    expect(result.trace[0]?.reason).toBe(
      process.platform === 'win32'
        ? "Script node 'code' failed [exit 1]: no diagnostic output"
        : "Script node 'code' failed: no diagnostic output [signal SIGTERM]"
    );
  });

  test.each([
    [null, 'SIGTERM', "Script node 'code' failed: no diagnostic output [signal SIGTERM]"],
    [1, null, "Script node 'code' failed [exit 1]: no diagnostic output"],
  ] as const)('reports termination code %s and signal %s', async (code, signal, reason) => {
    const script = 'process.kill(process.pid, "SIGTERM");';
    const spawn = spyOn(git, 'execFileAsync').mockRejectedValueOnce(
      Object.assign(new Error(`Command failed: bun -e ${script}`), {
        code,
        signal,
        stdout: '',
        stderr: '',
      })
    );
    try {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'termination-diagnostic',
          nodes: [{ id: 'code', runtime: 'bun', script }],
        }),
        execCode: true,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]).toMatchObject({ state: 'failed', reason });
    } finally {
      spawn.mockRestore();
    }
  });

  test('executable bash dry runs reject NUL without executing a prefix', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'nul-bash',
        nodes: [{ id: 'code', bash: "printf before # '\0'\nexit 7" }],
      }),
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]).toMatchObject({
      state: 'failed',
      reason: 'Bash source cannot contain NUL bytes',
    });
  });

  test('executable bash dry runs deliver large inline values and stdin EOF', async () => {
    const value = '€'.repeat(32_000);
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'large-bash',
        nodes: [
          { id: 'producer', prompt: 'produce' },
          {
            id: 'consumer',
            depends_on: ['producer'],
            bash: 'a=$producer.output; b=$producer.output; if IFS= read -r line; then exit 8; fi; printf \'%s%s\' "$a" "$b"',
          },
        ],
      }),
      execCode: true,
      stubs: { producer: value },
    });
    expect(result.outcome).toBe('completed');
    expect(result.summary).toBe(value + value);
  });

  test.each(['bash', 'script'] as const)(
    'delivers configured env with input and engine precedence to failed %s nodes',
    async kind => {
      expect(process.env.ARCHON_CONFIGURED_DIAGNOSTIC).toBeUndefined();
      const previous = process.env.ARCHON_ENV_PRECEDENCE;
      process.env.ARCHON_ENV_PRECEDENCE = 'host-value';
      try {
        const result = await dryRunWorkflow({
          workflow: makeTestWorkflow({
            name: 'configured-env',
            inputs: { value: { required: true } },
            nodes: [
              {
                id: 'code',
                ...(kind === 'bash'
                  ? {
                      bash: 'printf "stdout: %s %s %s %s" "$ARCHON_CONFIGURED_DIAGNOSTIC" "$ARCHON_ENV_PRECEDENCE" "$INPUTS_VALUE" "$WORKFLOW_ID"; printf "stderr: %s" "$ARCHON_CONFIGURED_DIAGNOSTIC" >&2; exit 7',
                    }
                  : {
                      runtime: 'bun',
                      script:
                        'console.log("stdout:", process.env.ARCHON_CONFIGURED_DIAGNOSTIC, process.env.ARCHON_ENV_PRECEDENCE, process.env.INPUTS_VALUE, process.env.WORKFLOW_ID); console.error("stderr:", process.env.ARCHON_CONFIGURED_DIAGNOSTIC); process.exit(7);',
                    }),
              },
            ],
          }),
          inputs: { value: 'input-value' },
          config: {
            assistant: undefined,
            assistants: { claude: {}, codex: {} },
            commands: {},
            envVars: {
              ARCHON_CONFIGURED_DIAGNOSTIC: 'configured-value',
              ARCHON_ENV_PRECEDENCE: 'project-value',
              INPUTS_VALUE: 'shadowed-input',
              WORKFLOW_ID: 'shadowed-engine',
            },
          },
          execCode: true,
        });
        expect(result.outcome).toBe('failed');
        expect(result.trace[0]).toMatchObject({ state: 'failed' });
        expect(result.trace[0]?.reason).toContain('[exit 7]');
        expect(result.trace[0]?.reason).toContain(
          'stdout: configured-value project-value input-value dry-run'
        );
        expect(result.trace[0]?.reason).toContain('stderr: configured-value');
      } finally {
        if (previous === undefined) delete process.env.ARCHON_ENV_PRECEDENCE;
        else process.env.ARCHON_ENV_PRECEDENCE = previous;
      }
    }
  );

  test('redacts declared token inputs from failed subprocess diagnostics', async () => {
    const secret = 'synthetic-input-credential-4353';
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'input-credential',
        inputs: { token: { required: true } },
        nodes: [{ id: 'code', bash: 'printf "%s" "$INPUTS_TOKEN"; exit 7' }],
      }),
      inputs: { token: secret },
      execCode: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]).toMatchObject({ state: 'failed' });
    expect(result.trace[0]?.reason).toContain('[exit 7]');
    expect(result.trace[0]?.reason).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test.each(['bash', 'script'] as const)(
    'redacts configured protected credentials from failed %s diagnostics',
    async kind => {
      const protectedValue = 'synthetic-protected-env-4353';
      const explicitValue = 'synthetic-explicit-value-4353';
      const previous = process.env.ARCHON_DIAGNOSTIC_ACCOUNT;
      delete process.env.ARCHON_DIAGNOSTIC_ACCOUNT;
      try {
        const result = await dryRunWorkflow({
          workflow: makeTestWorkflow({
            name: 'protected-credentials',
            inputs: { value: { required: true } },
            nodes: [
              {
                id: 'code',
                ...(kind === 'bash'
                  ? {
                      bash: 'printf "stdout: %s %s" "$ARCHON_DIAGNOSTIC_ACCOUNT" "$INPUTS_VALUE"; printf "stderr: %s %s" "$ARCHON_DIAGNOSTIC_ACCOUNT" "$INPUTS_VALUE" >&2; exit 7',
                    }
                  : {
                      runtime: 'bun',
                      script:
                        'console.log("stdout:", process.env.ARCHON_DIAGNOSTIC_ACCOUNT, process.env.INPUTS_VALUE); console.error("stderr:", process.env.ARCHON_DIAGNOSTIC_ACCOUNT, process.env.INPUTS_VALUE); process.exit(7);',
                    }),
              },
            ],
          }),
          inputs: { value: explicitValue },
          config: applyRunEnvironment(
            {
              assistant: undefined,
              assistants: { claude: {}, codex: {} },
              commands: {},
              protectedCredentialValues: [explicitValue],
            },
            { ARCHON_DIAGNOSTIC_ACCOUNT: protectedValue }
          ),
          execCode: true,
        });
        expect(result.outcome).toBe('failed');
        expect(result.trace[0]).toMatchObject({ state: 'failed' });
        expect(result.trace[0]?.reason).toContain('[exit 7]');
        expect(result.trace[0]?.reason).toContain('stdout: [REDACTED] [REDACTED]');
        expect(result.trace[0]?.reason).toContain('stderr: [REDACTED] [REDACTED]');
        expect(JSON.stringify(result)).not.toContain(protectedValue);
        expect(JSON.stringify(result)).not.toContain(explicitValue);
      } finally {
        if (previous === undefined) delete process.env.ARCHON_DIAGNOSTIC_ACCOUNT;
        else process.env.ARCHON_DIAGNOSTIC_ACCOUNT = previous;
      }
    }
  );

  test('redacts inherited credentials from output-contract diagnostics', async () => {
    const secret = 'synthetic-contract-credential-4353';
    const previous = process.env.ARCHON_DRY_RUN_TEST_SECRET;
    process.env.ARCHON_DRY_RUN_TEST_SECRET = secret;
    try {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'credential-contract',
          nodes: [
            {
              id: 'code',
              bash: 'printf "%s" "$ARCHON_DRY_RUN_TEST_SECRET"',
              output_format: { type: 'object' },
            },
          ],
        }),
        execCode: true,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain('must be a single JSON document');
      expect(result.trace[0]?.reason).toContain('[REDACTED]');
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.ARCHON_DRY_RUN_TEST_SECRET;
      else process.env.ARCHON_DRY_RUN_TEST_SECRET = previous;
    }
  });

  test('an executed code node is held to its output_format like a real run', async () => {
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    } as const;
    const run = (stdout: string) =>
      dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'exec-contract',
          nodes: [
            { id: 'code', bash: `printf '%s' '${stdout}'`, output_format: okSchema },
            { id: 'next', depends_on: ['code'], bash: 'echo "$code_ok"' },
          ],
        }),
        execCode: true,
        stubs: { next: 'done' },
      });

    const bad = await run('{"ok":"yes"}');
    expect(bad.outcome).toBe('failed');
    expect(bad.trace[0]).toMatchObject({ state: 'failed' });
    expect(bad.trace[0]?.reason).toContain("Bash node 'code'");
    expect(bad.trace[0]?.reason).toContain('did not satisfy its declared output_format');

    const notJson = await run('nope');
    expect(notJson.trace[0]?.reason).toContain('must be a single JSON document');

    const good = await run('{"ok":true}');
    expect(good.outcome).toBe('completed');
    expect(good.trace[0]).toMatchObject({ state: 'completed', reason: 'executed locally' });
  });

  test('exec-code writes land in an ephemeral ARCHON_HOME temp dir, not the repo', async () => {
    const home = temporaryDirectory();
    const cwd = temporaryDirectory();
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const workflow = makeTestWorkflow({
        name: 'hermetic',
        nodes: [
          {
            id: 'code',
            bash: 'printf data > "$ARTIFACTS_DIR/out.txt"\nprintf s > "$STATE_DIR/s.txt"\ncat "$ARTIFACTS_DIR/out.txt"\necho\necho "$ARTIFACTS_DIR"',
          },
        ],
      });
      const result = await dryRunWorkflow({ workflow, cwd, execCode: true });

      expect(result.outcome).toBe('completed');
      const [written, reportedDir] = (result.trace[0]?.output ?? '').split('\n');
      expect(written).toBe('data');
      expect(reportedDir?.startsWith(join(home, 'temp'))).toBe(true);
      expect(existsSync(join(cwd, '.archon'))).toBe(false);
      expect(readdirSync(join(home, 'temp'))).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  test('exec-code delivers generated bindings and lists them in the filter manifest', async () => {
    const key = inputEnvKey('project-setting');
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'binding-env',
        nodes: [
          {
            id: 'code',
            runtime: 'bun',
            script: `console.log(JSON.stringify({ value: process.env.${key}, keys: JSON.parse(process.env.ARCHON_RUN_ENV_KEYS) }));`,
            with: { 'project-setting': 'bound value' },
          },
        ],
      }),
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    expect(JSON.parse(result.trace[0]?.output ?? 'null')).toEqual({
      value: 'bound value',
      keys: [...EXEC_NODE_ENVIRONMENT_NAMES, key],
    });
  });

  test('exec-code receives the fixed engine-owned environment', async () => {
    const workflow = makeTestWorkflow({
      name: 'engine-env',
      nodes: [
        {
          id: 'code',
          bash: `printf '%s|%s|%s|%s|%s|%s|%s' "$WORKFLOW_ID" "$BASE_BRANCH" "$ARGUMENTS" "$LOG_DIR" "$LOOP_PREV_OUTPUT" "$REJECTION_REASON" "$ARCHON_RUN_ENV_KEYS"`,
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: 'hello',
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    const fields = result.trace[0]?.output?.split('|') ?? [];
    expect(fields.slice(0, 3)).toEqual(['dry-run', 'dry-run-base', 'hello']);
    expect(fields[3]).toContain(`${sep}dry-run-`);
    expect(fields[3]).toEndWith(`${sep}logs`);
    expect(fields.slice(4, 6)).toEqual(['', '']);
    expect(JSON.parse(fields[6] ?? 'null')).toEqual([...EXEC_NODE_ENVIRONMENT_NAMES]);
  });

  test('a dry run that executes nothing creates no temp directory', async () => {
    const home = temporaryDirectory();
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const workflow = makeTestWorkflow({
        name: 'stub-only',
        nodes: [{ id: 'code', bash: 'printf never-runs' }],
      });
      const result = await dryRunWorkflow({
        workflow,
        stubs: { code: 'stubbed' },
        execCode: true,
      });

      expect(result.outcome).toBe('completed');
      expect(existsSync(join(home, 'temp'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });
});
