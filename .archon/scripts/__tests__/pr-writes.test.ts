/**
 * The pack's pull-request writes, through both sources.
 *
 * Fixtures stub these nodes, so only a subprocess run can observe what they
 * actually write, which source they wrote through, and whether a write that did
 * not read back is reported as a failure rather than a delivery.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PR,
  PR_URL,
  forgeOperation,
  forgeFailure,
  forgePrRecord,
  gitCheckout,
  runPackScript,
  type ScriptOptions,
  type ScriptRun,
} from './deliver-checks-harness';

const MARKER = '<!-- archon-review-report -->';
const REPORT = 'Round 1: ready';

/** The engine's typed-artifact listing for a run with no typed artifacts yet. */
const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });

interface Target {
  readonly headRepo?: { host: string; path: string };
  readonly head?: string;
  readonly existing?: number | null;
}

/**
 * Run publish-pr in a real checkout whose `upstream` remote is the recorded
 * repository (a local bare repository behind `url.insteadOf`), so the push it makes
 * first lands and reads back. The fake forge reports that pushed commit as the head.
 */
function publishPr(options: ScriptOptions & { target?: Target } = {}): ScriptRun & { head: string; cwd: string } {
  const { target = {}, ...rest } = options;
  const cwd = gitCheckout();
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const run = runPackScript('pr/scripts/publish-pr', {
    ...rest,
    cwd,
    gh: { ...rest.gh, pr: { headRefOid: head, ...rest.gh?.pr } },
    inputs: {
      INPUTS_REPO: JSON.stringify(PR.repo),
      INPUTS_HEAD_REPO: JSON.stringify(target.headRepo ?? PR.repo),
      INPUTS_HEAD: target.head ?? 'feature',
      INPUTS_BASE: 'dev',
      // The engine binds a field prepare declared null as empty text.
      INPUTS_EXISTING: target.existing == null ? '' : JSON.stringify(target.existing),
      INPUTS_TITLE: 'A title',
      INPUTS_BODY: '{ARTIFACTS}/pr-body.md',
      INPUTS_DRAFT: 'true',
      TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      ...rest.inputs,
    },
    artifacts: { 'pr-body.md': 'A body', 'listing.json': EMPTY_LISTING, ...rest.artifacts },
  });
  return { ...run, head, cwd };
}

