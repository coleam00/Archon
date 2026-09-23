import { describe, expect, it } from 'bun:test';
import { forgeResponse, runDeliverScript, type ForgeFake } from './deliver-checks-harness';

const probe = runDeliverScript.bind(null, 'check-ci');

describe('check-ci on the default gh source', () => {
  it('reads the recorded qualified PR through gh and never calls the forge CLI', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'build', state: 'SUCCESS', bucket: 'pass' },
          { name: 'docs', state: 'SKIPPED', bucket: 'skipping' },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'all 2 observed check(s) green; skipped (non-blocking): docs',
    });
    expect(result.gh[0]).toBe('pr checks 42 --repo ghe.example.com/example/repo --json name,state');
    expect(result.forge).toEqual([]);
  });

  it('keeps a running check pending even when another already failed', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'lint', state: 'FAILURE', bucket: 'fail' },
          { name: 'test', state: 'IN_PROGRESS', bucket: 'pending' },
        ],
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({ state: 'pending', detail: '1 check(s) running' });
  });

  // gh buckets STALE and STARTUP_FAILURE as pending and anything it does not
  // know as pending too, so the reader classifies gh's raw state, not its bucket.
  it('names failed, cancelled, stale, startup-failed and unrecognized checks as red', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'lint', state: 'FAILURE', bucket: 'fail' },
          { name: 'e2e', state: 'CANCELLED', bucket: 'cancel' },
          { name: 'old', state: 'STALE', bucket: 'pending' },
          { name: 'boot', state: 'STARTUP_FAILURE', bucket: 'pending' },
          { name: 'odd', state: 'SOMETHING_NEW', bucket: 'pending' },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'red',
      detail:
        'non-green checks: lint (failure), e2e (cancelled), old (stale), boot (startup_failure); ' +
        'checks have unknown state: odd (something_new)',
    });
  });

  // gh buckets ACTION_REQUIRED as fail; it is a maintainer's approval gate, not a broken branch.
  it('reports a check awaiting maintainer approval as gated, not red', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'build', state: 'SUCCESS', bucket: 'pass' },
          { name: 'deploy', state: 'ACTION_REQUIRED', bucket: 'fail' },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'checks gated: deploy (action_required)',
    });
  });

  it('refuses a failed read instead of concluding there is no CI', () => {
    const result = probe({ gh: { checks: 'fail', rollup: 'fail', workflows: 0 } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('check-ci: could not read check state: HTTP 502');
  });

  it('concludes without the grace wait when the repository has no active workflow', () => {
    const result = probe({ gh: { rollup: 0, workflows: 0 } });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'no checks configured on this repository — nothing to await',
    });
    expect(result.gh).toContain(
      'api --hostname ghe.example.com repos/example/repo/actions/workflows --paginate --jq .workflows[] | select(.state == "active") | .id'
    );
  });

  it('gives configured CI one registration grace read, then names the maintainer gate', () => {
    const result = probe({ gh: { rollup: 0, workflows: 2 } });
    expect(JSON.parse(result.stdout).state).toBe('concluded');
    expect(result.stdout).toContain("awaiting a maintainer's approval");
    expect(result.gh.filter(call => call.startsWith('pr checks'))).toHaveLength(2);
  });

  it('refuses an unrecognized check source instead of guessing one', () => {
    const result = probe({ source: 'gitlab', gh: { checks: [{ name: 'b', state: 'SUCCESS', bucket: 'pass' }] } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ARCHON_SDLC_FORGE must be "gh" (the default) or "forge"');
    expect(result.gh).toEqual([]);
  });
});

describe('check-ci on the opt-in forge source', () => {
  const forge = (response: string | string[]): ForgeFake => ({ kind: 'fake', response });

  it('classifies external-status-only observations and keeps the evaluated revision', () => {
    const result = probe({
      source: 'forge',
      forge: forge(forgeResponse([{ name: 'external/status', state: 'red' }])),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'red',
      detail: 'non-green checks at deadbeef: external/status (failure)',
    });
    expect(result.forge[0]).toContain('forge checks --json --data');
    expect(result.forge[0]).toContain('ghe.example.com');
    expect(result.gh).toEqual([]);
  });

  it('prefers the required set when the plugin reports one', () => {
    const result = probe({
      source: 'forge',
      forge: forge(
        forgeResponse([{ name: 'optional', state: 'red' }], {
          required: [{ name: 'required', state: 'green' }],
        })
      ),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'all 1 observed check(s) green at deadbeef',
    });
  });

  it('keeps gated explicit without calling it green', () => {
    const result = probe({ source: 'forge', forge: forge(forgeResponse([{ name: 'build', state: 'gated' }])) });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'checks gated at deadbeef: build (failure)',
    });
  });

  it('gives an empty observation one grace read without the Actions probe', () => {
    const result = probe({
      source: 'forge',
      forge: forge([
        forgeResponse([], { revision: 'first' }),
        forgeResponse([{ name: 'build', state: 'green' }], { revision: 'second' }),
      ]),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'all 1 observed check(s) green at second',
    });
    expect(result.forge).toHaveLength(2);
    expect(result.gh).toEqual([]);
  });

  it('fails loudly when forge is selected but the host published no CLI command', () => {
    const result = probe({ source: 'forge', forge: { kind: 'no-host' } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ARCHON_SDLC_FORGE=forge: ARCHON_CLI_COMMAND is not set');
    expect(result.gh).toEqual([]);
  });

  it('fails loudly when forge is selected but no plugin is installed', () => {
    const result = probe({ source: 'forge', forge: { kind: 'no-plugin' } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'check-ci: ARCHON_SDLC_FORGE=forge: forge check read failed: no forge plugin claims ghe.example.com'
    );
    expect(result.gh).toEqual([]);
  });
});
