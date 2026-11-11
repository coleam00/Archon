import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { WorkOrder } from '../../workflows/sdlc/.shared/order';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import { gitCheckout, hostCli, PR, packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();
const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');

const AT = '2026-11-06T00:00:00.000Z';

function order(members: number[]): WorkOrder {
  return { version: 1, members, approved: { by: 'maintainer', at: AT }, status: 'open', done_at: null };
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

describe('a work order from the run\'s message', () => {
  /** Run the order script as run `run-1`, started as `user-1`. */
  function writeOrder(env: Record<string, string>, declared: unknown, calls: string): ScriptRun {
    return runPackScript('build-queue/scripts/order', {
      cwd: env.INTAKE_STATE_CWD,
      forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
      inputs: {
        ...env,
        WORKFLOW_ID: 'run-1',
        RUN_LISTING: JSON.stringify([{ id: 'run-1', user_id: 'user-1' }]),
        ARCHON_CALL_LOG: calls,
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_ORDER: JSON.stringify(declared),
      },
    });
  }

  test('an id that exists is refused and the approved order is left as it was', () => {
    const env = store({ 'work-order/next': order([7]) });
    const before = inStore(env, () => stateGet('work-order/next'));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(writeOrder(env, { id: 'next', members: [8, 9], unresolved: [] }, calls).code).not.toBe(0);
    expect(inStore(env, () => stateGet('work-order/next'))).toEqual(before);
  }, 60_000);
});
