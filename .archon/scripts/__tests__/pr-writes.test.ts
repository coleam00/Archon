/**
 * The pack's pull-request writes, through both sources.
 *
 * Fixtures stub these nodes, so only a subprocess run can observe what they
 * actually write, which source they wrote through, and whether a write that did
 * not read back is reported as a failure rather than a delivery.
 */
import { describe, expect, it } from 'bun:test';
import {
  PR,
  PR_URL,
  forgeOperation,
  forgeFailure,
  forgePrRecord,
  runPackScript,
  type ScriptOptions,
  type ScriptRun,
} from './deliver-checks-harness';

const MARKER = '<!-- archon-review-report -->';
const REPORT = 'Round 1: ready';

const intent = {
  repo: PR.repo,
  headRepo: PR.repo,
  head: 'feature',
  headRevision: 'deadbeef',
  base: 'dev',
  title: 'A title',
  bodyPath: '{ARTIFACTS}/pr-body.md',
  draft: true,
};

function publishPr(options: ScriptOptions & { intent?: object } = {}): ScriptRun {
  const { intent: supplied, ...rest } = options;
  return runPackScript('pr/scripts/publish-pr', {
    ...rest,
    inputs: { INPUTS_INTENT: '{ARTIFACTS}/pr-intent.json', ...rest.inputs },
    artifacts: {
      'pr-intent.json': JSON.stringify(supplied ?? intent),
      'pr-body.md': 'A body',
      ...rest.artifacts,
    },
  });
}

