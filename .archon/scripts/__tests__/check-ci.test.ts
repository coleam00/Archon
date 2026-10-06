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
    expect(result.gh[0]).toBe('pr checks 42 --repo ghe.example.com/example/repo --json name,state,completedAt');
    expect(result.forge).toEqual([]);
  });

  // A project whose CI skips drafts: at the flip only the draft's skipped runs exist,
  // and the ready runs register seconds later (#3882's run 54793aad).
  it('waits on checks a draft skipped before the ready flip', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'changes', state: 'SKIPPED', bucket: 'skipping', completedAt: '2026-10-06T07:20:02Z' },
          { name: 'test', state: 'SKIPPED', bucket: 'skipping', completedAt: '2026-10-06T07:20:03Z' },
        ],
      },
      inputs: { INPUTS_FLIPPED_AT: '2026-10-06T07:23:35.120Z' },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'skipped before the ready flip, so not yet run for review: changes (skipped), test (skipped)',
    });
  });

  it('concludes on a check skipped after the flip beside one that ran', () => {
    const result = probe({
      gh: {
        checks: [
          { name: 'build', state: 'SUCCESS', bucket: 'pass', completedAt: '2026-10-06T07:30:00Z' },
          { name: 'docs', state: 'SKIPPED', bucket: 'skipping', completedAt: '2026-10-06T07:23:39Z' },
        ],
      },
      inputs: { INPUTS_FLIPPED_AT: '2026-10-06T07:23:35.120Z' },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'all 2 observed check(s) green; skipped (non-blocking): docs',
    });
  });

  // Nothing ran, so nothing is green, whether or not this run flipped the pull
  // request or the source reports when the checks concluded.
  it('keeps waiting when every check was skipped, even with no flip time', () => {
    const result = probe({
      gh: { checks: [{ name: 'test', state: 'SKIPPED', bucket: 'skipping' }] },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'every check was skipped; waiting for one that runs',
    });
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
      detail: "checks gated on a maintainer's approval: deploy (action_required)",
    });
  });

  it('refuses a failed read instead of concluding there is no CI', () => {
    const result = probe({ gh: { checks: 'fail', rollup: 'fail' } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('check-ci: could not read check state: HTTP 502');
  });

  it('concludes at once when no checks are expected and none registered', () => {
    const result = probe({ gh: { rollup: 0 } });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: 'no checks are expected to gate this merge, and none registered',
    });
    expect(result.gh.some(call => call.includes('actions/'))).toBe(false);
  });

  it('keeps waiting while an expected check has not registered, whatever CI posts it', () => {
    const result = probe({
      inputs: { INPUTS_EXPECTED: JSON.stringify(['ci/circleci: test']) },
      gh: { rollup: 0 },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'expected check(s) not registered yet: ci/circleci: test',
    });
  });

  it('waits for a missing expected check even when the others are green', () => {
    const result = probe({
      inputs: { INPUTS_EXPECTED: JSON.stringify(['build', 'e2e']) },
      gh: { checks: [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }] },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'expected check(s) not registered yet: e2e',
    });
  });

  it('reports gated only from a workflow run the forge says awaits approval', () => {
    const result = probe({
      inputs: { INPUTS_EXPECTED: JSON.stringify(['build']) },
      gh: { rollup: 0, approvalRuns: 1 },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'concluded',
      detail: "checks gated on a maintainer's approval; not yet run: build",
    });
    expect(result.gh).toContain(
      'api --hostname ghe.example.com repos/example/repo/actions/runs?head_sha=deadbeef --jq [.workflow_runs[] | select(.conclusion == "action_required")] | length'
    );
  });

  it('refuses when the approval state cannot be read, instead of waiting blind', () => {
    const result = probe({
      inputs: { INPUTS_EXPECTED: JSON.stringify(['build']) },
      gh: { rollup: 0, approvalRuns: 'fail' },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('could not read workflow runs for the head commit');
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
      detail: "checks gated on a maintainer's approval at deadbeef: build (failure)",
    });
  });

  it('keeps an expected check pending on an empty observation, without any workflow-run read', () => {
    const result = probe({
      source: 'forge',
      inputs: { INPUTS_EXPECTED: JSON.stringify(['build']) },
      forge: forge(forgeResponse([], { revision: 'first' })),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      state: 'pending',
      detail: 'expected check(s) not registered yet at first: build',
    });
    expect(result.forge).toHaveLength(1);
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
