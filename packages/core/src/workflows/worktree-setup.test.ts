// @archon-test-isolated
import { test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
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
const run = { id: 'setup-run', user_id: null };
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
    timeout: 300000,
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

test('setup stdin is empty rather than waiting for its timeout', async () => {
  await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(['if read value; then exit 1; else echo empty; fi'], 2000));
  expect(rows[1].event_type).toBe('worktree_setup_completed');
  expect(rows[1].data?.stdoutTail).toBe('empty');
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

test('timeout is distinct and bounds a command that ignores SIGTERM', async () => {
  const startedAt = Date.now();
  const error = await createRunWorktreeSetupExecutor(
    deps,
    run,
    {}
  )(input(["trap '' TERM; sleep 5"], 30)).catch((error: unknown) => error);
  expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(error).toBeInstanceOf(WorktreePostCreateError);
  expect(rows[1].data?.failureKind).toBe('timeout');
  expect(rows[1].data?.message).toContain('30 ms');
});

for (const background of [false, true]) {
  test(`timeout ends a ${background ? 'background' : 'foreground'} descendant`, async () => {
    const descendant =
      "trap '' TERM INT; touch ready; while [ ! -f go ]; do sleep 0.01; done; touch leaked";
    const command = background
      ? `bash -c "${descendant}" & wait`
      : `true; bash -c "${descendant}"; true`;
    try {
      await expect(
        createRunWorktreeSetupExecutor(
          deps,
          run,
          {}
        )(input([command], process.platform === 'win32' ? 1000 : 200))
      ).rejects.toBeInstanceOf(WorktreePostCreateError);
      expect(await Bun.file(join(root, 'ready')).exists()).toBe(true);
      expect(rows[1].data?.failureKind).toBe('timeout');
      await writeFile(join(root, 'go'), '');
      await Bun.sleep(300);
      expect(await Bun.file(join(root, 'leaked')).exists()).toBe(false);
    } finally {
      // Release a survivor even when running this regression against the old executor.
      await writeFile(join(root, 'go'), '');
      await Bun.sleep(100);
    }
  });
}

// Windows taskkill cannot end leftovers once the command has exited.
test.skipIf(process.platform === 'win32').each([
  { exitCode: 0, redirect: false },
  { exitCode: 3, redirect: false },
  { exitCode: 0, redirect: true },
])(
  'command exit $exitCode ends leftovers (redirected output: $redirect)',
  async ({ exitCode, redirect }) => {
    try {
      const error = await createRunWorktreeSetupExecutor(
        deps,
        run,
        {}
      )(
        input(
          [
            `bash -c 'touch ready; while [ ! -f go ]; do sleep 0.01; done; touch leaked' ${redirect ? '>/dev/null 2>&1' : ''} & while [ ! -f ready ]; do sleep 0.01; done; echo started; exit ${exitCode}`,
          ],
          2000
        )
      ).catch((error: unknown) => error);
      if (exitCode === 0) {
        expect(error).toBeUndefined();
        expect(rows[1].event_type).toBe('worktree_setup_completed');
      } else {
        expect(error).toBeInstanceOf(WorktreePostCreateError);
        expect(rows[1].data?.failureKind).toBe('exit');
        expect(rows[1].data?.exitCode).toBe(exitCode);
      }
      await writeFile(join(root, 'go'), '');
      await Bun.sleep(300);
      expect(await Bun.file(join(root, 'leaked')).exists()).toBe(false);
    } finally {
      await writeFile(join(root, 'go'), '');
      await Bun.sleep(100);
    }
  }
);

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

// Windows has no POSIX signals: Git Bash's `kill -TERM $$` does not terminate the shell.
test.skipIf(process.platform === 'win32')(
  'a command terminated by a signal is an execution failure',
  async () => {
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
  }
);

for (const scenario of [
  {
    name: 'named user without a token scrubs host and bot credentials',
    perUser: true,
    user: 'user',
    token: undefined,
    fallback: false,
    expected: '||',
  },
  {
    name: 'personal token wins over bot and host',
    perUser: true,
    user: 'user',
    token: 'personal-setup-credential',
    fallback: false,
    expected: 'personal-setup-credential|personal-setup-credential|',
  },
  {
    name: 'trusted server uses bot credentials',
    perUser: true,
    user: undefined,
    token: undefined,
    fallback: false,
    expected: 'bot-setup-credential|bot-setup-credential|host-copilot-credential',
  },
  {
    name: 'disabled per-user mode uses bot credentials',
    perUser: false,
    user: 'user',
    token: undefined,
    fallback: false,
    expected: 'bot-setup-credential|bot-setup-credential|host-copilot-credential',
  },
  {
    name: 'explicit org fallback keeps bot credentials',
    perUser: true,
    user: 'user',
    token: undefined,
    fallback: true,
    expected: 'bot-setup-credential|bot-setup-credential|host-copilot-credential',
  },
]) {
  test(`setup GitHub policy: ${scenario.name}`, async () => {
    const previous = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
      ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK,
    };
    Object.assign(process.env, {
      GH_TOKEN: 'host-setup-credential',
      GITHUB_TOKEN: 'host-setup-credential',
      COPILOT_GITHUB_TOKEN: 'host-copilot-credential',
      ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK: String(scenario.fallback),
    });
    try {
      const credentialsDeps = {
        store: {
          ...deps.store,
          getCodebase: async () => ({
            id: 'project',
            name: 'acme/demo',
            repository_url: 'https://github.com/acme/demo',
            default_cwd: root,
            kind: 'repo' as const,
          }),
        },
        resolveBotGitHubToken: async () => 'bot-setup-credential',
        isPerUserGitHubEnabled: () => scenario.perUser,
        getUserGithubToken: async () => scenario.token,
      };
      const probe = 'printf "%s|%s|%s" "$GH_TOKEN" "$GITHUB_TOKEN" "$COPILOT_GITHUB_TOKEN"';
      await createRunWorktreeSetupExecutor(
        credentialsDeps,
        { ...run, user_id: scenario.user ?? null },
        {}
      )(input([`${probe} | tee github-environment`]));
      expect(await readFile(join(root, 'github-environment'), 'utf8')).toBe(scenario.expected);
      const { resolveWorkflowGithubEnvironment } = await import('@archon/workflows/executor');
      const environment = await resolveWorkflowGithubEnvironment(
        credentialsDeps,
        'project',
        scenario.user,
        {}
      );
      const bash = await runSubprocess({ kind: 'host' }, resolveBashPath(), ['-c', probe], {
        cwd: root,
        timeout: 300000,
        env: environment.envVars ?? {},
        protectedEnvKeys: environment.protectedEnvKeys,
        retention: { standalone: true },
      });
      expect(bash.stdout).toBe(scenario.expected);
      for (const credential of [
        'host-setup-credential',
        'host-copilot-credential',
        'personal-setup-credential',
        'bot-setup-credential',
      ])
        expect(JSON.stringify(rows)).not.toContain(credential);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test.each([false, true])(
  'managed values with arbitrary key names are redacted (failure: %s)',
  async fails => {
    const secret = 'arbitrary-managed-db-credential';
    const error = await createRunWorktreeSetupExecutor(deps, run, {
      envVars: { REGISTRY_AUTH: secret },
      protectedCredentialValues: [secret],
    })(
      input([`echo "$REGISTRY_AUTH"; echo "$REGISTRY_AUTH" >&2; ${fails ? 'exit 7' : 'true'}`])
    ).catch((error: unknown) => error);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[1]?.data?.stdoutTail).toContain('[REDACTED]');
    expect(rows[1]?.data?.stderrTail).toContain('[REDACTED]');
    if (fails) {
      expect(error).toBeInstanceOf(WorktreePostCreateError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    }
  }
);

test.each([false, true])(
  'standalone setup protects every managed value in application logs (failure: %s)',
  async fails => {
    const capture = captureLogLines();
    try {
      const error = await executeStandaloneWorktreeSetup(
        input([`echo "$PROJECT_VALUE"; echo "$PRECEDENCE" >&2; ${fails ? 'exit 7' : 'true'}`])
      ).catch((error: unknown) => error);
      const events = capture.lines.filter(line => line.module === 'isolation.worktree-setup');
      expect(events).toHaveLength(2);
      expect(events[1]?.stdoutTail).toContain('[REDACTED]');
      expect(events[1]?.stderrTail).toContain('[REDACTED]');
      expect(JSON.stringify(events)).not.toContain('"project"');
      if (fails) expect(String(error)).not.toContain('project');
    } finally {
      capture.restore();
    }
  }
);
