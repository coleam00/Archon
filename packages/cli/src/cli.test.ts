/**
 * Tests for CLI argument parsing and main flow
 *
 * Note: These tests focus on argument parsing logic.
 * Full integration tests would require mocking the database and commands.
 */
import { receiptPath } from '@archon/plugin-manifest/store';
import { RUN_GITHUB_IDENTITY_KEYS } from '@archon/workflows/utils/github-token-policy';
import { assertRunForgeAccess, ForgeRequirementError } from '@archon/workflows/run-forge-access';
import { RUN_GITHUB_IDENTITY_HANDOFF_ENV } from '@archon/paths/github-token-env';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseArgs } from 'util';
import ts from 'typescript';
import { cliArgOptions } from './args';
import { generateConversationId } from './utils/conversation-id';
import { canonicalizeProjectPath, projectKeyForCodebase } from '@archon/paths';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealWorkflowRunConfig } from '@archon/core/config';
import {
  isContinueSubcommand,
  rejectConfigOutsideRun,
  rejectInputFileOutsideRun,
  rejectRunFlagsOnContinue,
} from './dispatch-guards';
import { loadCliEnv } from './load-cli-env';

const CLI_ENTRY = join(import.meta.dir, 'cli.ts');
// The enclosing git worktree — a valid repo for the git gate, with a real
// .archon/workflows/ directory so an unknown workflow name fails deterministically.
const repoRoot = join(import.meta.dir, '..', '..', '..');

it('plugin rejection guidance lists only public commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-plugin-cli-reject-'));
  try {
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'plugin', 'bogus'], {
      cwd: root,
      env: { ...process.env, ARCHON_HOME: root, ARCHON_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      'Usage: archon plugin add <owner/repo[/path][@tag]> | update <id>[@tag] | remove <id> | copy <id> | list'
    );
  } finally {
    await removeTempTree(root);
  }
});

describe('forge user trust boundary', () => {
  it('resolves a workflow probe without changing the host environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-probe-env-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, '.archon'), { recursive: true });
    writeFileSync(
      join(home, '.env'),
      'GH_TOKEN=home-token\nGH_CONFIG_DIR=user-login\nGIT_CONFIG_PARAMETERS=home-helpers\n'
    );
    writeFileSync(
      join(repo, '.archon/.env'),
      'GH_TOKEN=repo-token\nGH_CONFIG_DIR=repo-login\nGIT_CONFIG_PARAMETERS=repo-helpers\n'
    );
    const host = { ...process.env };
    try {
      for (const token of ['app-token', '']) {
        const env = {
          ARCHON_HOME: home,
          GH_CONFIG_DIR: 'workflow-login',
          GIT_CONFIG_PARAMETERS: "'credential.helper='",
          GH_TOKEN: token,
          [RUN_GITHUB_IDENTITY_HANDOFF_ENV]: '1',
        };
        const trusted = await loadCliEnv(repo, { env });
        expect(trusted.GH_CONFIG_DIR).toBe('workflow-login');
        expect(trusted.GIT_CONFIG_PARAMETERS).toBe("'credential.helper='");
        expect(env.GH_CONFIG_DIR).toBe('workflow-login');
        expect(env.GIT_CONFIG_PARAMETERS).toBe("'credential.helper='");
        expect(env.GH_TOKEN).toBe(token);
      }
      expect(process.env).toEqual(host);
    } finally {
      await removeTempTree(root);
    }
  });

  it.each([undefined, 'user-login'])(
    'does not pass a repo stored-login redirect to workflow children (user login: %s)',
    async login => {
      const root = mkdtempSync(join(tmpdir(), 'archon-login-env-'));
      const home = join(root, 'home');
      const repo = join(root, 'repo');
      mkdirSync(home);
      mkdirSync(join(repo, '.archon'), { recursive: true });
      if (login) writeFileSync(join(home, '.env'), `GH_CONFIG_DIR=${login}\n`);
      writeFileSync(join(repo, '.archon/.env'), 'GH_CONFIG_DIR=repo-login\n');
      const env: NodeJS.ProcessEnv = { ARCHON_HOME: home };
      try {
        const trusted = await loadCliEnv(repo, { env });
        expect(trusted.GH_CONFIG_DIR).toBe(login);
        expect(env.GH_CONFIG_DIR).toBe(login);
      } finally {
        await removeTempTree(root);
      }
    }
  );

  it('refuses to start when the repo .archon/.env sets ARCHON_HOME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-repo-home-refused-'));
    const repo = join(root, 'repo');
    const repoEnv = join(repo, '.archon', '.env');
    mkdirSync(join(repo, '.archon'), { recursive: true });
    writeFileSync(repoEnv, `ARCHON_HOME=${join(root, 'repo-selected-home')}\n`);
    try {
      const result = spawnSync(process.execPath, [CLI_ENTRY, 'version'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ARCHON_HOME: join(root, 'home'), ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`${repoEnv} sets ARCHON_HOME`);
    } finally {
      await removeTempTree(root);
    }
  });

  // The engine expresses a run's GitHub identity by setting the key (a token, '' to
  // scrub, or a stored-login redirect). An absent key is no opinion, so Archon's env
  // files supply it. Exercised in process: a CLI subprocess per scenario is too slow on
  // Windows runners.
  for (const key of RUN_GITHUB_IDENTITY_KEYS) {
    it(`${key}: a run's credential state wins over Archon env files`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-run-token-'));
      const home = join(root, 'home');
      mkdirSync(home);
      writeFileSync(join(home, '.env'), `${key}=home-test-token\n`);
      const saved = { ...process.env };
      const cases = [
        {
          name: 'outside',
          run: false,
          inherited: undefined,
          repoEnv: false,
          gets: 'home-test-token',
        },
        {
          name: 'absent',
          run: true,
          inherited: undefined,
          repoEnv: false,
          gets: 'home-test-token',
        },
        {
          name: 'absent-repo',
          run: true,
          inherited: undefined,
          repoEnv: true,
          gets: key === 'GH_CONFIG_DIR' ? 'home-test-token' : 'repo-test-token',
        },
        {
          name: 'engine',
          run: true,
          inherited: 'engine-test-token',
          repoEnv: false,
          gets: 'engine-test-token',
        },
        {
          name: 'engine-repo',
          run: true,
          inherited: 'engine-test-token',
          repoEnv: true,
          gets: 'engine-test-token',
        },
        { name: 'empty', run: true, inherited: '', repoEnv: false, gets: '' },
        { name: 'empty-repo', run: true, inherited: '', repoEnv: true, gets: '' },
      ] as const;
      try {
        for (const { name, run, inherited, repoEnv, gets } of cases) {
          const repo = join(root, name);
          mkdirSync(join(repo, '.archon'), { recursive: true });
          if (repoEnv) writeFileSync(join(repo, '.archon', '.env'), `${key}=repo-test-token\n`);
          process.env.ARCHON_HOME = home;
          process.env.WORKFLOW_ID = run ? 'credential-run' : '';
          if (inherited === undefined) delete process.env[key];
          else process.env[key] = inherited;
          await loadCliEnv(repo);
          expect({ name, token: process.env[key] }).toEqual({ name, token: gets });
        }
      } finally {
        for (const name of Object.keys(process.env)) {
          if (!(name in saved)) delete process.env[name];
        }
        Object.assign(process.env, saved);
        await removeTempTree(root);
      }
    });
  }

  // One end-to-end case proves cli.ts applies loadCliEnv's result to the credential a
  // forge plugin receives.
  it("a run's engine token reaches a forge plugin over both Archon env files", async () => {
    const key = 'GH_TOKEN';
    const root = mkdtempSync(join(tmpdir(), 'archon-forge-run-token-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const plugin = join(root, 'plugin.ts');
    const marker = join(root, 'marker');
    mkdirSync(home);
    mkdirSync(join(repo, '.archon'), { recursive: true });
    writeFileSync(join(home, '.env'), `${key}=home-test-token\n`);
    writeFileSync(join(repo, '.archon', '.env'), `${key}=repo-test-token\n`);
    writeFileSync(
      plugin,
      `import { writeFileSync } from 'node:fs';
if (process.argv[3] === 'metadata') {
  console.log(JSON.stringify({ protocol: 1, name: 'marker', version: '1', forge: 'test', hosts: ['forge.example'], capabilities: ['checks.state'], token_env: [${JSON.stringify(key)}] }));
} else {
  writeFileSync(process.argv[2], process.env.ARCHON_FORGE_TOKEN ?? 'absent');
  const request = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify({ operationId: request.operationId, ok: true, result: { op: 'checks.state', value: { ref: request.ref, revision: 'marker', units: [], required: null, summary: { state: 'none', counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 } } } } }));
}
`
    );
    writeFileSync(
      join(home, 'config.yaml'),
      `forge:\n  plugins:\n    - plugin: marker\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(plugin)}, ${JSON.stringify(marker)}]\n  hosts:\n    forge.example: marker\n`
    );
    try {
      // The beforeAll seed process has closed this registry. Copy its schema so
      // fresh-database DDL does not consume the process-boundary test's budget.
      copyFileSync(join(jsonEnvelopeHome, 'archon.db'), join(home, 'archon.db'));
      const db = new Database(join(home, 'archon.db'));
      try {
        db.run(
          "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('conversation', 'cli', 'credential-test')"
        );
        db.run(
          "INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ('credential-run', 'conversation', 'credential-test', '')"
        );
      } finally {
        db.close();
      }
      const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 7 };
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'forge', 'checks', '--data', JSON.stringify({ ref })],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            ARCHON_HOME: home,
            ARCHON_TELEMETRY_DISABLED: '1',
            DATABASE_URL: '',
            WORKFLOW_ID: 'credential-run',
            [key]: 'engine-test-token',
          },
        }
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
      expect(readFileSync(marker, 'utf8')).toBe('engine-test-token');
    } finally {
      await removeTempTree(root);
    }
  });

  // A fresh run has no WORKFLOW_ID yet, so the start-time forge check hands its
  // resolved identity to the CLI it spawns explicitly.
  it("a fresh run's forge check keeps the user's credential state over the host env file", async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-forge-check-identity-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const plugin = join(root, 'plugin.ts');
    mkdirSync(home);
    mkdirSync(repo);
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    spawnSync('git', ['remote', 'add', 'origin', 'https://forge.example/owner/repo.git'], {
      cwd: repo,
    });
    writeFileSync(join(home, '.env'), 'GH_TOKEN=home-test-token\n');
    writeFileSync(
      plugin,
      // Metadata, then the check's read: a resolve of the remote and a pr.view by head.
      `const metadata = { protocol: 1, name: 'marker', version: '1', forge: 'test', hosts: ['forge.example'], capabilities: ['resolve', 'pr.view'], token_env: ['GH_TOKEN'] };
if (process.argv[2] !== 'op') { console.log(JSON.stringify(metadata)); process.exit(0); }
const input = await Bun.stdin.json();
const repo = { host: 'forge.example', path: 'owner/repo' };
const value = input.op === 'resolve' ? { kind: 'resolved', forge: 'test', repo, plugin: { name: 'marker', version: '1' } } : null;
console.log(JSON.stringify({ operationId: input.operationId, ok: true, result: { op: input.op, value } }));\n`
    );
    writeFileSync(
      join(home, 'config.yaml'),
      `forge:\n  plugins:\n    - plugin: marker\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(plugin)}]\n  hosts:\n    forge.example: marker\n`
    );
    const savedCliCommand = process.env.ARCHON_CLI_COMMAND;
    process.env.ARCHON_CLI_COMMAND = JSON.stringify([process.execPath, CLI_ENTRY]);
    const start = (userToken: string | undefined) =>
      assertRunForgeAccess(
        {
          store: { getCodebase: async () => null },
          isPerUserGitHubEnabled: () => true,
          getUserGithubToken: async () => userToken,
        },
        {
          name: 'deliver',
          pack: { key: 'factory', source: 'project', forge: { operations: ['pr.view'] } },
        },
        {
          config: {
            envVars: {
              HOME: root,
              USERPROFILE: root,
              ARCHON_HOME: home,
              ARCHON_TELEMETRY_DISABLED: '1',
              WORKFLOW_ID: '',
            },
          },
          executionUserId: 'user-1',
        },
        { cwd: repo, settingsCwd: repo, codebaseId: undefined, supplied: undefined }
      );
    try {
      const refused = await start(undefined).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(refused).toBeInstanceOf(ForgeRequirementError);
      expect((refused as ForgeRequirementError).failures).toEqual([
        expect.objectContaining({ remote: 'origin', reason: 'no_credential' }),
      ]);
      await start('user-test-token');
    } finally {
      if (savedCliCommand === undefined) delete process.env.ARCHON_CLI_COMMAND;
      else process.env.ARCHON_CLI_COMMAND = savedCliCommand;
      await removeTempTree(root);
    }
  });

  it('keeps config and executable discovery user-scoped while accepting a repo credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-forge-trust-'));
    const repo = join(root, 'repo');
    const trustedHome = join(root, 'trusted-home');
    const plugin = join(root, 'plugin.ts');
    const trustedMarker = join(root, 'trusted-marker');
    mkdirSync(join(repo, '.archon'), { recursive: true });
    mkdirSync(trustedHome, { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    writeFileSync(
      plugin,
      `import { appendFileSync } from 'node:fs';\n` +
        `const marker = process.argv[2];\n` +
        `if (process.env.ARCHON_FORGE_TOKEN) appendFileSync(marker, process.env.ARCHON_FORGE_TOKEN);\n` +
        `if (process.argv[3] === 'metadata') {\n` +
        `  console.log(JSON.stringify({ protocol: 1, name: 'trusted', version: '1', forge: 'test', hosts: ['forge.example'], capabilities: ['checks.state'], token_env: ['FORGE_SECRET'] }));\n` +
        `} else {\n` +
        `  const request = JSON.parse(await Bun.stdin.text());\n` +
        `  console.log(JSON.stringify({ operationId: request.operationId, ok: true, result: { op: 'checks.state', value: { ref: request.ref, revision: 'trusted-revision', units: [], required: null, summary: { state: 'none', counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 } } } } }));\n` +
        `}\n`
    );
    writeFileSync(
      join(trustedHome, 'config.yaml'),
      `forge:\n  plugins:\n    - plugin: trusted\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(plugin)}, ${JSON.stringify(trustedMarker)}]\n  hosts:\n    forge.example: trusted\n`
    );
    writeFileSync(join(repo, '.archon', '.env'), 'FORGE_SECRET=repo-secret\n');

    try {
      const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 7 };
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'forge', 'checks', '--data', JSON.stringify({ ref })],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: trustedHome,
            ARCHON_TELEMETRY_DISABLED: '1',
            FORGE_SECRET: '',
            // Inside an Archon run this would make the forge audit a run id the scratch DB lacks.
            WORKFLOW_ID: '',
          },
        }
      );

      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: { value: { revision: 'trusted-revision' } },
      });
      await expect(Bun.file(trustedMarker).text()).resolves.toBe('repo-secret');
    } finally {
      await removeTempTree(root);
    }
  });
});