describe('publish-pr opens the pull request at most once', () => {
  it('creates and verifies through gh when the head has no open pull request', () => {
    const result = publishPr({ gh: { noOpenPr: true, pr: { headRefName: 'feature' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL, is_draft: true });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(true);
    expect(result.gh.every(call => call.includes('--repo ghe.example.com/example/repo'))).toBe(true);
    expect(result.forge).toEqual([]);
  });

  it('reuses the open pull request for that head instead of opening a second one', () => {
    const result = publishPr({ gh: { pr: { headRefName: 'feature' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.stderr).toContain('already has this head');
  });

  it('refuses when a create reports success but no pull request has that head', () => {
    const result = publishPr({ gh: { noOpenPr: true, writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('a pull request may exist');
  });

  it('refuses when the created pull request does not match what was requested', () => {
    const result = publishPr({
      gh: { noOpenPr: true, pr: { headRefName: 'feature', headRefOid: 'a-different-revision' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not match what was requested');
  });

  it('publishes through the plugin, never gh, when the operator opted in', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', null),
          forgeOperation('pr.create', {
            target: PR.repo,
            outcome: 'applied',
            changed: true,
            pr: forgePrRecord(),
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    expect(result.gh).toEqual([]);
    expect(result.forge[1]).toContain('forge pr.create --json --data-file');
    // The authored body travels in the request file, never on the command line.
    expect(result.forge.join(' ')).not.toContain('A body');
    expect(JSON.parse(result.forgeRequests[1]).body).toBe('A body');
  });

  it('reports a refused create as a refusal that wrote nothing', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', null),
          forgeFailure('pr.create', 'refused', 'the base branch does not exist'),
        ],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('refused');
    expect(result.stderr).toContain('the base branch does not exist');
  });

  it('reuses the open pull request when the head repository differs only in case', () => {
    const result = publishPr({
      intent: { ...intent, headRepo: { host: PR.repo.host, path: 'Example/Repo' } },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.stderr).toContain('already has this head');
  });

  it('keeps the created pull request when the host could not audit the write', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        okExitCode: 2,
        response: [
          forgeOperation('pr.view', null),
          forgeOperation('pr.create', {
            target: PR.repo,
            outcome: 'applied',
            changed: true,
            pr: forgePrRecord(),
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    expect(result.stderr).toContain("could not record it in the run's audit log");
  });

  it('reads back the pull request the run was launched onto instead of creating one', () => {
    const result = publishPr({
      intent: { repo: PR.repo, headRepo: PR.repo, head: 'feature', existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr list'))).toBe(false);
  });

  it('adopts a named pull request whose head repository differs only in case', () => {
    const result = publishPr({
      intent: {
        repo: PR.repo,
        headRepo: { host: PR.repo.host, path: 'Example/Repo' },
        head: 'feature',
        existing: 42,
      },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
  });

  it('refuses a named pull request whose head is not the recorded branch', () => {
    const result = publishPr({
      intent: { repo: PR.repo, headRepo: PR.repo, head: 'feature', existing: 42 },
      gh: { pr: { headRefName: 'somebody-elses-branch' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not the recorded');
  });

  it('fails loudly when forge is selected but unavailable, never falling back to gh', () => {
    const result = publishPr({ source: 'forge', forge: { kind: 'no-host' } });
    expect(result.code).not.toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.stderr).toContain('ARCHON_CLI_COMMAND is not set');
  });
});

function publishBody(options: ScriptOptions & { change?: boolean } = {}): ScriptRun {
  const { change = true, ...rest } = options;
  return runPackScript('deliver/scripts/publish-pr-body', {
    ...rest,
    inputs: { INPUTS_INTENT: '{ARTIFACTS}/pr-body-intent.json', ...rest.inputs },
    artifacts: {
      'pr-body-intent.json': JSON.stringify(
        change ? { change: true, bodyPath: '{ARTIFACTS}/pr-body-final.md' } : { change: false }
      ),
      'pr-body-final.md': 'The corrected body',
      ...rest.artifacts,
    },
  });
}

describe('publish-pr-body applies the resync and proves it landed', () => {
  const record = JSON.stringify(forgePrRecord());

  it('edits through gh and reads the body back', () => {
    const result = publishBody({ inputs: { INPUTS_PR: record } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr edit 42 --repo'))).toBe(true);
  });

  it('refuses when the edit reports success and the body reads back unchanged', () => {
    const result = publishBody({ inputs: { INPUTS_PR: record }, gh: { writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('does not match what was written');
  });

  it('writes nothing at all when the body was already accurate', () => {
    const result = publishBody({ change: false, inputs: { INPUTS_PR: record } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
  });

  it('edits through the plugin on the opt-in path, with the body in the request file', () => {
    const result = publishBody({
      source: 'forge',
      inputs: { INPUTS_PR: record },
      forge: {
        kind: 'fake',
        response: forgeOperation('pr.edit-body', {
          target: PR,
          outcome: 'applied',
          changed: true,
          pr: forgePrRecord(),
          bodyDigest: 'digest',
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(JSON.parse(result.forgeRequests[0]).body).toBe('The corrected body');
  });

  it('surfaces an unverified edit with what may remain on the forge', () => {
    const result = publishBody({
      source: 'forge',
      inputs: { INPUTS_PR: record },
      forge: {
        kind: 'fake',
        response: forgeFailure(
          'pr.edit-body',
          'verification_failed',
          'Pull request body read-back did not match',
          { leaveBehind: 'the pull request body may have changed' }
        ),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('verification_failed');
    expect(result.stderr).toContain('the pull request body may have changed');
  });
});

function publishReview(options: ScriptOptions = {}): ScriptRun {
  return runPackScript('review/scripts/publish-review', {
    ...options,
    inputs: {
      INPUTS_PR: JSON.stringify(PR),
      INPUTS_REPORT: '{ARTIFACTS}/review/report.md',
      INPUTS_READY: 'true',
      INPUTS_ACTION: 'none',
      INPUTS_SUMMARY: 'stub: nothing open',
      INPUTS_REPORT_POINTER: JSON.stringify({
        type: 'archon_artifact',
        run_id: 'fixture-run',
        path: 'review/report.md',
      }),
      ...options.inputs,
    },
    artifacts: { 'review-report.md': REPORT, ...options.artifacts },
  });
}

describe('publish-review keeps one canonical comment per pull request', () => {
  const report = { INPUTS_REPORT: '{ARTIFACTS}/review-report.md' };

  it('creates the marked comment on the first round and edits it on the next', () => {
    const first = publishReview({ inputs: report });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ ready: true, action: 'none' });
    expect(first.gh.some(call => call.includes('--method POST'))).toBe(true);

    const second = publishReview({
      inputs: report,
      gh: { comments: [{ id: 5, body: `${MARKER}\nRound 1: ready\n` }] },
    });
    expect(second.code).toBe(0);
    expect(second.gh.some(call => call.includes('--method PATCH'))).toBe(true);
    expect(second.gh.some(call => call.includes('--method POST'))).toBe(false);
  });

  it('refuses rather than choosing between two marked comments', () => {
    const result = publishReview({
      inputs: report,
      gh: {
        comments: [
          { id: 1, body: `${MARKER}\nolder` },
          { id: 2, body: `${MARKER}\nnewer` },
        ],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('more than one comment');
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('refuses when the written comment does not read back', () => {
    const result = publishReview({ inputs: report, gh: { writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('does not read back as written');
  });

  it('publishes nothing for a working-diff review and still reports the verdict', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_PR: '{}' } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
  });

  // Delivery hands the review its verified record as the scope. The scope agent's
  // declaration is then a restatement, not the authority: a wrong or empty one must
  // not move the comment or silently skip it.
  it.each([
    ['declares no pull request', '{}'],
    ['names another pull request', JSON.stringify({ ...PR, number: 43 })],
  ])('refuses when delivery recorded the target and the scope %s', (_label, declared) => {
    const result = publishReview({
      inputs: { ...report, INPUTS_SCOPE: JSON.stringify(PR), INPUTS_PR: declared },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('delivery recorded');
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('publishes to the recorded pull request when the scope declaration agrees', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_SCOPE: JSON.stringify(PR) } });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.includes('repos/example/repo/issues/42/comments'))).toBe(
      true
    );
  });

  it('upserts through the plugin on the opt-in path, with the report in the request file', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        response: forgeOperation('comment.upsert', {
          target: PR,
          outcome: 'applied',
          changed: true,
          comment: {
            ref: PR,
            id: '900',
            url: `${PR_URL}#issuecomment-900`,
            bodyDigest: 'digest',
          },
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    const request = JSON.parse(result.forgeRequests[0]) as { marker: string; body: string };
    expect(request.marker).toBe(MARKER);
    expect(request.body.split('\n')[0]).toBe(MARKER);
    expect(request.body).toContain(REPORT);
    expect(result.forge.join(' ')).not.toContain(REPORT);
  });

  it('still reports the verdict when the host could not audit the comment write', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        okExitCode: 2,
        response: forgeOperation('comment.upsert', {
          target: PR,
          outcome: 'applied',
          changed: true,
          comment: {
            ref: PR,
            id: '900',
            url: `${PR_URL}#issuecomment-900`,
            bodyDigest: 'digest',
          },
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
    expect(result.stderr).toContain("could not record it in the run's audit log");
  });

  it('reports an unknown comment outcome without claiming the review was published', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        response: forgeFailure('comment.upsert', 'outcome_unknown', 'forge plugin timed out'),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outcome_unknown');
  });
});
