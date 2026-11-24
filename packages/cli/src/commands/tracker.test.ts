import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrackerPassReport } from '@archon/adapters/item-tracker/item-tracker';
import { clearConfigCache, loadConfig } from '@archon/core/config/config-loader';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { activateConfiguredTracker, trackerSyncCommand } from './tracker';

const tempRoots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  clearConfigCache();
});

const scanned: TrackerPassReport = {
  project: 'acme/widgets',
  outcome: 'scanned',
  posted: [{ item: 'issue-7', marker: '<!-- archon-item-status -->' }],
  notPosted: [],
};
const held: TrackerPassReport = {
  project: 'acme/gadgets',
  outcome: 'held',
  heldBy: { host: 'build-box', pid: 42, instance: 'i' },
  since: '2026-11-17T10:00:00.000Z',
};

async function sync(projects: TrackerPassReport[] | undefined) {
  let out = '';
  const code = await trackerSyncCommand({
    json: true,
    sync: async () => projects,
    stdout: async text => {
      out += text;
    },
  });
  return { code, document: JSON.parse(out) as unknown };
}

test('tracker sync exits 0 when every project was scanned or is held by a live pass', async () => {
  expect(await sync([scanned, held])).toEqual({
    code: 0,
    document: { ok: true, projects: [scanned, held] },
  });
  expect(await sync(undefined)).toEqual({ code: 0, document: { ok: true, projects: [] } });
});

test('tracker sync exits 1 when a tracked project could not be scanned at all', async () => {
  const misconfigured: TrackerPassReport = {
    project: 'acme/broken',
    outcome: 'misconfigured',
    errorKind: 'unsupported_op',
  };
  const failed: TrackerPassReport = {
    project: 'acme/down',
    outcome: 'failed',
    error: 'db',
    posted: [],
    notPosted: [],
  };
  for (const report of [misconfigured, failed])
    expect(await sync([scanned, report])).toEqual({
      code: 1,
      document: { ok: false, projects: [scanned, report] },
    });
});

test('reading the tracker config on a fresh home creates no config.yaml; a default load still does', async () => {
  const home = tempRoots(await mkdtemp(join(tmpdir(), 'archon-tracker-home-')));
  process.env.ARCHON_HOME = home;
  registerBuiltinProviders();
  setPlatformPolicies([]);
  clearConfigCache();

  // Host creation for every `trigger` and `workflow` command reads the tracker config here.
  expect(await activateConfiguredTracker({})).toBeUndefined();
  expect(await readdir(home)).toEqual([]);

  await loadConfig();
  expect(existsSync(join(home, 'config.yaml'))).toBe(true);
});