describe('deprecated provider notice', () => {
  // The CLI installs the registry's deprecation reporter at startup; only a real
  // process shows which channel the notice reaches.
  async function runCli(config: string | undefined, args: string[][]): Promise<string[]> {
    const root = mkdtempSync(join(tmpdir(), 'archon-deprecated-provider-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
    if (config !== undefined) writeFileSync(join(home, 'config.yaml'), config);
    writeFileSync(
      join(repo, '.archon', 'workflows', 'greet.yaml'),
      'name: greet\ndescription: greet\nnodes:\n  - id: greet\n    prompt: say hi\n'
    );
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    try {
      return args.map(
        argv =>
          spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
            cwd: repo,
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              HOME: root,
              USERPROFILE: root,
              ARCHON_HOME: home,
              ARCHON_TELEMETRY_DISABLED: '1',
              DATABASE_URL: '',
            },
          }).stderr
      );
    } finally {
      await removeTempTree(root);
    }
  }

  it(
    'stays silent on a fresh install',
    async () => {
      const stderrs = await runCli(undefined, [['version'], ['workflow', 'list']]);
      for (const stderr of stderrs) expect(stderr).not.toContain('deprecated');
    },
    testTimeout(30_000)
  );

  it(
    'reaches a user who selected the provider once, as readable text',
    async () => {
      // OpenCode without a model fails the node before spawning its runtime.
      const [stderr] = await runCli('defaultAssistant: opencode\n', [
        ['workflow', 'run', 'greet', '--no-worktree', 'hello'],
      ]);
      expect(stderr.split('OpenCode is deprecated').length - 1).toBe(1);
      expect(stderr).not.toContain('provider.deprecated');
    },
    testTimeout(30_000)
  );
});

describe('removed continue command', () => {
  // Full interpreter startup: the rejection lives in main()'s dispatch, not in
  // a pure guard, so a subprocess is the only way to pin the actual outcome.
  it('rejects archon continue and points to explicit run adoption', () => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'continue', 'some/branch', 'carry on'], {
      encoding: 'utf8',
      env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Removed: 'archon continue'");
    expect(result.stderr).toContain('--adopt <run-id>');
  });

  it('rejects archon continue outside any git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-no-repo-'));
    try {
      const result = spawnSync(process.execPath, [CLI_ENTRY, 'continue', 'some/branch'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Removed: 'archon continue'");
      expect(result.stderr).toContain('--adopt <run-id>');
    } finally {
      await removeTempTree(dir);
    }
  });
});

describe('workflow model arguments', () => {
  it('parses repeated --model values without accepting a coarse provider flag', () => {
    const parsed = parseArgs({
      args: ['workflow', 'run', 'x', '--model', 'large=openai/gpt-5.6', '--model', '@p=large'],
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
    expect(parsed.values.model).toEqual(['large=openai/gpt-5.6', '@p=large']);
    expect(() =>
      parseArgs({
        args: ['workflow', 'run', 'x', '--provider', 'pi'],
        options: cliArgOptions,
        allowPositionals: true,
        strict: true,
      })
    ).toThrow(/provider/);
  });

  for (const args of [
    ['workflow', 'resume', 'run-1'],
    ['workflow', 'approve', 'run-1'],
    ['workflow', 'reject', 'run-1'],
    ['workflow', 'respond', 'run-1', 'approve'],
    ['workflow', 'answer', 'run-1', '--occurrence', 'x'],
  ]) {
    it(`rejects run-only flags on ${args[0]} ${args[1]}`, () => {
      // Pure pre-dispatch argv guard — no I/O, so asserted in-process instead
      // of through a full interpreter startup. A defined message is what makes
      // main() print to stderr and exit 1.
      expect(isContinueSubcommand(args[1])).toBe(true);
      for (const [values, flag, kept] of [
        [{ model: 'large=opus' }, '--model', 'the model bindings'],
        [{ input: ['ticket=1'] }, '--input', 'the inputs'],
        [{ 'input-file': ['ticket=ticket.md'] }, '--input-file', 'the inputs'],
        [{ base: 'main' }, '--base', 'the base branch'],
      ] as const) {
        const message = rejectRunFlagsOnContinue(args[1], values);
        expect(message).toContain(
          `${flag} cannot be used when continuing an existing workflow run`
        );
        expect(message).toContain(`keeps ${kept} it started with`);
      }
    });
  }

  it('does not classify fresh runs or queries as continuations', () => {
    for (const subcommand of ['run', 'list', 'attention', undefined]) {
      expect(isContinueSubcommand(subcommand)).toBe(false);
      expect(
        rejectRunFlagsOnContinue(subcommand, { model: 'large=foo', input: ['a=1'], base: 'main' })
      ).toBeUndefined();
    }
  });
});

describe('workflow answer flag rejection and command discovery', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'archon-cli-answer-flags-'));
  });
  afterAll(async () => {
    await removeTempTree(home);
  });

  const invoke = (args: string[]) =>
    spawnSync(process.execPath, [CLI_ENTRY, 'workflow', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCHON_HOME: home,
        ARCHON_TELEMETRY_DISABLED: '1',
        DATABASE_URL: '',
        GITHUB_APP_ID: '',
        TOKEN_ENCRYPTION_KEY: '',
      },
    });

  it('refuses --model on answer with the continuation error before run lookup', () => {
    const result = invoke(['answer', 'missing-run', '--occurrence', 'x', '--model', 'large=foo']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--model cannot be used when continuing an existing workflow run'
    );
    expect(result.stderr).toContain('keeps the model bindings it started with');
  });

  for (const json of [false, true]) {
    it(`refuses --detach on answer before recording an answer (json=${json})`, () => {
      const result = invoke([
        'answer',
        'missing-run',
        '--occurrence',
        'x',
        '--detach',
        ...(json ? ['--json'] : []),
      ]);
      expect(result.status).toBe(1);
      if (json) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: 'Error: --detach cannot be used with workflow answer.',
        });
      } else {
        expect(result.stderr).toContain('Error: --detach cannot be used with workflow answer.');
      }
    });
  }

  it('returns nonzero when a JSON answer cannot find its run', () => {
    const result = invoke(['answer', 'missing-run', '--occurrence', 'x', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Workflow run not found'),
    });
    expect(result.status).toBe(1);
  });

  it('routes end-turn to its run lookup', () => {
    const result = invoke(['end-turn', 'missing-run', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      action: 'end_turn',
      error: 'not_found',
    });
  });

  it('requires a run ID for end-turn', () => {
    const result = invoke(['end-turn', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: 'Usage: archon workflow end-turn <run-id>',
    });
  });

  it('advertises every workflow dispatch route and no others', () => {
    const result = invoke(['unknown-command']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown workflow subcommand: unknown-command');
    const available = result.stderr.split('Available: ')[1]?.split('\n')[0]?.split(', ');
    const source = ts.createSourceFile(
      CLI_ENTRY,
      readFileSync(CLI_ENTRY, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const routes = new Set<string>();
    const comparisons = (node: ts.Node, identifier: string): string[] => {
      const names: string[] = [];
      const visit = (child: ts.Node): void => {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isIdentifier(child.left) &&
          child.left.text === identifier &&
          ts.isStringLiteral(child.right)
        )
          names.push(child.right.text);
        ts.forEachChild(child, visit);
      };
      visit(node);
      return names;
    };
    const visit = (node: ts.Node, workflow = false): void => {
      if (ts.isIfStatement(node) && comparisons(node.expression, 'command').includes('workflow')) {
        for (const name of comparisons(node.expression, 'subcommand')) routes.add(name);
      }
      const inWorkflow =
        workflow ||
        (ts.isCaseClause(node) &&
          ts.isStringLiteral(node.expression) &&
          node.expression.text === 'workflow');
      if (
        inWorkflow &&
        ts.isSwitchStatement(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'subcommand'
      ) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
            routes.add(clause.expression.text);
          }
        }
      }
      ts.forEachChild(node, child => visit(child, inWorkflow));
    };
    visit(source);
    expect(routes.size).toBeGreaterThan(0);
    expect(available?.sort()).toEqual([...routes].sort());
  });
});