describe('publish-pr opens the pull request at most once', () => {
  it.each(['gh', 'forge'] as const)(
    'refuses another create through %s while the earlier write is unresolved',
    source => {
      const result = publishPr({
        source,
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('a previous PR create is unresolved');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

  it.each(['gh', 'forge'] as const)(
    'reconciles a previously started create through %s when its PR is visible',
    source => {
      const result = publishPr({
        source,
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        gh: { pr: { headRefName: 'feature' } },
        forge: { kind: 'fake', response: forgeOperation('pr.view', { pr: forgePrRecord() }) },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

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
    // Nothing was written, so a retry may create.
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it.each(['outcome_unknown', 'verification_failed'] as const)(
    'keeps the create claim after a %s create so a retry cannot open a duplicate',
    outcome => {
      const result = publishPr({
        source: 'forge',
        forge: {
          kind: 'fake',
          response: [
            forgeOperation('pr.view', null),
            forgeFailure('pr.create', outcome, 'forge plugin timed out'),
          ],
        },
      });
      expect(result.code).not.toBe(0);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(true);
    }
  );

  it('reuses the open pull request when the head repository differs only in case', () => {
    const result = publishPr({
      target: { headRepo: { host: PR.repo.host, path: 'Example/Repo' } },
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
      target: { existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr list'))).toBe(false);
  });

  it('adopts a named pull request whose head repository differs only in case', () => {
    const result = publishPr({
      target: { headRepo: { host: PR.repo.host, path: 'Example/Repo' }, existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
  });

  it('refuses before pushing when prepare did not continue the pull request the caller named', () => {
    for (const existing of [null, 41]) {
      const result = publishPr({ target: { existing }, inputs: { INPUTS_PULL_REQUEST: '42' } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('the caller named pull request 42 to continue');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    }
    const agreed = publishPr({
      target: { existing: 42 },
      inputs: { INPUTS_PULL_REQUEST: '42' },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(agreed.code).toBe(0);
    // A caller with no pull request to continue binds null.
    expect(publishPr({ inputs: { INPUTS_PULL_REQUEST: 'null' } }).code).toBe(0);
  });

  it('refuses a named pull request whose head is not the recorded branch, before pushing', () => {
    const result = publishPr({
      target: { existing: 42 },
      gh: { pr: { headRefName: 'somebody-elses-branch' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not the recorded');
    const remote = spawnSync('git', ['ls-remote', '--heads', 'upstream', 'feature'], { cwd: result.cwd, encoding: 'utf8' });
    expect(remote.stdout.trim()).toBe('');
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
  const pointer = { type: 'archon_artifact', run_id: 'run', path: 'pr-body-final.md' };
  return runPackScript('deliver/scripts/publish-pr-body', {
    ...rest,
    inputs: {
      // A declared null binds as empty text.
      INPUTS_BODY: change ? JSON.stringify(pointer) : '',
      TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      ...rest.inputs,
    },
    artifacts: {
      'pr-body-final.md': 'The corrected body',
      'listing.json': EMPTY_LISTING,
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

  it('rebuilds the red-cause block from the gates instead of keeping a stale one', () => {
    const gate = { gate: 'green', red_cause: 'inherited', stage: 'The project gate', summary: 'e2e was red on dev', head: null };
    const result = publishBody({
      source: 'forge',
      inputs: { INPUTS_PR: record },
      artifacts: {
        'pr-body-final.md':
          '<!-- archon-red-causes -->\nan old disclosure\n<!-- /archon-red-causes -->\n\nThe corrected body',
        'nodes/gate.md': JSON.stringify(gate),
        'listing.json': JSON.stringify({
          runId: 'run',
          artifactsByType: { 'green-gate': [{ nodeId: 'gate', path: 'nodes/gate.md' }] },
          errors: [],
        }),
      },
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
    const body = JSON.parse(result.forgeRequests[0]).body as string;
    expect(body.startsWith('<!-- archon-red-causes -->')).toBe(true);
    expect(body).toContain('The project gate: inherited red');
    expect(body).not.toContain('an old disclosure');
    expect(body.endsWith('The corrected body')).toBe(true);
  });

  it('writes nothing when the body was already accurate and no gate passed red', () => {
    const result = publishBody({ change: false, inputs: { INPUTS_PR: record } });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr edit'))).toBe(false);
  });

  it('adds the red-cause block to an accurate body when a gate passed red after it opened', () => {
    const gate = { gate: 'green', red_cause: 'inherited', stage: 'The project gate', summary: 'e2e was red on dev', head: null };
    const result = publishBody({
      change: false,
      inputs: { INPUTS_PR: record },
      artifacts: {
        'nodes/gate.md': JSON.stringify(gate),
        'listing.json': JSON.stringify({
          runId: 'run',
          artifactsByType: { 'green-gate': [{ nodeId: 'gate', path: 'nodes/gate.md' }] },
          errors: [],
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr edit 42'))).toBe(true);
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
      INPUTS_HEAD: REVIEWED,
      ARCHON_NODE_EXECUTION: atCommit(REVIEWED),
      INPUTS_READY: 'true',
      INPUTS_ACTION: 'none',
      INPUTS_SUMMARY: 'stub: nothing open',
      INPUTS_REPORT_POINTER: JSON.stringify({
        type: 'archon_artifact',
        run_id: 'fixture-run',
        path: 'review/report.md',
      }),
      INPUTS_DISCOVERIES: '[]',
      INPUTS_MISSING: '[]',
      ...options.inputs,
    },
    artifacts: { 'review-report.md': REPORT, ...options.artifacts },
  });
}

/** The PR head the fake gh and forge report, and so the commit a passing round reviewed. */
const REVIEWED = 'deadbeef';

function atCommit(commit: string): string {
  return JSON.stringify({ attempt: { checkoutStart: { kind: 'git', commit } } });
}

const prView = forgeOperation('pr.view', { pr: forgePrRecord(), title: 'A title', body: 'A body' });

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
    const result = publishReview({ inputs: { ...report, INPUTS_PR: 'null' } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
  });

  it('still accepts a legacy empty-object working-diff declaration', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_PR: '{}' } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
  });

  // Delivery hands the review its verified record as the scope. The scope agent's
  // declaration is then a restatement, not the authority: a wrong or empty one must
  // not move the comment or silently skip it.
  it.each([
    ['declares no pull request', 'null'],
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
        response: [
          prView,
          forgeOperation('comment.upsert', {
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
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    const request = JSON.parse(result.forgeRequests[1]) as { marker: string; body: string };
    expect(request.marker).toBe(MARKER);
    expect(request.body.split('\n')[0]).toBe(MARKER);
    expect(request.body).toContain(REPORT);
    // The comment names the commit it reviewed from the round's own record, not the report text.
    expect(request.body.split('\n')[1]).toBe(`Reviewed commit: \`${REVIEWED}\``);
    expect(result.forge.join(' ')).not.toContain(REPORT);
  });

  it('still reports the verdict when the host could not audit the comment write', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        okExitCode: 2,
        response: [
          prView,
          forgeOperation('comment.upsert', {
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
        ],
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
        response: [prView, forgeFailure('comment.upsert', 'outcome_unknown', 'forge plugin timed out')],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outcome_unknown');
  });
});

// A round's verdict goes public only about the commit it reviewed. The stale case
// is a pull-request record whose head revision was captured when the PR opened:
// a report about that commit must not stand as the verdict on the PR's head.
describe('publish-review publishes a verdict only about the head it reviewed', () => {
  const report = { INPUTS_REPORT: '{ARTIFACTS}/review-report.md' };
  const STALE = 'stale0000';

  it('records the reviewed commit beside the report as the next round\'s cursor', () => {
    const result = publishReview({ inputs: report });
    expect(result.code).toBe(0);
    expect(readFileSync(join(result.artifacts, 'reviewed-head'), 'utf8').trim()).toBe(REVIEWED);
  });

  it('refuses a round that reviewed a commit the pull request no longer carries', () => {
    const result = publishReview({
      inputs: {
        ...report,
        INPUTS_SCOPE: JSON.stringify(PR),
        INPUTS_HEAD: STALE,
        ARCHON_NODE_EXECUTION: atCommit(STALE),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`this round reviewed ${STALE}, but`);
    expect(result.stderr).toContain(`is at ${REVIEWED}`);
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'reviewed-head'))).toBe(false);
  });

  it('refuses a ready verdict while an enabled lens did not complete', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_MISSING: JSON.stringify(['code']) } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('enabled lenses did not complete: code');
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('refuses action none while a lens is missing, whatever the ready field says', () => {
    const result = publishReview({
      inputs: { ...report, INPUTS_READY: 'false', INPUTS_ACTION: 'none', INPUTS_MISSING: JSON.stringify(['code']) },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('enabled lenses did not complete: code');
  });

  it('publishes a not-ready verdict that names a missing lens', () => {
    const result = publishReview({
      inputs: { ...report, INPUTS_READY: 'false', INPUTS_ACTION: 'correct', INPUTS_MISSING: JSON.stringify(['code']) },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: false });
  });

  it('refuses when the checkout moved after the round fixed its commit', () => {
    const result = publishReview({
      inputs: { ...report, ARCHON_NODE_EXECUTION: atCommit('moved0000') },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`reviewed ${REVIEWED}, but the checkout is now at moved0000`);
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });
});

describe('markPrDraft uses the selected source', () => {
  const script = '../../scripts/__tests__/mark-pr-draft';
  it('converts through gh and reads back draft state', () => {
    const result = runPackScript(script, { gh: { pr: { isDraft: false } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ is_draft: true, state: 'open' });
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo --undo');
  });
  it.each(['CLOSED', 'MERGED'] as const)('refuses %s without a write', state => {
    const result = runPackScript(script, { gh: { pr: { state } } });
    expect(result.code).not.toBe(0);
    expect(result.gh.some(call => call.startsWith('pr ready'))).toBe(false);
  });
  it('does not write for an already-draft PR', () => {
    const result = runPackScript(script);
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr ready'))).toBe(false);
  });
  it('fails when gh conversion does not read back', () => {
    const result = runPackScript(script, { gh: { pr: { isDraft: false }, writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not report an open draft');
  });
  it('calls pr.draft through forge without gh', () => {
    const result = runPackScript(script, {
      source: 'forge',
      forge: {
        kind: 'fake',
        response: forgeOperation('pr.draft', {
          target: PR,
          outcome: 'applied',
          changed: true,
          pr: forgePrRecord(),
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge[0]).toContain('forge pr.draft --json --data-file');
    expect(JSON.parse(result.forgeRequests[0]).ref).toEqual(PR);
    expect(JSON.parse(result.stdout)).toMatchObject({ is_draft: true });
  });
  it.each(['refused', 'verification_failed', 'outcome_unknown'] as const)(
    'surfaces %s with no fallback',
    outcome => {
      const result = runPackScript(script, {
        source: 'forge',
        forge: {
          kind: 'fake',
          response: forgeFailure('pr.draft', outcome, 'unsupported or unverifiable conversion'),
        },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(outcome);
      expect(result.gh).toEqual([]);
    }
  );
});
