/**
 * review-round fixes what a review round reviews: the checkout's HEAD, and on a
 * continuation the previous round's reviewed commit, which that head must descend
 * from. The stale case is a round whose checkout sits on an ancestor of the commit
 * the previous round reviewed: its delta would run backwards and reopen findings
 * the newer commits fixed.
 */
import { FULL_REVIEW_RISKS } from '../../workflows/sdlc/.shared/review-policy';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { resolveWorkflow } from '../../../packages/workflows/src/graph-plan';
import { dryRunWorkflow } from '../../../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../../../packages/workflows/src/fixture-runner';
import { qualifyWorkflowResources } from '../../../packages/workflows/src/packaged-workflow';
import { packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with two commits on one line of history. */
function history(): { cwd: string; older: string; newer: string } {
  const cwd = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-review-round-')));
  git(cwd, 'init', '-q');
  const commit = (message: string): string => {
    writeFileSync(join(cwd, 'file.txt'), message);
    git(cwd, 'add', 'file.txt');
    git(
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message
    );
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const older = commit('older');
  const newer = commit('newer');
  return { cwd, older, newer };
}

/** The engine identity review-round passes through for synthesis to count lenses by. */
function execution(head: string): object {
  return {
    path: 'review__mode',
    invocation: { loopPath: [{ groupId: 'delivery', iteration: 2 }] },
    attempt: { checkoutStart: { kind: 'git', commit: head } },
  };
}

function round(
  cwd: string,
  head: string,
  cursor?: string,
  extra: { light?: boolean; part?: string } = {}
): ScriptRun {
  return runPackScript('review/scripts/review-round', {
    cwd,
    inputs: {
      INPUTS_PRIOR_REPORT: cursor === undefined ? '' : '{ARTIFACTS}/review/report.md',
      INPUTS_LIGHT: extra.light ? 'true' : 'false',
      INPUTS_PART: extra.part ?? '',
      ARCHON_NODE_EXECUTION: JSON.stringify(execution(head)),
    },
    artifacts:
      cursor === undefined
        ? {}
        : {
            'review/report.md': 'Round 1',
            'review/reviewed-head': `${cursor}\n`,
          },
  });
}

describe('review-round', () => {
  it('reviews the checkout head on a first round', () => {
    const { cwd, newer } = history();
    const run = round(cwd, newer);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      continuation: false,
      light: false,
      head: newer,
      cursor: '',
      risks: FULL_REVIEW_RISKS,
      execution: execution(newer),
      seams: false, code: false, tests: false, errors: false, docs: false,
      part: null,
    });
  });

  // The route agent adds every other lens a continuation earns; the code lens is
  // the one this round always reruns, whatever an earlier round ran.
  it("continues from the previous round's reviewed commit with the code lens alone", () => {
    const { cwd, older, newer } = history();
    const part = { delivers: 1, parts: [{ part: 2, items: ['later'] }] };
    const run = round(cwd, newer, older, { part: JSON.stringify(part) });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      continuation: true,
      light: false,
      head: newer,
      cursor: older,
      risks: FULL_REVIEW_RISKS,
      execution: execution(newer),
      seams: false, code: true, tests: false, errors: false, docs: false,
      part,
    });
  });

  it('refuses a part assignment that is not JSON without echoing it', () => {
    const { cwd, newer } = history();
    const run = round(cwd, newer, undefined, { part: 'deliver chunk 1 of #42' });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('the part input is not JSON');
    for (const fragment of ['deliver', 'chunk', '#42']) expect(run.stderr).not.toContain(fragment);
  });

  it('runs the code lens alone on a light continuation', () => {
    const { cwd, older, newer } = history();
    expect(JSON.parse(round(cwd, newer, older, { light: true }).stdout)).toMatchObject({
      light: true,
      seams: false,
      code: true,
      tests: false,
      errors: false,
      docs: false,
    });
  });

  it('refuses a head that is an ancestor of the commit the previous round reviewed', () => {
    const { cwd, older, newer } = history();
    const run = round(cwd, older, newer);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`at ${older}, which does not descend from ${newer}`);
  });

  it('returns the mismatch response before checking continuation ancestry', async () => {
    const { cwd, older, newer } = history();
    git(cwd, 'checkout', '--detach', older);
    const prior = join(cwd, 'report.md');
    writeFileSync(prior, 'Previous review');
    writeFileSync(join(cwd, 'reviewed-head'), newer);
    const root = join(import.meta.dir, '../../..');
    const parsed = parseWorkflow(readFileSync(join(root,
      '.archon/workflows/sdlc/review/archon-review-block.yaml'), 'utf8'), 'archon-review-block.yaml', providerRegistry);
    if (!parsed.workflow) throw new Error(parsed.error.error);
    qualifyWorkflowResources(parsed.workflow, { source: 'project', pack: 'sdlc', workflow: 'review' });
    const { stubs } = parseFixtureFile(
      readFileSync(join(root, '.archon/workflows/sdlc/review/fixtures/head-mismatch.stubs.yaml'), 'utf8'),
      'head-mismatch.stubs.yaml');
    for (const matches of [false, true]) {
      const run = await dryRunWorkflow({
        workflow: resolveWorkflow(parsed.workflow), cwd: root, execWorkspace: cwd,
        userMessage: '', execCode: true, inputs: { prior_report: prior },
        stubs: { ...stubs, scope: { head_matches: matches, pr: null,
          report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'review/scope.md' } } },
      });
      const mode = run.trace.find(node => node.nodeId === 'mode');
      expect(mode?.state, JSON.stringify(run)).toBe(matches ? 'failed' : 'skipped');
      if (matches) {
        expect(mode?.reason).toContain('does not descend from');
        for (const id of ['route', 'seams', 'code', 'tests', 'errors', 'docs', 'synthesize', 'publish', 'result']) {
          expect(run.trace.find(node => node.nodeId === id)?.state).toBe('skipped');
        }
      } else {
        expect(run.outcome).toBe('completed');
        expect(run.summary).toContain('Rerun: archon workflow run archon-review');
      }
    }
  });

  it('refuses a continuation whose report records no reviewed commit', () => {
    const { cwd, newer } = history();
    const run = runPackScript('review/scripts/review-round', {
      cwd,
      inputs: {
        INPUTS_PRIOR_REPORT: '{ARTIFACTS}/review/report.md',
        ARCHON_NODE_EXECUTION: JSON.stringify({
          attempt: { checkoutStart: { kind: 'git', commit: newer } },
        }),
      },
      artifacts: { 'review/report.md': 'Round 1' },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('records no reviewed commit');
  });
});
