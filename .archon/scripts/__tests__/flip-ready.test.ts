/**
 * The ready mark is the one claim a delivery hands a maintainer. flip-ready makes it
 * only after the ci node judged CI green, and refuses a head that does not merge into
 * its freshly fetched base. Fixtures stub it, so only a subprocess run can observe this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  PR_URL,
  forgeOperation,
  forgePrRecord,
  gitCheckout,
  runDeliverScript,
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
const readyCalled = (calls: readonly string[]): boolean =>
  calls.some(call => call.startsWith('pr ready') && !call.includes('--undo'));

describe('flip-ready', () => {
  it('marks the recorded qualified pull request ready', () => {
    const result = flip({});
    expect(result.code).toBe(0);
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo');
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
    expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR_URL });
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
