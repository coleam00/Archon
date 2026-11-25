/**
 * One queue, one reader: for one install, `archon workflow attention`, its `--watch`, the
 * API list route and the chat attention tool report the same items, and the paused run
 * behind them is answered and finishes as before. Each surface runs for real, in its own
 * process, against one scratch home.
 */
import { expect, test } from 'bun:test';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const CLI = join(import.meta.dir, '../packages/cli/src/cli.ts');
const ROUTE = join(import.meta.dir, '../packages/server/src/test/attention-list-route.fixture.ts');
const TOOL = join(import.meta.dir, '../packages/core/src/test/attention-tool-list.fixture.ts');

interface Item {
  kind: string;
  ref: string;
  run?: { id: string; occurrence?: string };
}

test('the CLI list, the watch, the API route and the chat tool list the same items, and the pause is answered and the run finishes', async () => {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-attention-readers-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, 'workflows'), { recursive: true });
  mkdirSync(project);
  writeFileSync(
    join(home, 'workflows', 'ask.yaml'),
    [
      'name: ask',
      'description: Pauses mid-run for an answer.',
      'worktree:',
      '  enabled: false',
      'nodes:',
      '  - id: warmup',
      '    bash: echo ready',
      '  - id: ask',
      '    depends_on: [warmup]',
      '    wait:',
      '      attention: "Ship it?"',
      '  - id: finish',
      '    depends_on: [ask]',
      '    bash: echo shipped',
      '',
    ].join('\n')
  );
  const env = { ...process.env, ARCHON_HOME: home, ARCHON_TELEMETRY_DISABLED: '1' };
  const run = (args: string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, ['--no-env-file', ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
    });
  const cli = (...args: string[]): SpawnSyncReturns<string> => run([CLI, 'workflow', ...args]);
  const lastJson = (result: SpawnSyncReturns<string>): unknown =>
    JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
  const listed = (): Item[] =>
    (JSON.parse(cli('attention', '--all', '--json').stdout) as { items: Item[] }).items;
  /** The items a watch sends before `ready`: the open set as the stream holds it. */
  const watched = async (): Promise<Item[]> => {
    const watch = spawn(
      process.execPath,
      ['--no-env-file', CLI, 'workflow', 'attention', '--all', '--watch', '--protocol', '--json'],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    try {
      let text = '';
      for await (const chunk of watch.stdout) {
        text += String(chunk);
        const lines = text
          .split('\n')
          .slice(0, -1)
          .map(line => JSON.parse(line) as { type: string; item: Item });
        if (lines.some(line => line.type === 'ready'))
          return lines.filter(line => line.type === 'attention').map(line => line.item);
      }
      throw new Error(`the watch ended before ready: ${text}`);
    } finally {
      watch.kill();
    }
  };

  const started = cli('run', 'ask', '--folder', '--no-worktree', '--quiet');
  expect(started.stdout).not.toContain('shipped');

  const items = listed();
  expect(items).toHaveLength(1);
  const [item] = items;
  const held = item?.run;
  if (item === undefined || held?.occurrence === undefined)
    throw new Error(`expected one item a paused run holds: ${JSON.stringify(items)}`);
  expect(item).toMatchObject({ kind: 'attention', ref: `${held.id}:${held.occurrence}` });
  expect(await watched()).toEqual(items);
  expect(lastJson(run([ROUTE]))).toEqual(items);
  expect(lastJson(run([TOOL]))).toEqual(items);

  const answered = cli('answer', held.id, '--occurrence', held.occurrence, '--text', 'yes');
  expect(answered.status, answered.stderr).toBe(0);
  // The answering CLI continues the run it answered, so the run is done when it returns.
  expect(JSON.parse(cli('get', held.id, '--json').stdout)).toMatchObject({ status: 'completed' });
  expect(listed()).toEqual([]);
}, 120_000);
