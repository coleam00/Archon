// @archon-test-isolated
import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolveBashPath } from '@archon/git';
import { runSubprocess } from '@archon/workflows/subprocess';
import { WorktreePostCreateError, classifyIsolationError } from '@archon/isolation';
import type { WorkflowEventInput } from '@archon/workflows/store';
import type { WorktreeSetupInput } from '@archon/isolation';

mock.module('../config/config-loader', () => ({
  loadConfig: async () => ({ envVars: { FILE_VALUE: 'file', PRECEDENCE: 'file' } }),
  loadRepoConfig: async () => ({}),
}));
mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: async () => ({ PROJECT_VALUE: 'project', PRECEDENCE: 'project' }),
}));
const { createRunWorktreeSetupExecutor, executeStandaloneWorktreeSetup } =
  await import('./worktree-setup');
const trackTempRoot = trackTempRoots();
const oldHome = process.env.ARCHON_HOME;
const oldBash = process.env.ARCHON_BASH_PATH;
let root: string;
let rows: WorkflowEventInput[];
const persist = mock(async (event: WorkflowEventInput): Promise<void> => {
  rows.push(event);
});
const deps = { store: { getCodebase: async () => null, persistWorkflowEvent: persist } };
const run = { id: 'setup-run' };
const input = (commands: string[], timeout = 300000): WorktreeSetupInput => ({
  workingPath: root,
  canonicalRepoPath: root,
  codebaseId: 'project',
  commands,
  timeout,
});

beforeEach(async () => {
  root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-setup-')));
  process.env.ARCHON_HOME = join(root, 'home');
  rows = [];
  persist.mockReset();
  persist.mockImplementation(async event => {
    rows.push(event);
  });
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = oldHome;
  if (oldBash === undefined) delete process.env.ARCHON_BASH_PATH;
  else process.env.ARCHON_BASH_PATH = oldBash;
});

test('sequential setup retains redacted stdout/stderr and parent attribution', async () => {
  const secret = 'secret-value-for-setup';
  await createRunWorktreeSetupExecutor(
    deps,
    run,
    { envVars: { TOKEN: secret } },
    { parentNodeId: 'spawn', childIndex: 2 }
  )(
    input([
      `printf '%s' "$TOKEN"; printf '%s' "$TOKEN" >&2; echo first > ordered`,
      'test -f ordered; echo second',
    ])
  );
  expect(rows.map(row => row.event_type)).toEqual([
    'worktree_setup_started',
    'worktree_setup_completed',
    'worktree_setup_started',
    'worktree_setup_completed',
  ]);
  expect(
    rows.every(
      row =>
        row.workflow_run_id === run.id &&
        row.data?.parentNodeId === 'spawn' &&
        row.data?.childIndex === 2
    )
  ).toBe(true);
  expect(rows[0].data?.attemptId).toBe(rows[3].data?.attemptId);
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(rows[1].data?.stdoutTail).toContain('[REDACTED]');
  expect(rows[1].data?.stderrTail).toContain('[REDACTED]');
});

test('host bash and setup receive the same managed environment without loading a copied .env', async () => {
  await writeFile(join(root, '.env'), 'TARGET_ONLY=ambient-target-secret\n');
  const envVars = { FILE_VALUE: 'file', PROJECT_VALUE: 'managed', PRECEDENCE: 'project' };
  const probe =
    'printf "%s|%s|%s|%s" "$FILE_VALUE" "$PROJECT_VALUE" "$PRECEDENCE" "${TARGET_ONLY-unset}"';
  const bash = await runSubprocess({ kind: 'host' }, resolveBashPath(), ['-c', probe], {
    cwd: root,
    env: envVars,
    timeout: 1000,
    retention: { standalone: true },
  });
  await createRunWorktreeSetupExecutor(deps, run, { envVars })(input([probe]));
  expect(rows[1].data?.stdoutTail).toBe(bash.stdout);
  expect(bash.stdout).toBe('file|managed|project|unset');
});

test('standalone setup merges project variables over file configuration', async () => {
  await executeStandaloneWorktreeSetup(
    input(['printf "%s|%s|%s" "$FILE_VALUE" "$PROJECT_VALUE" "$PRECEDENCE" > environment'])
  );
  expect(await readFile(join(root, 'environment'), 'utf8')).toBe('file|project|project');
  expect(rows).toHaveLength(0);
});

