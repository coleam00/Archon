import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { bunTestCommand, bunTestEnv } from './bun-test-command';

const repoRoot = join(import.meta.dir, '..');

describe('a bun test process never inherits the operator home', () => {
  it(
    'work left running after cleanup reopens the database outside the inherited home',
    async () => {
      // Stands in for the operator's ~/.archon: the parent's ARCHON_HOME that a test
      // process would inherit from the shell.
      const operatorHome = mkdtempSync(join(tmpdir(), 'archon-operator-home-'));
      try {
        const child = Bun.spawn(
          bunTestCommand([join(import.meta.dir, 'fixtures', 'late-db-reopen.fixture.ts')]),
          {
            cwd: join(repoRoot, 'packages', 'core'),
            env: bunTestEnv({ ...process.env, ARCHON_HOME: operatorHome, DATABASE_URL: '' }),
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        const report = stdout.split('\n').find(line => line.includes('lateDbPath'));
        expect(report).toBeDefined();
        const { lateDbPath } = JSON.parse(report ?? '{}') as { lateDbPath: string };
        expect(lateDbPath.startsWith(operatorHome)).toBe(false);
        expect(existsSync(join(operatorHome, 'archon.db'))).toBe(false);
      } finally {
        await removeTempTree(operatorHome);
      }
    },
    testTimeout(30_000)
  );
});
