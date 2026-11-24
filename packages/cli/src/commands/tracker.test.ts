import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrackerPassReport } from '@archon/adapters/item-tracker/item-tracker';
import { clearConfigCache, loadConfig } from '@archon/core/config/config-loader';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { activateConfiguredTracker, trackerReleaseCommand, trackerSyncCommand } from './tracker';

const tempRoots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
const previousAssistant = process.env.DEFAULT_AI_ASSISTANT;

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  if (previousAssistant === undefined) delete process.env.DEFAULT_AI_ASSISTANT;
  else process.env.DEFAULT_AI_ASSISTANT = previousAssistant;
  clearConfigCache();
});

/** An empty ARCHON_HOME whose config loads regardless of the caller's provider setting. */
async function freshHome(): Promise<string> {
  const home = tempRoots(await mkdtemp(join(tmpdir(), 'archon-tracker-home-')));
  process.env.ARCHON_HOME = home;
  process.env.DEFAULT_AI_ASSISTANT = '';
  registerBuiltinProviders();
  setPlatformPolicies([]);
  clearConfigCache();
  return home;
}

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
  const home = await freshHome();

  expect(await activateConfiguredTracker({})).toBeUndefined();
  expect(existsSync(join(home, 'config.yaml'))).toBe(false);

  await loadConfig();
  expect(existsSync(join(home, 'config.yaml'))).toBe(true);
});

test('tracker release on a fresh home refuses an untracked project without creating config.yaml', async () => {
  const home = await freshHome();

  expect(await trackerReleaseCommand('acme/widgets', { json: true, stdout: async () => {} })).toBe(
    1
  );
  expect(existsSync(join(home, 'config.yaml'))).toBe(false);
});
