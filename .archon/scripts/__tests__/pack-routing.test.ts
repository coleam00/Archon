/**
 * Deliver's and the build block's terminal report after a node failure: a pull-request
 * create that started and was never confirmed is reported unresolved, so no later run
 * opens a second pull request. Run as the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { PR, PR_URL, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

describe("deliver's report after a node failure", () => {
  /** The `pull-request` outputs a run bound, as the engine delivers them. */
  const published = (...values: object[]): string =>
    JSON.stringify(values.map(value => ({ node: 'pr__publish', loop: [{ group: 'rounds', iteration: 1 }], at: '2026-11-06T10:00:00Z', value })));
  /** A report node's bindings after a node failure, in a run with no typed output. */
  const FAILED = { INPUTS_OUTCOME: 'null', INPUTS_PULL_REQUESTS: '[]' };
  const failedReport = (pullRequests: string, extra: Partial<Parameters<typeof runPackScript>[1]> = {}) =>
    runPackScript('deliver/scripts/report', {
      ...extra,
      inputs: { ...FAILED, INPUTS_PULL_REQUESTS: pullRequests, ...extra.inputs },
    });
  const reported = (run: ReturnType<typeof failedReport>): { reason: string; pr_url: string } =>
    JSON.parse(run.stdout) as { reason: string; pr_url: string };

  it('names the pull request a round published before the failure, so the next run continues it', () => {
    // No outcomes listing reaches this run, so the creation record decides, and there is none.
    expect(reported(failedReport(published({ number: 42, url: PR_URL })))).toMatchObject({ reason: 'failed', pr_url: PR_URL });
    expect(reported(failedReport('[]'))).toMatchObject({ reason: 'failed', pr_url: '' });
  });
  it("lets the creation record decide once the publish node's latest invocation failed", () => {
    // Round 1 published PR_URL; round 2's publish failed after its create started.
    const outcomes = (state: string) => JSON.stringify({
      run_id: 'run', first_failed_node: null,
      nodes: [
        { node_id: 'rounds.pr__publish', state: 'completed', loop_group_path: [{ groupId: 'rounds', iteration: 1 }] },
        { node_id: 'rounds.pr__publish', state, loop_group_path: [{ groupId: 'rounds', iteration: 2 }] },
      ],
    });
    for (const secondRound of ['failed', 'completed']) {
      const run = failedReport(published({ url: PR_URL }), {
        inputs: { NODE_OUTCOMES_FILE: '{ARTIFACTS}/outcomes.json' },
        artifacts: {
          'outcomes.json': outcomes(secondRound),
          'pr-create-started': JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }),
        },
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject(
        secondRound === 'failed' ? { reason: 'pr_create_unresolved', pr_url: '' } : { reason: 'failed', pr_url: PR_URL }
      );
    }
  });

  it('does not certify a URL without a complete PR record', () => {
    const result = runPackScript('deliver/scripts/report', {
      inputs: FAILED,
      artifacts: { 'pr-create-started': JSON.stringify({ pr: { url: PR_URL } }) },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ reason: 'pr_create_unresolved', pr_url: '' });
  });

  for (const script of ['deliver/scripts/report', 'build-route/scripts/report']) {
    it.each(['unverified', 'unreadable', 'directory'])(
      'distinguishes an unresolved %s create from no PR', kind => {
        const run = runPackScript(script, {
          inputs: FAILED,
          artifacts: kind === 'directory' ? {} : {
            'pr-create-started': kind === 'unverified' ? JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }) : 'invalid JSON',
          },
          preload: kind === 'directory' ? `import { mkdirSync } from 'node:fs'; mkdirSync('{ARTIFACTS}/pr-create-started');` : undefined,
        });
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ reason: 'pr_create_unresolved', pr_url: '' });
      }
    );
  }
});

