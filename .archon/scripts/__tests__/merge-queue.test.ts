import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { type BuildRecord, buildWaits } from '../../workflows/sdlc/.shared/build';
import {
  checksOf,
  DEV_EFFECTS,
  DEV_STATES,
  gateRefusals,
  MERGE_ASKED_BY,
  MERGE_EFFECTS,
  MERGE_PATHS,
  type MergeAttention,
  type MergeRecord,
  mergeWaits,
  POLICY_CLASSES,
  type PrFacts,
  prFromUrl,
  RERUNS,
  SWEEP_ACTIONS,
} from '../../workflows/sdlc/.shared/merge';
import { CONFIDENCES } from '../../workflows/sdlc/.shared/queue';
import { REVIEW_MARKER, readReviewStamp, reviewCommentBody } from '../../workflows/sdlc/.shared/review-comment';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import { newWorkItem, parseWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { type GhCommentRow, gitCheckout, PACK, packScriptRunner, PR, PR_URL, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const AT = '2026-10-16T00:00:00.000Z';
const LATER = '2026-10-16T01:00:00.000Z';
const HEAD = '1111111111111111111111111111111111111111';
const OLD = '2222222222222222222222222222222222222222';
const SUBJECT = { repo: PR.repo, number: 7 };

const TRIAGE: TriageFacts = {
  verdict: { contract: 'READY', route: 'deliver' },
  pull_request: null,
  type: { value: 'bug', reason: 'r' },
  size: { value: 's', reason: 'r' },
  complexity: { value: 'low', reason: 'r' },
  importance: { value: 'medium', reason: 'r' },
  urgency: { value: 'none', reason: 'r' },
  at: AT,
  run_id: 'intake-run',
};

const BUILT: BuildRecord = {
  status: 'ready',
  brief: '',
  rounds: [
    { run_id: 'ship-1', at: AT, delivered: true, reason: 'ready', pr_url: PR_URL, summary: 'Ready', artifacts: '/runs/ship-1' },
  ],
  decisions: [],
  at: AT,
};

function item(build: BuildRecord = BUILT, merge?: MergeRecord, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...newWorkItem(SUBJECT, AT),
    stage: 'deliver',
    trust: 'maintainer',
    facts: { triage: TRIAGE, build, ...(merge === undefined ? {} : { merge }) },
    ...overrides,
  };
}

function merge(status: MergeRecord['status'], at = LATER): MergeRecord {
  return { status, pr: PR, approval: null, decisions: [], at };
}

const FACTS: PrFacts = {
  pr: PR,
  url: PR_URL,
  title: 'Fix the thing',
  state: 'open',
  is_draft: false,
  base: 'dev',
  default_branch: 'dev',
  head: 'feature',
  head_revision: HEAD,
  merge_commit: null,
  mergeable: 'clean',
  size: { additions: 10, deletions: 2, files: 2 },
  checks: { state: 'green', failing: [], pending: [] },
  threads: { unresolved: 0, urls: [] },
  verdict: { state: 'ready', reviewed: HEAD, url: `${PR_URL}#issuecomment-1` },
};

describe('the merge record and the gate', () => {
  test('an item waits once the build queue finished it, until the merge queue settles it', () => {
    expect(mergeWaits(item())).toBe(true);
    expect(mergeWaits(item({ ...BUILT, status: 'next' }))).toBe(false);
    expect(mergeWaits({ ...item(), facts: { triage: TRIAGE } })).toBe(false);
    for (const status of ['waiting', 'asking'] as const) expect(mergeWaits(item(BUILT, merge(status)))).toBe(true);
    for (const status of ['merged', 'returned', 'parked'] as const) {
      expect(mergeWaits(item(BUILT, merge(status)))).toBe(false);
    }
    // The build queue readied it again after the merge queue parked or returned it.
    expect(mergeWaits(item({ ...BUILT, at: '2026-10-16T02:00:00.000Z' }, merge('parked')))).toBe(true);
  });

  test('the gate passes only a Ready verdict, green CI and no open thread, all at the pinned head', () => {
    expect(gateRefusals(FACTS, HEAD)).toEqual([]);
    const refused = (facts: Partial<PrFacts>, head = HEAD) => gateRefusals({ ...FACTS, ...facts }, head);
    expect(refused({ verdict: { ...FACTS.verdict, reviewed: OLD } })).toEqual([
      `its Ready verdict is for ${OLD}, not its head`,
    ]);
    expect(refused({ verdict: { ...FACTS.verdict, state: 'unstamped' } })).toEqual(['its review verdict is unstamped']);
    expect(refused({ verdict: { state: 'not_ready', reviewed: HEAD, url: null } })).toEqual(['its review verdict is not_ready']);
    expect(refused({ checks: { state: 'pending', failing: [], pending: ['test (ubuntu)'] } })).toEqual([
      'CI at its head is pending (test (ubuntu))',
    ]);
    expect(refused({ checks: { state: 'red', failing: ['lint'], pending: [] } })).toEqual(['CI at its head is red (lint)']);
    expect(refused({ threads: { unresolved: 2, urls: [] } })).toEqual(['2 review threads are unresolved']);
    expect(refused({}, OLD)).toEqual([`its head is ${HEAD}, not ${OLD}`]);
    expect(refused({ is_draft: true, base: 'main', state: 'closed' })).toEqual([
      'it is closed',
      'it is a draft',
      'it targets main, not the default branch dev',
    ]);
  });

  test('CI reads green only when every check on the commit concluded and passed', () => {
    const run = (status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', name: `run ${status} ${String(conclusion)}`, status, conclusion });
    const rollup = (...nodes: unknown[]) => ({ contexts: { totalCount: nodes.length, nodes } });
    expect(checksOf(rollup(run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), { __typename: 'StatusContext', context: 'ci', state: 'SUCCESS' })).state).toBe('green');
    expect(checksOf(rollup(run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS'))).state).toBe('pending');
    expect(checksOf(rollup(run('IN_PROGRESS'), run('COMPLETED', 'CANCELLED'))).state).toBe('red');
    expect(checksOf(rollup({ __typename: 'StatusContext', context: 'CodeRabbit', state: 'PENDING' })).pending).toEqual(['CodeRabbit']);
    expect(checksOf(null).state).toBe('none');
  });

  test('a review comment carries the reviewed commit and the verdict in stamped lines; an older one has no verdict', () => {
    expect(readReviewStamp(reviewCommentBody(HEAD, true, '# Report'))).toEqual({ reviewed: HEAD, ready: true, report: '# Report' });
    expect(readReviewStamp(reviewCommentBody(HEAD, false, '# Report'))?.ready).toBe(false);
    expect(readReviewStamp(`${REVIEW_MARKER}\nReviewed commit: \`${HEAD}\`\n\n# Report`)).toEqual({
      reviewed: HEAD,
      ready: null,
      report: '# Report',
    });
    expect(readReviewStamp('Verdict: ready')).toBeNull();
  });

  test('a pull request URL names its repository and number; anything else refuses', () => {
    expect(prFromUrl(PR_URL)).toEqual(PR);
    expect(() => prFromUrl('https://ghe.example.com/example/repo/issues/42')).toThrow('not a pull request URL');
  });

  test("the paths, actions, classes, effects and confidences are archon-merge-queue's own", () => {
    type Enum = { enum: string[] };
    type Schema = { enum?: string[]; properties?: Record<string, Schema>; items?: Schema };
    const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'merge-queue/archon-merge-queue.yaml'), 'utf8')) as {
      nodes: { id: string; output_format?: Schema }[];
    };
    const at = (id: string, ...path: string[]): Schema | undefined =>
      path.reduce<Schema | undefined>(
        (schema, key) => (key === '[]' ? schema?.items : schema?.properties?.[key]),
        workflow.nodes.find(node => node.id === id)?.output_format
      );
    const decision = ['decisions', '[]'];
    expect((at('facts', 'path') as Enum).enum).toEqual([...MERGE_PATHS]);
    expect(at('sweep', ...decision, 'action')?.enum).toEqual([...SWEEP_ACTIONS]);
    expect(at('sweep', ...decision, 'class')?.enum).toEqual([...POLICY_CLASSES]);
    expect(at('sweep', ...decision, 'attention', 'choices', '[]', 'effect')?.enum).toEqual([...MERGE_EFFECTS]);
    expect(at('sweep', ...decision, 'attention', 'recommendation', 'confidence')?.enum).toEqual([...CONFIDENCES]);
    expect(at('sweep', 'dev', 'state')?.enum).toEqual([...DEV_STATES]);
    expect(at('sweep', 'dev', 'rerun')?.enum).toEqual([...RERUNS]);
    expect(at('sweep', 'dev', 'attention', 'choices', '[]', 'effect')?.enum).toEqual([...DEV_EFFECTS]);
    expect(at('record', 'class')?.enum).toEqual(['', ...MERGE_ASKED_BY]);
    expect(at('ruling', 'decision')?.enum).toEqual([...MERGE_EFFECTS, ...DEV_EFFECTS]);
  });
});

// --- the scripts, run as the engine runs them --------------------------------------

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');

interface Install {
  readonly checkout: string;
  readonly env: Record<string, string>;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** A checkout whose remote's default branch lists `Maintainer`, and an empty Archon home. */
function install(): Install {
  const checkout = gitCheckout({}, track);
  git(checkout, 'checkout', '-q', 'dev');
  mkdirSync(join(checkout, '.archon/sdlc/policy'), { recursive: true });
  writeFileSync(join(checkout, '.archon/sdlc/policy/maintainers.json'), '["Maintainer"]\n');
  git(checkout, 'add', '.archon/sdlc/policy/maintainers.json');
  git(checkout, 'commit', '-q', '-m', 'maintainers');
  git(checkout, 'push', '-q', 'upstream', 'HEAD:dev');
  git(checkout, 'checkout', '-q', 'feature');
  const home = track(mkdtempSync(join(tmpdir(), 'archon-merge-home-')));
  return {
    checkout,
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout },
  };
}

function inProcess<T>(at: Install, body: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, at.env, { ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]) });
  try {
    return body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function seed(at: Install, doc: WorkItem): void {
  inProcess(at, () => {
    expect(statePut('work/7', doc, stateGet('work/7').revision)).toBe('ok');
  });
}

function stored(at: Install): { revision: number; value: WorkItem | null } {
  return inProcess(at, () => {
    const read = stateGet('work/7');
    return { revision: read.revision, value: read.value === null ? null : parseWorkItem(read.value) };
  });
}

/** The pull request the GraphQL reads report, and what a merge does to it. */
interface FakePr {
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly headRefOid?: string;
  readonly checks?: 'green' | 'red';
  readonly threads?: number;
}

/**
 * Answers the gate's GraphQL reads and `gh pr merge` in front of the harness's fake gh,
 * logging each call it answers to `{ARTIFACTS}/forge-gh.log`.
 */
function forgePreload(pr: FakePr): string {
  return `
const forgePr = { state: 'OPEN', headRefOid: ${JSON.stringify(HEAD)}, checks: 'green', threads: 0, mergeCommit: null, ...${JSON.stringify(pr)} };
const harness = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] !== 'gh') return harness(argv, settings);
  const out = (exitCode, stdout = '', stderr = '') => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  const query = argv.find(part => String(part).startsWith('query=')) ?? '';
  const answered = () => appendFileSync('{ARTIFACTS}/forge-gh.log', argv.slice(1, 3).join(' ') + ' ' + argv.slice(3).filter(part => !String(part).startsWith('query=')).join(' ') + '\\n');
  const rollup = { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: forgePr.checks === 'green' ? 'SUCCESS' : 'FAILURE' }] } };
  if (argv[1] === 'pr' && argv[2] === 'merge') {
    answered();
    if (argv[argv.indexOf('--match-head-commit') + 1] !== forgePr.headRefOid) return out(1, '', 'Head branch was modified');
    forgePr.state = 'MERGED';
    forgePr.mergeCommit = '3333333333333333333333333333333333333333';
    return out(0);
  }
  if (argv[1] === 'api' && argv[2] === 'graphql' && query.includes('pullRequest(number')) {
    answered();
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev' }, pullRequest: {
      url: ${JSON.stringify(PR_URL)}, title: 'Fix the thing', state: forgePr.state, isDraft: false,
      baseRefName: 'dev', headRefName: 'feature', headRefOid: forgePr.headRefOid, mergeable: 'MERGEABLE',
      additions: 10, deletions: 2, changedFiles: 2,
      mergeCommit: forgePr.mergeCommit === null ? null : { oid: forgePr.mergeCommit },
      commits: { nodes: [{ commit: { oid: forgePr.headRefOid, statusCheckRollup: rollup } }] },
      reviewThreads: { totalCount: forgePr.threads, nodes: Array.from({ length: forgePr.threads }, () => ({ isResolved: false, comments: { nodes: [{ url: 'thread' }] } })) },
    } } } }));
  }
  if (argv[1] === 'api' && argv[2] === 'graphql' && query.includes('defaultBranchRef { name target')) {
    answered();
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev', target: { oid: ${JSON.stringify(OLD)}, statusCheckRollup: rollup } } } } }));
  }
  return harness(argv, settings);
} });
`;
}

const REVIEWED: GhCommentRow = { id: 1, author: 'Maintainer', body: reviewCommentBody(HEAD, true, '# Review report') };

function run(
  at: Install,
  script: 'facts' | 'gate' | 'record' | 'ruling',
  inputs: Record<string, string>,
  options: { pr?: FakePr; comments?: readonly GhCommentRow[]; args?: readonly string[]; artifacts?: Record<string, string> } = {}
): ScriptRun {
  return runPackScript(`merge-queue/scripts/${script}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    preload: forgePreload(options.pr ?? {}),
    gh: { issue: { number: 7, author: 'Maintainer', body: 'The contract.' }, comments: options.comments ?? [REVIEWED] },
    args: options.args,
    artifacts: options.artifacts,
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_ORDER: '',
      INPUTS_LIMIT: '10',
      INPUTS_MERGE_METHOD: 'squash',
      INPUTS_MODE: 'live',
      INPUTS_REPLAY: '[]',
      ...inputs,
    },
  });
}

function ok(result: ScriptRun): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Every GraphQL read and merge the forge preload answered. */
function forgeCalls(result: ScriptRun): string[] {
  const log = join(result.artifacts, 'forge-gh.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

function merges(result: ScriptRun): string[] {
  return forgeCalls(result).filter(call => call.startsWith('pr merge'));
}

const CLAIMED = { claim: { run_id: 'run-1', at: AT, requests: [] } };
const ITEMS = JSON.stringify([{ item: SUBJECT, pr: PR, url: PR_URL, facts: FACTS, record: null, prior_report: '', recorded: null }]);
const DEV_GREEN = { state: 'green', rerun: 'none', summary: 'green after the batch', attention: null };

const ATTENTION: MergeAttention = {
  what: 'PR 42 changes the SDLC pack; merge it?',
  why: 'Merging changes every pack run; holding it leaves the fix out.',
  recommendation: { choice: 'merge', why: 'reviewed Ready', evidence: 'the review report', confidence: 'medium', would_change: 'a failing bench' },
  choices: [
    { id: 'merge', label: 'Merge it', does: 'merges it once the gate passes at this head', effect: 'merge', ruling: '' },
    { id: 'return', label: 'Rework it', does: 'sends it back to the build queue', effect: 'return', ruling: 'Keep the old prompt wording.' },
    { id: 'park', label: 'Park it', does: 'stops working it', effect: 'park', ruling: '' },
  ],
  if_unanswered: 'It waits; nothing else is blocked.',
  links: [PR_URL],
};

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
  return { number: 42, action: 'merged', class: 'clear', head: HEAD, synced: false, reran: false, reason: 'a small fix', brief: '', attention: null, ...overrides };
}

function recordInputs(decisions: readonly Record<string, unknown>[], dev: Record<string, unknown> = DEV_GREEN): Record<string, string> {
  return {
    INPUTS_PATH: 'sweep',
    INPUTS_ITEMS: ITEMS,
    INPUTS_SETTLED: '[]',
    INPUTS_SWEEP: JSON.stringify({ decisions, review_url: '', review_prior: '', dev, summary: 'swept' }),
  };
}

const RECEIPT = { 'merge/receipts/42.json': JSON.stringify({ pr: PR_URL, head: HEAD, merge_commit: '3', at: AT }) };

describe('the merge queue scripts', () => {
  test('facts claims the items the build queue finished, reads each pull request, and leaves its review for a delta review', () => {
    const at = install();
    seed(at, item());
    const picked = run(at, 'facts', {});
    const output = ok(picked) as { path: string; items: { facts: PrFacts; prior_report: string }[]; gate: string };
    expect(output.path).toBe('sweep');
    expect(output.items[0]?.facts.verdict).toEqual({ state: 'ready', reviewed: HEAD, url: `${PR_URL}#issuecomment-1` });
    expect(readFileSync(output.items[0]?.prior_report ?? '', 'utf8')).toBe('# Review report');
    expect(readFileSync(join(picked.artifacts, 'merge/42/review/reviewed-head'), 'utf8')).toBe(`${HEAD}\n`);
    expect(output.gate).toContain('gate.ts');
    expect(stored(at).value?.claim?.run_id).toBe('run-1');
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: '{"run-1":"running"}' }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('a review comment from anyone but a listed maintainer is no verdict', () => {
    const at = install();
    seed(at, item());
    const forged = { ...REVIEWED, author: 'outsider' };
    const output = ok(run(at, 'facts', {}, { comments: [forged] })) as { items: { facts: PrFacts; prior_report: string }[] };
    expect(output.items[0]?.facts.verdict.state).toBe('none');
    expect(output.items[0]?.prior_report).toBe('');
  }, 60_000);

  test('an item whose pull request merged before the sweep is settled without it', () => {
    const at = install();
    seed(at, item());
    expect(ok(run(at, 'facts', {}, { pr: { state: 'MERGED' } }))).toMatchObject({
      path: 'record',
      items: [],
      settled: [{ item: SUBJECT, pr: PR, status: 'merged' }],
    });
  }, 60_000);

  test('the gate merges pinned to the head it passed, and writes the receipt record checks', () => {
    const at = install();
    const args = ['--method', 'squash', '--receipts', '{ARTIFACTS}/merge/receipts', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const gated = run(at, 'gate', {}, { args });
    expect(ok(gated)).toEqual({ pr: PR_URL, head: HEAD, refusals: [], merge_commit: '3333333333333333333333333333333333333333' });
    expect(merges(gated)).toEqual([`pr merge 42 --repo ${PR.repo.host}/${PR.repo.path} --squash --match-head-commit ${HEAD}`]);
    expect(JSON.parse(readFileSync(join(gated.artifacts, 'merge/receipts/42.json'), 'utf8'))).toMatchObject({ head: HEAD });
  }, 60_000);

  test('the gate refuses a verdict on an older commit, a red check or an open thread, and merges nothing', () => {
    const at = install();
    const args = ['--method', 'squash', '--receipts', '{ARTIFACTS}/receipts', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const stale = run(at, 'gate', {}, { args, comments: [{ ...REVIEWED, body: reviewCommentBody(OLD, true, 'old') }] });
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ refusals: [`its Ready verdict is for ${OLD}, not its head`], merge_commit: null });
    const red = run(at, 'gate', {}, { args, pr: { checks: 'red', threads: 1 } });
    expect(JSON.parse(red.stdout).refusals).toEqual(['CI at its head is red (test)', '1 review threads are unresolved']);
    for (const result of [stale, red]) {
      expect(merges(result)).toEqual([]);
      expect(existsSync(join(result.artifacts, 'receipts'))).toBe(false);
    }
  }, 60_000);

  test('a merge the forge reads back is recorded and released; one it does not is refused before any write', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const before = stored(at).revision;
    const unmerged = run(at, 'record', recordInputs([decision({})]), { artifacts: RECEIPT });
    expect(unmerged.code).not.toBe(0);
    expect(unmerged.stderr).toContain(`the sweep says it merged ${PR_URL}, but it reads back open`);
    expect(stored(at).revision).toBe(before);

    const recorded = ok(run(at, 'record', recordInputs([decision({})]), { pr: { state: 'MERGED' }, artifacts: RECEIPT }));
    expect(recorded).toMatchObject({ merged: [42], attention: '', class: '', asked: null });
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)' }] } } });
    expect(doc.facts.merge?.decisions[0]?.reason).not.toContain('no gate receipt');
    expect(mergeWaits(doc)).toBe(false);
  }, 60_000);

  test('a return hands the item back to the build queue with its brief', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const brief = 'PR 42 has an unresolved review thread: address it.';
    ok(run(at, 'record', recordInputs([decision({ action: 'return', brief, reason: 'one open thread' })])));
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'returned' }, build: { status: 'next', brief } } });
    expect(buildWaits(doc)).toBe(true);
    expect(mergeWaits(doc)).toBe(false);
  }, 60_000);

  test('an ask keeps the claim and raises one attention item with every field and the declared choices', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const asked = ok(run(at, 'record', recordInputs([decision({ action: 'ask', class: 'unclear', attention: ATTENTION, brief: 'rework PR 42' })])));
    expect(asked).toMatchObject({
      class: 'pr',
      options: [
        { id: 'merge', label: 'Merge it' },
        { id: 'return', label: 'Rework it' },
        { id: 'park', label: 'Park it' },
      ],
      asked: { by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42' },
    });
    for (const part of [ATTENTION.what, ATTENTION.why, 'Recommendation: `merge`** (medium confidence)', ATTENTION.if_unanswered, PR_URL]) {
      expect(asked.attention).toContain(part);
    }
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'run-1' }, facts: { merge: { status: 'asking' } } });
  }, 60_000);

  test('a red default branch takes the run\'s one question, and the pull request\'s ask waits for the next sweep', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const dev = {
      state: 'red',
      rerun: 'red',
      summary: 'lint red after the batch',
      attention: { ...ATTENTION, what: 'dev is red after merging PR 40', choices: [{ id: 'hold', label: 'Hold merges', does: 'merges nothing until dev is green', effect: 'hold', ruling: '' }], recommendation: { ...ATTENTION.recommendation, choice: 'hold' } },
    };
    const raised = ok(run(at, 'record', recordInputs([decision({ action: 'ask', class: 'unclear', attention: ATTENTION })], dev)));
    expect(raised).toMatchObject({ class: 'dev', options: [{ id: 'hold', label: 'Hold merges' }], asked: { by: 'dev' } });
    expect(raised.attention).toContain('dev is red after merging PR 40');
    expect(stored(at).value).toMatchObject({
      claim: null,
      facts: { merge: { status: 'waiting', decisions: [{ decision: 'ask (not raised this run) (unclear)' }] } },
    });
  }, 60_000);

  test('a decision for a pull request the run did not claim, or one left undecided, refuses', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const extra = run(at, 'record', recordInputs([decision({ action: 'wait' }), decision({ number: 43, action: 'wait' })]));
    expect(extra.stderr).toContain('the sweep decided PR 43, which this run did not claim');
    const none = run(at, 'record', recordInputs([]));
    expect(none.stderr).toContain('the sweep left PR 42 undecided');
  }, 60_000);

  const ASKED = JSON.stringify({ by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', attention: ATTENTION });

  test("a maintainer's merge approves the pull request at the head they were asked about", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    expect(ok(run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'merge', INPUTS_TEXT: '' }))).toMatchObject({ decision: 'merge', section: '' });
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', approval: { head: HEAD } } } });
    expect(mergeWaits(doc)).toBe(true);
  }, 60_000);

  test('a return writes its ruling into the issue body and the build round starts from it', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const ruled = run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'return', INPUTS_TEXT: '' });
    const heading = ok(ruled).section as string;
    expect(heading).toMatch(/^Current scope \(maintainer ruling on the merge queue's question on PR 42, \d{4}-\d{2}-\d{2}\)$/);
    expect(ruled.bodies).toEqual([`The contract.\n\n\n## ${heading}\n\nKeep the old prompt wording.\n`]);
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'returned' }, build: { status: 'next' } } });
    expect(doc.facts.build?.brief).toContain('rework PR 42');
    expect(doc.facts.build?.brief).toContain(heading);
  }, 60_000);
});

