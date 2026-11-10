/**
 * `archon workflow types` as a process: its arguments, exit codes and the stream each
 * outcome is written to. What the generated file holds is the engine's test, in
 * @archon/workflows' output-types.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testTimeout, trackTempRoots } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const trackTempRoot = trackTempRoots();

const workflow = (levels: string): string => `name: sorter
description: d
nodes:
  - id: rank
    bash: echo '{"level":"low"}'
    output_format:
      type: object
      properties:
        level: { type: string, enum: [${levels}] }
      required: [level]
`;

describe('workflow types', () => {
  it(
    'writes a pack file, checks it, and exits 1 naming the file once the schema changes',
    () => {
      const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-cli-types-'))));
      const repo = join(root, 'repo');
      const folder = join(repo, '.archon', 'workflows', 'alpha', 'sorter');
      mkdirSync(folder, { recursive: true });
      spawnSync('git', ['init', '-q', '.'], { cwd: repo });
      writeFileSync(join(folder, 'sorter.yaml'), workflow('low, high'));
      const generated = join(
        repo,
        '.archon',
        'workflows',
        'alpha',
        '.shared',
        'outputs.generated.ts'
      );
      const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } =>
        spawnSync(process.execPath, [CLI_ENTRY, 'workflow', 'types', ...args], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            ARCHON_HOME: join(root, 'home'),
            ARCHON_TELEMETRY_DISABLED: '1',
            DATABASE_URL: '',
          },
        });

      const usage = run();
      expect(usage.status).toBe(1);
      expect(usage.stderr).toContain('Usage: archon workflow types <name|folder|path>');

      const missing = run('alpha', '--check');
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`${generated} is missing or stale`);

      const written = run('alpha');
      expect(written.status).toBe(0);
      expect(written.stdout).toContain(`Wrote ${generated} (1 node output(s) in 1 workflow(s))`);
      expect(readFileSync(generated, 'utf8')).toContain("readonly level: 'low' | 'high';");
      expect(run('.archon/workflows/alpha', '--check').status).toBe(0);

      writeFileSync(join(folder, 'sorter.yaml'), workflow('low, mid, high'));
      const stale = run('alpha', '--check', '--json');
      expect(stale.status).toBe(1);
      expect(JSON.parse(stale.stdout)).toMatchObject({
        ok: false,
        status: 'stale',
        path: generated,
      });
      expect(readFileSync(generated, 'utf8')).not.toContain('mid');

      const single = run('sorter', '--out', 'sorter.gen.ts');
      expect(single.status).toBe(0);
      expect(readFileSync(join(repo, 'sorter.gen.ts'), 'utf8')).toContain("'low' | 'mid' | 'high'");

      const noOut = run('sorter', '--json');
      expect(noOut.status).toBe(1);
      expect(JSON.parse(noOut.stdout)).toMatchObject({ ok: false });
    },
    testTimeout(60_000)
  );
});
