import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { BuildRecord } from '../../workflows/sdlc/.shared/build';
import type { MergeRecord } from '../../workflows/sdlc/.shared/merge';
import type { WorkOrder } from '../../workflows/sdlc/.shared/order';
import { state } from 'archon:script';
import { newWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { gitCheckout, hostCli, PR, packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();
const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');

const AT = '2026-11-06T00:00:00.000Z';
const TRIAGE: TriageFacts = {
  verdict: { contract: 'READY', route: 'deliver' },
  pull_request: null,
  type: { value: 'bug', reason: 'r' },
  size: { value: 's', reason: 'r' },
  complexity: { value: 'low', reason: 'r' },
  importance: { value: 'medium', reason: 'r' },
  urgency: { value: 'none', reason: 'r' },
  at: AT,
  run_id: 'intake-run',
};

function waiting(number: number, urgency: 'none' | 'now' = 'none'): WorkItem {
  return {
    ...newWorkItem({ repo: PR.repo, number }, AT),
    stage: 'deliver',
    trust: 'maintainer',
    facts: { triage: { ...TRIAGE, urgency: { value: urgency, reason: 'r' } } },
  };
}

function merged(number: number): WorkItem {
  const build: BuildRecord = { status: 'ready', brief: '', rounds: [], decisions: [], at: AT };
  const merge: MergeRecord = { status: 'merged', pr: { repo: PR.repo, number: 100 + number }, approval: null, decisions: [], at: AT };
  const item = waiting(number);
  return { ...item, facts: { ...item.facts, build, merge } };
}

function order(members: number[], status: WorkOrder['status'] = 'open'): WorkOrder {
  const base = { version: 1, members, approved: { by: 'maintainer', at: AT } } as const;
  return status === 'done' ? { ...base, status, done_at: AT } : { ...base, status, done_at: null };
}

/** A scratch state store with these documents in it; the real CLI writes them. */
function store(documents: Record<string, unknown>): Record<string, string> {
  const home = track(mkdtempSync(join(tmpdir(), 'archon-order-home-')));
  const env = {
    ARCHON_HOME: home,
    HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    INTAKE_STATE_CWD: gitCheckout(track),
    INTAKE_HOST_CLI: JSON.stringify(hostCli()),
  };
  inStore(env, () => {
    for (const [name, value] of Object.entries(documents)) expect(state.put(name, value, { ifRevision: 0 }).ok).toBe(true);
  });
  return env;
}

function inStore<T>(env: Record<string, string>, body: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, env, { ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]) });
  try {
    return body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** Run the pick with no message; returns the issues it fired a build for, in order. */
function fired(env: Record<string, string>, inputs: Record<string, string>): unknown {
  const result: ScriptRun = runPackScript('build-pick/scripts/fire', {
    cwd: env.INTAKE_STATE_CWD,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    inputs: {
      ...env,
      WORKFLOW_ID: 'run-1',
      INPUTS_REPO: JSON.stringify(PR.repo),
      INPUTS_INTERPRETED: 'null',
      INPUTS_CHOSEN: 'null',
      INPUTS_BUILD_QUEUE_BINDING: '/bindings/build-queue.json',
      ...inputs,
    },
  });
  if (result.code !== 0) throw new Error(`fire exited ${String(result.code)}: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { fired: unknown }).fired;
}

const ORDERS_ONLY = { INPUTS_ORDERS_ONLY: 'true' };

describe('the pick with work orders', () => {
  test('off, the pick ignores orders; on, it starts only the members of an open order', () => {
    // 8 sorts first on urgency, but only 9 is in the order.
    const documents = { 'work/7': waiting(7), 'work/8': waiting(8, 'now'), 'work/9': waiting(9), 'work-order/next': order([9]) };
    expect(fired(store(documents), {})).toEqual([8, 7, 9]);
    expect(fired(store(documents), ORDERS_ONLY)).toEqual([9]);
  }, 60_000);

  test('on, an item the queue already built a round for gets its next round though no order holds it', () => {
    const begun = { ...waiting(7), facts: { ...waiting(7).facts, build: { status: 'next', brief: 'continue', rounds: [], decisions: [], at: AT } satisfies BuildRecord } };
    expect(fired(store({ 'work/7': begun, 'work/8': waiting(8) }), ORDERS_ONLY)).toEqual([7]);
  }, 60_000);

  test('on, with no open order, nothing starts', () => {
    for (const orders of [{}, { 'work-order/old': order([7], 'done') }]) {
      expect(fired(store({ 'work/7': waiting(7), ...orders }), ORDERS_ONLY)).toEqual([]);
    }
  }, 60_000);

  test('an open order whose members all merged is marked done, and builds nothing more', () => {
    const env = store({ 'work/7': merged(7), 'work/8': merged(8), 'work/9': waiting(9), 'work-order/next': order([7, 8]) });
    expect(fired(env, ORDERS_ONLY)).toEqual([]);
    expect(inStore(env, () => state.get('work-order/next')).value).toMatchObject({ members: [7, 8], status: 'done' });
  }, 60_000);

  test('a member re-triaged after its merge is not finished: the order stays open and the member builds again', () => {
    const rebuilt = merged(7);
    const retriaged = { ...rebuilt, facts: { ...rebuilt.facts, triage: { ...TRIAGE, at: '2026-11-06T01:00:00.000Z' } } };
    const env = store({ 'work/7': retriaged, 'work/8': merged(8), 'work/9': waiting(9), 'work-order/next': order([7, 8, 9]) });
    expect(fired(env, ORDERS_ONLY)).toEqual([7, 9]);
    expect(inStore(env, () => state.get('work-order/next').value)).toMatchObject({ status: 'open', done_at: null });
  }, 60_000);
});

describe('a work order from the run\'s message', () => {
  /** Run the order script as run `run-1`, started as `user-1`. */
  function writeOrder(env: Record<string, string>, declared: unknown, calls: string): ScriptRun {
    return runPackScript('build-pick/scripts/order', {
      cwd: env.INTAKE_STATE_CWD,
      forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
      inputs: {
        ...env,
        WORKFLOW_ID: 'run-1',
        RUN_LISTING: JSON.stringify([{ id: 'run-1', user_id: 'user-1' }]),
        ARCHON_CALL_LOG: calls,
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_ORDER: JSON.stringify(declared),
        INPUTS_INTAKE_BINDING: '/bindings/intake.json',
      },
    });
  }

  test('is written open, approved by the run\'s user, and sends an unseen member to intake', () => {
    const env = store({ 'work/7': waiting(7) });
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const result = writeOrder(env, { id: 'next', members: [7, 8], unresolved: [] }, calls);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    expect(inStore(env, () => state.get('work-order/next').value)).toMatchObject({
      version: 1,
      members: [7, 8],
      approved: { by: 'user-1' },
      status: 'open',
      done_at: null,
    });
    const fires = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).filter(argv => argv[0] === 'trigger');
    expect(fires).toHaveLength(1);
    expect(fires[0]).toEqual(expect.arrayContaining(['--binding', '/bindings/intake.json', '--item', 'issue-8']));
  }, 60_000);

  test('an id that exists is refused and the approved order is left as it was', () => {
    const env = store({ 'work-order/next': order([7]) });
    const before = inStore(env, () => state.get('work-order/next'));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(writeOrder(env, { id: 'next', members: [8, 9], unresolved: [] }, calls).code).not.toBe(0);
    expect(inStore(env, () => state.get('work-order/next'))).toEqual(before);
  }, 60_000);
});
