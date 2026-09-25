/**
 * The ready flip is the one irreversible step, so its own check read must refuse
 * before `gh pr ready` on anything but green or no checks, and on any failed read,
 * whichever source the operator selected. Fixtures stub `flip-ready`'s output, so
 * only a subprocess run of the script can observe this.
 */
import { describe, expect, it } from 'bun:test';
import {
  PR_URL,
  forgeOperation,
  forgePrRecord,
  forgeResponse,
  runDeliverScript,
  type GhFake,
} from './deliver-checks-harness';

/** A forge run of flip-ready: read the checks, view the PR, then flip it. */
const forgeFlip = (checks: string, ...rest: string[]): readonly string[] => [checks, ...rest];

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
  const view = forgeOperation('pr.view', { pr: forgePrRecord(), title: 't', body: 'b' });
  const flipped = forgeOperation('pr.ready', {
    target: { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 },
    outcome: 'applied',
    changed: true,
    pr: forgePrRecord({ is_draft: false }),
  });

  it('reads and flips the exact qualified PR through the plugin, never gh', () => {
    const result = flip({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: forgeFlip(forgeResponse([{ name: 'build', state: 'green' }]), view, flipped),
      },
    });
    expect(result.code).toBe(0);
    expect(result.forge[0]).toContain('forge checks --json --data');
    expect(result.forge[0]).toContain('ghe.example.com');
    expect(result.forge[2]).toContain('forge pr.ready --json --data-file');
    expect(result.gh).toEqual([]);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
  });

  it('allows an empty observation without leaking captured vendor output', () => {
    const result = flip({
      source: 'forge',
      forge: { kind: 'fake', response: forgeFlip(forgeResponse([]), view, flipped) },
    });
    expect(result.code).toBe(0);
    expect(result.forge.some(call => call.startsWith('forge pr.ready'))).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('refuses a flip the plugin could not verify, naming what may remain', () => {
    const result = flip({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: forgeFlip(
          forgeResponse([{ name: 'build', state: 'green' }]),
          view,
          JSON.stringify({
            operationId: 'op-ready',
            ok: false,
            error: { kind: 'invalid_response', message: 'Ready read-back did not match' },
            mutation: {
              op: 'pr.ready',
              target: { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 },
              outcome: 'verification_failed',
              leaveBehind: 'the pull request draft state may have changed',
            },
          })
        ),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('verification_failed');
    expect(result.stderr).toContain('draft state may have changed');
  });

  for (const state of ['pending', 'red', 'gated', 'unknown'] as const) {
    it(`refuses ${state} checks before the ready write`, () => {
      const result = flip({
        source: 'forge',
        forge: { kind: 'fake', response: forgeResponse([{ name: 'build', state }]) },
      });
      expect(result.code).not.toBe(0);
      expect(result.forge.some(call => call.startsWith('forge pr.ready'))).toBe(false);
      expect(result.stderr).toContain('refusing to flip');
    });
  }

  it('refuses a failed forge read before the ready write', () => {
    const result = flip({ source: 'forge', forge: { kind: 'fake' } });
    expect(result.code).not.toBe(0);
    expect(result.forge.some(call => call.startsWith('forge pr.ready'))).toBe(false);
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

  it('reports the delivery when the recorded PR is already merged, without writing', () => {
    const result = flip({ gh: { ...green, pr: { state: 'MERGED' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
    expect(result.stderr).toContain('already merged');
    expect(readyCalled(result.gh)).toBe(false);
  });

  it('refuses a PR closed without a merge and names the state', () => {
    const result = flip({ gh: { ...green, pr: { state: 'CLOSED' } } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CLOSED');
    expect(readyCalled(result.gh)).toBe(false);
  });

  it('reports an already-ready PR as delivered without flipping it again', () => {
    const result = flip({ gh: { ...green, pr: { isDraft: false } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
    expect(readyCalled(result.gh)).toBe(false);
  });

  it("fails with gh's own words when the flip itself is refused", () => {
    const result = flip({ gh: { ...green, readyFail: READY_REFUSAL } });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Only draft pull requests');
  });

  it('refuses when the flip reports success but the PR still reads as a draft', () => {
    const result = flip({ gh: { ...green, writeLost: true } });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(readyCalled(result.gh)).toBe(true);
    expect(result.stderr).toContain('still reports draft');
  });
});
