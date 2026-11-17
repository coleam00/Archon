import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { createTrackerExit } from './tracker-exit';

const CLI_ENTRY = join(import.meta.dir, '../cli.ts');

function recorder(scan: () => Promise<unknown> = async () => []) {
  const events: string[] = [];
  const exit = createTrackerExit(async () => {
    events.push('activate');
    return {
      scan: async () => {
        events.push('scan');
        return scan();
      },
    };
  });
  return { events, exit };
}

test('a process that changed no run makes no tracker pass', async () => {
  const { events, exit } = recorder();
  await exit.syncIfOwed({});
  expect(events).toEqual([]);
});

test('a process that can start runs activates the tracker before them and scans at exit', async () => {
  const { events, exit } = recorder();
  await exit.prepare({});
  events.push('run');
  await exit.prepare({});
  await exit.syncIfOwed({});
  await exit.syncIfOwed({});
  expect(events).toEqual(['activate', 'run', 'scan']);
});

test('a process that only ended a run activates and scans at exit', async () => {
  const { events, exit } = recorder();
  exit.markOwed();
  await exit.syncIfOwed({});
  expect(events).toEqual(['activate', 'scan']);
});

test('a tracker that fails does not fail the command', async () => {
  const { events, exit } = recorder(async () => {
    throw new Error('forge unreachable');
  });
  await exit.prepare({});
  await exit.syncIfOwed({});
  expect(events).toEqual(['activate', 'scan']);

  const failedActivation = createTrackerExit(async () => {
    throw new Error('database down');
  });
  await failedActivation.prepare({});
  await failedActivation.syncIfOwed({});
});

test('a CLI process that runs a workflow activates the tracker before the run and scans before it exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-tracker-exit-'));
  try {
    const events = join(root, 'events');
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, '.archon/workflows'), { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      `itemTracker:
  projects:
    - project: acme/widgets
      repo: { host: example.invalid, path: acme/widgets }
      keys: [{ prefix: 'issue-', kind: issue }]
`
    );
    writeFileSync(
      join(repo, '.archon/workflows/mark.yaml'),
      `name: mark
description: Records that it ran.
nodes:
  - id: mark
    bash: echo run >> ${JSON.stringify(events)}
`
    );
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const preload = join(root, 'preload.ts');
    writeFileSync(
      preload,
      `import { appendFileSync } from 'node:fs';
import { mock } from 'bun:test';
const record = (event: string) => appendFileSync(${JSON.stringify(events)}, event + '\\n');
mock.module(${JSON.stringify(join(import.meta.dir, '../commands/tracker.ts'))}, () => ({
  activateConfiguredTracker: async () => {
    record('activate');
    return { scan: async () => { record('scan'); return []; } };
  },
}));
`
    );
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['--preload', preload, CLI_ENTRY, ...args], {
        cwd: repo,
        env: {
          ...process.env,
          ARCHON_HOME: home,
          ARCHON_TELEMETRY_DISABLED: '1',
          DATABASE_URL: '',
        },
        encoding: 'utf8',
      });
    const run = cli('workflow', 'run', 'mark', '--no-worktree');
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(events, 'utf8')).toBe('activate\nrun\nscan\n');
    // A command that cannot start, pause or end a run makes no pass.
    const list = cli('workflow', 'list');
    expect(list.status, list.stderr).toBe(0);
    expect(readFileSync(events, 'utf8')).toBe('activate\nrun\nscan\n');
  } finally {
    await removeTempTree(root);
  }
});
