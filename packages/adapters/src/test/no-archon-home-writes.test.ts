import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const track = trackTempRoots();

test('ARCHON_HOME guard rejects files, dotfiles and empty directories', async () => {
  const result = await runGuardFixture(`
    writeFileSync(join(getArchonHome(), 'config.yaml'), 'leak');
    writeFileSync(join(getArchonHome(), '.hidden'), 'leak');
    mkdirSync(join(getArchonHome(), 'empty-directory'));
  `);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('Adapter test wrote under guard-owned ARCHON_HOME');
  for (const entry of ['config.yaml', '.hidden', 'empty-directory']) {
    expect(result.output).toContain(join(result.guardedHome, entry));
  }
  expect(result.output).toContain('mock.module() merges');
  expect(existsSync(result.guardedHome)).toBe(false);
});

test('ARCHON_HOME guard allows a test-owned temporary home', async () => {
  const result = await runGuardFixture(`
    const guardedHome = process.env.ARCHON_HOME;
    const ownHome = mkdtempSync(join(tmpdir(), 'archon-adapter-owned-home-'));
    try {
      process.env.ARCHON_HOME = ownHome;
      writeFileSync(join(getArchonHome(), 'config.yaml'), 'owned');
    } finally {
      await removeTempTree(ownHome);
      process.env.ARCHON_HOME = guardedHome;
    }
  `);
  expect(result.exitCode).toBe(0);
  expect(result.output).not.toContain('Adapter test wrote under guard-owned ARCHON_HOME');
  expect(existsSync(result.guardedHome)).toBe(false);
});

async function runGuardFixture(body: string): Promise<{
  exitCode: number;
  output: string;
  guardedHome: string;
}> {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-adapter-home-guard-test-')));
  const homeRecord = join(root, 'guarded-home');
  const fixture = join(root, 'fixture.test.ts');
  await writeFile(
    fixture,
    `import { expect, test } from 'bun:test';
     import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
     import { tmpdir } from 'node:os';
     import { join } from 'node:path';
     import { getArchonHome } from ${JSON.stringify(
       resolve(import.meta.dir, '../../../paths/src/archon-paths.ts')
     )};
     import { removeTempTree } from ${JSON.stringify(
       resolve(import.meta.dir, '../../../paths/src/test-utils.ts')
     )};
     writeFileSync(${JSON.stringify(homeRecord)}, process.env.ARCHON_HOME);
     test('guard fixture', async () => {
       expect(getArchonHome()).toBe(process.env.ARCHON_HOME);
       ${body}
     });`
  );
  const child = Bun.spawn([process.execPath, 'test', fixture], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, ARCHON_HOME: root, ARCHON_DOCKER: 'true', WORKSPACE_PATH: '/workspace' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    output: stdout + stderr,
    guardedHome: await readFile(homeRecord, 'utf8'),
  };
}
