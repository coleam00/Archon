import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { bunTestCommand, bunTestEnv } from './bun-test-command';

const repoRoot = join(import.meta.dir, '..');

describe('a bun test process never inherits the operator database', () => {
  it(
    'work left running after cleanup reopens neither the inherited home nor the inherited DATABASE_URL',
    async () => {
      // Stand in for the operator's ~/.archon and PostgreSQL: what a test process would
      // inherit from the shell. The Docker signals are what a test run inside the Archon
      // container inherits; getArchonHome() would let them override ARCHON_HOME.
      const operatorHome = mkdtempSync(join(tmpdir(), 'archon-operator-home-'));
      try {
        const child = Bun.spawn(
          bunTestCommand([join(import.meta.dir, 'fixtures', 'late-db-reopen.fixture.ts')]),
          {
            cwd: join(repoRoot, 'packages', 'core'),
            env: bunTestEnv({
              ...process.env,
              ARCHON_HOME: operatorHome,
              DATABASE_URL: `postgresql://operator@/archon?host=${join(operatorHome, 'no-socket')}`,
              ARCHON_DOCKER: 'true',
              WORKSPACE_PATH: '/workspace',
            }),
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
        const { lateDbPath, lateDbUrl, lateHome, lateEnvHome } = JSON.parse(report ?? '{}') as {
          lateDbPath: string;
          lateDbUrl: string;
          lateHome: string;
          lateEnvHome: string;
        };
        expect(lateDbUrl).toBe('');
        expect(lateHome).toBe(lateEnvHome);
        expect(lateDbPath.startsWith(operatorHome)).toBe(false);
        expect(existsSync(join(operatorHome, 'archon.db'))).toBe(false);
      } finally {
        await removeTempTree(operatorHome);
      }
    },
    testTimeout(30_000)
  );
});
