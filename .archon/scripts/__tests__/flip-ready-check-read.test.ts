/**
 * The ready flip is the one irreversible step, so its own check read must refuse
 * before `gh pr ready` on anything but green or no checks, and on any failed read,
 * whichever source the operator selected. Fixtures stub `flip-ready`'s output, so
 * only a subprocess run of the script can observe this.
 */
import { describe, expect, it } from 'bun:test';
import { PR_URL, forgeResponse, runDeliverScript, type GhFake } from './deliver-checks-harness';

const READY_REFUSAL = 'Only draft pull requests can be marked as "ready for review"';
const flip = runDeliverScript.bind(null, 'flip-ready');
const readyCalled = (calls: readonly string[]): boolean =>
  calls.some(call => call.startsWith('pr ready'));

describe('flip-ready preflight on the default gh source', () => {
  it('flips the recorded qualified PR when every check is green or skipped', () => {
    const result = flip({
      gh: {
        checks: [
          { name: 'build', state: 'SUCCESS', bucket: 'pass' },
          { name: 'docs', state: 'SKIPPED', bucket: 'skipping' },
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo');
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
    expect(result.forge).toEqual([]);
  });

  it('flips on an observed empty check set without leaking gh output', () => {
    const result = flip({ gh: { rollup: 0 } });
    expect(result.code).toBe(0);
    expect(readyCalled(result.gh)).toBe(true);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
  });

  const refusals: [string, GhFake, string][] = [
    ['a failed check read', { checks: 'fail', rollup: 'fail' }, 'could not read check state'],
    ['a red check', { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] }, 'red checks: build (failure)'],
    ['a running check', { checks: [{ name: 'unit', state: 'IN_PROGRESS', bucket: 'pending' }] }, 'pending checks: unit'],
    ['a cancelled check', { checks: [{ name: 'e2e', state: 'CANCELLED', bucket: 'cancel' }] }, 'red checks: e2e (cancelled)'],
  ];
  for (const [label, gh, reason] of refusals) {
    it(`refuses ${label} before the ready write`, () => {
      const result = flip({ gh });
      expect(result.code).not.toBe(0);
      expect(readyCalled(result.gh)).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('flip-ready:');
      expect(result.stderr).toContain(reason);
    });
  }
});

describe('flip-ready preflight on the opt-in forge source', () => {
  it('passes the exact qualified PR and flips only green checks', () => {
    const result = flip({
      source: 'forge',
      forge: { kind: 'fake', response: forgeResponse([{ name: 'build', state: 'green' }]) },
    });
    expect(result.code).toBe(0);
    expect(result.forge[0]).toContain('forge checks --json --data');
    expect(result.forge[0]).toContain('ghe.example.com');
    expect(result.gh.some(call => call.startsWith('pr checks'))).toBe(false);
    expect(readyCalled(result.gh)).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
  });

  it('allows an empty observation without leaking captured vendor output', () => {
    const result = flip({ source: 'forge', forge: { kind: 'fake', response: forgeResponse([]) } });
    expect(result.code).toBe(0);
    expect(readyCalled(result.gh)).toBe(true);
    expect(result.stderr).toBe('');
  });

  for (const state of ['pending', 'red', 'gated', 'unknown'] as const) {
    it(`refuses ${state} checks before the ready write`, () => {
      const result = flip({
        source: 'forge',
        forge: { kind: 'fake', response: forgeResponse([{ name: 'build', state }]) },
      });
      expect(result.code).not.toBe(0);
      expect(readyCalled(result.gh)).toBe(false);
      expect(result.stderr).toContain('refusing to flip');
    });
  }

  it('refuses a failed forge read before the ready write', () => {
    const result = flip({ source: 'forge', forge: { kind: 'fake' } });
    expect(result.code).not.toBe(0);
    expect(readyCalled(result.gh)).toBe(false);
    expect(result.stderr).toContain('forge check read failed');
  });

  it('fails loudly when forge is selected but no plugin is installed, never falling back to gh', () => {
    const result = flip({
      source: 'forge',
      forge: { kind: 'no-plugin' },
      gh: { checks: [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }] },
    });
    expect(result.code).not.toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.stderr).toContain('flip-ready: ARCHON_SDLC_FORGE=forge:');
    expect(result.stderr).toContain('no forge plugin claims ghe.example.com');
  });
});

describe('flip-ready terminal-state classification', () => {
  const green: GhFake = { checks: [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }] };

  it('reports the delivery when the refused flip finds the PR already merged', () => {
    const result = flip({ gh: { ...green, readyFail: READY_REFUSAL, prState: 'MERGED' } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
    expect(result.stderr).toContain('already merged');
  });

  it('refuses a PR closed without a merge and names the state', () => {
    const result = flip({ gh: { ...green, readyFail: READY_REFUSAL, prState: 'CLOSED' } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CLOSED');
    expect(result.stderr).not.toContain('the ready flip failed');
  });

  it("keeps a refusal on an open PR a failure carrying gh's own words", () => {
    const result = flip({ gh: { ...green, readyFail: READY_REFUSAL, prState: 'OPEN' } });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Only draft pull requests');
  });

  it("fails with gh's own words when the state behind a refusal cannot be read", () => {
    const result = flip({ gh: { ...green, readyFail: READY_REFUSAL } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Only draft pull requests');
  });
});
