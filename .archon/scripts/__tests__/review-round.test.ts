/**
 * review-round fixes what a review round reviews: the checkout's HEAD, and on a
 * continuation the previous round's reviewed commit, which that head must descend
 * from. The stale case is a round whose checkout sits on an ancestor of the commit
 * the previous round reviewed: its delta would run backwards and reopen findings
 * the newer commits fixed.
 */
import { FULL_REVIEW_RISKS } from '../../workflows/sdlc/.shared/review-policy';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from './temp-roots';
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
