import { expect, test } from 'bun:test';
import type { TrackerPassReport } from '@archon/adapters/item-tracker/item-tracker';
import { trackerSyncCommand } from './tracker';

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
  const failed: TrackerPassReport = { project: 'acme/down', outcome: 'failed', error: 'db' };
  for (const report of [misconfigured, failed])
    expect(await sync([scanned, report])).toEqual({
      code: 1,
      document: { ok: false, projects: [scanned, report] },
    });
});