test('first nonzero exit stops setup and is not reclassified from output prose', async () => {
  const error = await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(['echo "timeout permission denied" >&2; exit 7', 'touch should-not-exist'])).catch(
    (error: unknown) => error
  );
  expect(error).toBeInstanceOf(WorktreePostCreateError);
  if (!(error instanceof WorktreePostCreateError)) throw new Error('Expected typed setup failure');
  expect(error.failureKind).toBe('exit');
  expect(error.exitCode).toBe(7);
  expect(classifyIsolationError(error)).toContain('exit code 7');
  expect(rows.map(row => row.event_type)).toEqual([
    'worktree_setup_started',
    'worktree_setup_failed',
  ]);
  expect(rows[1].data?.stderrTail).toContain('timeout permission denied');
});

test('timeout is distinct and honors the configured per-command bound', async () => {
  const error = await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(['while :; do :; done'], 30)).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorktreePostCreateError);
  expect(rows[1].data?.failureKind).toBe('timeout');
  expect(rows[1].data?.message).toContain('30 ms');
});

test('an invalid configured bash path records a spawn failure', async () => {
  process.env.ARCHON_BASH_PATH = join(root, 'missing-bash');
  await expect(createRunWorktreeSetupExecutor(deps, run, {})(input(['true']))).rejects.toThrow(
    'ARCHON_BASH_PATH'
  );
  expect(rows[1].data?.failureKind).toBe('spawn');
});

test('start audit failure prevents execution', async () => {
  persist.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(
    createRunWorktreeSetupExecutor(deps, run, {})(input(['touch must-not-run']))
  ).rejects.toThrow('audit unavailable');
  expect(await Bun.file(join(root, 'must-not-run')).exists()).toBe(false);
});

test('terminal audit failure aborts success and prevents later commands', async () => {
  persist.mockImplementation(async event => {
    if (event.event_type === 'worktree_setup_completed')
      throw new Error('terminal audit unavailable');
    rows.push(event);
  });
  await expect(
    createRunWorktreeSetupExecutor(deps, run, {})(input(['true', 'touch must-not-run']))
  ).rejects.toThrow('terminal audit unavailable');
  expect(await Bun.file(join(root, 'must-not-run')).exists()).toBe(false);
});

test('a failed command and failed audit both remain visible without leaking credentials', async () => {
  persist.mockImplementation(async event => {
    if (event.event_type === 'worktree_setup_failed') throw new Error('failure audit unavailable');
    rows.push(event);
  });
  const secret = 'secret-setup-failure';
  const error = await createRunWorktreeSetupExecutor(deps, run, { envVars: { TOKEN: secret } })(
    input([`echo ${secret}; echo "$TOKEN" >&2; exit 9`])
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorktreePostCreateError);
  expect(String(error)).toContain('exit code 9');
  expect(String(error)).toContain('failure audit unavailable');
  expect(JSON.stringify(error)).not.toContain(secret);
  if (error instanceof WorktreePostCreateError && error.cause instanceof AggregateError)
    expect(error.cause.errors.map(String).join(' ')).not.toContain(secret);
});

test('output overflow has its own failure kind and retains bounded evidence', async () => {
  await expect(
    createRunWorktreeSetupExecutor(deps, run, {})(input(["printf '%1100000s' x | tr ' ' x"]))
  ).rejects.toThrow('output_limit');
  expect(rows[1].data?.failureKind).toBe('output_limit');
  expect(rows[1].data?.stdoutTail).toBe(`…[truncated to last 2000 chars]\n${'x'.repeat(2000)}`);
});

test('successful setup uses marked stream tails and omits whitespace-only evidence', async () => {
  await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(["printf '%2200s' x | tr ' ' x; printf '   \n' >&2"]));
  expect(rows[1].data?.stdoutTail).toBe(`…[truncated to last 2000 chars]\n${'x'.repeat(2000)}`);
  expect(rows[1].data?.stderrTail).toBeUndefined();
});

test('a command terminated by a signal is an execution failure', async () => {
  const error = await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(['kill -TERM $$'])).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorktreePostCreateError);
  if (!(error instanceof WorktreePostCreateError)) throw new Error('Expected setup failure');
  expect(error.failureKind).toBe('exit');
  if (error.signal) expect(error.message).toContain(error.signal);
  else expect(typeof error.exitCode).toBe('number');
});