describe('workflow run config argument', () => {
  for (const args of [
    ['help'],
    ['forge', 'pr.view'],
    ['workflow', 'wake'],
    ['workflow', 'wake', 'schedule'],
    ['workflow', 'signal', 'run-1'],
  ]) {
    for (const flag of ['config', 'config-from-run']) {
      it.each([false, true])(
        `refuses --${flag} on ${args.join(' ')} before initialization (json: %s)`,
        async json => {
          const root = mkdtempSync(join(tmpdir(), 'archon-config-refusal-'));
          const preload = join(root, 'preload.ts');
          writeFileSync(
            preload,
            `import { mock } from 'bun:test';
mock.module(${JSON.stringify(join(import.meta.dir, 'routes/route-loader.ts'))}, () => ({
  usesDatabaseStore: async () => { throw new Error('unexpected store initialization'); },
  registerProviders: async () => { throw new Error('unexpected provider initialization'); },
  loadRoute: async () => { throw new Error('unexpected command initialization'); },
  markDatabaseRouteLoaded: () => {},
  closeDb: async () => {},
}));
mock.module(${JSON.stringify(join(import.meta.dir, 'utils/workflow-host.ts'))}, () => ({
  createCliWorkflowHost: async () => { throw new Error('unexpected host initialization'); },
}));
`
          );
          try {
            const result = spawnSync(
              process.execPath,
              [
                '--preload',
                preload,
                CLI_ENTRY,
                ...args,
                `--${flag}`,
                'unused-config',
                ...(json ? ['--json'] : []),
              ],
              {
                cwd: root,
                env: {
                  ...process.env,
                  ARCHON_HOME: root,
                  ARCHON_TELEMETRY_DISABLED: '1',
                  DATABASE_URL: '',
                },
                encoding: 'utf8',
              }
            );
            const message =
              flag === 'config'
                ? 'Error: --config can only be used with workflow run, trigger fire, trigger schedule, or pack bindings.'
                : 'Error: --config-from-run can only be used with workflow run.';
            expect(result.status, result.stderr).toBe(1);
            if (json) {
              expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: message });
              expect(result.stderr).toBe('');
            } else {
              expect(result.stdout).toBe('');
              expect(result.stderr).toBe(`${message}\n`);
            }
          } finally {
            await removeTempTree(root);
          }
        }
      );
    }
  }

  it('refuses --input-file outside workflow run, leaving continuations their own message', () => {
    const files = ['diff=changes.diff'];
    expect(rejectInputFileOutsideRun('trigger', 'fire', files)).toBe(
      'Error: --input-file can only be used with workflow run.'
    );
    expect(rejectInputFileOutsideRun('workflow', 'list', files)).toBeDefined();
    expect(rejectInputFileOutsideRun('workflow', 'run', files)).toBeUndefined();
    expect(rejectInputFileOutsideRun('workflow', 'resume', files)).toBeUndefined();
    expect(rejectInputFileOutsideRun('trigger', 'fire', undefined)).toBeUndefined();
  });

  it('accepts config flags on their owning commands', () => {
    expect(rejectConfigOutsideRun('workflow', 'run', 'config.yaml')).toBeUndefined();
    expect(rejectConfigOutsideRun('workflow', 'run', undefined, 'run-1')).toBeUndefined();
    for (const subcommand of ['fire', 'schedule']) {
      expect(rejectConfigOutsideRun('trigger', subcommand, 'config.yaml')).toBeUndefined();
    }
    expect(rejectConfigOutsideRun('pack', 'bindings', 'run.yaml')).toBeUndefined();
  });

  it('parses one local path', () => {
    const parsed = parseArgs({
      args: ['workflow', 'run', 'x', '--config', './config.minimax.yaml'],
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
    expect(parsed.values.config).toBe('./config.minimax.yaml');
  });

  it('refuses --config-from-run on the trigger commands that take --config', () => {
    for (const subcommand of ['fire', 'schedule']) {
      expect(rejectConfigOutsideRun('trigger', subcommand, undefined, 'paused-run')).toBe(
        'Error: --config-from-run can only be used with workflow run.'
      );
    }
    expect(rejectConfigOutsideRun('workflow', 'run', undefined, 'paused-run')).toBeUndefined();
  });

  it('rejects --config outside workflow run before dispatch', () => {
    // Pure pre-dispatch argv guard — no I/O, so asserted in-process.
    const message = rejectConfigOutsideRun('chat', undefined, './does-not-exist.yaml');
    expect(message).toBe(
      'Error: --config can only be used with workflow run, trigger fire, trigger schedule, or pack bindings.'
    );
  });

  it('resolves a relative config path from the requested subdirectory cwd', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-config-cwd-'));
    const subdir = join(repo, 'bench');
    mkdirSync(subdir, { recursive: true });
    spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    writeFileSync(join(subdir, 'config.yaml'), 'paths: {}\n');

    try {
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'run', 'x', '--cwd', subdir, '--config', './config.yaml'],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown run config key 'paths'");
      expect(result.stderr).not.toContain('Unable to read run config');
    } finally {
      await removeTempTree(repo);
    }
  });

  it('keeps a detached config handoff outside repo env overrides', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-detached-config-'));
    const archonHome = join(repo, 'archon-home');
    mkdirSync(join(repo, '.archon'), { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    writeFileSync(
      join(repo, '.env'),
      `TOKEN_ENCRYPTION_KEY=${'33'.repeat(32)}\n` +
        `ARCHON_HOME=${join(repo, 'wrong-home')}\n` +
        'ARCHON_DOCKER=true\n' +
        'WORKSPACE_PATH=/workspace\n' +
        'HOME=/root\n'
    );
    writeFileSync(join(repo, '.archon', '.env'), `TOKEN_ENCRYPTION_KEY=${'22'.repeat(32)}\n`);

    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    const savedArchonHome = process.env.ARCHON_HOME;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    process.env.ARCHON_HOME = relative(process.cwd(), archonHome);
    const payload = JSON.stringify(
      sealWorkflowRunConfig({ docsPath: 'accepted' }, { kind: 'cli', label: 'config.minimax.yaml' })
    );
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedArchonHome;

    try {
      const result = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'run', 'x', '--dry-run', '--internal-detached-run-config', payload],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: archonHome,
            TOKEN_ENCRYPTION_KEY: '',
            ARCHON_DOCKER: '',
            WORKSPACE_PATH: '',
            HOME: homedir(),
          },
        }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('could not be decrypted');
      expect(result.stderr).toContain("Workflow 'x' not found");
    } finally {
      await removeTempTree(repo);
    }
  });

  it('keeps a detached Docker install classified through target env loading', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-detached-docker-'));
    mkdirSync(join(repo, '.archon'), { recursive: true });
    writeFileSync(
      join(repo, '.env'),
      `TOKEN_ENCRYPTION_KEY=${'33'.repeat(32)}\n` +
        `ARCHON_HOME=${join(repo, 'wrong-home')}\n` +
        'ARCHON_DOCKER=false\n' +
        'WORKSPACE_PATH=\n' +
        `HOME=${repo}\n`
    );
    writeFileSync(join(repo, '.archon', '.env'), `TOKEN_ENCRYPTION_KEY=${'22'.repeat(32)}\n`);

    const stripBootUrl = pathToFileURL(
      join(repoRoot, 'packages', 'paths', 'src', 'strip-cwd-env-boot.ts')
    ).href;
    const pathsUrl = pathToFileURL(join(repoRoot, 'packages', 'paths', 'src', 'index.ts')).href;
    const probe = join(repo, 'probe.ts');
    writeFileSync(
      probe,
      `import '${stripBootUrl}';\n` +
        `import { captureDetachedInstallContext, getArchonHome, isDocker, loadArchonEnv, restoreDetachedInstallContext } from '${pathsUrl}';\n` +
        'const inherited = captureDetachedInstallContext();\n' +
        'loadArchonEnv(process.cwd());\n' +
        'restoreDetachedInstallContext(inherited);\n' +
        'process.stdout.write(JSON.stringify({ docker: isDocker(), home: getArchonHome(), context: inherited }));\n'
    );

    try {
      const result = spawnSync(
        process.execPath,
        [probe, '--internal-detached-run-config', 'placeholder'],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKEN_ENCRYPTION_KEY: 'parent-key',
            ARCHON_HOME: '/.archon',
            ARCHON_DOCKER: 'true',
            WORKSPACE_PATH: '/workspace',
            HOME: '/root',
            USERPROFILE: '',
          },
        }
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: expect.stringContaining('[archon] stripped 5 keys'),
      });
      expect(JSON.parse(result.stdout)).toEqual({
        docker: true,
        home: '/.archon',
        context: {
          TOKEN_ENCRYPTION_KEY: 'parent-key',
          ARCHON_HOME: '/.archon',
          ARCHON_DOCKER: 'true',
          WORKSPACE_PATH: '/workspace',
          HOME: '/root',
          USERPROFILE: '',
        },
      });
    } finally {
      await removeTempTree(repo);
    }
  });

  for (const args of [
    ['workflow', 'resume', 'run-1'],
    ['workflow', 'approve', 'run-1'],
    ['workflow', 'reject', 'run-1'],
    ['workflow', 'respond', 'run-1', 'approve'],
  ]) {
    it(`rejects --config on ${args[0]} ${args[1]}`, () => {
      // Pure pre-dispatch argv guard — no I/O, so asserted in-process instead
      // of through a full interpreter startup.
      const message = rejectConfigOutsideRun(args[0], args[1], './config.minimax.yaml');
      expect(message).toBe(
        'Error: --config can only be used with workflow run, trigger fire, trigger schedule, or pack bindings.'
      );
    });
  }
});

