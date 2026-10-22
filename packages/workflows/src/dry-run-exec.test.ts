// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';

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
    expect(failureResult.trace[0]).toMatchObject({ state: 'failed', reason: 'nope' });
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

  test('exec-code receives the fixed engine-owned environment', async () => {
    const workflow = makeTestWorkflow({
      name: 'engine-env',
      nodes: [
        {
          id: 'code',
          bash: `printf '%s|%s|%s|%s|%s|%s|%s' "$WORKFLOW_ID" "$BASE_BRANCH" "$ARGUMENTS" "$LOG_DIR" "$LOOP_PREV_OUTPUT" "$REJECTION_REASON" "$ARCHON_INPUT_ENV_KEYS"`,
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
    expect(fields.slice(4)).toEqual(['', '', '[]']);
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
