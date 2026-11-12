import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  forgeOperation,
  gitCheckout,
  packScriptRunner,
  type ScriptOptions,
} from './deliver-checks-harness';
import { REQUIRED_FORGE_OPERATIONS } from '../../workflows/sdlc/.shared/forge-check';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

const ANSWERED = forgeOperation('pr.view', null);
const ARCHON_HOME = join(tmpdir(), 'archon-home-elsewhere');

function refusal(kind: string, message: string): string {
  return JSON.stringify({ operationId: 'op-labels', ok: false, error: { kind, message } });
}

function check(options: ScriptOptions & { mirror?: boolean } = {}) {
  const { mirror, ...rest } = options;
  const cwd = rest.cwd ?? gitCheckout({}, trackTempRoot);
  if (mirror === true) {
    spawnSync('git', ['remote', 'add', 'mirror', 'https://mirror.example.com/example/repo.git'], {
      cwd,
    });
  }
  return runPackScript('.shared/scripts/forge-check', {
    cwd,
    ...rest,
    inputs: { ARCHON_HOME, ...rest.inputs },
  });
}

/** A forge plugin the real host discovers: it advertises `capabilities` and answers `pr.view` for the accepted token. */
function installed(capabilities: readonly string[]): ScriptOptions {
  const plugin = `
    if (process.argv.includes('metadata')) {
      console.log(JSON.stringify({protocol: 1, name: 'github', version: 'test', forge: 'github',
        hosts: ['ghe.example.com'], capabilities: ${JSON.stringify(capabilities)}, token_env: ['GH_TOKEN']}));
    } else {
      const request = await Bun.stdin.json();
      if (request.op !== 'pr.view' || process.env.ARCHON_FORGE_TOKEN !== 'accepted') throw new Error('invalid preflight read');
      console.log(JSON.stringify({operationId: request.operationId, ok: true, result: {op: 'pr.view', value: null}}));
    }
  `;
  return {
    forge: {
      kind: 'home',
      config: {
        scanPath: false,
        plugins: [{ plugin: 'github', command: process.execPath, args: ['--no-env-file', '-e', plugin] }],
      },
    },
    inputs: { GH_TOKEN: 'accepted' },
  };
}

describe('forge-check refuses a run whose forge plugin cannot act', () => {
  it('accepts a capable installed plugin through the host check and an authenticated read', () => {
    const run = check(installed(REQUIRED_FORGE_OPERATIONS));
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.stdout).toContain('Read access is verified; write access is not');
    expect(run.stdout).toContain('source: GH_TOKEN');
  });

  it('refuses a plugin missing checks.state, naming it', () => {
    const run = check(installed(REQUIRED_FORGE_OPERATIONS.filter(op => op !== 'checks.state')));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('does not support checks.state');
  });

  it('passes when one remote fails its read and a mirror answers, reporting the failure', () => {
    const checked = forgeOperation('check', { host: 'any', operations: [] });
    const run = check({
      mirror: true,
      forge: {
        kind: 'fake',
        response: [checked, refusal('process_failed', 'token expired'), checked, ANSWERED],
      },
    });
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(run.forge).toHaveLength(4);
    expect(run.stdout).toContain('ghe.example.com/example/repo: forge pr.view failed');
    expect(run.stdout).toContain('forge answered for mirror.example.com/example/repo');
  });
});
