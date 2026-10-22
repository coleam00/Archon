/**
 * Small deterministic steps of the delivery tail whose fixtures stub them: the
 * investigation's derived outcome, deliver's correction round, and the deliver, ship
 * and upkeep terminal reports. Run as
 * the engine runs them, from their bound inputs.
 */
import { describe, expect, it } from 'bun:test';
import { PR, PR_URL, forgePrRecord, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });

describe('investigate verdict', () => {
  it.each([
    ['rooted', true],
    ['refuted', false],
    ['inconclusive', false],
  ] as const)('derives rooted from a %s verdict', (verdict, rooted) => {
    const run = runPackScript('investigate/scripts/verdict', {
      inputs: {
        INPUTS_VERDICT: verdict,
        INPUTS_SUMMARY: 'stub',
        INPUTS_REPORT: JSON.stringify({ type: 'archon_artifact', run_id: 'r', path: 'investigation.md' }),
      },
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ verdict, rooted });
  });
});

describe("ship's terminal outcome", () => {
  interface ShipOutcome { delivered: boolean; reason: string; pr_url: string; summary: string }
  const outcome = (inputs: Record<string, string>): ShipOutcome => {
    const run = runPackScript('ship/scripts/outcome', {
      inputs: {
        INPUTS_ROUTE: 'no_action',
        INPUTS_CONTRACT: 'NO_ACTION',
        INPUTS_BLOCKED_REASON: '',
        INPUTS_SUMMARY: 'triage summary',
        INPUTS_INV_VERDICT: 'null',
        INPUTS_INV_SUMMARY: 'null',
        INPUTS_PLAN_SUMMARY: 'null',
        INPUTS_OPEN_QUESTIONS: 'null',
        INPUTS_DELIVERED: 'null',
        INPUTS_DELIVERY: 'null',
        INPUTS_DELIVERY_REASON: 'null',
        INPUTS_PR_URL: 'null',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...inputs,
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as ShipOutcome;
  };

  it('reports a refuted investigation as no work owed, in the investigator’s words', () => {
    const result = outcome({
      INPUTS_ROUTE: 'investigate',
      INPUTS_CONTRACT: 'READY',
      INPUTS_INV_VERDICT: 'refuted',
      INPUTS_INV_SUMMARY: 'the cause is owned upstream in the provider SDK',
    });
    expect(result.delivered).toBe(false);
    expect(result.summary).toContain('the cause is owned upstream in the provider SDK');
    expect(result.summary).toContain('investigation.md');
  });

  it('reports an inconclusive investigation as work not done, with its gap', () => {
    const result = outcome({
      INPUTS_ROUTE: 'investigate',
      INPUTS_CONTRACT: 'READY',
      INPUTS_INV_VERDICT: 'inconclusive',
      INPUTS_INV_SUMMARY: 'the probe could not authenticate',
    });
    expect(result.delivered).toBe(false);
    expect(result.summary).toContain('the probe could not authenticate');
  });

  it('relays every open question when planning stops on a call it cannot make', () => {
    const result = outcome({
      INPUTS_ROUTE: 'plan',
      INPUTS_CONTRACT: 'READY',
      INPUTS_PLAN_SUMMARY: 'needs a product call',
      INPUTS_OPEN_QUESTIONS: JSON.stringify(['keep the field?', 'which default?']),
    });
    expect(result).toMatchObject({ delivered: false, reason: 'ask', pr_url: '' });
    expect(result.summary).toContain('needs a product call\n- keep the field?\n- which default?');
  });

  it('relays questions the planner judged non-blocking with a delivery', () => {
    const result = outcome({
      INPUTS_ROUTE: 'plan',
      INPUTS_CONTRACT: 'READY',
      INPUTS_OPEN_QUESTIONS: JSON.stringify(['rename the flag later?']),
      INPUTS_DELIVERED: 'true',
      INPUTS_DELIVERY: 'https://x/pull/1',
      INPUTS_DELIVERY_REASON: 'delivered',
    });
    expect(result).toMatchObject({ delivered: true, reason: 'delivered' });
    expect(result.summary).toContain('non-blocking:\n- rename the flag later?');
  });

  it('names a blocked item as requested work not done', () => {
    const result = outcome({ INPUTS_CONTRACT: 'BLOCKED', INPUTS_BLOCKED_REASON: 'waits on a release' });
    expect(result.delivered).toBe(false);
    expect(result.summary).toContain('waits on a release');
  });

  it('keeps an honest no-action as no delivery needed', () => {
    expect(outcome({})).toMatchObject({ delivered: false });
    expect(outcome({}).summary).toContain('triage summary');
  });

  it("reports deliver's own outcome and pull request, ready or not", () => {
    const deliver = { INPUTS_ROUTE: 'deliver', INPUTS_CONTRACT: 'READY', INPUTS_PR_URL: PR_URL };
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'true', INPUTS_DELIVERY: `Ready: done\n${PR_URL}`, INPUTS_DELIVERY_REASON: 'delivered' })
    ).toEqual({
      delivered: true,
      reason: 'delivered',
      pr_url: PR_URL,
      summary: `Ready: done\n${PR_URL}`,
    });
    expect(
      outcome({ ...deliver, INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready, red: lint', INPUTS_DELIVERY_REASON: 'ci_other' })
    ).toEqual({
      delivered: false,
      reason: 'ci_other',
      pr_url: PR_URL,
      summary: 'Not ready, red: lint',
    });
  });
});

describe("upkeep's terminal outcome", () => {
  const outcome = (inputs: Record<string, string>): { delivered: boolean; pr_url: string; summary: string } => {
    const run = runPackScript('upkeep/scripts/outcome', {
      inputs: { INPUTS_SUMMARY: 'already current', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json', ...inputs },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as { delivered: boolean; pr_url: string; summary: string };
  };

  it("reports deliver's pull request, and none when no update was needed", () => {
    expect(
      outcome({ INPUTS_ACTION: 'update', INPUTS_DELIVERED: 'false', INPUTS_DELIVERY: 'Not ready: ci_other', INPUTS_PR_URL: PR_URL })
    ).toEqual({ delivered: false, pr_url: PR_URL, summary: 'Not ready: ci_other' });
    expect(
      outcome({ INPUTS_ACTION: 'no_action', INPUTS_DELIVERED: 'null', INPUTS_DELIVERY: 'null', INPUTS_PR_URL: 'null' })
    ).toMatchObject({ delivered: false, pr_url: '' });
  });
});

describe("deliver's terminal outcome", () => {
  interface Outcome { ready: boolean; reason: string; pr_url: string; summary: string }
  const outcome = (rounds: object, source = 'gh'): Outcome => {
    const run = runPackScript('deliver/scripts/outcome', {
      inputs: {
        INPUTS_ROUNDS: JSON.stringify(rounds),
        INPUTS_SOURCE: source,
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      },
      artifacts: { 'listing.json': EMPTY_LISTING },
    });
    expect(run.code).toBe(0);
    return JSON.parse(run.stdout) as Outcome;
  };

  it("reports the last round's ending with its pull request", () => {
    expect(
      outcome({ ready: true, reason: 'delivered', pr_url: PR_URL, contract_left: [], summary: 'Round 1: delivered. all passed' })
    ).toMatchObject({ ready: true, reason: 'delivered', pr_url: PR_URL });
    const blocked = outcome({ ready: false, reason: 'implement_blocked', pr_url: '', contract_left: null, summary: 'Round 1: implement_blocked. x' });
    expect(blocked).toMatchObject({ ready: false, reason: 'implement_blocked', pr_url: '' });
      });

  it('says review threads were not checked on the forge source', () => {
    const forge = outcome(
      { ready: true, reason: 'delivered', pr_url: PR_URL, contract_left: [], summary: 'Round 1: delivered. all passed' },
      'forge'
    );
    expect(forge.summary).toContain('Review threads');
    const noPr = outcome({ ready: false, reason: 'implement_blocked', pr_url: '', contract_left: null, summary: 'x' }, 'forge');
    expect(noPr.summary).not.toContain('Review threads');
  });

  it('lists the contract items the latest review left open', () => {
    const partial = outcome({
      ready: true,
      reason: 'delivered',
      pr_url: PR_URL,
     
      contract_left: ['acceptance: the console shows it (deferred)'],
      summary: 'Round 1: delivered. all passed',
    });
    expect(partial.summary).toContain('acceptance: the console shows it (deferred)');
  });
});

describe("deliver's report after a node failure", () => {
  const failedReport = (listing: object, artifacts: Record<string, string> = {}): { reason: string; pr_url: string } =>
    JSON.parse(
      runPackScript('deliver/scripts/report', {
        inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
        artifacts: { 'listing.json': JSON.stringify({ runId: 'run', errors: [], ...listing }), ...artifacts },
      }).stdout
    ) as { reason: string; pr_url: string };

  it('names the pull request a round published before the failure, so the next run continues it', () => {
    const published = failedReport(
      { artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json' }] } },
      { 'nodes/publish.json': JSON.stringify({ number: 42, url: PR_URL }) }
    );
    expect(published).toMatchObject({ reason: 'failed', pr_url: PR_URL });
    expect(failedReport({ artifactsByType: {} })).toMatchObject({ reason: 'failed', pr_url: '' });
  });
  it('selects the latest publication across typed output and the creation record', () => {
    for (const recoveryIsLatest of [true, false]) {
      const run = runPackScript('deliver/scripts/report', {
        inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
        artifacts: {
          'listing.json': JSON.stringify({ artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json' }] }, errors: [] }),
          'nodes/publish.json': JSON.stringify({ url: PR_URL }),
          'pr-create-started': JSON.stringify({ pr: forgePrRecord({ number: 43, url: 'https://ghe.example.com/example/repo/pull/43' }) }),
        },
        preload: `import { utimesSync } from 'node:fs';
          utimesSync('{ARTIFACTS}/nodes/publish.json', 100, ${recoveryIsLatest ? 100 : 300});
          utimesSync('{ARTIFACTS}/pr-create-started', 200, 200);`,
      });
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        reason: 'failed', pr_url: recoveryIsLatest ? 'https://ghe.example.com/example/repo/pull/43' : PR_URL,
      });
    }
  });

  it('keeps the timestamp with the readable typed publication when a later artifact is missing', () => {
    const run = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
      artifacts: {
        'listing.json': JSON.stringify({ artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json' }, { path: 'nodes/missing.json' }] }, errors: [] }),
        'nodes/publish.json': JSON.stringify({ url: PR_URL }),
        'pr-create-started': JSON.stringify({ pr: forgePrRecord({ number: 43, url: 'https://ghe.example.com/example/repo/pull/43' }) }),
      },
      preload: `import { utimesSync } from 'node:fs';
        utimesSync('{ARTIFACTS}/nodes/publish.json', 300, 300);
        utimesSync('{ARTIFACTS}/pr-create-started', 200, 200);`,
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).pr_url).toBe(PR_URL);
  });

  it('does not certify a URL without a complete PR record', () => {
    const result = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null' },
      artifacts: { 'pr-create-started': JSON.stringify({ pr: { url: PR_URL } }) },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: 'pr_create_unresolved',
      pr_url: '', summary: expect.stringContaining('invalid pull-request record'),
    });
  });

  it.each([true, false])('orders an unresolved claim against typed output (claim latest: %s)', claimIsLatest => {
    const run = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null', TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json' },
      artifacts: {
        'listing.json': JSON.stringify({ artifactsByType: { 'pull-request': [{ path: 'nodes/publish.json' }] }, errors: [] }),
        'nodes/publish.json': JSON.stringify({ url: PR_URL }),
        'pr-create-started': JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }),
      },
      preload: `import { utimesSync } from 'node:fs';
        utimesSync('{ARTIFACTS}/nodes/publish.json', 100, ${claimIsLatest ? 100 : 300});
        utimesSync('{ARTIFACTS}/pr-create-started', 200, 200);`,
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      ready: false, reason: claimIsLatest ? 'pr_create_unresolved' : 'failed', pr_url: claimIsLatest ? '' : PR_URL,
    });
  });

  for (const script of ['deliver/scripts/report', 'ship/scripts/report']) {
    it.each(['unverified', 'unreadable', 'directory'])(
      'distinguishes an unresolved %s create from no PR', kind => {
        const run = runPackScript(script, {
          inputs: { INPUTS_OUTCOME: 'null' },
          artifacts: kind === 'directory' ? {} : {
            'pr-create-started': kind === 'unverified' ? JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }) : 'invalid JSON',
          },
          preload: kind === 'directory' ? `import { mkdirSync } from 'node:fs'; mkdirSync('{ARTIFACTS}/pr-create-started');` : undefined,
        });
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ reason: 'pr_create_unresolved', pr_url: '', summary: expect.stringContaining('pr-create-started') });
      }
    );
  }
});

