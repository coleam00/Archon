/**
 * Provider admission against a real SQLite database: the capped wrapper, the
 * attempt-holder liveness rule, and cross-process exclusion.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  getRegistration,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerProvider,
} from '@archon/providers';
import type {
  MessageChunk,
  ProviderAdmissionEvent,
  ProviderCodexRateLimitRequest,
  SendQueryOptions,
} from '@archon/providers';
import { closeDatabase, getDatabase, resetDatabase } from '../db/connection';
import { SqliteAdapter } from '../db/adapters/sqlite';
import {
  listProviderAttemptHolders,
  providerResourceKey,
  releaseProviderAttemptHolder,
  tryAdmitProviderAttempt,
} from '../db/provider-attempts';
import { currentProcessOwner } from '../db/process-owner';
import { ProviderConcurrencyConfigError } from '../config/provider-concurrency';
import { getAgentProvider, ProviderAdmissionAbortedError } from './provider-admission';

const PROVIDER = 'admission-fake';
const POLL_MS = 10;
const REPO_ROOT = join(import.meta.dir, '../../../..');

/** Scripted behavior of fake `sendQuery` calls, keyed by prompt: admission order is not call order. */
type Script = (options: SendQueryOptions | undefined) => AsyncGenerator<MessageChunk>;
const scripts = new Map<string, Script>();
let calls: (SendQueryOptions | undefined)[] = [];
let codexRateLimitRequests: ProviderCodexRateLimitRequest[] = [];

beforeAll(() => {
  registerBuiltinProviders();
  if (isRegisteredProvider(PROVIDER)) return;
  const claude = getRegistration('claude');
  registerProvider({
    ...claude,
    id: PROVIDER,
    displayName: 'Admission fake',
    builtIn: false,
    factory: () => ({
      getType: () => PROVIDER,
      getCapabilities: () => claude.capabilities,
      readCodexRateLimit: async request => {
        codexRateLimitRequests.push(request);
        return {
          limitId: request.limitId,
          exhausted: true,
          fetchedAt: Date.now(),
        };
      },
      sendQuery: (prompt, _cwd, _resume, options) => {
        calls.push(options);
        const script = scripts.get(prompt);
        if (!script) throw new Error(`no scripted sendQuery for '${prompt}'`);
        return script(options);
      },
    }),
  });
});

let root = '';
const originalArchonHome = process.env.ARCHON_HOME;
const originalDatabaseUrl = process.env.DATABASE_URL;

async function writeCaps(caps: Record<string, number> | string): Promise<void> {
  const body =
    typeof caps === 'string'
      ? caps
      : `concurrency:\n  providers:\n${Object.entries(caps)
          .map(([id, n]) => `    ${id}: ${String(n)}\n`)
          .join('')}`;
  await writeFile(join(root, 'config.yaml'), body);
}

async function holderCount(): Promise<number> {
  const rows = await getDatabase().query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM remote_agent_resource_slot_holders WHERE resource_key = $1',
    [providerResourceKey(PROVIDER)]
  );
  return Number(rows.rows[0]?.n ?? 0);
}

/** A stream that yields once, then waits for `release()` before finishing. */
function gated(): {
  script: Script;
  started: Promise<void>;
  release: () => void;
  closed: Promise<void>;
} {
  let release!: () => void;
  let markStarted!: () => void;
  let markClosed!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const started = new Promise<void>(resolve => (markStarted = resolve));
  const closed = new Promise<void>(resolve => (markClosed = resolve));
  return {
    started,
    release,
    closed,
    script: async function* () {
      try {
        markStarted();
        yield { type: 'assistant', content: 'working' };
        await gate;
        yield { type: 'result' };
      } finally {
        markClosed();
      }
    },
  };
}

async function drain(stream: AsyncGenerator<MessageChunk>): Promise<void> {
  for await (const _ of stream) {
    // consume
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-provider-admission-'));
  process.env.ARCHON_HOME = root;
  delete process.env.DATABASE_URL;
  resetDatabase();
  scripts.clear();
  calls = [];
  codexRateLimitRequests = [];
});

afterEach(async () => {
  await closeDatabase();
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await removeTempTree(root);
});