describe('unknown flag rejection (#2769)', () => {
  it('exits non-zero naming the mistyped flag before any command runs', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'assist', '--dryrun', '--stubs', 'x.yaml'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--dryrun');
  });

  it('still accepts a valid workflow dry-run invocation', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'definitely-not-a-workflow', '--dry-run'],
      { encoding: 'utf8', cwd: join(import.meta.dir, '../../../') }
    );

    // Fails on the unknown workflow name (after parsing), not on the flag.
    expect(result.stderr).not.toContain('Error parsing arguments');
  });
});

describe('workflow status arguments', () => {
  it('rejects a run id and points to workflow get', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'status', 'abc123'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Usage: archon workflow status [--all] [--json] [--verbose] [--events]'
    );
    expect(result.stderr).toContain('archon workflow get <run-id>');
    expect(result.stdout).toBe('');
  });
});

describe('workflow get arguments', () => {
  it('accepts a run id, the form recovery hints name', async () => {
    const archonHome = mkdtempSync(join(tmpdir(), 'archon-cli-get-'));
    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, 'cli.ts'), 'workflow', 'get', 'definitely-not-a-run'],
        { encoding: 'utf8', env: { ...process.env, ARCHON_HOME: archonHome } }
      );

      expect(result.stderr).not.toContain('Usage: archon workflow get');
    } finally {
      await removeTempTree(archonHome);
    }
  });
});

describe('workflow status project scope', () => {
  it('uses the run-owned project after its conversation moves and returns every project with --all', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'archon-cli-status-scope-'));
    const archonHome = join(scratch, 'home');
    const projectA = join(scratch, 'project-a');
    const projectB = join(scratch, 'project-b');
    const unregisteredProject = join(scratch, 'unregistered-project');
    mkdirSync(archonHome, { recursive: true });
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(unregisteredProject);

    try {
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: projectA }).status).toBe(0);
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: projectB }).status).toBe(0);
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: unregisteredProject }).status).toBe(0);
      const projectARoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectA,
        encoding: 'utf8',
      });
      const projectBRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectB,
        encoding: 'utf8',
      });
      expect(projectARoot.status).toBe(0);
      expect(projectBRoot.status).toBe(0);
      const env = {
        ...process.env,
        ARCHON_HOME: archonHome,
        ARCHON_TELEMETRY_DISABLED: '1',
        DATABASE_URL: '',
      };
      const initialize = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--all', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: initialize.status, stderr: initialize.stderr }).toEqual({
        status: 0,
        stderr: '',
      });

      const database = new Database(join(archonHome, 'archon.db'));
      try {
        const insertCodebase = database.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES (?, ?, ?)'
        );
        insertCodebase.run(
          'codebase-a',
          'fixture/a',
          await canonicalizeProjectPath(projectARoot.stdout.trim())
        );
        insertCodebase.run(
          'codebase-b',
          'fixture/b',
          await canonicalizeProjectPath(projectBRoot.stdout.trim())
        );

        const insertConversation = database.query(
          'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id) VALUES (?, ?, ?, ?)'
        );
        insertConversation.run('conversation-a', 'cli', 'cli-a', 'codebase-a');
        insertConversation.run('conversation-b', 'cli', 'cli-b', 'codebase-b');

        const insertRun = database.query(
          'INSERT INTO remote_agent_workflow_runs (id, conversation_id, codebase_id, workflow_name, user_message, status) VALUES (?, ?, ?, ?, ?, ?)'
        );
        insertRun.run(
          '00000000-0000-4000-8000-00000000000a',
          'conversation-a',
          'codebase-a',
          'project-a-work',
          'test',
          'running'
        );
        insertRun.run(
          '00000000-0000-4000-8000-00000000000b',
          'conversation-b',
          'codebase-b',
          'project-b-work',
          'test',
          'paused'
        );
        database
          .query('UPDATE remote_agent_conversations SET codebase_id = ? WHERE id = ?')
          .run('codebase-b', 'conversation-a');
      } finally {
        database.close();
      }

      const scoped = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: scoped.status, stderr: scoped.stderr }).toEqual({ status: 0, stderr: '' });
      const scopedJson = JSON.parse(scoped.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(scopedJson.scopeFallback).toBe(false);
      expect(scopedJson.runs.map(run => run.workflow_name)).toEqual(['project-a-work']);

      const otherProject = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', projectB],
        { cwd: projectB, env, encoding: 'utf8' }
      );
      expect({ status: otherProject.status, stderr: otherProject.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      const otherProjectJson = JSON.parse(otherProject.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(otherProjectJson.scopeFallback).toBe(false);
      expect(otherProjectJson.runs.map(run => run.workflow_name)).toEqual(['project-b-work']);

      const global = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--all', '--json', '--cwd', projectA],
        { cwd: projectA, env, encoding: 'utf8' }
      );
      expect({ status: global.status, stderr: global.stderr }).toEqual({ status: 0, stderr: '' });
      const globalJson = JSON.parse(global.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(globalJson.scopeFallback).toBe(false);
      expect(new Set(globalJson.runs.map(run => run.workflow_name))).toEqual(
        new Set(['project-a-work', 'project-b-work'])
      );

      const fallback = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--json', '--cwd', unregisteredProject],
        { cwd: unregisteredProject, env, encoding: 'utf8' }
      );
      expect({ status: fallback.status, stderr: fallback.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      const fallbackJson = JSON.parse(fallback.stdout) as {
        scopeFallback: boolean;
        runs: Array<{ workflow_name: string }>;
      };
      expect(fallbackJson.scopeFallback).toBe(true);
      expect(new Set(fallbackJson.runs.map(run => run.workflow_name))).toEqual(
        new Set(['project-a-work', 'project-b-work'])
      );
    } finally {
      await removeTempTree(scratch);
    }
  }, 30_000);
});

describe('workflow get arguments', () => {
  it('rejects extra positional arguments', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'get', 'abc123', 'accidental-extra'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Usage: archon workflow get <run-id> [--json] [--verbose] [--events] [--throughput]'
    );
    expect(result.stdout).toBe('');
  });
});

describe('workflow logs arguments', () => {
  it.each([
    ['missing run id', ['workflow', 'logs']],
    ['extra positional', ['workflow', 'logs', 'abc123', 'accidental-extra']],
  ])('rejects %s', (_label, args) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'cli.ts'), ...args], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: archon workflow logs <run-id> [--follow]');
    expect(result.stdout).toBe('');
  });

  it.each([
    [
      '--json, because stdout is already raw JSONL',
      ['--json'],
      'workflow logs already emits JSONL',
    ],
    [
      '--json with --format text',
      ['--json', '--format', 'text'],
      'workflow logs already emits JSONL',
    ],
    ['an unknown --format', ['--format', 'yaml'], "--format must be 'jsonl' or 'text', got 'yaml'"],
  ])('rejects %s', (_label, flags, message) => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'logs', 'abc123', ...flags],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe('');
  });

  it('rejects the get-only --events mode', () => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dir, 'cli.ts'), 'workflow', 'logs', 'abc123', '--events'],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--events applies to workflow status/get');
    expect(result.stdout).toBe('');
  });
});

describe('CLI workflow event dispatch', () => {
  it('resolves a run prefix using the registered effective cwd', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'archon-cli-event-'));
    const archonHome = join(scratch, 'home');
    const repoDir = join(scratch, 'repo');
    mkdirSync(archonHome, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    try {
      expect(spawnSync('git', ['init', '-q', '.'], { cwd: repoDir }).status).toBe(0);
      const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: repoDir,
        encoding: 'utf8',
      });
      expect(repoRoot.status).toBe(0);

      const env = {
        ...process.env,
        ARCHON_HOME: archonHome,
        ARCHON_TELEMETRY_DISABLED: '1',
      };
      const initialize = spawnSync(
        process.execPath,
        [CLI_ENTRY, 'workflow', 'status', '--cwd', repoDir],
        { env, encoding: 'utf8' }
      );
      expect({ status: initialize.status, stderr: initialize.stderr }).toEqual({
        status: 0,
        stderr: '',
      });

      const fullRunId = '0b1ee8da-1111-2222-3333-444455556666';
      const database = new Database(join(archonHome, 'archon.db'));
      try {
        database.run(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES (?, ?, ?)',
          ['codebase-1', 'fixture', await canonicalizeProjectPath(repoRoot.stdout.trim())]
        );
        database.run(
          'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id) VALUES (?, ?, ?, ?)',
          ['conversation-1', 'cli', 'cli-fixture', 'codebase-1']
        );
        database.run(
          'INSERT INTO remote_agent_workflow_runs (id, conversation_id, codebase_id, workflow_name, user_message) VALUES (?, ?, ?, ?, ?)',
          [fullRunId, 'conversation-1', 'codebase-1', 'fixture', 'test']
        );
      } finally {
        database.close();
      }

      const emitted = spawnSync(
        process.execPath,
        [
          CLI_ENTRY,
          'workflow',
          'event',
          'emit',
          '--run-id',
          fullRunId.slice(0, 8),
          '--type',
          'workflow_started',
          '--cwd',
          repoDir,
        ],
        { env, encoding: 'utf8' }
      );
      expect({ status: emitted.status, stderr: emitted.stderr }).toEqual({ status: 0, stderr: '' });

      const verify = new Database(join(archonHome, 'archon.db'), { readonly: true });
      try {
        const event = verify
          .query<{ workflow_run_id: string; event_type: string }, []>(
            'SELECT workflow_run_id, event_type FROM remote_agent_workflow_events'
          )
          .get();
        expect(event).toEqual({
          workflow_run_id: fullRunId,
          event_type: 'workflow_started',
        });
      } finally {
        verify.close();
      }
    } finally {
      await removeTempTree(scratch);
    }
  }, 30_000);
});

