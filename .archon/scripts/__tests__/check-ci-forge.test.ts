import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { ChecksObservation } from '../../../packages/forge/src/operations';
import { trackTempRoots } from '@archon/paths/test-utils';

const SCRIPT = resolve(import.meta.dir, '../../workflows/sdlc/deliver/scripts/check-ci.ts');
const PR = { repo: { host: 'github.com', path: 'example/repo' }, number: 7 };
const trackTempRoot = trackTempRoots();

type State = 'pending' | 'green' | 'red' | 'gated' | 'unknown';

function set(state: State, name = 'build'): Pick<ChecksObservation, 'units' | 'summary'> {
  const unit: ChecksObservation['units'][number] = {
    unit: { kind: 'commit_status', id: name, name },
    nativeState: state,
    phase: state === 'pending' ? 'running' : 'completed',
    nativeResult: state,
    result: state === 'green' ? 'success' : state === 'pending' ? null : 'failure',
    state,
  };
  return {
    units: [unit],
    summary: {
      state,
      counts: {
        total: 1,
        green: state === 'green' ? 1 : 0,
        red: state === 'red' ? 1 : 0,
        pending: state === 'pending' ? 1 : 0,
        gated: state === 'gated' ? 1 : 0,
        unknown: state === 'unknown' ? 1 : 0,
      },
    },
  };
}

function run(
  full: ReturnType<typeof set>,
  required: ReturnType<typeof set> | null = null,
  exitCode = 0
): SpawnSyncReturns<string> {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'check-ci-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'archon');
  const response = JSON.stringify({
    operationId: 'op-checks',
    ok: true,
    result: {
      op: 'checks.state',
      value: { ref: PR, revision: 'deadbeef', ...full, required },
    },
  });
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(response)}); process.exitCode = ${exitCode};`);
  return spawnSync('bun', ['run', SCRIPT], {
    env: {
      ...process.env,
      ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]),
      INPUTS_PR: JSON.stringify(PR),
    },
    encoding: 'utf8',
  });
}

describe('check-ci forge observations', () => {
  it('classifies external-status-only observations and preserves revision evidence', () => {
    const result = run(set('red', 'external/status'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'red',
      detail: 'non-green checks at deadbeef: external/status (failure)',
    });
  });

  it('preserves a successful read when only audit persistence failed', () => {
    const result = run(set('green'), null, 2);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('applied/read succeeded; audit persistence failed');
    expect(result.stderr).toContain('op-checks');
    expect(result.stdout).toBe('');
  });

  it('prefers the authoritative required set when available', () => {
    const result = run(set('red', 'optional'), set('green', 'required'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('concluded');
    expect(result.stdout).toContain('1 observed check(s) green');
  });

  it('keeps gated explicit without calling it green', () => {
    const result = run(set('gated'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'checks gated at deadbeef: build (failure)',
    });
  });

  it('routes unknown state as red', () => {
    const result = run(set('unknown'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state).toBe('red');
    expect(result.stdout).toContain('unknown state');
  });

  it('gives none one bounded grace read before concluding', () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'check-ci-grace-')));
    const cli = join(root, 'archon');
    const marker = join(root, 'read-once');
    const none = JSON.stringify({
      operationId: 'one',
      ok: true,
      result: {
        op: 'checks.state',
        value: {
          ref: PR,
          revision: 'first',
          units: [],
          summary: {
            state: 'none',
            counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
          },
          required: null,
        },
      },
    });
    const green = JSON.stringify({
      operationId: 'two',
      ok: true,
      result: {
        op: 'checks.state',
        value: { ref: PR, revision: 'second', ...set('green'), required: null },
      },
    });
    writeFileSync(
      cli,
      `import { existsSync, writeFileSync } from 'node:fs'; const marker = ${JSON.stringify(marker)}; const seen = existsSync(marker); writeFileSync(marker, ''); process.stdout.write(seen ? ${JSON.stringify(green)} : ${JSON.stringify(none)});`
    );
    const preload = join(root, 'no-sleep.ts');
    writeFileSync(preload, "Object.defineProperty(Bun, 'sleepSync', { value: () => {} });\n");
    const result = spawnSync('bun', ['--preload', preload, SCRIPT], {
      env: {
        ...process.env,
        ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]),
        INPUTS_PR: JSON.stringify(PR),
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'all 1 observed check(s) green at second',
    });
  });
});
