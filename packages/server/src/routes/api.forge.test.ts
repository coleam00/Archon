import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ChangeLookup, ChangeMergeState } from '@archon/adapters/forge-host';
import {
  forgeSubjectsResponseSchema,
  registerForgeRoutes,
  type DeliveredRun,
  type ForgeRouteDeps,
} from './api.forge';

const PR = 'https://github.com/coleam00/archon-factory-console/pull/112';
const REMOTE = 'https://github.com/coleam00/archon-factory-console.git';

function appWith(opts: {
  runs: Record<string, DeliveredRun>;
  state?: (lookup: ChangeLookup) => Promise<ChangeMergeState>;
  title?: (n: number) => Promise<string>;
  now?: () => number;
}) {
  const asked = { changes: 0, issues: 0 };
  const deps: ForgeRouteDeps = {
    remote: async id => (id === 'p' ? REMOTE : undefined),
    deliveredRun: async run => opts.runs[run] ?? null,
    changeMergeState: async lookup => {
      asked.changes++;
      return (
        opts.state?.(lookup) ??
        Promise.resolve({ url: PR, merged: false, mergedAt: null, number: 112 })
      );
    },
    viewWorkItem: async number => {
      asked.issues++;
      const title = await (opts.title?.(number) ?? Promise.resolve(`Issue ${String(number)}`));
      return { number, title, state: 'open', url: `${REMOTE}/issues/${String(number)}` };
    },
    waitMs: 20,
    now: opts.now,
  };
  const app = new OpenAPIHono();
  registerForgeRoutes(app, deps);
  const read = async (query: string) => {
    const res = await app.request(`/api/forge/subjects?codebaseId=p&${query}`);
    const json: unknown = await res.json();
    const parsed = forgeSubjectsResponseSchema.safeParse(json);
    return { status: res.status, body: parsed.success ? parsed.data : { issues: [], changes: [] } };
  };
  return { read, asked };
}

const delivered = (recorded: DeliveredRun['recorded']): DeliveredRun => ({
  audits: [],
  branches: async () => ['archon/task-1'],
  recorded,
});
const MERGED_AT = '2026-11-20T12:00:00.000Z';
const url = `changeRun=r1&changeUrl=${encodeURIComponent(PR)}`;

describe('GET /api/forge/subjects', () => {
  test('a change whose item recorded its merge is merged without asking the forge whether', async () => {
    const { read, asked } = appWith({
      runs: { r1: delivered({ change: PR, at: '2026-11-20T12:00:00Z' }) },
      state: async () => ({ url: PR, merged: true, mergedAt: null, number: 112 }),
    });
    const { body } = await read(url);
    expect(body.changes).toEqual([
      { run: 'r1', url: PR, merged: true, mergedAt: '2026-11-20T12:00:00Z', number: null },
    ]);
    // Only the pull request's number is asked, once, without waiting.
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await read(url)).body.changes[0]?.number).toBe(112);
    expect(asked.changes).toBe(1);
  });

  test('an unrecorded change asks once within the cache time, then refreshes until it merged', async () => {
    let clock = 0;
    let merged = false;
    const { read, asked } = appWith({
      runs: { r1: delivered(null) },
      now: () => clock,
      state: async () => ({ url: PR, merged, mergedAt: merged ? MERGED_AT : null, number: 112 }),
    });
    expect((await read(url)).body.changes[0]).toMatchObject({ merged: false, number: 112 });
    clock = 30_000;
    await read(url);
    expect(asked.changes).toBe(1);
    // A minute on, the change merged on the forge: the stale answer is served once while it
    // refreshes, and the next read has the merge.
    merged = true;
    clock = 60_000;
    expect((await read(url)).body.changes[0]?.merged).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await read(url)).body.changes[0]).toMatchObject({ merged: true, mergedAt: MERGED_AT });
    expect(asked.changes).toBe(2);
    // A merge does not come undone: it is never asked again.
    clock = 10_000_000;
    await read(url);
    expect(asked.changes).toBe(2);
  });

  test('a forge that throws answers unknown, and the read still answers', async () => {
    const { read } = appWith({
      runs: { r1: delivered(null) },
      state: async () => {
        throw new Error('forge down');
      },
    });
    const { status, body } = await read(url);
    expect(status).toBe(200);
    expect(body.changes[0]).toMatchObject({ url: PR, merged: 'unknown' });
  });

  test('a slow forge answers pending, and the next read has its answer', async () => {
    const { read } = appWith({
      runs: { r1: delivered(null) },
      state: () =>
        new Promise(resolve =>
          setTimeout(() => resolve({ url: PR, merged: true, mergedAt: null, number: 112 }), 60)
        ),
    });
    expect((await read(url)).body.changes[0]?.merged).toBe('pending');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect((await read(url)).body.changes[0]?.merged).toBe(true);
  });

  test('a run that named no URL with no branch on its item has no change', async () => {
    const { read } = appWith({
      runs: { r2: { audits: [], branches: async () => [], recorded: null } },
    });
    expect((await read('branchRun=r2')).body.changes).toEqual([]);
  });

  test("an issue's title is answered, then served from the cache", async () => {
    const { read, asked } = appWith({ runs: {} });
    const first = await read('issue=111&issue=111');
    expect(first.body.issues).toEqual([
      {
        number: 111,
        title: 'Issue 111',
        state: 'open',
        url: `${REMOTE}/issues/111`,
        pending: false,
      },
    ]);
    await read('issue=111');
    expect(asked.issues).toBe(1);
  });

  test('refuses a changeRun without its changeUrl', async () => {
    const { read } = appWith({ runs: {} });
    expect((await read('changeRun=r1')).status).toBe(400);
  });
});