describe('eval mode', () => {
  test('decides the replayed pull requests from their recorded facts and claims, reads and writes nothing', () => {
    const at = install();
    seed(at, item());
    const before = stored(at).revision;
    const replay = [{ number: 42, at: AT, facts: 'verdict ready at head; CI green; 0 threads' }];
    const facts = run(at, 'facts', { INPUTS_MODE: 'eval', INPUTS_REPLAY: JSON.stringify(replay) });
    expect(ok(facts)).toMatchObject({
      path: 'sweep',
      base: null,
      gate: '',
      items: [{ item: null, pr: PR, url: PR_URL, facts: null, recorded: { at: AT, facts: replay[0]?.facts } }],
    });
    const items = JSON.stringify([{ item: null, pr: PR, url: PR_URL, facts: null, record: null, prior_report: '', recorded: replay[0] }]);
    const recorded = run(at, 'record', {
      ...recordInputs([decision({ action: 'ask', class: 'unclear', attention: ATTENTION })], { state: 'unchecked', rerun: 'none', summary: '', attention: null }),
      INPUTS_MODE: 'eval',
      INPUTS_ITEMS: items,
    });
    expect(ok(recorded)).toMatchObject({
      attention: '',
      asked: null,
      evaluation: { decisions: [{ number: 42, action: 'ask' }], asked: 'pr' },
    });
    for (const result of [facts, recorded]) expect([...result.gh, ...forgeCalls(result)]).toEqual([]);
    expect(stored(at).revision).toBe(before);
  }, 60_000);
});