describe('provider admission wrapper', () => {
  test('an uncapped provider runs unchanged and never takes a slot', async () => {
    await writeCaps({ claude: 1 });
    const options: SendQueryOptions = { model: 'm' };
    scripts.set('p', async function* () {
      expect(await holderCount()).toBe(0);
      yield { type: 'result' };
    });
    await drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('p', '/tmp', undefined, options));
    expect(calls).toEqual([options]);
    expect(await holderCount()).toBe(0);
  });

  test('provider-native Codex rate-limit reads pass through without consuming a send slot', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const request: ProviderCodexRateLimitRequest = {
      limitId: 'five_hour',
      expectedAccountId: 'test-account',
      cacheScope: 'opaque-user-scope',
      cwd: '/tmp/project',
      options: {
        env: { CODEX_HOME: '/tmp/codex-home' },
        codexAuthProfile: { kind: 'user-oauth', accountId: 'test-account' },
      },
    };

    const snapshot = await getAgentProvider(PROVIDER, POLL_MS).readCodexRateLimit?.(request);

    expect(codexRateLimitRequests).toEqual([request]);
    expect(snapshot).toMatchObject({ limitId: 'five_hour', exhausted: true });
    expect(calls).toHaveLength(0);
    expect(await holderCount()).toBe(0);
  });

  test('a cap of 1 serializes attempts and reports the wait', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const first = gated();
    const second = gated();
    scripts.set('a', first.script).set('b', second.script);
    const events: ProviderAdmissionEvent[] = [];
    const provider = getAgentProvider(PROVIDER, POLL_MS);

    const firstRun = drain(provider.sendQuery('a', '/tmp'));
    await first.started;
    const secondRun = drain(
      provider.sendQuery('b', '/tmp', undefined, { onAdmission: event => events.push(event) })
    );
    await Bun.sleep(POLL_MS * 5);
    expect(calls).toHaveLength(1);
    expect(events.map(e => e.state)).toEqual(['waiting']);
    expect(await holderCount()).toBe(1);

    first.release();
    await firstRun;
    await second.started;
    expect(events.map(e => e.state)).toEqual(['waiting', 'admitted']);
    second.release();
    await secondRun;
    expect(events.map(e => e.state)).toEqual(['waiting', 'admitted', 'released']);
    expect(new Set(events.map(e => e.attemptId)).size).toBe(1);
    expect(events[0]).toMatchObject({ provider: PROVIDER, capacity: 1 });
    expect(await holderCount()).toBe(0);
  });

  test('aborting a waiter admits nothing and leaves no holder', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const first = gated();
    scripts.set('a', first.script);
    const provider = getAgentProvider(PROVIDER, POLL_MS);
    const firstRun = drain(provider.sendQuery('a', '/tmp'));
    await first.started;

    const controller = new AbortController();
    const waiter = drain(
      provider.sendQuery('b', '/tmp', undefined, { abortSignal: controller.signal })
    );
    await Bun.sleep(POLL_MS * 3);
    controller.abort();
    await expect(waiter).rejects.toBeInstanceOf(ProviderAdmissionAbortedError);
    expect(calls).toHaveLength(1);
    expect(await holderCount()).toBe(1);

    first.release();
    await firstRun;
    expect(await holderCount()).toBe(0);
  });

  test('the slot is released only after the provider stream has closed', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const order: string[] = [];
    scripts.set('a', async function* () {
      try {
        yield { type: 'assistant', content: 'x' };
        yield { type: 'assistant', content: 'never read' };
      } finally {
        order.push(`provider closed, holders=${String(await holderCount())}`);
      }
    });
    const stream = getAgentProvider(PROVIDER, POLL_MS).sendQuery('a', '/tmp');
    for await (const _ of stream) break; // consumer abandons mid-stream
    order.push(`after return, holders=${String(await holderCount())}`);
    expect(order).toEqual(['provider closed, holders=1', 'after return, holders=0']);
  });

  test('a failing attempt releases its slot and keeps its own error', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    scripts.set('a', async function* () {
      yield { type: 'assistant', content: 'x' };
      throw new Error('provider exploded');
    });
    await expect(drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('a', '/tmp'))).rejects.toThrow(
      'provider exploded'
    );
    expect(await holderCount()).toBe(0);
  });

  test('releaseDuring frees the slot for another attempt during backoff', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const other = gated();
    let duringBackoff = -1;
    scripts.set('a', async function* (options) {
      yield { type: 'assistant', content: 'first try failed' };
      await options?.admission?.releaseDuring(async () => {
        duringBackoff = await holderCount();
        const run = drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('other', '/tmp'));
        await other.started;
        other.release();
        await run;
      });
      yield { type: 'result' };
    });
    scripts.set('other', other.script);
    await drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('a', '/tmp'));
    expect(duringBackoff).toBe(0);
    expect(calls).toHaveLength(2);
    expect(await holderCount()).toBe(0);
  });

  test('lowering the cap blocks new admissions and never revokes live holders', async () => {
    await writeCaps({ [PROVIDER]: 2 });
    const a = gated();
    const b = gated();
    const c = gated();
    scripts.set('a', a.script).set('b', b.script).set('c', c.script);
    const provider = getAgentProvider(PROVIDER, POLL_MS);
    const runA = drain(provider.sendQuery('a', '/tmp'));
    const runB = drain(provider.sendQuery('b', '/tmp'));
    await Promise.all([a.started, b.started]);

    await writeCaps({ [PROVIDER]: 1 });
    const runC = drain(provider.sendQuery('c', '/tmp'));
    a.release();
    await runA;
    await Bun.sleep(POLL_MS * 5);
    // One live holder already meets the lowered cap.
    expect(calls).toHaveLength(2);
    expect(await holderCount()).toBe(1);

    b.release();
    await runB;
    await c.started;
    c.release();
    await runC;
    expect(await holderCount()).toBe(0);
  });

  test('invalid cap config refuses the attempt before the provider starts', async () => {
    for (const config of [
      { 'no-such-provider': 1 },
      `concurrency:\n  providers:\n    ${PROVIDER}: 0\n`,
      `concurrency:\n  providers:\n    ${PROVIDER}: two\n`,
      'concurrency: [unclosed',
    ]) {
      await writeCaps(config);
      await expect(
        drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('a', '/tmp'))
      ).rejects.toBeInstanceOf(ProviderConcurrencyConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  test('a waiter admits against the cap as it is now, not as it was when it began', async () => {
    await writeCaps({ [PROVIDER]: 1 });
    const a = gated();
    const b = gated();
    const c = gated();
    scripts.set('a', a.script).set('b', b.script).set('c', c.script);
    const provider = getAgentProvider(PROVIDER, POLL_MS);
    const runA = drain(provider.sendQuery('a', '/tmp'));
    await a.started;
    const runB = drain(provider.sendQuery('b', '/tmp'));
    await Bun.sleep(POLL_MS * 3);
    expect(calls).toHaveLength(1);

    // Raised while B waits: B is admitted beside A.
    await writeCaps({ [PROVIDER]: 2 });
    await b.started;
    expect(await holderCount()).toBe(2);

    // Removed while C waits: C proceeds uncapped without a holder.
    await writeCaps({ [PROVIDER]: 2 });
    const runC = drain(provider.sendQuery('c', '/tmp'));
    await Bun.sleep(POLL_MS * 3);
    expect(calls).toHaveLength(2);
    await writeCaps({ claude: 1 });
    await c.started;
    expect(await holderCount()).toBe(2);

    for (const g of [a, b, c]) g.release();
    await Promise.all([runA, runB, runC]);
    expect(await holderCount()).toBe(0);
  });

  test('an empty concurrency or providers block means no caps', async () => {
    for (const config of ['concurrency:\n', 'concurrency:\n  providers:\n']) {
      await writeCaps(config);
      scripts.set('a', async function* () {
        yield { type: 'result' };
      });
      await drain(getAgentProvider(PROVIDER, POLL_MS).sendQuery('a', '/tmp'));
    }
    expect(calls).toHaveLength(2);
    expect(await holderCount()).toBe(0);
  });
});

describe('attempt holder liveness', () => {
  async function insertAttempt(owner: {
    host: string;
    pid: number;
    instance: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    expect(
      (await tryAdmitProviderAttempt({ provider: PROVIDER, capacity: 99, attemptId: id, owner }))
        .admitted
    ).toBe(true);
    return id;
  }

  test('a same-host holder whose process is gone is released at the next admission', async () => {
    const child = Bun.spawn(['bun', '-e', '0']);
    await child.exited;
    await insertAttempt({ ...currentProcessOwner, pid: child.pid });
    // A restarted process can get its old pid back; its instance token differs.
    await insertAttempt({ ...currentProcessOwner, instance: crypto.randomUUID() });

    const next = crypto.randomUUID();
    expect(
      await tryAdmitProviderAttempt({ provider: PROVIDER, capacity: 1, attemptId: next })
    ).toEqual({
      admitted: true,
      live: 1,
    });
    expect((await listProviderAttemptHolders()).map(h => h.attemptId)).toEqual([next]);
  });

  test('an owner on another host stays held until the operator releases it', async () => {
    const remote = await insertAttempt({ host: 'another-host', pid: 1, instance: 'x' });
    const local = await insertAttempt(currentProcessOwner);
    expect(
      await tryAdmitProviderAttempt({
        provider: PROVIDER,
        capacity: 2,
        attemptId: crypto.randomUUID(),
      })
    ).toEqual({ admitted: false, live: 2 });

    const holders = await listProviderAttemptHolders();
    expect(holders.find(h => h.attemptId === remote)?.ownerOnThisHost).toBe(false);
    expect(await releaseProviderAttemptHolder(local)).toBe('owner_running');
    expect(await releaseProviderAttemptHolder(remote)).toBe('released');
    expect(await releaseProviderAttemptHolder(remote)).toBe('not_found');
    expect((await listProviderAttemptHolders()).map(h => h.attemptId)).toEqual([local]);
  });
});

describe('cross-process admission', () => {
  function spawnScript(script: string): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(['bun', '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  test('independent processes never exceed the cap', async () => {
    await writeCaps({ claude: 1 });
    // Prime the schema once so the children only contend for the slot.
    await getDatabase().query('SELECT 1');
    const script = `
      import { registerBuiltinProviders } from './packages/providers/src/index.ts';
      import { tryAdmitProviderAttempt, releaseProviderAttempt } from './packages/core/src/db/provider-attempts.ts';
      registerBuiltinProviders();
      const id = crypto.randomUUID();
      while (!(await tryAdmitProviderAttempt({ provider: 'claude', capacity: 1, attemptId: id })).admitted) {
        await Bun.sleep(5);
      }
      const start = performance.timeOrigin + performance.now();
      await Bun.sleep(60);
      const end = performance.timeOrigin + performance.now();
      await releaseProviderAttempt('claude', id);
      console.log(JSON.stringify({ start, end }));
    `;
    const children = Array.from({ length: 4 }, () => spawnScript(script));
    const intervals = await Promise.all(
      children.map(async child => {
        const [out, err, code] = await Promise.all([
          new Response(child.stdout as ReadableStream).text(),
          new Response(child.stderr as ReadableStream).text(),
          child.exited,
        ]);
        expect({ code, err }).toEqual({ code: 0, err: expect.any(String) });
        return JSON.parse(out.trim().split('\n').pop() ?? '') as { start: number; end: number };
      })
    );
    intervals.sort((x, y) => x.start - y.start);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i].start).toBeGreaterThanOrEqual(intervals[i - 1].end);
    }
  }, 30_000);

  test('a killed holder process is released by the next admission on this host', async () => {
    await getDatabase().query('SELECT 1');
    const child = spawnScript(`
      import { tryAdmitProviderAttempt } from './packages/core/src/db/provider-attempts.ts';
      await tryAdmitProviderAttempt({ provider: '${PROVIDER}', capacity: 1, attemptId: crypto.randomUUID() });
      console.log('held');
      await Bun.sleep(60_000);
    `);
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let output = '';
    while (!output.includes('held')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    expect(output).toContain('held');

    const blocked = await tryAdmitProviderAttempt({
      provider: PROVIDER,
      capacity: 1,
      attemptId: crypto.randomUUID(),
    });
    expect(blocked).toEqual({ admitted: false, live: 1 });

    child.kill('SIGKILL');
    await child.exited;
    const after = await tryAdmitProviderAttempt({
      provider: PROVIDER,
      capacity: 1,
      attemptId: crypto.randomUUID(),
    });
    expect(after).toEqual({ admitted: true, live: 1 });
  }, 30_000);
});

