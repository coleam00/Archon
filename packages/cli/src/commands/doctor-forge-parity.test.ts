import { afterAll, beforeAll, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
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

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const setups = [
  {
    name: 'Enterprise token with empty public token',
    source: 'gh',
    login: false,
    enterprise: true,
    ok: true,
    detail: 'source: GH_ENTERPRISE_TOKEN',
  },
  ...(['gh', 'forge'] as const).map(source => ({
    name: `unconnected per-user ${source}`,
    source,
    login: true,
    app: true,
    perUser: true,
    repoToken: 'host-repository-token',
    ok: false,
    detail:
      source === 'gh'
        ? 'connect it with'
        : 'credential environment GH_TOKEN or GITHUB_TOKEN is empty',
  })),
  {
    name: 'workflow login directory',
    source: 'forge',
    login: true,
    workflowLogin: false,
    ok: false,
    detail: 'repair the gh login',
  },
  ...(['gh', 'forge'] as const).map(source => ({
    name: `App only ${source}`,
    source,
    login: false,
    app: true,
    repoToken: 'stale-repository-token',
    ok: true,
    detail: 'source: GH_TOKEN',
  })),
  ...(['gh', 'forge'] as const).map(source => ({
    name: `Unregistered App ${source}`,
    source,
    login: false,
    app: true,
    repoToken: 'stale-repository-token',
    unregistered: true,
    ok: true,
    detail: 'source: GH_TOKEN',
  })),
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
  if (!('workflowLogin' in setup))
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
    ...('enterprise' in setup
      ? { GH_TOKEN: '', GH_ENTERPRISE_TOKEN: 'fixture-enterprise-token' }
      : {}),
    ...('perUser' in setup
      ? { TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), ARCHON_USER_ID: 'fixture-user' }
      : {}),
  };
  for (const args of [
    ['init'],
    [
      'remote',
      'add',
      'origin',
      `https://${'app' in setup ? 'github.com' : 'ghe.example.com'}/example/repo.git`,
    ],
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
            args:
              'released' in setup && setup.released
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
                    `if (process.argv.includes('metadata')) console.log(JSON.stringify({protocol:1,name:'github',version:'test',forge:'github',hosts:['ghe.example.com','github.com'],capabilities:${JSON.stringify(REQUIRED_FORGE_OPERATIONS)},token_env:['GH_TOKEN','GITHUB_TOKEN']})); else { const request = await Bun.stdin.json(); if (process.env.ARCHON_FORGE_TOKEN !== '${'app' in setup ? 'fixture-app-token' : 'fixture-keyring-token'}') throw new Error('wrong login'); console.log(JSON.stringify({operationId:request.operationId,ok:true,result:{op:request.op,value:null}})); }`,
                  ],
          },
        ],
      },
    })
  );
  writeFileSync(
    join(repo, '.archon/config.yaml'),
    JSON.stringify({
      env: {
        ...('repoSource' in setup ? { ARCHON_SDLC_FORGE: setup.repoSource } : {}),
        ...('workflowLogin' in setup ? { GH_CONFIG_DIR: join(home, 'logged-out') } : {}),
      },
    })
  );
  if ('repoLogin' in setup)
    writeFileSync(join(repo, '.archon/.env'), `GH_CONFIG_DIR=${join(home, 'logged-out')}\n`);
  if ('repoToken' in setup)
    writeFileSync(join(repo, '.archon/.env'), `GH_TOKEN=${setup.repoToken}\n`);
  const preload = join(home, 'app-preload.ts');
  if ('app' in setup) {
    Object.assign(env, {
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      WEBHOOK_SECRET: 'fixture-secret',
    });
    writeFileSync(
      preload,
      `
      import { mock } from 'bun:test';
      globalThis.fetch = async () => { throw new Error('Network forbidden'); };
      mock.module(${JSON.stringify(Bun.resolveSync('@octokit/rest', resolve(import.meta.dir, '../../../core')))}, () => ({ Octokit: class {
        async request(route, args) {
          if (route === 'GET /repos/{owner}/{repo}/installation' && args.owner === 'example' && args.repo === 'repo') return {data: {id: 42}};
          if (route === 'POST /app/installations/{installation_id}/access_tokens' && args.installation_id === 42) return {data: {token: 'fixture-app-token', expires_at: new Date(Date.now()+3600000).toISOString()}};
          throw new Error('Unexpected App request');
        }
      }}));
      const { createCliWorkflowHost } = await import(${JSON.stringify(resolve(import.meta.dir, '../utils/workflow-host.ts'))});
      const host = await createCliWorkflowHost();
      const { canonicalizeProjectPath } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../paths/src/index.ts'))});
      const cwd = await canonicalizeProjectPath(process.cwd());
      if (${'unregistered' in setup ? 'false' : 'true'} && !await host.records.codebases.findCodebaseByDefaultCwd(cwd)) await host.records.codebases.createCodebase({name:'fixture',kind:'repo',default_cwd:cwd,repository_url:'https://github.com/example/repo.git'});
    `
    );
  }
  const preloadArgs = 'app' in setup ? ['--preload', preload] : [];
  const doctor = Bun.spawn([process.execPath, '--no-env-file', ...preloadArgs, cli, 'doctor'], {
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
      ...preloadArgs,
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
    const { createCliWorkflowHost } = await import(${JSON.stringify(resolve(import.meta.dir, '../utils/workflow-host.ts'))});
    const host = await createCliWorkflowHost(true);
    const { resolveWorkflowGithubEnvironment } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../workflows/src/executor.ts'))});
    const { resolveCodebaseForPath } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../core/src/services/codebase-checkout-resolver.ts'))});
    if (${'unregistered' in setup}) {
      const { canonicalizeProjectPath } = await import(${JSON.stringify(resolve(import.meta.dir, '../../../paths/src/index.ts'))});
      await host.records.codebases.createCodebase({name:'fixture',kind:'repo',default_cwd:await canonicalizeProjectPath(process.cwd()),repository_url:'https://github.com/example/repo.git'});
    }
    const { codebase } = await resolveCodebaseForPath(process.cwd(), host.records.codebases);
    const user = ${'perUser' in setup}
      ? await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'fixture-user', 'fixture-user')
      : undefined;
    const github = await resolveWorkflowGithubEnvironment(host.deps, codebase?.id, user?.id, config);
    const run = await host.deps.store.createWorkflowRun({ workflow_name: 'forge-parity', user_message: '' });
    const child = Bun.spawn([${JSON.stringify(process.execPath)}, '--no-env-file', ${JSON.stringify(preflight)}], {
      env: {...process.env, ...github.envVars, WORKFLOW_ID: run.id, ARCHON_CLI_COMMAND: ${JSON.stringify(JSON.stringify([process.execPath, '--no-env-file', cli]))}},
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

test('installation verification enters a forge checkout before doctor', async () => {
  const doc = await Bun.file(
    resolve(import.meta.dir, '../../../docs-web/src/content/docs/getting-started/installation.md')
  ).text();
  const recipe = doc.slice(doc.indexOf('## Verify Installation'), doc.indexOf('## Next Steps'));
  expect(recipe).toContain('cd /path/to/your/repo');
  expect(recipe.indexOf('archon version')).toBeLessThan(recipe.indexOf('cd /path/to/your/repo'));
  expect(recipe.indexOf('cd /path/to/your/repo')).toBeLessThan(recipe.indexOf('archon doctor'));
  expect(recipe).toContain('forge remote');
});
test('Docker gh login uses the persisted server home and user', async () => {
  const doc = await Bun.file(
    resolve(import.meta.dir, '../../../docs-web/src/content/docs/deployment/docker.md')
  ).text();
  const dockerfile = await Bun.file(resolve(import.meta.dir, '../../../../Dockerfile')).text();
  const home = dockerfile.match(/^ENV HOME=(\S+)$/m)?.[1];
  expect(home).toBe('/home/appuser');
  expect(doc).toContain(`docker compose exec -u appuser -e HOME=${home} app gh auth login`);
  const compose = Bun.YAML.parse(
    await Bun.file(resolve(import.meta.dir, '../../../../docker-compose.yml')).text()
  );
  expect(compose).toMatchObject({
    services: {
      app: { volumes: expect.arrayContaining([`\${ARCHON_USER_HOME:-archon_user_home}:${home}`]) },
    },
  });
  const entrypoint = await Bun.file(
    resolve(import.meta.dir, '../../../../docker-entrypoint.sh')
  ).text();
  expect(entrypoint.split('\n').map(line => line.trim())).toContain(`fix_ownership ${home}`);
  expect(doc).not.toContain('docker compose exec app gh auth login');
});
