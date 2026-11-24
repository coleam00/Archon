import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrackerPassReport } from '@archon/adapters/item-tracker/item-tracker';
import { clearConfigCache, loadConfig } from '@archon/core/config/config-loader';
import { clearPlatformPolicies, setPlatformPolicies } from '@archon/core/platforms/registry';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { activateConfiguredTracker, trackerReleaseCommand, trackerSyncCommand } from './tracker';

registerBuiltinProviders();
const trackTempRoot = trackTempRoots();
const savedHome = process.env.ARCHON_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  clearConfigCache();
  clearPlatformPolicies();
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

test('reading the tracker config leaves a fresh home without a config.yaml', async () => {
  const home = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-home-')));
  process.env.ARCHON_HOME = home;
  clearConfigCache();
  setPlatformPolicies([]);
  const configPath = join(home, 'config.yaml');

  expect(await activateConfiguredTracker({})).toBeUndefined();
  expect(
    await trackerReleaseCommand('acme/widgets', { json: true, stdout: async () => undefined })
  ).toBe(1);
  expect(existsSync(configPath)).toBe(false);

  await loadConfig();
  expect(existsSync(configPath)).toBe(true);
});
