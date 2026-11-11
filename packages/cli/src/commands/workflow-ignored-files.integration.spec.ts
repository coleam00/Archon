import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

let root: string | undefined;
afterEach(async () => {
  if (root) await removeTempTree(root);
});

test.each([{ command: ['list'] }, { command: ['test', 'x'] }])(
  'workflow $command reports an ignored workflow in a real checkout and continues normally',
  async ({ command }) => {
    root = await mkdtemp(join(tmpdir(), 'archon-ignore-cli-'));
    const repo = join(root, 'repo');
    const workflows = join(repo, '.archon/workflows');
    const ignored = join(workflows, 'build');
    await mkdir(join(ignored, 'fixtures'), { recursive: true });
    const init = spawnSync('git', ['init', repo], { encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    await writeFile(join(repo, '.gitignore'), 'build/\n');
    await writeFile(
      join(repo, '.archon/config.yaml'),
      'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n'
    );
    await writeFile(
      join(ignored, 'x.yaml'),
      'name: x\ndescription: Ignore diagnostic\nnodes:\n  - id: probe\n    bash: echo probe\n'
    );
    await writeFile(
      join(ignored, 'fixtures/probe.stubs.yaml'),
      'fixture:\n  expect: completed\nprobe: stub\n'
    );
    const warning =
      'Git ignores ".archon/workflows/build/x.yaml" (workflows: "x"); it may be missing from other checkouts.';
    for (const isIgnored of [true, false]) {
      if (!isIgnored) {
        await rename(join(ignored, 'x.yaml'), join(workflows, 'x.yaml'));
        await rename(join(ignored, 'fixtures'), join(workflows, 'fixtures'));
      }
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, '..', 'cli.ts'), 'workflow', ...command, '--json'],
        {
          cwd: repo,
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            ...process.env,
            ARCHON_HOME: join(root, 'home'),
            DATABASE_URL: '',
            ARCHON_TELEMETRY_DISABLED: '1',
          },
        }
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      if (isIgnored) {
        expect(result.stderr).toContain(warning);
        expect(output.sourceWarnings).toEqual([warning]);
      } else {
        expect(result.stderr).toBe('');
        expect(output.sourceWarnings).toBeUndefined();
      }
      if (command[0] === 'list') {
        expect(output.workflows.map((entry: { name: string }) => entry.name)).toEqual(['x']);
        expect(output.errors).toEqual([]);
      } else {
        expect(output.passed).toBe(1);
        expect(output.failed).toBe(0);
      }
    }
  },
  30_000
);