describe('schema upgrade', () => {
  test('a dev database with the run-only holder CHECK is rebuilt and keeps its holders', async () => {
    await closeDatabase();
    const path = join(root, 'narrow.db');
    const seed = new Database(path);
    seed.run(`CREATE TABLE remote_agent_resource_slots (
      resource_key TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    seed.run(`CREATE TABLE remote_agent_resource_slot_holders (
      resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
      holder_kind TEXT NOT NULL CHECK (holder_kind IN ('run')),
      holder_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (resource_key, holder_kind, holder_id))`);
    seed.run("INSERT INTO remote_agent_resource_slots (resource_key) VALUES ('shared')");
    seed.run(
      "INSERT INTO remote_agent_resource_slot_holders (resource_key, holder_kind, holder_id, acquired_at) VALUES ('shared', 'run', 'r1', '2026-01-01 00:00:00')"
    );
    seed.close();

    const db = new SqliteAdapter(path);
    try {
      const holders = await db.query<Record<string, unknown>>(
        'SELECT resource_key, holder_kind, holder_id, acquired_at, owner_host FROM remote_agent_resource_slot_holders'
      );
      expect(holders.rows).toEqual([
        {
          resource_key: 'shared',
          holder_kind: 'run',
          holder_id: 'r1',
          acquired_at: '2026-01-01 00:00:00',
          owner_host: null,
        },
      ]);
      await db.query(
        `INSERT INTO remote_agent_resource_slot_holders
           (resource_key, holder_kind, holder_id, owner_host, owner_pid, owner_instance)
           VALUES ('shared', 'attempt', 'a1', 'h', 1, 'i')`
      );
    } finally {
      await db.close();
    }
  });
});
