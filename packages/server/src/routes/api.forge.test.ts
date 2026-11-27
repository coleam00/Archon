import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ChangeLookup, ChangeMergeState } from '@archon/adapters/forge-host';
import {
  forgeSubjectsResponseSchema,
  registerForgeRoutes,
  type DeliveredRun,
  type ForgeRouteDeps,
} from './api.forge';
import { forgeAnswerFile } from './forge-answer-file';

const track = trackTempRoots();

const PR = 'https://github.com/coleam00/archon-factory-console/pull/112';
const REMOTE = 'https://github.com/coleam00/archon-factory-console.git';

function appWith(opts: {
  runs: Record<string, DeliveredRun>;
  state?: (lookup: ChangeLookup) => Promise<ChangeMergeState>;
  title?: (n: number) => Promise<string>;
  now?: () => number;
  answerFile?: string;
}) {
  const asked = { changes: 0, issues: 0 };
  const answerFileAt = opts.answerFile;
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
    answerFile: answerFileAt === undefined ? undefined : forgeAnswerFile(() => answerFileAt),
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
  codebaseId: 'p',
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
      runs: { r2: { codebaseId: 'p', audits: [], branches: async () => [], recorded: null } },
    });
    expect((await read('branchRun=r2')).body.changes).toEqual([]);
  });

  test('a merge the item recorded answers only for the change it names', async () => {
    const PR113 = PR.replace('/112', '/113');
    const { read, asked } = appWith({
      runs: { r1: delivered({ change: PR, at: MERGED_AT }) },
      state: async () => ({ url: PR113, merged: false, mergedAt: null, number: 113 }),
    });
    const { body } = await read(`changeRun=r1&changeUrl=${encodeURIComponent(PR113)}`);
    expect(body.changes).toEqual([
      { run: 'r1', url: PR113, merged: false, mergedAt: null, number: 113 },
    ]);
    expect(asked.changes).toBe(1);
  });

  test('a run that named no URL answers only for its own project', async () => {
    const { read, asked } = appWith({
      runs: { r3: { ...delivered({ change: PR, at: MERGED_AT }), codebaseId: 'other' } },
    });
    expect((await read('branchRun=r3')).body.changes).toEqual([]);
    expect(asked.changes).toBe(0);
  });

  test('at most eight change lookups run at once, and every one settles into the cache', async () => {
    let inFlight = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const urls = Array.from({ length: 20 }, (_, i) => PR.replace('/112', `/${String(200 + i)}`));
    const { read, asked } = appWith({
      runs: { r1: delivered(null) },
      state: async lookup => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise<void>(resolve => gates.push(resolve));
        inFlight--;
        const at = lookup.kind === 'url' ? lookup.url : PR;
        return { url: at, merged: true, mergedAt: MERGED_AT, number: 112 };
      },
    });
    const query = urls.map(u => `changeRun=r1&changeUrl=${encodeURIComponent(u)}`).join('&');
    const first = await read(query);
    expect(first.body.changes.every(change => change.merged === 'pending')).toBe(true);
    expect(most).toBe(8);
    while (asked.changes < urls.length || gates.length > 0) {
      gates.splice(0).forEach(open => open());
      await Bun.sleep(1);
    }
    expect(most).toBe(8);
    expect((await read(query)).body.changes.every(change => change.merged === true)).toBe(true);
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

  test('a failed issue lookup is asked again after ten minutes, an answer is kept six hours', async () => {
    let at = Date.parse('2026-11-26T12:00:00.000Z');
    const asked: number[] = [];
    let failing = true;
    const app = new OpenAPIHono();
    registerForgeRoutes(app, {
      remote: async () => REMOTE,
      deliveredRun: async () => null,
      changeMergeState: async () => ({ url: PR, merged: false, mergedAt: null, number: 112 }),
      viewWorkItem: async number => {
        asked.push(number);
        if (failing && number === 7) return { number, unknown: 'gh: rate limited' };
        return {
          number,
          title: `Issue ${String(number)}`,
          state: 'open',
          url: `${REMOTE}/issues/1`,
        };
      },
      waitMs: 20,
      now: () => at,
    });
    const titles = async (): Promise<(string | null)[]> => {
      const res = await app.request('/api/forge/subjects?codebaseId=p&issue=7&issue=8');
      return forgeSubjectsResponseSchema.parse(await res.json()).issues.map(i => i.title);
    };
    expect(await titles()).toEqual([null, 'Issue 8']);
    failing = false;
    at += 11 * 60_000;
    // The failure is past its life and is asked again behind the stale answer; the answer is not.
    expect(await titles()).toEqual([null, 'Issue 8']);
    await Bun.sleep(10);
    expect(await titles()).toEqual(['Issue 7', 'Issue 8']);
    expect(asked).toEqual([7, 8, 7]);
  });

  test('refuses a changeRun without its changeUrl', async () => {
    const { read } = appWith({ runs: {} });
    expect((await read('changeRun=r1')).status).toBe(400);
  });
});

