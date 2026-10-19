import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
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
import { CONFIDENCES, withOther } from '../../workflows/sdlc/.shared/queue';
import { REVIEW_MARKER, readReviewStamp, reviewCommentBody } from '../../workflows/sdlc/.shared/review-comment';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import { newWorkItem, parseWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { type GhCommentRow, gitCheckout, hostCli, PACK, packScriptRunner, PR, PR_URL, type ScriptRun } from './deliver-checks-harness';

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
  default_head: OLD,
  behind: 0,
  head: 'feature',
  head_revision: HEAD,
  merge_commit: null,
  mergeable: 'clean',
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

  test('the gate passes only a Ready verdict, green CI and no open thread, at a pinned head that contains the default branch or merges into it cleanly', () => {
    expect(gateRefusals(FACTS, HEAD)).toEqual([]);
    const refused = (facts: Partial<PrFacts>, head = HEAD) => gateRefusals({ ...FACTS, ...facts }, head);
    // Which commit the Ready verdict is for is the sweep's judgment, not the gate's.
    expect(refused({ verdict: { ...FACTS.verdict, reviewed: OLD } })).toEqual([]);
    expect(refused({ verdict: { ...FACTS.verdict, state: 'unstamped' } })).toEqual(['its review verdict is unstamped']);
    expect(refused({ verdict: { state: 'not_ready', reviewed: HEAD, url: null } })).toEqual(['its review verdict is not_ready']);
    expect(refused({ checks: { state: 'pending', failing: [], pending: ['test (ubuntu)'] } })).toEqual([
      'CI at its head is pending (test (ubuntu))',
    ]);
    expect(refused({ checks: { state: 'red', failing: ['lint'], pending: [] } })).toEqual(['CI at its head is red (lint)']);
    // Whether an open thread holds the merge is the sweep's judgment, not the gate's.
    expect(refused({ threads: { unresolved: 2, urls: [] } })).toEqual([]);
    expect(refused({}, OLD)).toEqual([`its head is ${HEAD}, not ${OLD}`]);
    // A head that is behind still merges when the forge reports the merge clean; the
    // default branch's CI judges the combined result.
    expect(refused({ behind: 3 })).toEqual([]);
    expect(refused({ behind: 3, mergeable: 'conflict' })).toEqual([`it lacks 3 commits of dev at ${OLD} and its merge is conflict`]);
    expect(refused({ behind: 3, mergeable: 'unknown' })).toEqual([`it lacks 3 commits of dev at ${OLD} and its merge is unknown`]);
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
    expect(() => checksOf({ contexts: { totalCount: 101, nodes: [run('COMPLETED', 'SUCCESS')] } })).toThrow(
      'the commit has 101 checks; the gate reads at most 100'
    );
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
function install(maintainers = '["Maintainer"]'): Install {
  const checkout = gitCheckout({}, track);
  git(checkout, 'checkout', '-q', 'dev');
  mkdirSync(join(checkout, '.archon/sdlc/policy'), { recursive: true });
  writeFileSync(join(checkout, '.archon/sdlc/policy/maintainers.json'), `${maintainers}\n`);
  git(checkout, 'add', '.archon/sdlc/policy/maintainers.json');
  git(checkout, 'commit', '-q', '-m', 'maintainers');
  git(checkout, 'push', '-q', 'upstream', 'HEAD:dev');
  git(checkout, 'checkout', '-q', 'feature');
  const home = track(mkdtempSync(join(tmpdir(), 'archon-merge-home-')));
  return {
    checkout,
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout, INTAKE_HOST_CLI: JSON.stringify(hostCli()) },
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
  const name = `work/${String(doc.subject.number)}`;
  inProcess(at, () => {
    expect(statePut(name, doc, stateGet(name).revision)).toBe('ok');
  });
}

function stored(at: Install, number = SUBJECT.number): { revision: number; value: WorkItem | null } {
  return inProcess(at, () => {
    const read = stateGet(`work/${String(number)}`);
    return { revision: read.revision, value: read.value === null ? null : parseWorkItem(read.value) };
  });
}

/** The pull request the GraphQL reads report, and what a merge does to it. */
interface FakePr {
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly headRefOid?: string;
  readonly checks?: 'green' | 'red';
  readonly threads?: number;
  /** The thread count the forge reports, when it is more than it returned. */
  readonly threadTotal?: number;
  /** Every pull request read fails. */
  readonly unreadable?: boolean;
  /** Every pull request read after a merge fails. */
  readonly unreadableAfterMerge?: boolean;
  /** `gh pr merge` succeeds and the pull request stays open, as when the forge queues merges. */
  readonly queuesMerge?: boolean;
  /** Commits of the default branch the head lacks. */
  readonly behind?: number;
  /** The head conflicts with the default branch. */
  readonly conflicts?: boolean;
  /** Pull requests, by number, that read back merged whatever `state` says. */
  readonly merged?: readonly number[];
  /** What `gh pr list --author` reports open. */
  readonly ownPrs?: readonly { number: number; url: string; isDraft: boolean }[];
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
  if (argv[1] === 'pr' && argv[2] === 'list') {
    answered();
    return out(0, JSON.stringify(forgePr.ownPrs ?? []));
  }
  if (argv[1] === 'pr' && argv[2] === 'merge') {
    answered();
    if (argv[argv.indexOf('--match-head-commit') + 1] !== forgePr.headRefOid) return out(1, '', 'Head branch was modified');
    if (forgePr.queuesMerge) return out(0);
    forgePr.state = 'MERGED';
    forgePr.mergeCommit = '3333333333333333333333333333333333333333';
    forgePr.unreadable = forgePr.unreadableAfterMerge === true;
    return out(0);
  }
  if (argv[1] === 'api' && argv[2] === 'graphql' && query.includes('pullRequest(number')) {
    answered();
    if (forgePr.unreadable) return out(1, '', 'HTTP 502');
    const number = Number(String(argv.find(part => String(part).startsWith('number=')) ?? 'number=42').slice('number='.length));
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev' }, pullRequest: {
      url: ${JSON.stringify(PR_URL.replace(/42$/, ''))} + number, title: 'Fix the thing',
      state: (forgePr.merged ?? []).includes(number) ? 'MERGED' : forgePr.state, isDraft: false,
      baseRefName: 'dev', headRefName: 'feature', headRefOid: forgePr.headRefOid, mergeable: forgePr.conflicts ? 'CONFLICTING' : 'MERGEABLE',
      additions: 10, deletions: 2, changedFiles: 2,
      mergeCommit: forgePr.mergeCommit === null ? null : { oid: forgePr.mergeCommit },
      commits: { nodes: [{ commit: { oid: forgePr.headRefOid, statusCheckRollup: rollup } }] },
      reviewThreads: { totalCount: forgePr.threadTotal ?? forgePr.threads, nodes: Array.from({ length: forgePr.threads }, () => ({ isResolved: false, comments: { nodes: [{ url: 'thread' }] } })) },
    } } } }));
  }
  if (argv[1] === 'api' && argv[2] === 'graphql' && query.includes('compare(headRef')) {
    answered();
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { target: { oid: ${JSON.stringify(OLD)} }, compare: { behindBy: forgePr.behind ?? 0 } } } } }));
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
const ITEMS = JSON.stringify([{ item: SUBJECT, pr: PR, url: PR_URL, facts: FACTS, record: null, prior_report: '' }]);
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

