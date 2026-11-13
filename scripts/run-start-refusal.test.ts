/**
 * One start, one answer: a start the engine refuses is refused with the same reason by
 * `archon workflow run` and by the run route, and neither starts anything. Each surface
 * runs for real, in its own process, against one scratch home.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const CLI = join(import.meta.dir, '../packages/cli/src/cli.ts');
const ROUTE = join(import.meta.dir, '../packages/server/src/test/run-route-start.fixture.ts');

test('the CLI and the run route refuse a start that misses a required input with the same reason', () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-start-refusal-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(project);
  writeFileSync(
    join(home, 'workflows', 'needs-issue.yaml'),
    [
      'name: needs-issue',
      'description: Needs an issue to start.',
      'worktree:',
      '  enabled: false',
      'inputs:',
      '  issue:',
      '    required: true',
      'nodes:',
      '  - id: show',
      '    bash: echo started',
      '',
    ].join('\n')
  );
  const run = (args: string[]): ReturnType<typeof spawnSync<string>> =>
    spawnSync(process.execPath, ['--no-env-file', ...args], {
      cwd: project,
      env: { ...process.env, ARCHON_HOME: home, ARCHON_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
    });

  const route = run([ROUTE, 'needs-issue']);
  const answer = JSON.parse(route.stdout.trim().split('\n').at(-1) ?? '') as {
    status: number;
    body: { error: string };
    dispatched: number;
  };
  expect(answer.status).toBe(400);
  expect(answer.dispatched).toBe(0);

  const cli = run([CLI, 'workflow', 'run', 'needs-issue', '--folder', '--no-worktree', '--quiet']);
  expect(cli.status).toBe(1);
  expect(cli.stdout).not.toContain('started');
  expect(cli.stderr.trim()).toBe(`Error: ${answer.body.error}`);
}, 60_000);