// Test the argument parsing logic used in cli.ts
describe('CLI argument parsing', () => {
  const parseCliArgs = (
    args: string[]
  ): { values: Record<string, unknown>; positionals: string[] } => {
    return parseArgs({
      args,
      options: cliArgOptions,
      allowPositionals: true,
      strict: true,
    });
  };

  describe('isolation cleanup flags', () => {
    it('parses --merged and --include-closed in strict mode', () => {
      const { values } = parseCliArgs(['isolation', 'cleanup', '--merged', '--include-closed']);
      expect(values.merged).toBe(true);
      expect(values['include-closed']).toBe(true);
    });
  });

  describe('--cwd flag', () => {
    it('should parse --cwd with path', () => {
      const result = parseCliArgs(['--cwd', '/custom/path', 'workflow', 'list']);
      expect(result.values.cwd).toBe('/custom/path');
      expect(result.positionals).toEqual(['workflow', 'list']);
    });

    it('should default to process.cwd() when --cwd not provided', () => {
      const result = parseCliArgs(['workflow', 'list']);
      expect(result.values.cwd).toBe(process.cwd());
    });

    it('should handle --cwd after command (interleaved)', () => {
      const result = parseCliArgs(['workflow', '--cwd', '/path', 'list']);
      expect(result.values.cwd).toBe('/path');
      expect(result.positionals).toEqual(['workflow', 'list']);
    });
  });

  describe('--help flag', () => {
    it('should parse --help flag', () => {
      const result = parseCliArgs(['--help']);
      expect(result.values.help).toBe(true);
    });

    it('should parse -h short flag', () => {
      const result = parseCliArgs(['-h']);
      expect(result.values.help).toBe(true);
    });
  });

  describe('--follow flag', () => {
    it('parses workflow transcript follow mode', () => {
      const result = parseCliArgs(['workflow', 'logs', 'abc123', '--follow']);
      expect(result.values.follow).toBe(true);
    });
  });

  describe('--quiet and --verbose flags', () => {
    it('should parse --quiet flag', () => {
      const result = parseCliArgs(['--quiet', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
    });

    it('should parse -q short flag', () => {
      const result = parseCliArgs(['-q', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
    });

    it('should parse --verbose flag', () => {
      const result = parseCliArgs(['--verbose', 'workflow', 'list']);
      expect(result.values.verbose).toBe(true);
    });

    it('should parse -v short flag', () => {
      const result = parseCliArgs(['-v', 'workflow', 'list']);
      expect(result.values.verbose).toBe(true);
    });

    it('should parse both --quiet and --verbose when provided', () => {
      const result = parseCliArgs(['-q', '-v', 'workflow', 'list']);
      expect(result.values.quiet).toBe(true);
      expect(result.values.verbose).toBe(true);
      // Precedence (quiet > verbose) is enforced in cli.ts main(), not in parsing
    });
  });

  describe('workflow run arguments', () => {
    it('should parse --from flag for workflow run', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--branch',
        'test-adapters',
        '--from',
        'feature/extract-adapters',
      ]);
      expect(result.values.from).toBe('feature/extract-adapters');
    });

    it('should parse --from-branch flag for workflow run', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--branch',
        'test-adapters',
        '--from-branch',
        'feature/extract-adapters',
      ]);
      expect(result.values['from-branch']).toBe('feature/extract-adapters');
    });

    it('should parse --base flag for workflow run', () => {
      const result = parseCliArgs(['workflow', 'run', 'assist', '--base', 'epic/foo']);
      expect(result.values.base).toBe('epic/foo');
    });

    it('parses workflow dry-run flags', () => {
      const result = parseCliArgs([
        'workflow',
        'run',
        'assist',
        '--dry-run',
        '--stubs',
        'fixtures.yaml',
        '--stubs-init',
        'generated.yaml',
        '--default-stubs',
        '--exec-code',
        '--pause-at-gates',
      ]);

      expect(result.values['dry-run']).toBe(true);
      expect(result.values.stubs).toBe('fixtures.yaml');
      expect(result.values['stubs-init']).toBe('generated.yaml');
      expect(result.values['default-stubs']).toBe(true);
      expect(result.values['exec-code']).toBe(true);
      expect(result.values['pause-at-gates']).toBe(true);
    });
  });

  describe('unknown flags (#2769)', () => {
    it('rejects an unknown flag instead of dropping it', () => {
      expect(() => parseCliArgs(['--unknown', 'workflow', 'list'])).toThrow(/unknown option/i);
    });

    it('rejects a typoed flag like --cwdd', () => {
      expect(() => parseCliArgs(['--cwdd', '/path', 'workflow', 'list'])).toThrow(/--cwdd/);
    });
  });

  describe('setup --scope and --force flags (#1303)', () => {
    it('parses --scope home', () => {
      const result = parseCliArgs(['setup', '--scope', 'home']);
      expect(result.values.scope).toBe('home');
    });

    it('parses --scope project', () => {
      const result = parseCliArgs(['setup', '--scope', 'project']);
      expect(result.values.scope).toBe('project');
    });

    it('defaults --scope to undefined when not provided', () => {
      const result = parseCliArgs(['setup']);
      expect(result.values.scope).toBeUndefined();
    });

    it('parses --force as boolean', () => {
      const result = parseCliArgs(['setup', '--force']);
      expect(result.values.force).toBe(true);
    });
  });
});

describe('Conversation ID generation', () => {
  it('should generate ID with cli- prefix', () => {
    const id = generateConversationId();
    expect(id.startsWith('cli-')).toBe(true);
  });

  it('should generate 100 unique IDs in the same millisecond even with repeated Math.random values', () => {
    const clock = spyOn(Date, 'now').mockReturnValue(123);
    const random = spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateConversationId());
      }
      expect(ids.size).toBe(100);
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });
});

// All --json error-envelope tests share one contract: exit 1 and a parseable
// `{ ok: false }` payload on stdout via the shared writeJsonLine catch path.
// One helper owns the spawn env and envelope access so every case pays setup
// once instead of repeating it; each test still drives its own invocation so
// the subprocess stdout/exit-code contract stays covered.
//
// The helper owns an ARCHON_HOME because these spawns are real CLI processes:
// the no-git folder-project gate opens the Archon registry to decide whether an
// unregistered directory is a folder project, before it refuses the command.
// Inheriting the ambient home aimed that at the operator's ~/.archon, so the
// tests both mutated real state and queued behind whoever else held it. The
// registry sets `PRAGMA busy_timeout = 5000` — the same number as Bun's
// implicit per-test budget — so a contended open can spend the whole budget
// waiting: holding a write lock for 3 s made this command take 3.41 s, and an
// 8 s lock took it to the 5.54 s ceiling. A private registry removes the
// contention, and seeding it once below keeps schema creation out of every
// timed body (#2982).
let jsonEnvelopeHome: string;
let cliTestHome: string;
// A git repo holding one workflow, so discovery results never depend on this checkout.
let listRepo: string;
const LONG_DESCRIPTION = 'Describes a workflow at length. '.repeat(8).trim();
let inheritedHome: string | undefined;
let inheritedDocker: string | undefined;
let inheritedWorkspace: string | undefined;

function spawnJsonError(argv: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHON_TELEMETRY_DISABLED: '1',
      ARCHON_HOME: jsonEnvelopeHome,
      ...extraEnv,
    },
  });
  return { status: result.status, envelope: () => JSON.parse(result.stdout ?? '') };
}

beforeAll(() => {
  cliTestHome = mkdtempSync(join(tmpdir(), 'archon-cli-test-home-'));
  inheritedHome = process.env.ARCHON_HOME;
  inheritedDocker = process.env.ARCHON_DOCKER;
  inheritedWorkspace = process.env.WORKSPACE_PATH;
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  process.env.ARCHON_HOME = cliTestHome;
  jsonEnvelopeHome = mkdtempSync(join(tmpdir(), 'archon-json-envelope-home-'));
  listRepo = mkdtempSync(join(tmpdir(), 'archon-cli-list-repo-'));
  spawnSync('git', ['init', '-q', '.'], { cwd: listRepo });
  mkdirSync(join(listRepo, '.archon', 'workflows'), { recursive: true });
  writeFileSync(
    join(listRepo, '.archon', 'workflows', 'described.yaml'),
    `name: described\ndescription: ${LONG_DESCRIPTION}\nnodes:\n  - id: a\n    prompt: hi\n`
  );

  // Build the registry once, here, so no timed body below pays for creating it.
  // Seeding through `spawnJsonError` rather than a bespoke spawn is deliberate:
  // it makes this also the check that the helper hands its ARCHON_HOME to the
  // child. If that wiring is ever dropped, no registry appears in the scratch
  // home and this throws, instead of every case below quietly falling back to
  // the operator's registry again.
  const seed = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()]);
  if (!existsSync(join(jsonEnvelopeHome, 'archon.db'))) {
    throw new Error(
      `--json envelope tests could not seed a scratch registry in ${jsonEnvelopeHome}.\n` +
        `status=${String(seed.status)}\n${JSON.stringify(seed.envelope())}`
    );
  }
});

afterAll(async () => {
  if (inheritedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = inheritedHome;
  if (inheritedDocker === undefined) delete process.env.ARCHON_DOCKER;
  else process.env.ARCHON_DOCKER = inheritedDocker;
  if (inheritedWorkspace === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = inheritedWorkspace;
  await removeTempTree(cliTestHome);
  if (jsonEnvelopeHome) await removeTempTree(jsonEnvelopeHome);
  if (listRepo) await removeTempTree(listRepo);
});

describe('workflow list arguments', () => {
  it('dispatches a named full-description request', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'described',
      '--full',
      '--json',
      '--cwd',
      listRepo,
    ]);

    expect(status).toBe(0);
    const output = envelope() as {
      workflows: Array<{
        name: string;
        description: string;
        descriptionTruncated: boolean;
      }>;
      errors: unknown[];
    };
    expect(output.workflows).toHaveLength(1);
    expect(output.workflows[0].name).toBe('described');
    expect(output.workflows[0].description).toBe(LONG_DESCRIPTION);
    expect(output.workflows[0].descriptionTruncated).toBe(false);
  });

  // Core no longer registers providers, so the CLI route default is what makes a
  // provider-scoped workflow parse.
  it('registers providers before discovering workflows', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'archon-cli-provider-route-'));
    try {
      mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
      spawnSync('git', ['init', '-q', '.'], { cwd: repo });
      writeFileSync(
        join(repo, '.archon', 'workflows', 'scoped.yaml'),
        'name: scoped\ndescription: Provider scoped.\nprovider: claude\nnodes:\n  - id: a\n    prompt: hi\n'
      );
      const { status, envelope } = spawnJsonError([
        'workflow',
        'list',
        'scoped',
        '--json',
        '--cwd',
        repo,
      ]);

      expect(status).toBe(0);
      const output = envelope() as { workflows: Array<{ name: string }>; errors: unknown[] };
      expect(output.errors).toEqual([]);
      expect(output.workflows.map(w => w.name)).toEqual(['scoped']);
    } finally {
      await removeTempTree(repo);
    }
  });

  it('rejects extra positionals with human-readable usage', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'list', 'first', 'second', '--cwd', listRepo],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_TELEMETRY_DISABLED: '1',
          ARCHON_HOME: jsonEnvelopeHome,
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: archon workflow list [name] [--full] [--json]');
    expect(result.stdout).toBe('');
  });

  it('rejects extra positionals with one JSON error envelope', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'first',
      'second',
      '--json',
      '--cwd',
      listRepo,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toEqual({
      ok: false,
      error: 'Usage: archon workflow list [name] [--full] [--json]',
    });
  });

  it('reports an unknown workflow through the JSON error envelope', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'list',
      'definitely-not-a-workflow',
      '--json',
      '--cwd',
      listRepo,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({
      ok: false,
      error: expect.stringContaining("Workflow 'definitely-not-a-workflow' not found"),
    });
  });

  it('preserves discovery errors in a missing-workflow JSON error envelope', async () => {
    const scratchRepo = mkdtempSync(join(tmpdir(), 'archon-workflow-list-errors-'));
    try {
      const gitInit = spawnSync('git', ['init', '--quiet', scratchRepo], { encoding: 'utf8' });
      expect(gitInit.status).toBe(0);
      const workflowDir = join(scratchRepo, '.archon', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, 'broken.yaml'), 'name: broken\nnodes: [\n');

      const { status, envelope } = spawnJsonError([
        'workflow',
        'list',
        'definitely-not-a-workflow',
        '--json',
        '--cwd',
        scratchRepo,
      ]);

      expect(status).toBe(1);
      expect(envelope()).toMatchObject({
        ok: false,
        error: expect.stringContaining("Workflow 'definitely-not-a-workflow' not found"),
        errors: [
          {
            filename: 'broken.yaml',
            errorType: 'parse_error',
          },
        ],
      });
    } finally {
      await removeTempTree(scratchRepo);
    }
  });
});