const DEV_UNCHECKED = { state: 'unchecked', rerun: 'none', summary: 'nothing merged', attention: null };

function recordInputs(decisions: readonly Record<string, unknown>[], dev: Record<string, unknown> = DEV_UNCHECKED): Record<string, string> {
  return {
    INPUTS_PATH: 'sweep',
    INPUTS_ITEMS: ITEMS,
    INPUTS_SETTLED: '[]',
    INPUTS_SWEEP: JSON.stringify({ decisions, review_url: '', review_prior: '', dev, summary: 'swept' }),
  };
}

// A second claimed pull request, PR 43 on work item 8, that the gate merged.
const OTHER = { repo: PR.repo, number: 8 };
const OTHER_PR = { repo: PR.repo, number: 43 };
const OTHER_URL = PR_URL.replace(/42$/, '43');
const BOTH_ITEMS = JSON.stringify([
  { item: OTHER, pr: OTHER_PR, url: OTHER_URL, facts: { ...FACTS, pr: OTHER_PR, url: OTHER_URL }, record: null, prior_report: '' },
  ...JSON.parse(ITEMS),
]);
const HOLD = { id: 'hold', label: 'Hold merges', does: 'merges nothing until dev is green', effect: 'hold', ruling: '' };
const DEV_RED = {
  state: 'red',
  rerun: 'red',
  summary: 'lint red after the batch',
  attention: { ...ATTENTION, what: 'dev is red after merging PR 43', choices: [HOLD], recommendation: { ...ATTENTION.recommendation, choice: 'hold' } },
};

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

  test("a maintainer who opted in gets their own open pull requests enrolled, once, and drafts and delivered ones left alone", () => {
    const at = install('[{ "login": "Maintainer", "merge_queue": "own-prs" }]');
    seed(at, item());
    const ownPrs = [
      { number: 42, url: PR_URL, isDraft: false },
      { number: 50, url: PR_URL.replace(/42$/, '50'), isDraft: false },
      { number: 51, url: PR_URL.replace(/42$/, '51'), isDraft: true },
    ];
    const picked = run(at, 'facts', {}, { pr: { ownPrs } });
    const output = ok(picked) as { items: { item: { number: number }; own_pr: boolean }[] };
    expect(output.items.map(entry => [entry.item.number, entry.own_pr])).toEqual([[7, false], [50, true]]);
    expect(stored(at, 50).value?.facts.own_pr?.url).toBe(PR_URL.replace(/42$/, '50'));
    expect(stored(at, 51).value).toBeNull();
    expect(forgeCalls(picked).filter(call => call.startsWith('pr list'))).toHaveLength(1);
  }, 60_000);

  test('without the opt-in, nobody\'s pull requests are enrolled', () => {
    const at = install();
    const picked = run(at, 'facts', {}, { pr: { ownPrs: [{ number: 50, url: PR_URL.replace(/42$/, '50'), isDraft: false }] } });
    expect(ok(picked)).toMatchObject({ path: 'idle' });
    expect(forgeCalls(picked).filter(call => call.startsWith('pr list'))).toEqual([]);
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

  test('the gate merges pinned to the head it passed', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const gated = run(at, 'gate', {}, { args });
    expect(ok(gated)).toEqual({ pr: PR_URL, head: HEAD, refusals: [], merge_commit: '3333333333333333333333333333333333333333' });
    expect(merges(gated)).toEqual([`pr merge 42 --repo ${PR.repo.host}/${PR.repo.path} --squash --match-head-commit ${HEAD}`]);
  }, 60_000);

  test('a merge whose read-back fails says it merged', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const gated = run(at, 'gate', {}, { args, pr: { unreadableAfterMerge: true } });
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain(`merged ${PR_URL} at ${HEAD}, so declare it merged, but the read-back failed`);
    expect(merges(gated)).toHaveLength(1);
  }, 60_000);

  test('a merge the forge accepts but does not make leaves no receipt, and the gate fails', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const gated = run(at, 'gate', {}, { args, pr: { queuesMerge: true } });
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain(`it reads back open at ${HEAD}, so it did not merge`);
    expect(merges(gated)).toHaveLength(1);
  }, 60_000);

  test('the gate refuses a head behind the default branch that conflicts, or a red check, and merges nothing', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const red = run(at, 'gate', {}, { args, pr: { checks: 'red', threads: 1, behind: 2, conflicts: true } });
    expect(JSON.parse(red.stdout).refusals).toEqual([
      `it lacks 2 commits of dev at ${OLD} and its merge is conflict`,
      'CI at its head is red (test)',
    ]);
    expect(merges(red)).toEqual([]);
  }, 60_000);

  test('the gate refuses two trusted review comments, or more review threads than it can read, and merges nothing', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const duplicate = run(at, 'gate', {}, { args, comments: [REVIEWED, { ...REVIEWED, id: 2 }] });
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.stdout).refusals).toEqual(['its review verdict is duplicate']);
    const truncated = run(at, 'gate', {}, { args, pr: { threads: 1, threadTotal: 101 } });
    expect(truncated.code).not.toBe(0);
    expect(truncated.stderr).toContain('has 101 review threads; the gate reads at most 100');
    for (const result of [duplicate, truncated]) {
      expect(merges(result)).toEqual([]);
    }
  }, 60_000);

  test('a pull request facts cannot read waits for the next sweep instead of stopping the batch', () => {
    const at = install();
    seed(at, item());
    const output = ok(run(at, 'facts', {}, { pr: { unreadable: true } })) as { path: string; settled: { status: string; reason: string }[] };
    expect(output).toMatchObject({ path: 'record', items: [], settled: [{ item: SUBJECT, pr: PR, status: 'waiting' }] });
    expect(output.settled[0]?.reason).toContain('HTTP 502');
    ok(run(at, 'record', { INPUTS_PATH: 'record', INPUTS_ITEMS: '[]', INPUTS_SETTLED: JSON.stringify(output.settled), INPUTS_SWEEP: 'null' }));
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' } } });
    expect(mergeWaits(doc)).toBe(true);
  }, 60_000);

  test('a claimed merge the forge does not show fails the record after every other decision is written', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const inputs = (dev: Record<string, unknown>) => ({ ...recordInputs([decision({ number: 43 }), decision({})], dev), INPUTS_ITEMS: BOTH_ITEMS });
    const unmerged = run(at, 'record', inputs(DEV_GREEN), { pr: { merged: [43] } });
    expect(unmerged.code).not.toBe(0);
    expect(unmerged.stderr).toContain(`the sweep says it merged ${PR_URL}, but it reads back open; every other decision is recorded`);
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)' }] } } });
    const claimed = stored(at).value as WorkItem;
    expect(claimed).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ decision: 'claimed merged, not merged (clear)' }] } } });
    expect(mergeWaits(claimed)).toBe(true);

    // Closed, not merged, under a red default branch, and PR 43's work item is no longer this run's.
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, { claim: { run_id: 'another-run', at: AT, requests: [] } }), subject: OTHER });
    const closed = run(at, 'record', inputs(DEV_RED), { pr: { state: 'CLOSED', merged: [43] } });
    expect(closed.code).not.toBe(0);
    expect(closed.stderr).toContain(`the sweep says it merged ${PR_URL}, but it reads back closed`);
    expect(closed.stderr).toContain('the default branch is red after the batch and was not raised (lint red after the batch)');
    expect(closed.stderr).toContain('PR 43: not recorded, the next sweep decides it again (work/8 is no longer claimed by this run); every other decision is recorded');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'parked' } } });
  }, 60_000);

  test('a merge the forge reads back is recorded and released at its head, whatever the sweep says', () => {
    const at = install();
    const merged = { state: 'MERGED' } as const;
    const released = { merged: [42], attention: '', class: '', asked: null };
    // Declared merged; declared at another head; merged by hand, declared wait; merged by hand under an ask.
    const cases = [
      [decision({}), DEV_GREEN],
      [decision({ head: OLD }), DEV_GREEN],
      [decision({ action: 'wait', reason: 'CI pending' }), DEV_UNCHECKED],
      [decision({ action: 'ask', attention: ATTENTION }), DEV_UNCHECKED],
    ] as const;
    for (const [decided, dev] of cases) {
      seed(at, item(BUILT, undefined, CLAIMED));
      expect(ok(run(at, 'record', recordInputs([decided], dev), { pr: merged }))).toMatchObject(released);
      expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)', head: HEAD }] } } });
      expect(mergeWaits(stored(at).value as WorkItem)).toBe(false);
    }
  }, 60_000);

  test('a rerun is recorded at its head, for the next sweep to read', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    ok(run(at, 'record', recordInputs([decision({ action: 'wait', reran: true, reason: 'red in untouched code; re-ran' })])));
    const record = (stored(at).value as WorkItem).facts.merge as MergeRecord;
    expect(record.decisions.at(-1)).toMatchObject({ head: HEAD, reran: true });
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
        { id: 'other', label: 'Something else' },
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
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const inputs = recordInputs([decision({ number: 43 }), decision({ action: 'ask', class: 'unclear', attention: ATTENTION })], DEV_RED);
    const raised = ok(run(at, 'record', { ...inputs, INPUTS_ITEMS: BOTH_ITEMS }, { pr: { merged: [43] } }));
    expect(raised).toMatchObject({ merged: [43], class: 'dev', options: [{ id: 'hold', label: 'Hold merges' }], asked: { by: 'dev' } });
    expect(raised.attention).toContain('dev is red after merging PR 43');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ decision: 'ask (not raised this run) (unclear)' }] } } });
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged' } } });
  }, 60_000);

  test('a decision for a pull request the run did not claim refuses, and one left undecided waits', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const extra = run(at, 'record', recordInputs([decision({ action: 'wait' }), decision({ number: 43, action: 'wait' })]));
    expect(extra.stderr).toContain('the sweep decided PR 43, which this run did not claim');
    ok(run(at, 'record', recordInputs([])));
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' } } });
  }, 60_000);

  const ASKED = JSON.stringify({ by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', attention: ATTENTION });

  test("a maintainer's merge approves the pull request at the head they were asked about", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(ok(run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'merge', INPUTS_TEXT: '', ARCHON_CALL_LOG: calls }))).toMatchObject({ decision: 'merge', section: '' });
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', approval: { head: HEAD } } } });
    expect(mergeWaits(doc)).toBe(true);
    // The approval is acted on at once: a sweep starts on the answered run's config.
    const launch = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');
    expect(launch).toEqual(expect.arrayContaining(['archon-merge-queue', '--config-from-run', 'run-1', '--detach']));
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

  test("an 'other' answer returns the pull request with its text as the ruling", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const asked = JSON.stringify({ by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', attention: withOther(ATTENTION, 'return') });
    const ruled = run(at, 'ruling', { INPUTS_ASKED: asked, INPUTS_CHOICE: 'other', INPUTS_TEXT: 'Split the contract change out first.' });
    expect(ok(ruled).decision).toBe('return');
    expect(ruled.bodies[0]).toContain("The maintainer's words: Split the contract change out first.");
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'returned' }, build: { status: 'next' } } });
  }, 60_000);
});
