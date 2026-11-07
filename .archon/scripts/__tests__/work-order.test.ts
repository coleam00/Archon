import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { BuildRecord } from '../../workflows/sdlc/.shared/build';
import type { MergeRecord } from '../../workflows/sdlc/.shared/merge';
import type { WorkOrder } from '../../workflows/sdlc/.shared/order';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
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
    INTAKE_STATE_CWD: gitCheckout({}, track),
    INTAKE_HOST_CLI: JSON.stringify(hostCli()),
  };
  inStore(env, () => {
    for (const [name, value] of Object.entries(documents)) expect(statePut(name, value, 0)).toBe('ok');
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

/** Run the pickup; the fake forge answers as issue `serves`, so claiming another issue fails the run. */
function facts(env: Record<string, string>, inputs: Record<string, string>, runId: string, serves = 0): Record<string, unknown> {
  const result: ScriptRun = runPackScript('build-queue/scripts/facts', {
    cwd: env.INTAKE_STATE_CWD,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    tracker: {
      issue: { number: serves, author: 'Maintainer', body: 'The contract.' },
      issueLabels: ['archon-ready'],
      repositoryLabels: [],
      pr: { state: 'OPEN', headRefName: 'feature' },
    },
    inputs: {
      ...env,
      WORKFLOW_ID: runId,
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_ROUND_LIMIT: '3',
      INPUTS_NUMBER: '',
      ...inputs,
    },
  });
  if (result.code !== 0) throw new Error(`facts exited ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const claimedNumber = (output: Record<string, unknown>): unknown => (output.item as { number: number } | null)?.number ?? null;

describe('build-queue pickup with work orders', () => {
  test('off, the pickup ignores orders; on, it claims only a member of an open order', () => {
    // 8 sorts first on urgency, but only 9 is in the order.
    const documents = { 'work/7': waiting(7), 'work/8': waiting(8, 'now'), 'work/9': waiting(9), 'work-order/next': order([9]) };
    expect(claimedNumber(facts(store(documents), {}, 'run-off', 8))).toBe(8);
    expect(claimedNumber(facts(store(documents), { INPUTS_ORDERS_ONLY: 'false' }, 'run-off', 8))).toBe(8);
    expect(claimedNumber(facts(store(documents), { INPUTS_ORDERS_ONLY: 'true' }, 'run-on', 9))).toBe(9);
  }, 60_000);

  test('on, with no open order, nothing is claimed', () => {
    for (const orders of [{}, { 'work-order/old': order([7], 'done') }]) {
      const env = store({ 'work/7': waiting(7), ...orders });
      expect(facts(env, { INPUTS_ORDERS_ONLY: 'true' }, 'run-on')).toMatchObject({ path: 'idle', item: null });
      expect(inStore(env, () => stateGet('work/7').value)).toMatchObject({ claim: null });
    }
  }, 60_000);

  test('an open order whose members all merged is marked done once, and builds nothing more', () => {
    const env = store({ 'work/7': merged(7), 'work/8': merged(8), 'work/9': waiting(9), 'work-order/next': order([7, 8]) });
    expect(facts(env, { INPUTS_ORDERS_ONLY: 'true' }, 'run-1')).toMatchObject({ path: 'idle' });
    const done = inStore(env, () => stateGet('work-order/next'));
    expect(done.value).toMatchObject({ members: [7, 8], status: 'done' });
    expect(typeof (done.value as WorkOrder).done_at).toBe('string');
    facts(env, { INPUTS_ORDERS_ONLY: 'true' }, 'run-2');
    expect(inStore(env, () => stateGet('work-order/next').revision)).toBe(done.revision);
  }, 60_000);

  test('an order with an unmerged member stays open and keeps its members building', () => {
    const env = store({ 'work/7': merged(7), 'work/9': waiting(9), 'work-order/next': order([7, 9]) });
    expect(claimedNumber(facts(env, { INPUTS_ORDERS_ONLY: 'true' }, 'run-1', 9))).toBe(9);
    expect(inStore(env, () => stateGet('work-order/next').value)).toMatchObject({ status: 'open', done_at: null });
  }, 60_000);

  test('a member re-triaged after its merge is not finished: the order stays open and the member builds again', () => {
    const rebuilt = merged(7);
    const retriaged = { ...rebuilt, facts: { ...rebuilt.facts, triage: { ...TRIAGE, at: '2026-11-06T01:00:00.000Z' } } };
    const env = store({ 'work/7': retriaged, 'work/8': merged(8), 'work-order/next': order([7, 8]) });
    expect(claimedNumber(facts(env, { INPUTS_ORDERS_ONLY: 'true' }, 'run-1', 7))).toBe(7);
    expect(inStore(env, () => stateGet('work-order/next').value)).toMatchObject({ status: 'open', done_at: null });
  }, 60_000);

  test('on, a named item is claimed though no open order holds it, so its follow-up rounds still start', () => {
    const env = store({ 'work/7': waiting(7) });
    expect(claimedNumber(facts(env, { INPUTS_ORDERS_ONLY: 'true', INPUTS_NUMBER: '7' }, 'run-1', 7))).toBe(7);
  }, 60_000);
});