describe('main catch --json error envelope', () => {
  it('emits { ok: false } on stdout when an unhandled command error reaches the top-level catch', () => {
    // An unknown workflow name makes workflowRunCommand throw with no local
    // handling, so the error escapes to main()'s outer catch — the last route
    // that could still leak bare stderr text under --json.
    //
    // `--dry-run` is not part of the contract; it is how this test avoids
    // paying for one. A real run freezes the workflow source BEFORE resolving
    // the name (workflow-run-admission.ts: selectRunWorkflow captures the source before
    // resolveWorkflowName, deliberately — discovery must read the frozen
    // bytes, #2660/#2747), so without the flag this single spawn copies and
    // digests every project, global, and bundled workflow file the run can
    // see — thousands of filesystem operations, and growing — then deletes
    // them, only to report that the workflow does not exist. The throw, its
    // route to main()'s catch, and the envelope are identical either way.
    const { status, envelope } = spawnJsonError([
      'workflow',
      'run',
      'definitely-not-a-workflow',
      '--json',
      '--dry-run',
      '--cwd',
      listRepo,
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('pre-dispatch gates --json error envelope', () => {
  it('emits { ok: false } on stdout when --cwd does not exist', () => {
    const { status, envelope } = spawnJsonError([
      'workflow',
      'run',
      'anything',
      '--json',
      '--cwd',
      '/does/not/exist',
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
    // The path is printed as the platform resolves it (a drive letter on Windows), so only
    // the refusal itself is asserted.
    expect(envelope().error).toContain('Directory does not exist');
  });

  it('emits { ok: false } on stdout when outside a git repository', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
    expect(envelope().error).toContain('Not in a git repository');
  });

  it('lets workflow attention past the git gate in every scope', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'archon-attention-outside-'));
    try {
      const project = projectKeyForCodebase(null, await canonicalizeProjectPath(outside));
      for (const scope of [['--all'], ['--project', project], []]) {
        const { status, envelope } = spawnJsonError([
          'workflow',
          'attention',
          ...scope,
          '--json',
          '--cwd',
          outside,
        ]);

        expect({ status, envelope: envelope() }).toMatchObject({
          status: 0,
          envelope: { ok: true, action: 'attention', items: [] },
        });
      }
    } finally {
      await removeTempTree(outside);
    }
  });

  it('leaves the default home untouched when the gate opens the registry', async () => {
    // Same command as the case above — the one route here that opens the
    // registry — but with the child's home directory pointed at a scratch tree,
    // so `<sentinel>/.archon` is what `getArchonHome()` would resolve to if the
    // helper's ARCHON_HOME stopped reaching the child. It must stay absent: the
    // registry belongs in the test-owned home, never the ambient one.
    const sentinel = mkdtempSync(join(tmpdir(), 'archon-json-envelope-sentinel-'));
    try {
      const { status } = spawnJsonError(['workflow', 'list', '--json', '--cwd', tmpdir()], {
        HOME: sentinel,
        USERPROFILE: sentinel,
      });

      expect(status).toBe(1);
      expect(existsSync(join(sentinel, '.archon'))).toBe(false);
      expect(existsSync(join(jsonEnvelopeHome, 'archon.db'))).toBe(true);
    } finally {
      await removeTempTree(sentinel);
    }
  });

  it('emits { ok: false } on stdout for an unknown command instead of usage text', () => {
    const { status, envelope } = spawnJsonError(['boguscmd', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when arg parsing rejects an unknown flag', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'list', '--json', '--bogus-flag']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it.each(['', 'hello'])('refuses unsupported chat JSON output with message %j', message => {
    const { status, envelope } = spawnJsonError(['chat', message, '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout for an invalid setup --scope', () => {
    const { status, envelope } = spawnJsonError(['setup', '--scope', 'bogus', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when workflow get is missing its run-id', () => {
    const { status, envelope } = spawnJsonError(['workflow', 'get', '--json']);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });

  it('emits { ok: false } on stdout when setup --scope project runs outside a git repo', () => {
    const { status, envelope } = spawnJsonError([
      'setup',
      '--scope',
      'project',
      '--json',
      '--cwd',
      tmpdir(),
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('workflow run flag conflicts', () => {
  const missingSource = join(tmpdir(), 'archon-missing-workflow-source');
  const cases: [string, string[], string][] = [
    [
      'branch with no-worktree',
      ['--branch', 'b', '--no-worktree'],
      'Error: --branch and --no-worktree are mutually exclusive.\n' +
        '  --branch creates an isolated worktree (safe).\n' +
        '  --no-worktree runs directly in your repo (no isolation).\n' +
        'Use one or the other.',
    ],
    [
      'from with no-worktree',
      ['--no-worktree', '--from', 'main'],
      'Error: --from/--from-branch has no effect with --no-worktree.\n' +
        'Remove --from or drop --no-worktree.',
    ],
    [
      'base with no-worktree',
      ['--no-worktree', '--base', 'main'],
      'Error: --base has no effect with --no-worktree.\nRemove --base or drop --no-worktree.',
    ],
    [
      'workflow-source with container',
      ['--workflow-source', tmpdir(), '--container'],
      'Error: --workflow-source and --container are mutually exclusive.\n' +
        '  A container run reads source from the project it mounts.\n' +
        '  Run without --container to execute source from another directory.',
    ],
    [
      'workflow-source that is not a directory',
      ['--workflow-source', missingSource],
      `Error: --workflow-source is not a directory: ${missingSource}\n` +
        '  Point it at the checkout holding .archon/workflows/.',
    ],
    [
      'the first conflict when several apply',
      ['--branch', 'b', '--no-worktree', '--from', 'main'],
      'Error: --branch and --no-worktree are mutually exclusive.\n' +
        '  --branch creates an isolated worktree (safe).\n' +
        '  --no-worktree runs directly in your repo (no isolation).\n' +
        'Use one or the other.',
    ],
  ];

  for (const [name, flags, error] of cases) {
    it(`refuses ${name}`, () => {
      const { status, envelope } = spawnJsonError([
        'workflow',
        'run',
        'x',
        ...flags,
        '--json',
        '--cwd',
        listRepo,
      ]);

      expect({ status, envelope: envelope() }).toEqual({
        status: 1,
        envelope: { ok: false, error },
      });
    });
  }
});

describe('workflow argument refusals', () => {
  const cases: [string, string[], string][] = [
    [
      'extra reset-sessions positionals',
      ['reset-sessions', 'wf', 'planner'],
      'unexpected positional argument(s): planner',
    ],
    [
      'a non-positive wait timeout',
      ['wait', 'some-run-id', '--timeout', '0'],
      '--timeout must be a positive number',
    ],
    ['a non-positive runs limit', ['runs', '--limit', '0'], '--limit must be a positive integer'],
  ];

  for (const [name, args, error] of cases) {
    it(`refuses ${name}`, () => {
      const { status, envelope } = spawnJsonError([
        'workflow',
        ...args,
        '--json',
        '--cwd',
        listRepo,
      ]);

      expect({ status, envelope: envelope() }).toMatchObject({
        status: 1,
        envelope: { ok: false, error: expect.stringContaining(error) },
      });
    });
  }
});

describe('workflow test --json error envelope', () => {
  it('emits { ok: false } on stdout when the command throws under --json', () => {
    // A --cwd that does not exist makes findRepoRoot throw inside the
    // `workflow test` handler — the only reachable error path without a full
    // fixture project. The envelope, not the message, is the contract.
    const { status, envelope } = spawnJsonError([
      'workflow',
      'test',
      '--json',
      '--cwd',
      join(tmpdir(), 'archon-missing-cwd'),
    ]);

    expect(status).toBe(1);
    expect(envelope).not.toThrow();
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe('log output channel (#3444)', () => {
  // The contract is the split between the process's stdout and stderr, so the
  // CLI runs as a subprocess.
  const logRecords = (text: string): Record<string, unknown>[] =>
    text
      .split('\n')
      .filter(line => line.startsWith('{"level"'))
      .map(line => JSON.parse(line) as Record<string, unknown>);

  it('keeps log records off stdout and loader warnings out of a default listing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-cli-log-channel-'));
    const repo = join(root, 'repo');
    const workflows = join(repo, '.archon', 'workflows');
    mkdirSync(workflows, { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    writeFileSync(
      join(workflows, 'listed.yaml'),
      'name: listed\ndescription: The listed workflow.\nnodes:\n  - id: a\n    bash: echo a\n'
    );
    // Another workflow with an authoring problem: discovery parses it on every listing,
    // which must not log it at the default level. `validate` rendering such a parse
    // warning is proved in commands/validate.test.ts.
    writeFileSync(
      join(workflows, 'typo.yaml'),
      'name: typo\ndescription: Has a typo.\nnodes:\n  - id: b\n    bash: echo b\n    contxt: fresh\n'
    );
    // A problem only the log reports: it must stay visible, on stderr.
    writeFileSync(
      join(workflows, 'bad-tags.yaml'),
      'name: bad-tags\ndescription: Bad tags.\ntags: nope\nnodes:\n  - id: c\n    bash: echo c\n'
    );
    const run = (
      args: string[],
      logLevel = ''
    ): { status: number | null; stdout: string; stderr: string } =>
      spawnSync(process.execPath, [CLI_ENTRY, ...args], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_HOME: join(root, 'home'),
          ARCHON_TELEMETRY_DISABLED: '1',
          DATABASE_URL: '',
          LOG_LEVEL: logLevel,
        },
      });

    try {
      const listed = run(['workflow', 'list', 'listed', '--full']);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain('The listed workflow.');
      expect(logRecords(listed.stdout)).toEqual([]);
      expect(logRecords(listed.stderr).map(r => [r.level, r.msg])).toEqual([
        [40, 'invalid_tags_block_ignored'],
      ]);

      // An explicit quieter level is not raised to the warn default.
      const quieter = run(['workflow', 'list', 'listed'], 'error');
      expect(quieter.status).toBe(0);
      expect(logRecords(quieter.stderr)).toEqual([]);

      const verbose = run(['workflow', 'list', 'listed', '--verbose']);
      expect(verbose.status).toBe(0);
      expect(logRecords(verbose.stdout)).toEqual([]);
      expect(logRecords(verbose.stderr)).toContainEqual(
        expect.objectContaining({ level: 20, msg: 'node_unknown_key_ignored' })
      );
    } finally {
      await removeTempTree(root);
    }
  }, 30_000);
});

it('CLI cleanup retains historical Telegram workspaces with no adapter credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-cli-retention-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const worktree = join(root, 'worktree');
  mkdirSync(repo);
  mkdirSync(home);
  try {
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    expect(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-qm',
          'initial',
        ],
        { cwd: repo }
      ).status
    ).toBe(0);
    expect(
      spawnSync('git', ['worktree', 'add', '-qb', 'retained', worktree], { cwd: repo }).status
    ).toBe(0);
    const db = new SqliteAdapter(join(home, 'archon.db'));
    try {
      await db.query(
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb', 'repo', $1)",
        [repo]
      );
      await db.query(
        "INSERT INTO remote_agent_isolation_environments (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform, created_at) VALUES ('retained', 'cb', 'thread', 'chat', 'worktree', $1, 'retained', 'telegram', datetime('now', '-30 days'))",
        [worktree]
      );
    } finally {
      await db.close();
    }
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'isolation', 'cleanup', '7', '--cwd', repo],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_HOME: home,
          ARCHON_TELEMETRY_DISABLED: '1',
          DATABASE_URL: '',
          TELEGRAM_BOT_TOKEN: '',
          SLACK_BOT_TOKEN: '',
          DISCORD_BOT_TOKEN: '',
        },
      }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No stale worktree environments found.');
    expect(existsSync(worktree)).toBe(true);
    const verify = new Database(join(home, 'archon.db'), { readonly: true });
    try {
      expect(
        verify
          .query("SELECT status FROM remote_agent_isolation_environments WHERE id = 'retained'")
          .get()
      ).toEqual({ status: 'active' });
    } finally {
      verify.close();
    }
  } finally {
    await removeTempTree(root);
  }
});

it('CLI complete ignores an unrelated legacy codebase path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-cli-complete-legacy-'));
  const repo = join(root, 'repo');
  try {
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    const db = new SqliteAdapter(join(root, 'archon.db'));
    try {
      for (const [id, cwd] of [
        ['target', await canonicalizeProjectPath(repo)],
        ['legacy', './old-repo'],
      ]) {
        await db.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $1, $2)',
          [id, cwd]
        );
        await db.query(
          `INSERT INTO remote_agent_isolation_environments
           (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, created_by_platform)
           VALUES ($1, $1, 'task', $1, 'worktree', $2, $1, 'cli')`,
          [id, join(root, id)]
        );
      }
    } finally {
      await db.close();
    }
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'complete', 'target', '--force'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARCHON_HOME: root,
        ARCHON_TELEMETRY_DISABLED: '1',
        DATABASE_URL: '',
      },
    });
    expect({ stdout: result.stdout, stderr: result.stderr, status: result.status }).toMatchObject({
      stdout: expect.stringContaining('Complete: 1 completed, 0 failed, 0 not found'),
      status: 0,
    });
    const verify = new Database(join(root, 'archon.db'), { readonly: true });
    try {
      expect(
        verify.query('SELECT id, status FROM remote_agent_isolation_environments ORDER BY id').all()
      ).toEqual([
        { id: 'legacy', status: 'active' },
        { id: 'target', status: 'destroyed' },
      ]);
    } finally {
      verify.close();
    }
  } finally {
    await removeTempTree(root);
  }
});

it('CLI complete returns failure after reporting an ambiguous branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-cli-complete-'));
  try {
    const db = new SqliteAdapter(join(root, 'archon.db'));
    try {
      for (const id of ['first', 'second']) {
        await db.query(
          'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $1, $2)',
          [id, root]
        );
        await db.query(
          `INSERT INTO remote_agent_isolation_environments
           (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name)
           VALUES ($1, $1, 'task', $1, 'worktree', $2, 'shared')`,
          [id, join(root, id)]
        );
      }
    } finally {
      await db.close();
    }
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'complete', 'shared', 'absent', '--force'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_HOME: root,
          ARCHON_TELEMETRY_DISABLED: '1',
          DATABASE_URL: '',
        },
      }
    );
    expect({ stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      stdout: expect.stringContaining('Complete: 0 completed, 1 failed, 1 not found'),
    });
    expect(result.stderr).toContain('multiple active environments');
    expect(result.status).toBe(1);
  } finally {
    await removeTempTree(root);
  }
});

