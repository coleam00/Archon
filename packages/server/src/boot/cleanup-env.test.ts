import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
// Existing server boot tests observed 10.8 s cold imports on Windows CI.
const serverImportBudgetMs = 30_000;
const variables = ['STALE_THRESHOLD_DAYS', 'CLEANUP_INTERVAL_HOURS', 'SESSION_RETENTION_DAYS'];

async function bootWithEnvFile(scope: 'user' | 'repo', contents: string) {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-cleanup-boot-')));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  await mkdir(home);
  await mkdir(join(repo, '.archon'), { recursive: true });
  await writeFile(join(scope === 'user' ? home : join(repo, '.archon'), '.env'), contents);
  const preload = join(root, 'preload.ts');
  const registration = resolve(
    import.meta.dir,
    '../../..',
    'core/src/providers/register-host-providers.ts'
  );
  const cleanup = resolve(import.meta.dir, '../../..', 'core/src/services/cleanup-service.ts');
  await writeFile(
    preload,
    `
    import { mock } from 'bun:test';
    mock.module(${JSON.stringify(registration)}, () => ({
      registerHostProviders: async () => {
        const service = await import(${JSON.stringify(cleanup)});
        console.log('CLEANUP_BOOT ' + JSON.stringify({
          staleDays: service.STALE_THRESHOLD_DAYS,
          retentionDays: service.SESSION_RETENTION_DAYS,
          intervalHours: process.env.CLEANUP_INTERVAL_HOURS,
        }));
        process.exit(0);
      },
    }));
  `
  );
  const child = Bun.spawn(
    [process.execPath, '--preload', preload, resolve(import.meta.dir, '../index.ts')],
    {
      cwd: repo,
      env: {
        ...process.env,
        ARCHON_HOME: home,
        ARCHON_DOCKER: '',
        WORKSPACE_PATH: '',
        ARCHON_TELEMETRY_DISABLED: '1',
        STALE_THRESHOLD_DAYS: '14',
        CLEANUP_INTERVAL_HOURS: '6',
        SESSION_RETENTION_DAYS: '30',
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: serverImportBudgetMs,
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exit };
}

for (const scope of ['user', 'repo'] as const) {
  describe(`${scope} env file cleanup startup`, () => {
    for (const name of variables) {
      test.each(['abc', '0', '-1', '1.5'])(
        `${name} rejects %j`,
        async value => {
          const result = await bootWithEnvFile(scope, `${name}=${value}\n`);
          expect(result.stderr).toContain(
            `${name} must be a positive integer; received ${JSON.stringify(value)}`
          );
          expect(result.exit).not.toBe(0);
          expect(result.stdout).not.toContain('CLEANUP_BOOT');
        },
        serverImportBudgetMs + 1000
      );
    }

    test(
      'captures configured thresholds before application imports',
      async () => {
        const result = await bootWithEnvFile(
          scope,
          'STALE_THRESHOLD_DAYS=21\nCLEANUP_INTERVAL_HOURS=12\nSESSION_RETENTION_DAYS=60\n'
        );
        expect(result.exit).toBe(0);
        expect(result.stdout).toContain(
          'CLEANUP_BOOT {"staleDays":21,"retentionDays":60,"intervalHours":"12"}'
        );
      },
      serverImportBudgetMs + 1000
    );
  });
}
