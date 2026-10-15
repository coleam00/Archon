import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { removeTempTree, skipCompiledBinaryTests } from '@archon/paths/test-utils';
import { REQUIRED_FORGE_OPERATIONS } from '../../../../.archon/workflows/sdlc/.shared/forge-check';

const cli = resolve(import.meta.dir, '../cli.ts');
const preflight = resolve(
  import.meta.dir,
  '../../../../.archon/workflows/sdlc/deliver/scripts/forge-check.ts'
);
const configLoader = resolve(import.meta.dir, '../../../core/src/config/config-loader.ts');
const skip = skipCompiledBinaryTests();
let root: string;
beforeAll(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'doctor-forge-parity-'));
  const build = Bun.spawnSync([
    process.execPath,
    'build',
    '--compile',
    join(import.meta.dir, 'fixtures/doctor-gh.ts'),
    '--outfile',
    join(root, process.platform === 'win32' ? 'gh.exe' : 'gh'),
  ]);
  expect(build.exitCode).toBe(0);
}, 60_000);
afterAll(async () => {
  if (!skip) await removeTempTree(root);
});

const setups = [
  { name: 'keyring gh', source: 'gh', login: true, ok: true, detail: 'source: gh auth login' },
  { name: 'logged-out gh', source: 'gh', login: false, ok: false, detail: 'not authenticated' },
  {
    name: 'released plugin',
    source: 'forge',
    login: true,
    released: true,
    ok: false,
    detail: 'missing:',
  },
  {
    name: 'repository selects forge over gh',
    source: 'gh',
    repoSource: 'forge',
    login: true,
    released: true,
    ok: false,
    detail: 'missing:',
  },
  {
    name: 'repository selects gh over forge',
    source: 'forge',
    repoSource: 'gh',
    login: false,
    ok: false,
    detail: 'not authenticated',
  },
  {
    name: 'trusted CLI login survives repository env',
    source: 'forge',
    login: true,
    repoLogin: false,
    ok: true,
    detail: 'source: gh auth token',
  },
];

test.skipIf(skip).each(setups)('$name: doctor and run preflight agree', async setup => {
  const home = join(root, setup.name);
  const repo = join(home, 'repo');
  const trustedLogin = join(home, 'trusted-login');
  mkdirSync(join(repo, '.archon'), { recursive: true });
  mkdirSync(trustedLogin);
  if (setup.login) writeFileSync(join(trustedLogin, 'logged-in'), '');
  writeFileSync(join(home, '.env'), `GH_CONFIG_DIR=${trustedLogin}\n`);
  const env: NodeJS.ProcessEnv = {
    PATH: root + delimiter + process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ARCHON_HOME: home,
    GH_CONFIG_DIR: trustedLogin,
    ARCHON_TELEMETRY_DISABLED: '1',
    DATABASE_URL: '',
    ARCHON_SDLC_FORGE: setup.source,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
    SystemRoot: process.env.SystemRoot,
    OPENAI_API_KEY: 'fixture-openai-key',
  };
  for (const args of [
    ['init'],
    ['remote', 'add', 'origin', 'https://ghe.example.com/example/repo.git'],
  ])
    expect(Bun.spawnSync(['git', ...args], { cwd: repo, env }).exitCode).toBe(0);
  writeFileSync(
    join(home, 'config.yaml'),
    JSON.stringify({
      defaultAssistant: 'claude',
      assistants: { pi: { model: 'openai/gpt-4o' } },
      forge: {
        scanPath: false,
        plugins: [
          {
            plugin: 'github',
            command: process.execPath,
            args: setup.released
              ? [
                  '--no-env-file',
                  resolve(
                    import.meta.dir,
                    '../../../../.archon/scripts/__tests__/fixtures/released-github-plugin.ts'
                  ),
                ]
              : [
                  '--no-env-file',
                  '-e',
                  `if (process.argv.includes('metadata')) console.log(JSON.stringify({protocol:1,name:'github',version:'test',forge:'github',hosts:['ghe.example.com'],capabilities:${JSON.stringify(REQUIRED_FORGE_OPERATIONS)},token_env:['GH_TOKEN','GITHUB_TOKEN']})); else { const request = await Bun.stdin.json(); if (process.env.ARCHON_FORGE_TOKEN !== 'fixture-keyring-token') throw new Error('wrong login'); console.log(JSON.stringify({operationId:request.operationId,ok:true,result:{op:request.op,value:null}})); }`,
                ],
          },
        ],
      },
    })
  );
  writeFileSync(
    join(repo, '.archon/config.yaml'),
    JSON.stringify({
      env: 'repoSource' in setup ? { ARCHON_SDLC_FORGE: setup.repoSource } : {},
    })
  );
  if ('repoLogin' in setup)
    writeFileSync(join(repo, '.archon/.env'), `GH_CONFIG_DIR=${join(home, 'logged-out')}\n`);
  const doctor = Bun.spawn([process.execPath, '--no-env-file', cli, 'doctor'], {
    cwd: repo,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const doctorOutput = await new Response(doctor.stdout).text();
  const doctorError = await new Response(doctor.stderr).text();
  const doctorCode = await doctor.exited;
  const run = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '-e',
      `
    const { loadCliEnv } = await import(${JSON.stringify(resolve(import.meta.dir, '../load-cli-env.ts'))});
    await loadCliEnv(process.cwd());
    const { setPlatformPolicies } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../core/src/platforms/registry.ts'))});
    setPlatformPolicies([]);
    const { registerBuiltinProviders, registerCommunityProviders } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../providers/src/in-process.ts'))});
    registerBuiltinProviders(); registerCommunityProviders();
    const { loadConfig } = await import(${JSON.stringify(configLoader)});
    const config = await loadConfig(process.cwd());
    const child = Bun.spawn([${JSON.stringify(process.execPath)}, '--no-env-file', ${JSON.stringify(preflight)}], {
      env: {...process.env, ...config.envVars, ARCHON_CLI_COMMAND: ${JSON.stringify(JSON.stringify([process.execPath, '--no-env-file', cli]))}},
      stdout: 'inherit', stderr: 'inherit',
    });
    process.exitCode = await child.exited;
  `,
    ],
    { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' }
  );
  const runOutput = await new Response(run.stdout).text();
  const runError = await new Response(run.stderr).text();
  expect(await run.exited, runError).toBe(setup.ok ? 0 : 1);
  expect(doctorCode, doctorOutput + doctorError).toBe(setup.ok ? 0 : 1);
  expect(doctorOutput).toContain(`${setup.ok ? '✓' : '✗'} SDLC forge:`);
  expect(doctorOutput).toContain(setup.detail);
  expect(runError + runOutput).toContain(setup.detail);
  expect(doctorOutput).toContain(`SDLC forge: ${runError.trim().replace(/^forge-check: /, '')}`);
});

test('CLI reference describes the selected-source check for gh', async () => {
  const reference = await Bun.file(
    resolve(import.meta.dir, '../../../docs-web/src/content/docs/reference/cli.md')
  ).text();
  expect(reference.includes('skipped when `ARCHON_SDLC_FORGE=gh`')).toBe(false);
  expect(reference).toContain('selected SDLC forge source');
});

test('CLI reference requires a checkout with a forge remote for doctor', async () => {
  const reference = await Bun.file(
    resolve(import.meta.dir, '../../../docs-web/src/content/docs/reference/cli.md')
  ).text();
  expect(
    reference.includes('`serve`, and `doctor` commands and `workflow attention` work anywhere')
  ).toBe(false);
  expect(reference).toContain('Run `archon doctor` from a checkout with a forge remote');
});
