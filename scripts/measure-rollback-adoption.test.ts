import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { bunTestEnv } from './bun-test-command';

const track = trackTempRoots();

for (const failedVersion of [undefined, 'baseline', 'current']) {
  test(
    `comparison selects both versions and completes all trials with ${failedVersion ?? 'no'} failure`,
    async () => {
      const root = track(mkdtempSync(join(tmpdir(), 'rollback-comparison-')));
      const core = join(root, 'packages/core');
      const testDir = join(core, 'src/workflows');
      mkdirSync(testDir, { recursive: true });
      writeFileSync(
        join(core, 'package.json'),
        JSON.stringify({
          scripts: { test: `bun run ${JSON.stringify(join(import.meta.dir, 'package-tests.ts'))}` },
        })
      );
      const currentPath = join(testDir, 'registered-worktree.integration.test.ts');
      const body = (version: string, fails: boolean): string =>
        `import { test, expect } from 'bun:test';
test('${version} evidence', () => { expect(${String(fails)}).toBe(false); });`;
      writeFileSync(currentPath, body('baseline', failedVersion === 'baseline'));
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      };
      git('init');
      git('add', 'packages');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Baseline'
      );
      writeFileSync(currentPath, body('current', failedVersion === 'current'));
      const output = join(root, 'evidence with spaces');
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'measure-rollback-adoption.ts'), 'HEAD', output],
        { cwd: root, env: bunTestEnv(), stdout: 'pipe', stderr: 'pipe' }
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(failedVersion ? 1 : 0);
      for (const [label, version] of [
        ['1-before', 'baseline'],
        ['2-after', 'current'],
        ['3-after', 'current'],
        ['4-before', 'baseline'],
      ]) {
        const log = readFileSync(join(output, `${label}.log`), 'utf8');
        expect(log).toContain(`${version} evidence`);
        expect(log).not.toContain(`${version === 'baseline' ? 'current' : 'baseline'} evidence`);
        expect(existsSync(join(output, `${label}.git.jsonl`))).toBe(true);
        if (version !== failedVersion) {
          expect(readFileSync(join(output, `${label}.xml`), 'utf8')).toContain(
            `${version} evidence`
          );
          expect(stdout).toContain(`Rollback comparison ${label} per-test timings:`);
        }
      }
      if (failedVersion) {
        for (const label of failedVersion === 'baseline'
          ? ['1-before', '4-before']
          : ['2-after', '3-after']) {
          expect(stderr).toContain(`${label} (exit 1)`);
        }
      }
      expect(existsSync(join(testDir, 'registered-worktree.before.integration.test.ts'))).toBe(
        false
      );
      expect(readFileSync(currentPath, 'utf8')).toBe(body('current', failedVersion === 'current'));
    },
    testTimeout(10000)
  );
}