describe('GET /api/forge/subjects with an answer file', () => {
  const NOW = Date.parse('2026-11-25T12:00:00.000Z');
  const issue5 = { number: 5, title: 'Kept title', state: 'open', url: `${REMOTE}/issues/5` };
  async function fileWith(body: unknown): Promise<string> {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-answers-')));
    const path = join(dir, 'cache', 'forge-subjects.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body));
    return path;
  }

  test('a restarted server answers from the file without asking the forge', async () => {
    const answerFile = await fileWith({
      version: 1,
      issues: { [`${REMOTE}#5`]: { value: issue5, at: NOW } },
      changes: {
        [PR]: { value: { url: PR, merged: true, mergedAt: MERGED_AT, number: 112 }, at: NOW },
      },
    });
    const { read, asked } = appWith({
      runs: { r1: delivered(null) },
      now: () => NOW + 1000,
      answerFile,
    });
    const { body } = await read(`issue=5&${url}`);
    expect(body.issues[0]?.title).toBe('Kept title');
    expect(body.changes[0]).toMatchObject({ merged: true, mergedAt: MERGED_AT, number: 112 });
    expect(asked).toEqual({ changes: 0, issues: 0 });
  });

  test('an old answer is served while it is asked again', async () => {
    const answerFile = await fileWith({
      version: 1,
      issues: { [`${REMOTE}#5`]: { value: issue5, at: NOW - 7 * 3600_000 } },
    });
    const { read, asked } = appWith({ runs: {}, now: () => NOW, answerFile });
    expect((await read('issue=5')).body.issues[0]?.title).toBe('Kept title');
    expect(asked.issues).toBe(1);
    await Bun.sleep(10);
    expect((await read('issue=5')).body.issues[0]?.title).toBe('Issue 5');
  });

  test('stale answers refresh two at a time, behind the answers already shown', async () => {
    const stale = Object.fromEntries(
      [1, 2, 3, 4, 5].map(n => [
        `${REMOTE}#${String(n)}`,
        { value: { ...issue5, number: n, title: `Kept ${String(n)}` }, at: NOW - 7 * 3600_000 },
      ])
    );
    const answerFile = await fileWith({ version: 1, issues: stale });
    let inFlight = 0;
    let most = 0;
    const { read } = appWith({
      runs: {},
      now: () => NOW,
      answerFile,
      title: async n => {
        inFlight++;
        most = Math.max(most, inFlight);
        await Bun.sleep(5);
        inFlight--;
        return `Issue ${String(n)}`;
      },
    });
    const { body } = await read('issue=1&issue=2&issue=3&issue=4&issue=5');
    expect(body.issues.map(entry => entry.title)).toEqual([
      'Kept 1',
      'Kept 2',
      'Kept 3',
      'Kept 4',
      'Kept 5',
    ]);
    await Bun.sleep(60);
    expect(most).toBe(2);
  });

  test('what the route learns is written, and a restarted server answers from it', async () => {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-answers-')));
    const path = join(dir, 'cache', 'forge-subjects.json');
    const ask = (file: ReturnType<typeof forgeAnswerFile>) => {
      const asked = { issues: 0 };
      const app = new OpenAPIHono();
      registerForgeRoutes(app, {
        remote: async () => REMOTE,
        deliveredRun: async () => null,
        changeMergeState: async () => ({ url: PR, merged: false, mergedAt: null, number: 112 }),
        viewWorkItem: async number => {
          asked.issues++;
          return { number, title: 'Learned', state: 'open', url: `${REMOTE}/issues/7` };
        },
        waitMs: 20,
        answerFile: file,
      });
      return { app, asked };
    };
    const first = forgeAnswerFile(() => path);
    const before = ask(first);
    await before.app.request('/api/forge/subjects?codebaseId=p&issue=7');
    expect(before.asked.issues).toBe(1);
    await first.flush();

    const after = ask(forgeAnswerFile(() => path));
    const res = await after.app.request('/api/forge/subjects?codebaseId=p&issue=7');
    const body = forgeSubjectsResponseSchema.parse(await res.json());
    expect(body.issues[0]?.title).toBe('Learned');
    expect(after.asked.issues).toBe(0);
  });

  test('a kept failure is shown at once after a restart and asked again behind it', async () => {
    const answerFile = await fileWith({
      version: 1,
      issues: {
        [`${REMOTE}#5`]: { value: issue5, at: NOW },
        [`${REMOTE}#9`]: { value: { number: 9, unknown: 'gh: not found' }, at: NOW - 11 * 60_000 },
      },
    });
    // A forge slower than the read's wait: a first lookup would answer `pending`.
    const { read, asked } = appWith({
      runs: {},
      now: () => NOW,
      answerFile,
      title: async n => {
        await Bun.sleep(100);
        return `Issue ${String(n)}`;
      },
    });
    const { body } = await read('issue=5&issue=9');
    expect(body.issues.map(entry => [entry.title, entry.pending])).toEqual([
      ['Kept title', false],
      [null, false],
    ]);
    expect(asked.issues).toBe(1);
  });

  test("a remote's credentials never reach the file, and a key an older server kept them in is cleaned", async () => {
    const CREDENTIALED = 'https://user:tok@github.com/coleam00/archon-factory-console.git';
    const answerFile = await fileWith({
      version: 1,
      issues: { [`${CREDENTIALED}#5`]: { value: issue5, at: NOW } },
    });
    const file = forgeAnswerFile(() => answerFile);
    const asked: number[] = [];
    const app = new OpenAPIHono();
    registerForgeRoutes(app, {
      remote: async () => CREDENTIALED,
      deliveredRun: async () => null,
      changeMergeState: async () => ({ url: PR, merged: false, mergedAt: null, number: 112 }),
      viewWorkItem: async (number, remote) => {
        asked.push(number);
        // The forge is still asked through the remote as registered.
        expect(remote).toBe(CREDENTIALED);
        return { number, title: 'Learned', state: 'open', url: `${REMOTE}/issues/7` };
      },
      waitMs: 20,
      now: () => NOW,
      answerFile: file,
    });
    const res = await app.request('/api/forge/subjects?codebaseId=p&issue=5&issue=7');
    const body = forgeSubjectsResponseSchema.parse(await res.json());
    expect(body.issues.map(entry => entry.title)).toEqual(['Kept title', 'Learned']);
    expect(asked).toEqual([7]);
    await file.flush();
    const written = await readFile(answerFile, 'utf8');
    expect(written).not.toContain('tok');
    expect(written).toContain('Kept title');
  });

  test('a file that does not parse is an empty cache', async () => {
    const answerFile = await fileWith('{ not json');
    const { read, asked } = appWith({ runs: {}, answerFile });
    expect((await read('issue=5')).body.issues[0]?.title).toBe('Issue 5');
    expect(asked.issues).toBe(1);
  });

  test('keys and entries this server does not know are ignored, the rest kept', async () => {
    const answerFile = await fileWith({
      version: 1,
      written: 'by a newer server',
      issues: {
        [`${REMOTE}#5`]: { value: { ...issue5, labels: ['x'] }, at: NOW, source: 'gh' },
        [`${REMOTE}#6`]: { value: { number: 6, shape: 'unknown' }, at: NOW },
      },
    });
    const { read, asked } = appWith({ runs: {}, now: () => NOW, answerFile });
    const { body } = await read('issue=5&issue=6');
    expect(body.issues.map(entry => entry.title)).toEqual(['Kept title', 'Issue 6']);
    expect(asked.issues).toBe(1);
  });
});

describe('forgeAnswerFile', () => {
  test('writes what it learned, failures with their time too, for the next server to load', async () => {
    const dir = track(await mkdtemp(join(tmpdir(), 'forge-answers-')));
    const path = join(dir, 'cache', 'forge-subjects.json');
    const first = forgeAnswerFile(() => path);
    await first.load();
    first.issues.set('r#1', {
      value: { number: 1, title: 'One', state: 'open', url: 'u1' },
      at: 7,
    });
    first.issues.set('r#2', { value: { number: 2, unknown: 'not found' }, at: 7 });
    first.changes.set(PR, {
      value: { url: PR, merged: false, mergedAt: null, number: 112 },
      at: 8,
    });
    first.changes.set('run:x', {
      value: { url: null, merged: 'unknown', mergedAt: null, number: null, reason: 'down' },
      at: 8,
    });
    first.changed();
    await first.flush();

    const next = forgeAnswerFile(() => path);
    await next.load();
    expect([...next.issues]).toEqual([
      ['r#1', { value: { number: 1, title: 'One', state: 'open', url: 'u1' }, at: 7 }],
      ['r#2', { value: { number: 2, unknown: 'not found' }, at: 7 }],
    ]);
    expect([...next.changes]).toEqual([
      [PR, { value: { url: PR, merged: false, mergedAt: null, number: 112 }, at: 8 }],
      [
        'run:x',
        {
          value: { url: null, merged: 'unknown', mergedAt: null, number: null, reason: 'down' },
          at: 8,
        },
      ],
    ]);
  });
});