describe("ship's continued pull request", () => {
  const continues = (caller: string, triage: string): { code: number; stdout: string; stderr: string } =>
    runPackScript('ship/scripts/continues', { inputs: { INPUTS_CALLER: caller, INPUTS_TRIAGE: triage } });

  it("is the caller's whichever route triage took, else triage's", () => {
    expect(JSON.parse(continues('42', 'null').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('', '42').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('42', '42').stdout)).toEqual({ pull_request: 42 });
    expect(JSON.parse(continues('null', 'null').stdout)).toEqual({ pull_request: null });
    expect(JSON.parse(continues('none', 'null').stdout)).toEqual({ pull_request: null });
  });

  it('refuses when the caller decided none but triage routed the run to continue one', () => {
    const result = continues('none', '42');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the caller decided the run continues no pull request, but triage routed it to continue 42');
  });

  it('refuses when the caller and triage name different pull requests', () => {
    const result = continues('42', '43');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the caller resolved pull request 42, but triage routed the run to continue 43');
  });
});

describe("deliver's round", () => {
  interface Round { round: number; done: boolean; ready: boolean; reason: string; pr_url: string; prior_report: string; light_review: boolean; contract_left: string[] | null; summary: string }
  const round = (inputs: Record<string, string>): Round =>
    JSON.parse(
      runPackScript('deliver/scripts/round', {
        inputs: {
          INPUTS_PREVIOUS: '',
          INPUTS_PRIOR_REPORT: '',
          INPUTS_PREVIOUS_PR_URL: '',
          INPUTS_GREEN: 'true',
          INPUTS_RED_CAUSE: '',
          INPUTS_IMPLEMENT_SUMMARY: 'built',
          INPUTS_PR_URL: PR_URL,
          INPUTS_REVIEW_READY: 'true',
          INPUTS_REVIEW_ACTION: 'none',
          INPUTS_REVIEW_SUMMARY: 'clean',
          INPUTS_REVIEW_CONTRACT_LEFT: '[]',
          INPUTS_PREVIOUS_CONTRACT_LEFT: '',
          INPUTS_CI: 'green',
          INPUTS_CI_SUMMARY: 'all passed',
          INPUTS_THREADS_OPEN: '0',
          INPUTS_THREADS_SUMMARY: 'no thread open',
          INPUTS_SETTLE_ASK: 'null',
          INPUTS_SETTLE_SUMMARY: 'null',
          ...inputs,
        },
      }).stdout
    ) as Round;

  it('delivers on a passing review and green CI', () => {
    expect(round({})).toMatchObject({ round: 1, done: true, ready: true, reason: 'delivered', pr_url: PR_URL });
  });

  it('stops on red the change introduced, before any pull request', () => {
    const ended = round({ INPUTS_GREEN: 'false', INPUTS_RED_CAUSE: 'introduced', INPUTS_PR_URL: 'null' });
    expect(ended).toMatchObject({ done: true, ready: false, reason: 'implement_blocked', pr_url: '' });
  });

  it('keeps an earlier round’s pull request when this round opened none', () => {
    const ended = round({
      INPUTS_PREVIOUS: '1',
      INPUTS_PREVIOUS_PR_URL: PR_URL,
      INPUTS_GREEN: 'false',
      INPUTS_PR_URL: 'null',
    });
    expect(ended).toMatchObject({ round: 2, reason: 'implement_blocked', pr_url: PR_URL });
  });

  it('goes again for open findings and a red the change caused, and stops on any other red', () => {
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'correct', INPUTS_CI: 'null' })).toMatchObject({
      done: false,
      reason: 'review_open',
    });
    expect(round({ INPUTS_CI: 'pr_caused' })).toMatchObject({ done: false, reason: 'ci_pr_caused' });
    expect(round({ INPUTS_CI: 'other' })).toMatchObject({ done: true, ready: false, reason: 'ci_other' });
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'replan', INPUTS_CI: 'null' })).toMatchObject({
      done: true,
      reason: 'replan',
    });
    expect(round({ INPUTS_REVIEW_READY: 'false', INPUTS_REVIEW_ACTION: 'ask', INPUTS_CI: 'null' })).toMatchObject({
      done: true,
      ready: false,
      reason: 'ask',
    });
  });

  it('does not end ready while a review thread is open, and asks on one no round can settle', () => {
    const open = round({ INPUTS_THREADS_OPEN: '2', INPUTS_THREADS_SUMMARY: '2 review threads are unresolved' });
    expect(open).toMatchObject({ done: false, ready: false, reason: 'threads_open' });
    expect(round({ INPUTS_PREVIOUS: '3', INPUTS_THREADS_OPEN: '1' })).toMatchObject({ done: true, ready: false, reason: 'round_cap' });
    const asked = round({
      INPUTS_THREADS_OPEN: '1',
      INPUTS_SETTLE_ASK: 'true',
      INPUTS_SETTLE_SUMMARY: 'a person decides the API name',
    });
    expect(asked).toMatchObject({ done: true, ready: false, reason: 'ask' });
    expect(asked.summary).toContain('a person decides the API name');
    // A CI red decides the round before the threads do.
    expect(round({ INPUTS_THREADS_OPEN: '1', INPUTS_CI: 'other' })).toMatchObject({ reason: 'ci_other' });
  });

  it('ends typed at the round cap instead of exhausting the loop', () => {
    expect(round({ INPUTS_PREVIOUS: '2', INPUTS_CI: 'pr_caused' })).toMatchObject({ round: 3, done: false });
    expect(round({ INPUTS_PREVIOUS: '3', INPUTS_CI: 'pr_caused' })).toMatchObject({
      round: 4,
      done: true,
      ready: false,
      reason: 'round_cap',
    });
  });
});
