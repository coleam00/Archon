import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';

const FLIP = resolve(import.meta.dir, '../../workflows/sdlc/deliver/scripts/flip-ready.ts');
const PR = { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 };
const READY_REFUSAL = 'Only draft pull requests can be marked as ready for review';
const trackTempRoot = trackTempRoots();

type State = 'none' | 'pending' | 'green' | 'red' | 'gated' | 'unknown';

function response(state: State): string {
  const units =
    state === 'none'
      ? []
      : [
          {
            unit: { kind: 'check', id: '1', name: 'build' },
            nativeState: state,
            phase: state === 'pending' ? 'running' : 'completed',
            nativeResult: state,
            result: state === 'green' ? 'success' : state === 'pending' ? null : 'failure',
            state,
          },
        ];
  return JSON.stringify({
    operationId: 'op-1',
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref: PR,
        revision: 'abc123',
        units,
        summary: {
          state,
          counts: {
            total: units.length,
            green: state === 'green' ? 1 : 0,
            red: state === 'red' ? 1 : 0,
            pending: state === 'pending' ? 1 : 0,
            gated: state === 'gated' ? 1 : 0,
            unknown: state === 'unknown' ? 1 : 0,
          },
        },
        required: null,
      },
    },
  });
}

function run(
  state: State,
  options: { forgeFail?: boolean; readyFail?: string; prState?: string } = {}
): { code: number; stdout: string; stderr: string; readyCalled: boolean; args: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'flip-ready-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const readyMarker = join(root, 'ready');
  const argsMarker = join(root, 'forge-args');
  const forge = join(bin, 'fake-archon');
  writeFileSync(
    forge,
    `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(argsMarker)}, process.argv.slice(2).join(' '));
    ${options.forgeFail ? "process.stderr.write('plugin unavailable'); process.exit(1);" : `process.stdout.write(${JSON.stringify(response(state))});`}`
  );
  const preload = join(root, 'fake-gh.ts');
  writeFileSync(
    preload,
    `import { writeFileSync } from 'node:fs';
    const original = Bun.spawnSync.bind(Bun);
    Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
      if (argv[0] !== 'gh') return original(argv, settings);
      const text = argv.join(' ');
      const result = (exitCode, stdout = '', stderr = 'gh update notice') => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
      if (text.includes('pr checks') || text.includes('api graphql')) return result(97, '', 'unexpected gh check read');
      if (text.includes('pr ready')) {
        if (!text.includes('--repo ghe.example.com/example/repo')) return result(96);
        writeFileSync(${JSON.stringify(readyMarker)}, '');
        return ${options.readyFail ? `result(1, '', ${JSON.stringify(options.readyFail)})` : "result(0, 'ready')"};
      }
      if (text.includes('--json isDraft')) return result(0, 'false');
      if (text.includes('--json state')) return ${options.prState ? `result(0, ${JSON.stringify(options.prState)})` : 'result(1)'};
      if (text.includes('--json url')) return result(0, 'https://ghe.example.com/example/repo/pull/42');
      return result(95, '', 'unexpected gh');
    } });`
  );
  const env = {
    ...process.env,
    ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, forge]),
    INPUTS_PR: JSON.stringify(PR),
  };
  const flip = spawnSync(process.execPath, ['--preload', preload, FLIP], { env, encoding: 'utf8' });
  return {
    code: flip.status ?? -1,
    stdout: flip.stdout ?? '',
    stderr: flip.stderr ?? '',
    readyCalled: existsSync(readyMarker),
    args: existsSync(argsMarker) ? readFileSync(argsMarker, 'utf8') : '',
  };
}

describe('flip-ready forge check preflight', () => {
  it('passes the exact qualified PR and flips only green checks', () => {
    const result = run('green');
    expect(result.code).toBe(0);
    expect(result.readyCalled).toBe(true);
    expect(result.args).toContain('forge checks --json --data');
    expect(result.args).toContain('ghe.example.com');
    expect(JSON.parse(result.stdout)).toEqual({
      pr_url: 'https://ghe.example.com/example/repo/pull/42',
    });
  });

  it('allows an empty observation without leaking captured vendor output', () => {
    const result = run('none');
    expect(result.code).toBe(0);
    expect(result.readyCalled).toBe(true);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      pr_url: 'https://ghe.example.com/example/repo/pull/42',
    });
  });

  for (const state of ['pending', 'red', 'gated', 'unknown'] as const) {
    it(`refuses ${state} checks before the ready write`, () => {
      const result = run(state);
      expect(result.code).not.toBe(0);
      expect(result.readyCalled).toBe(false);
      expect(result.stderr).toContain(state);
    });
  }

  it('refuses a failed forge read before the ready write', () => {
    const result = run('green', { forgeFail: true });
    expect(result.code).not.toBe(0);
    expect(result.readyCalled).toBe(false);
    expect(result.stderr).toContain('forge check read failed');
  });
});

describe('flip-ready terminal-state classification', () => {
  it('reports delivery when the refused flip finds the PR merged', () => {
    const result = run('green', { readyFail: READY_REFUSAL, prState: 'MERGED' });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      pr_url: 'https://ghe.example.com/example/repo/pull/42',
    });
    expect(result.stderr).toContain('already merged');
  });

  it('refuses a PR closed without a merge', () => {
    const result = run('green', { readyFail: READY_REFUSAL, prState: 'CLOSED' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('CLOSED');
  });
});
