/**
 * The ready state is the one claim a delivery hands a maintainer. flip-ready makes it
 * once the work is done, refusing a head that does not merge into its base;
 * confirm-ready certifies it on the final head after the single CI wait, and puts the
 * pull request back in draft on anything but green — so a red pull request never
 * stays ready. Fixtures stub both, so only a subprocess run can observe this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  PR_URL,
  forgeOperation,
  forgePrRecord,
  forgeResponse,
  gitCheckout,
  runDeliverScript,
  type GhFake,
  type ScriptRun,
} from './deliver-checks-harness';

const READY_REFUSAL = 'Only draft pull requests can be marked as "ready for review"';
// The flip only reads and fetches its checkout, so the runs that are not about a
// conflict share one instead of building a repository each.
let clean = '';
const cleanRoots: string[] = [];
beforeAll(() => {
  clean = gitCheckout({}, root => {
    cleanRoots.push(root);
    return root;
  });
});
afterAll(async () => {
  for (const root of cleanRoots) await removeTempTree(root);
});
const flip = (options: Parameters<typeof runDeliverScript>[1] = {}): ScriptRun =>
  runDeliverScript('flip-ready', { cwd: clean, ...options });
const confirm = (options: Parameters<typeof runDeliverScript>[1] = {}): ScriptRun =>
  runDeliverScript('confirm-ready', { cwd: clean, ...options });

/** A typed-artifact listing holding one record per named type, as the engine writes it. */
function records(byType: Record<string, unknown>): { inputs: Record<string, string>; artifacts: Record<string, string> } {
  const artifacts: Record<string, string> = {};
  const artifactsByType: Record<string, { path: string; nodeId: string }[]> = {};
  for (const [type, value] of Object.entries(byType)) {
    artifacts[`nodes/${type}.json`] = JSON.stringify(value);
    artifactsByType[type] = [{ path: `nodes/${type}.json`, nodeId: type }];
  }
  artifacts['listing.json'] = JSON.stringify({ runId: 'run', artifactsByType, errors: [] });
  return { inputs: { TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' }, artifacts };
}
const readyCalled = (calls: readonly string[]): boolean =>
  calls.some(call => call.startsWith('pr ready') && !call.includes('--undo'));
const undoCalled = (calls: readonly string[]): boolean =>
  calls.some(call => call.startsWith('pr ready') && call.includes('--undo'));

const green: GhFake['checks'] = [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }];

describe('confirm-ready on the final head, default gh source', () => {
  it('keeps a ready pull request ready when every check is green or skipped', () => {
    const result = confirm({
      gh: {
        checks: [...green, { name: 'docs', state: 'SKIPPED', bucket: 'skipping' }],
        pr: { isDraft: false },
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
    expect(undoCalled(result.gh)).toBe(false);
  });

  it('marks a pull request the operator path left in draft ready again once green', () => {
    const result = confirm({ gh: { checks: green } });
    expect(result.code).toBe(0);
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo');
  });

  const unresolved: [string, GhFake, Record<string, string>, string][] = [
    ['a failed check read', { checks: 'fail', rollup: 'fail' }, {}, 'could not read check state'],
    ['a red check', { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }] }, {}, 'red checks: build (failure)'],
    ['a running check', { checks: [{ name: 'unit', state: 'IN_PROGRESS', bucket: 'pending' }] }, {}, 'pending checks: unit'],
    ['a cancelled check', { checks: [{ name: 'e2e', state: 'CANCELLED', bucket: 'cancel' }] }, {}, 'red checks: e2e (cancelled)'],
    ['no checks when some were expected', { rollup: 0 }, { INPUTS_EXPECTED: '["build"]' }, 'expected check(s) never ran: build'],
    ['an expected check that never ran', { checks: green }, { INPUTS_EXPECTED: '["build","e2e"]' }, 'expected check(s) never ran: e2e'],
  ];
  for (const [label, gh, inputs, reason] of unresolved) {
    it(`puts the pull request back in draft on ${label}`, () => {
      const result = confirm({ gh: { ...gh, pr: { isDraft: false } }, inputs });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo --undo');
      expect(result.stderr).toContain('the pull request is back in draft');
      expect(result.stderr).toContain(reason);
    });
  }

  describe('the CI fix owes a converged review', () => {
    const fixed = { 'ci-cause': { cause: 'introduced' }, 'ci-fix-delta': { moved: true } };

    it('puts the pull request back in draft when that review never converged', () => {
      const result = confirm({ gh: { checks: green, pr: { isDraft: false } }, ...records(fixed) });
      expect(result.code).not.toBe(0);
      expect(undoCalled(result.gh)).toBe(true);
      expect(result.stderr).toContain('the review of the CI fix did not converge');
    });

    it('keeps it ready once the review gate recorded convergence', () => {
      const result = confirm({
        gh: { checks: green, pr: { isDraft: false } },
        ...records({ ...fixed, 'ci-fix-review': { ready: 'true' } }),
      });
      expect(result.code).toBe(0);
      expect(undoCalled(result.gh)).toBe(false);
    });

    it('fails closed when the cause record cannot be read', () => {
      const { inputs, artifacts } = records(fixed);
      delete artifacts['nodes/ci-cause.json'];
      const result = confirm({ gh: { checks: green, pr: { isDraft: false } }, inputs, artifacts });
      expect(result.code).not.toBe(0);
      expect(undoCalled(result.gh)).toBe(true);
      expect(result.stderr).toContain('could not read this ci-cause record');
    });

    it('owes nothing when the fix moved nothing, or the red was not introduced', () => {
      for (const byType of [
        { 'ci-cause': { cause: 'introduced' }, 'ci-fix-delta': { moved: false } },
        { 'ci-cause': { cause: 'inherited' } },
      ]) {
        const result = confirm({ gh: { checks: green, pr: { isDraft: false } }, ...records(byType) });
        expect(result.code).toBe(0);
      }
    });
  });

  it('leaves a draft in draft when its head no longer merges into the base', () => {
    const result = confirm({ gh: { checks: green }, cwd: gitCheckout({ conflict: true }) });
    expect(result.code).not.toBe(0);
    expect(readyCalled(result.gh)).toBe(false);
    expect(result.stderr).toContain('does not merge cleanly into upstream/dev: a.txt');
  });

  it('refuses when the draft conversion does not read back', () => {
    const result = confirm({
      gh: { checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }], pr: { isDraft: false }, writeLost: true },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('still reports ready after converting it to draft');
  });

  it('reports a merged pull request as delivered without writing', () => {
    const result = confirm({ gh: { checks: green, pr: { state: 'MERGED' } } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('already merged');
    expect(readyCalled(result.gh) || undoCalled(result.gh)).toBe(false);
  });
});

describe('confirm-ready on the opt-in forge source', () => {
  const view = forgeOperation('pr.view', { pr: forgePrRecord({ is_draft: false }), title: 't', body: 'b' });

  it('reads the pull request and its checks through the plugin, never gh, when green', () => {
    const result = confirm({
      source: 'forge',
      forge: { kind: 'fake', response: [view, forgeResponse([{ name: 'build', state: 'green' }])] },
    });
    expect(result.code).toBe(0);
    expect(result.forge[1]).toContain('forge checks --json --data');
    expect(result.gh).toEqual([]);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
  });

  it('converts a red pull request back to draft through gh, which owns that write', () => {
    const result = confirm({
      source: 'forge',
      gh: { pr: { isDraft: false } },
      forge: { kind: 'fake', response: [view, forgeResponse([{ name: 'build', state: 'red' }])] },
    });
    expect(result.code).not.toBe(0);
    expect(undoCalled(result.gh)).toBe(true);
    expect(result.stderr).toContain('the pull request is back in draft');
  });

  it('fails loudly when forge is selected but no plugin is installed, never falling back to gh', () => {
    const result = confirm({ source: 'forge', forge: { kind: 'no-plugin' }, gh: { checks: green } });
    expect(result.code).not.toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.stderr).toContain('no forge plugin claims ghe.example.com');
  });
});

describe('flip-ready once the work is done', () => {
  it('marks the recorded qualified pull request ready without waiting on CI', () => {
    const result = flip({});
    expect(result.code).toBe(0);
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo');
    expect(result.gh.some(call => call.startsWith('pr checks'))).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
  });

  it('refuses a head that conflicts with its freshly fetched base, before the write', () => {
    const result = flip({ cwd: gitCheckout({ conflict: true }) });
    expect(result.code).not.toBe(0);
    expect(readyCalled(result.gh)).toBe(false);
    expect(result.stderr).toContain('does not merge cleanly into upstream/dev: a.txt');
  });

  it('fetches the base into its tracking ref even when the clone tracks only another branch', () => {
    const cwd = gitCheckout({ conflict: true });
    spawnSync('git', ['config', 'remote.upstream.fetch', '+refs/heads/main:refs/remotes/upstream/main'], { cwd });
    spawnSync('git', ['update-ref', '-d', 'refs/remotes/upstream/dev'], { cwd });
    const result = flip({ cwd });
    expect(result.stderr).toContain('does not merge cleanly into upstream/dev: a.txt');
  });

  it('flips through the plugin on the opt-in path, never gh', () => {
    const result = flip({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', { pr: forgePrRecord(), title: 't', body: 'b' }),
          forgeOperation('pr.ready', {
            target: { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 },
            outcome: 'applied',
            changed: true,
            pr: forgePrRecord({ is_draft: false }),
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(result.forge[1]).toContain('forge pr.ready --json --data-file');
    expect(result.gh).toEqual([]);
  });

  it('reports a merged pull request without writing', () => {
    const result = flip({ gh: { pr: { state: 'MERGED' } } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('already merged');
    expect(readyCalled(result.gh)).toBe(false);
  });

  it('refuses a pull request closed without a merge', () => {
    const result = flip({ gh: { pr: { state: 'CLOSED' } } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('CLOSED');
    expect(readyCalled(result.gh)).toBe(false);
  });

  it('does not flip an already-ready pull request again', () => {
    const result = flip({ gh: { pr: { isDraft: false } } });
    expect(result.code).toBe(0);
    expect(readyCalled(result.gh)).toBe(false);
  });

  it("fails with gh's own words when the flip itself is refused", () => {
    const result = flip({ gh: { readyFail: READY_REFUSAL } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Only draft pull requests');
  });

  it('refuses when the flip reports success but the pull request still reads as a draft', () => {
    const result = flip({ gh: { writeLost: true } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('still reports draft');
  });
});

describe('mark-draft before the operator pause', () => {
  it('converts a ready pull request back to draft and reads it back', () => {
    const result = runDeliverScript('mark-draft', { gh: { pr: { isDraft: false } } });
    expect(result.code).toBe(0);
    expect(undoCalled(result.gh)).toBe(true);
    expect(result.stdout).toContain('is a draft while CI stays red');
  });

  it('writes nothing when the pull request is already a draft', () => {
    const result = runDeliverScript('mark-draft', {});
    expect(result.code).toBe(0);
    expect(undoCalled(result.gh)).toBe(false);
  });
});