describe('registration base branch parsing', () => {
  it('rejects the registration flag outside workflow run and project add', () => {
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'version', '--base-branch', 'release', '--json'],
      { encoding: 'utf8', env: { ...process.env, ARCHON_TELEMETRY_DISABLED: '1' } }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('--base-branch is only supported by workflow run');
  });
  for (const choice of [['--base-branch', 'release'], ['--base-branch=release']]) {
    it(`keeps ${choice[0]} distinct from the dispatch base`, () => {
      const { values } = parseArgs({
        args: ['workflow', 'run', 'deliver', ...choice, '--base', 'dev'],
        options: cliArgOptions,
        allowPositionals: true,
      });
      expect(values['base-branch']).toBe('release');
      expect(values.base).toBe('dev');
    });
  }
});

describe('compiled CLI update notices', () => {
  const cases = [
    { args: ['workflow', 'run'], notice: true, status: 1 },
    { args: ['workflow', 'resume'], notice: true, status: 1 },
    { args: ['version'], notice: false, status: 0 },
    { args: ['workflow', 'run', '--quiet'], notice: false, status: 1 },
    { args: ['workflow', 'run', '--json'], notice: false, status: 1 },
    { args: ['workflow', 'run'], notice: false, status: 1, stale: true },
    { args: ['workflow', 'run'], notice: false, status: 1, stale: true, pending: true },
    { args: ['workflow', 'run'], notice: false, status: 1, source: true },
    {
      args: ['workflow', 'run', '--internal-detached-run-config', 'invalid'],
      notice: true,
      status: 1,
    },
  ];
  for (const entry of cases) {
    it(`${entry.args.join(' ')} ${entry.pending ? 'with a pending network request' : entry.source ? 'in a source build' : entry.stale ? 'offline with stale cache' : 'with fresh cache'}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-cli-update-'));
      const preload = join(root, 'preload.ts');
      writeFileSync(
        join(root, 'update-check.json'),
        JSON.stringify({
          latestVersion: '99.0.0',
          releaseUrl: 'https://example.com/release',
          checkedAt: entry.stale ? 0 : Date.now(),
        })
      );
      writeFileSync(
        preload,
        `import { mock } from 'bun:test';
const bundledBuild = await import(${JSON.stringify(join(repoRoot, 'packages/paths/src/bundled-build.ts'))});
mock.module(${JSON.stringify(join(repoRoot, 'packages/paths/src/bundled-build.ts'))}, () => ({
  ...bundledBuild,
  BUNDLED_IS_BINARY: ${!entry.source}, BUNDLED_VERSION: '0.11.1', BUNDLED_GIT_COMMIT: 'test', BUNDLED_WEB_DIST_SHA256: '',
}));
globalThis.fetch = () => ${entry.pending ? 'new Promise(() => {})' : "Promise.reject(new Error('Network unavailable'))"};
`
      );
      try {
        const result = spawnSync(
          process.execPath,
          ['--preload', preload, CLI_ENTRY, ...entry.args, '--cwd', join(root, 'missing')],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, ARCHON_HOME: root, ARCHON_TELEMETRY_DISABLED: '1' },
          }
        );
        expect({ status: result.status, stderr: result.stderr }).toMatchObject({
          status: entry.status,
        });
        expect(result.stderr.includes('Update available:')).toBe(entry.notice);
        if (entry.notice) {
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('brew upgrade archon');
          expect(result.stderr).toContain('https://archon.diy/getting-started/updating/');
        }
        if (entry.args.includes('--json')) expect(JSON.parse(result.stdout).ok).toBe(false);
      } finally {
        await removeTempTree(root);
      }
    });
  }
});

describe('receipt policies in the CLI host', () => {
  it('plugin list and remove remain reachable with an incompatible provider receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-protocol-recovery-'));
    const home = join(root, 'home');
    const id = 'owner/stale-provider';
    const file = receiptPath(join(home, 'plugins'), id);
    const { claudeDescriptor } = await import('@archon/providers');
    mkdirSync(join(home, 'plugins', 'installed', 'owner', 'stale-provider'), { recursive: true });
    const contents = JSON.stringify({
      schemaVersion: 1,
      id,
      manifest: {
        schemaVersion: 1,
        kind: 'provider',
        name: 'stale-provider',
        description: 'test',
        executable: 'archon-provider-claude',
      },
      tag: 'v1',
      commit: 'a'.repeat(40),
      installedAt: new Date(0).toISOString(),
      files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
      descriptor: { ...claudeDescriptor, protocol: 1 },
    });
    writeFileSync(file, contents);
    const run = (args: string[]) =>
      spawnSync(process.execPath, [CLI_ENTRY, 'plugin', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_HOME: home,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
      });
    try {
      const listed = run(['list']);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain(`${id}  unavailable  Plugin unavailable:`);
      expect(readFileSync(file, 'utf8')).toBe(contents);
      const removed = run(['remove', id]);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toContain(`Removed the unavailable receipt of ${id}`);
      expect(existsSync(file)).toBe(false);
    } finally {
      await removeTempTree(root);
    }
  });

  it.each(['--version', '-V', '-v', '-version', 'version', '--cwd . --version'])(
    '%s works with a malformed installed receipt',
    async command => {
      const root = mkdtempSync(join(tmpdir(), 'cli-version-receipt-'));
      const home = join(root, 'home');
      const file = receiptPath(join(home, 'plugins'), 'owner/broken');
      mkdirSync(join(home, 'plugins', 'installed', 'owner', 'broken'), { recursive: true });
      writeFileSync(file, '{invalid json');
      try {
        const result = spawnSync(process.execPath, [CLI_ENTRY, ...command.split(' ')], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: home,
            DATABASE_URL: '',
            ARCHON_TELEMETRY_DISABLED: '1',
          },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Archon CLI v');
        expect(result.stderr).not.toContain(file);
      } finally {
        await removeTempTree(root);
      }
    }
  );

  it('reads -v before a command as --verbose, not as a version request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-verbose-not-version-'));
    expect(spawnSync('git', ['init', '-q', '.'], { cwd: root }).status).toBe(0);
    try {
      const result = spawnSync(process.execPath, [CLI_ENTRY, '-v', 'workflow', 'list'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_HOME: join(root, 'home'),
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
      });
      // The command ran (a parse rejection exits 1) with debug logging on, which
      // only --verbose enables; commands default to warn.
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('"level":20');
      expect(`${result.stdout}${result.stderr}`).not.toContain('Archon CLI v');
    } finally {
      await removeTempTree(root);
    }
  });

  it(
    'registers a receipt without executing its binary, then keeps and reports its workspace after removal',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cli-chat-policy-'));
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      const executable = join(home, 'plugins', 'archon-chat-fixture');
      const marker = join(root, 'executed');
      const file = receiptPath(join(home, 'plugins'), 'owner/chat-fixture');
      mkdirSync(join(home, 'plugins', 'installed', 'owner', 'chat-fixture'), { recursive: true });
      mkdirSync(workspace);
      mkdirSync(join(workspace, '.git'));
      writeFileSync(
        executable,
        `#!/bin/sh\necho executed > '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`,
        { mode: 0o755 }
      );
      const receipt = {
        schemaVersion: 1,
        id: 'owner/chat-fixture',
        manifest: {
          schemaVersion: 1,
          kind: 'chat',
          name: 'fixture',
          description: 'Fixture',
          executable: 'archon-chat-fixture',
        },
        tag: 'v1',
        commit: 'a'.repeat(40),
        installedAt: new Date(0).toISOString(),
        files: [
          {
            path: 'archon-chat-fixture' + (process.platform === 'win32' ? '.exe' : ''),
            sha256: 'b'.repeat(64),
          },
        ],
        descriptor: {
          protocol: 'archon-chat/1',
          id: 'slack',
          displayName: 'Fixture',
          version: '1',
          capabilities: { defaultWorkflowDispatch: 'background' },
          policy: { workspaceRetention: 'retain' },
        },
      };
      writeFileSync(file, JSON.stringify(receipt));
      const db = new SqliteAdapter(join(home, 'archon.db'));
      const run = () =>
        spawnSync(process.execPath, [CLI_ENTRY, 'isolation', 'cleanup'], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: home,
            DATABASE_URL: '',
            ARCHON_TELEMETRY_DISABLED: '1',
          },
        });
      try {
        await db.query(
          "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb', 'fixture', $1)",
          [workspace]
        );
        await db.query(
          `INSERT INTO remote_agent_isolation_environments
        (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status, created_by_platform, created_at)
        VALUES ('env', 'cb', 'thread', 'fixture', 'worktree', $1, 'fixture', 'active', 'slack', datetime('now', '-30 days'))`,
          [workspace]
        );
        const registered = run();
        expect(registered.status).toBe(0);
        expect(registered.stdout).toContain('No stale worktree environments found.');
        expect(registered.stdout).not.toContain('not registered');
        expect(registered.stdout).not.toContain('Reconciled');
        expect(existsSync(marker)).toBe(false);
        receipt.descriptor.id = 'matrix-chat';
        writeFileSync(file, JSON.stringify(receipt));
        await db.query(
          "UPDATE remote_agent_isolation_environments SET created_by_platform = 'matrix-chat' WHERE id = 'env'",
          []
        );
        const installed = run();
        expect(installed.status).toBe(0);
        expect(installed.stdout).toContain('No stale worktree environments found.');
        expect(installed.stdout).not.toContain('not registered');
        await import('node:fs/promises').then(fs => fs.unlink(file));
        await removeTempTree(workspace);
        const removed = run();
        expect(removed.status).toBe(0);
        expect(removed.stdout).toContain("platform 'matrix-chat' is not registered");
        expect(removed.stdout).not.toContain('Reconciled');
        expect(
          (
            await db.query<{ status: string }>(
              "SELECT status FROM remote_agent_isolation_environments WHERE id = 'env'",
              []
            )
          ).rows[0]?.status
        ).toBe('active');
        expect(existsSync(marker)).toBe(false);
      } finally {
        await db.close();
        await removeTempTree(root);
      }
    },
    testTimeout(60_000)
  );
});

