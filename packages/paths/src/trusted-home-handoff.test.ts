/**
 * The trusted Archon home crosses into every Archon process a host spawns. These
 * run real processes because the process boundary is the subject: the parent loads
 * a repository env that redirects ARCHON_HOME, then spawns a child the way Archon's
 * spawn paths do.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTempTree } from './test-utils';

const stripBootUrl = pathToFileURL(join(import.meta.dir, 'strip-cwd-env-boot.ts')).href;
const indexUrl = pathToFileURL(join(import.meta.dir, 'index.ts')).href;

interface Fixture {
  root: string;
  repo: string;
  trustedHome: string;
  repoHome: string;
}

/**
 * `repoHomeValue` is the ARCHON_HOME the repository env writes; `~/` makes it differ
 * from its resolved form, which the rewriting spawn paths pass instead.
 */
function makeFixture(repoHomeValue?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-trusted-handoff-'));
  const repo = join(root, 'repo');
  const trustedHome = join(root, 'trusted-home');
  const value = repoHomeValue ?? join(root, 'repo-chosen-home');
  const repoHome = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  mkdirSync(join(repo, '.archon'), { recursive: true });
  mkdirSync(trustedHome, { recursive: true });
  writeFileSync(join(repo, '.archon', '.env'), `ARCHON_HOME=${value}\n`);
  return { root, repo, trustedHome, repoHome };
}

/**
 * How the parent builds the child's env, after loading the repository env:
 * - `inherit`: spreads its env unchanged (workflow scripts, detached control commands).
 * - `rewrite`: sets ARCHON_HOME and reissues the handoff (trigger execute).
 * - `redirect`: a caller points the child at another home without a handoff.
 * The child boots like the CLI: strip, capture the install context when the payload
 * flag is present, load env, restore.
 */
type SpawnShape = 'inherit' | 'rewrite' | 'redirect';

function runParent(
  fixture: Fixture,
  shape: SpawnShape,
  childArgs: string[] = [],
  childCwd: string = fixture.repo
): { status: number | null; stdout: string; stderr: string } {
  const child = join(fixture.root, 'child.ts');
  writeFileSync(
    child,
    `import '${stripBootUrl}';\n` +
      `import { captureDetachedInstallContext, getArchonHome, getPluginsPath, loadArchonEnv, restoreDetachedInstallContext } from '${indexUrl}';\n` +
      "const gated = process.argv.includes('--internal-detached-run-config');\n" +
      'const inherited = gated ? captureDetachedInstallContext() : undefined;\n' +
      'loadArchonEnv(process.cwd());\n' +
      'if (inherited) restoreDetachedInstallContext(inherited);\n' +
      'process.stdout.write(JSON.stringify({ plugins: getPluginsPath(), home: getArchonHome() }));\n'
  );
  const parent = join(fixture.root, 'parent.ts');
  writeFileSync(
    parent,
    `import '${stripBootUrl}';\n` +
      "import { spawnSync } from 'node:child_process';\n" +
      `import { childArchonHomeEnv, getArchonHome, loadArchonEnv } from '${indexUrl}';\n` +
      'loadArchonEnv(process.cwd());\n' +
      `const shape = ${JSON.stringify(shape)};\n` +
      `const redirected = ${JSON.stringify(join(fixture.root, 'caller-home'))};\n` +
      'const env = { ...process.env };\n' +
      "if (shape === 'rewrite') Object.assign(env, childArchonHomeEnv(getArchonHome()));\n" +
      "if (shape === 'redirect') env.ARCHON_HOME = redirected;\n" +
      `const result = spawnSync(process.execPath, [${JSON.stringify(child)}, ...${JSON.stringify(childArgs)}], { cwd: ${JSON.stringify(childCwd)}, encoding: 'utf8', env });\n` +
      'process.stderr.write(result.stderr);\n' +
      'process.stdout.write(result.stdout);\n' +
      'process.exitCode = result.status ?? 1;\n'
  );
  return spawnSync(process.execPath, [parent], {
    cwd: fixture.repo,
    encoding: 'utf8',
    // '' rather than deleting it: the test runner may itself run under an Archon host.
    env: { ...process.env, ARCHON_HOME: fixture.trustedHome, ARCHON_TRUSTED_HOME: '' },
  });
}

function childView(result: { status: number | null; stdout: string; stderr: string }): unknown {
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 0,
    stderr: expect.any(String),
  });
  return JSON.parse(result.stdout);
}

async function withFixture(
  body: (fixture: Fixture) => void,
  repoHomeValue?: string
): Promise<void> {
  const fixture = makeFixture(repoHomeValue);
  try {
    body(fixture);
  } finally {
    await removeTempTree(fixture.root);
  }
}

describe('trusted Archon home handoff', () => {
  it('a child spawned with the parent env reads plugins from the trusted home', () =>
    withFixture(fixture => {
      expect(childView(runParent(fixture, 'inherit'))).toEqual({
        plugins: join(fixture.trustedHome, 'plugins'),
        home: fixture.repoHome,
      });
    }));

  it('a child whose ARCHON_HOME the spawn rewrites reads plugins from the trusted home', () =>
    withFixture(fixture => {
      expect(childView(runParent(fixture, 'rewrite'))).toEqual({
        plugins: join(fixture.trustedHome, 'plugins'),
        home: fixture.repoHome,
      });
    }, '~/archon-trusted-handoff-never-created'));

  it('a detached run child keeps its sealed install home and the trusted plugins home', () =>
    withFixture(fixture => {
      expect(
        childView(runParent(fixture, 'rewrite', ['--internal-detached-run-config', 'placeholder']))
      ).toEqual({
        plugins: join(fixture.trustedHome, 'plugins'),
        home: fixture.repoHome,
      });
    }, '~/archon-trusted-handoff-never-created'));

  it('a caller that points the child at another home gets that home, not the ancestor handoff', () =>
    withFixture(fixture => {
      const callerHome = join(fixture.root, 'caller-home');
      expect(childView(runParent(fixture, 'redirect'))).toEqual({
        plugins: join(callerHome, 'plugins'),
        home: fixture.repoHome,
      });
    }));

  it('a cwd .env that names the handoff stops the child instead of dropping the handoff', () =>
    withFixture(fixture => {
      // Stripping it would leave the child to pin its inherited, repository-chosen home.
      const childCwd = join(fixture.repo, 'packages', 'app');
      mkdirSync(childCwd, { recursive: true });
      writeFileSync(join(childCwd, '.env'), 'ARCHON_TRUSTED_HOME=anything\n');
      const result = runParent(fixture, 'inherit', [], childCwd);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('sets ARCHON_TRUSTED_HOME, which only Archon sets');
    }));
});