describe('retained Pi process-error routing', () => {
  it.each(['unhandledRejection', 'uncaughtException'] as const)(
    'routes %s to the extension turn without exiting the CLI',
    async event => {
      const root = mkdtempSync(join(tmpdir(), 'archon-cli-pi-error-'));
      const preload = join(root, 'preload.ts');
      writeFileSync(
        preload,
        `
import { mock } from 'bun:test';
const bundledPath = ${JSON.stringify(join(repoRoot, 'packages/paths/src/bundled-build.ts'))};
const bundled = await import(bundledPath);
mock.module(bundledPath, () => ({ ...bundled, BUNDLED_IS_BINARY: true }));
mock.module('@archon/core/providers/register-host-providers', () => ({ registerHostProviders: async () => {} }));
const { beginPiExtensionTurn } = await import(${JSON.stringify(join(repoRoot, 'packages/providers/src/community/pi/extension-error-broker.ts'))});
mock.module(${JSON.stringify(join(repoRoot, 'packages/cli/src/commands/ai.ts'))}, () => ({
  aiListCommand: async () => {
    const turn = beginPiExtensionTurn(['/extensions/review.ts']);
    const error = new Error('extension callback failed');
    error.stack = 'Error: extension callback failed\\n    at callback (/extensions/review.ts:12:3)';
    try {
      process.emit('${event}', error${event === 'unhandledRejection' ? ', Promise.resolve()' : ", 'uncaughtException'"});
      try { turn.throwIfFailed(); } catch (failure) {
        if (failure === error) { console.log('extension turn failed; host alive'); return 0; }
        throw failure;
      }
      throw new Error('extension error was not routed');
    } finally { turn.close(); }
  },
}));
`
      );
      try {
        const result = spawnSync(
          process.execPath,
          ['--no-env-file', '--preload', preload, CLI_ENTRY, 'ai', 'list'],
          {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: testTimeout(10_000),
            env: { ...process.env, ARCHON_HOME: root, ARCHON_TELEMETRY_DISABLED: '1' },
          }
        );
        expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
        expect(result.stdout).toContain('extension turn failed; host alive');
      } finally {
        await removeTempTree(root);
      }
    }
  );
});

describe('setup provider selection dispatch', () => {
  const cases = [
    { name: 'flag', args: ['--providers', 'codex'], env: '', selected: ['codex'] },
    { name: 'environment', args: [], env: ' codex, pi ', selected: ['codex', 'pi'] },
    { name: 'flag precedence', args: ['--providers', 'codex'], env: 'claude', selected: ['codex'] },
    { name: 'explicit empty flag', args: ['--providers='], env: 'claude', selected: [] },
    { name: 'empty environment', args: [], env: '', selected: [] },
    { name: 'invalid environment', args: [], env: 'codex,unknown', selected: null },
  ];
  for (const entry of cases) {
    it(`forwards ${entry.name} through setup validation without prompting`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'archon-setup-dispatch-'));
      const cwd = join(root, 'repo');
      mkdirSync(cwd);
      const preload = join(root, 'preload.ts');
      writeFileSync(join(root, '.env'), 'GITHUB_TOKEN=file-token\n');
      writeFileSync(
        preload,
        `
import { mock } from 'bun:test';
mock.module('@archon/core/providers/register-host-providers', () => ({ registerHostProviders: async () => {} }));
const setupPath = ${JSON.stringify(join(repoRoot, 'packages/cli/src/commands/setup.ts'))};
const { selectSetupProviders } = await import(${JSON.stringify(join(repoRoot, 'packages/cli/src/commands/setup-ai.ts'))});
mock.module(setupPath, () => ({
  setupCommand: async options => {
    let prompts = 0;
    const installs = [];
    try {
      const selected = await selectSetupProviders(options.providers,
        async ids => { installs.push(...ids); },
        async () => { prompts++; return ['claude']; });
      console.log(JSON.stringify({ providers: options.providers, selected, installs, prompts, inheritedToken: options.inheritedEnv?.GITHUB_TOKEN, effectiveToken: process.env.GITHUB_TOKEN }));
      return 0;
    } catch (error) {
      console.log(JSON.stringify({ error: error.message, installs, prompts, inheritedToken: options.inheritedEnv?.GITHUB_TOKEN, effectiveToken: process.env.GITHUB_TOKEN }));
      return 1;
    }
  },
}));
`
      );
      try {
        const result = spawnSync(
          process.execPath,
          ['--no-env-file', '--preload', preload, CLI_ENTRY, 'setup', ...entry.args, '--cwd', cwd],
          {
            cwd,
            encoding: 'utf8',
            timeout: testTimeout(10_000),
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              ARCHON_HOME: root,
              CODEX_HOME: join(root, 'codex'),
              CLAUDE_CONFIG_DIR: join(root, 'claude'),
              PI_CODING_AGENT_DIR: join(root, 'pi'),
              ARCHON_TELEMETRY_DISABLED: '1',
              ARCHON_PROVIDERS: entry.env,
              GITHUB_TOKEN: 'shell-token',
              WORKFLOW_ID: '',
            },
          }
        );
        expect({ status: result.status, stderr: result.stderr }).toMatchObject({
          status: entry.selected === null ? 1 : 0,
        });
        const line = result.stdout
          .trim()
          .split('\n')
          .find(line => line.startsWith('{'));
        expect(line).toBeDefined();
        const dispatched: unknown = JSON.parse(line!);
        expect(dispatched).toMatchObject({
          prompts: 0,
          inheritedToken: 'shell-token',
          effectiveToken: 'file-token',
        });
        if (entry.selected === null) {
          expect(dispatched).toMatchObject({
            installs: [],
            error: expect.stringContaining("Unknown maintained provider 'unknown'"),
          });
        } else {
          expect(dispatched).toMatchObject({
            providers: entry.selected,
            selected: entry.selected,
            installs: entry.selected,
          });
        }
      } finally {
        await removeTempTree(root);
      }
    });
  }
});

it.each([true, false])(
  'file-only commands inspect local files without a registry (Git: %s)',
  async initGit => {
    const root = mkdtempSync(join(tmpdir(), 'archon-file-only-'));
    const repo = join(root, 'repo');
    const home = join(root, 'home');
    mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
    mkdirSync(join(repo, '.archon', 'commands'), { recursive: true });
    mkdirSync(join(home, 'archon.db'), { recursive: true });
    if (initGit) expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    // Inside Git, invoke from a child directory: discovery must fall back to the Git root.
    const cwd = initGit ? join(repo, 'deep') : repo;
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repo, '.archon', 'workflows', 'fixtures'), { recursive: true });
    writeFileSync(
      join(repo, '.archon', 'workflows', 'fixtures', 'probe.stubs.yaml'),
      'fixture:\n  expect: completed\nprobe: stub\n'
    );
    writeFileSync(
      join(repo, '.archon', 'config.yaml'),
      'defaults:\n  loadDefaultCommands: false\n  loadDefaultWorkflows: false\n'
    );
    writeFileSync(
      join(repo, '.archon', 'workflows', 'probe.yaml'),
      'name: probe\ndescription: File-only probe\nnodes:\n  - id: probe\n    bash: echo probe\n'
    );
    writeFileSync(join(repo, '.archon', 'commands', 'probe.md'), 'Run the probe.\n');
    try {
      for (const args of [
        ...(initGit
          ? [
              ['workflow', 'list'],
              ['validate', 'workflows'],
              ['validate', 'commands'],
            ]
          : []),
        ['workflow', 'run', 'probe', '--dry-run', '--default-stubs'],
        ['workflow', 'test', 'probe'],
      ]) {
        const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
          cwd,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            ARCHON_HOME: home,
            DATABASE_URL: '',
            ARCHON_TELEMETRY_DISABLED: '1',
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('probe');
      }
      const execution = spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'run', 'probe'], {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          ARCHON_HOME: home,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
      });
      expect(execution.status).toBe(1);
      expect(execution.stdout + execution.stderr).toContain(
        'Could not verify project registration'
      );
    } finally {
      await removeTempTree(root);
    }
  },
  30_000
);
