import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { type BuildRecord, buildWaits } from '../../workflows/sdlc/.shared/build';
import {
  checksOf,
  BASE_EFFECTS,
  gateRefusals,
  MERGE_ASKED_BY,
  MERGE_EFFECTS,
  MERGE_PATHS,
  type MergeAttention,
  type MergeRecord,
  type MergeSettled,
  mergeWaits,
  POLICY_CLASSES,
  type PrFacts,
  prFromUrl,
  SWEEP_ACTIONS,
  UNREADABLE,
} from '../../workflows/sdlc/.shared/merge';
import { MERGE_QUEUE_SELECTIONS } from '../../workflows/sdlc/.shared/launch';
import { checkAttention, CONFIDENCES, withOther } from '../../workflows/sdlc/.shared/queue';
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

function parkedOwn() {
  return {
    ...newWorkItem(PR, AT),
    facts: {
      own_pr: { url: PR_URL, at: AT },
      merge: {
        ...merge('parked'),
        approval: { head: HEAD, at: AT },
        decisions: [{
          at: LATER, run_id: 'old-run', decision: 'answered: park', reason: 'hold', links: [], head: HEAD, reran: false,
          answer: { choice: 'park', text: 'repair it', at: LATER },
        }],
      },
    },
  } satisfies WorkItem;
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

const BASE = { head: OLD, checks: { state: 'green', failing: [], pending: [] } } as const;

describe('the merge record and the gate', () => {
  test('an item waits once the build queue finished it, until the merge queue settles it', () => {
    expect(mergeWaits(item())).toBe(true);
    expect(mergeWaits(item({ ...BUILT, status: 'next' }))).toBe(false);
    expect(mergeWaits({ ...item(), facts: { triage: TRIAGE } })).toBe(false);
    for (const status of ['waiting', 'asking'] as const) expect(mergeWaits(item(BUILT, merge(status)))).toBe(true);
    for (const status of ['merged', 'returned', 'parked'] as const) {
      expect(mergeWaits(item(BUILT, merge(status)))).toBe(false);
    }
    // Later build readiness also remains possible after an earlier merge.
    for (const status of ['parked', 'returned', 'merged'] as const) {
      expect(mergeWaits(item({ ...BUILT, at: '2026-10-16T02:00:00.000Z' }, merge(status)))).toBe(true);
    }
  });

  test('the gate passes only a Ready verdict and green CI at a pinned head that contains the default branch or merges into it cleanly, on a default branch that is not red', () => {
    expect(gateRefusals(FACTS, HEAD, BASE)).toEqual([]);
    const refused = (facts: Partial<PrFacts>, head = HEAD) => gateRefusals({ ...FACTS, ...facts }, head, BASE);
    expect(refused({ verdict: { ...FACTS.verdict, reviewed: OLD } })).toEqual([`its review verdict is for ${OLD}, not ${HEAD}`]);
    expect(refused({ verdict: { ...FACTS.verdict, state: 'unstamped' } })).toEqual(['its review verdict is unstamped']);
    expect(refused({ verdict: { state: 'not_ready', reviewed: HEAD, url: null } })).toEqual(['its review verdict is not_ready']);
    expect(refused({ checks: { state: 'pending', failing: [], pending: ['test (ubuntu)'] } })).toEqual([
      'CI at its head is pending (test (ubuntu))',
    ]);
    expect(refused({ checks: { state: 'red', failing: ['lint'], pending: [] } })).toEqual(['CI at its head is red (lint)']);
    // Whether an open thread holds the merge is the sweep's judgment, not the gate's.
    expect(refused({ threads: { unresolved: 2, urls: [] } })).toEqual([]);
    expect(refused({}, OLD)).toEqual([`its head is ${HEAD}, not ${OLD}`, `its review verdict is for ${HEAD}, not ${OLD}`]);
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
      inputs: Record<string, unknown>;
      nodes: { id: string; output_format?: Schema }[];
    };
    // A new input fails here until someone decides whether a follow-up sweep keeps it.
    expect(Object.keys(workflow.inputs).sort()).toEqual([...MERGE_QUEUE_SELECTIONS, 'repo_host', 'repo_path'].sort());
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
    expect(at('sweep', 'base', 'attention', 'choices', '[]', 'effect')?.enum).toEqual([...BASE_EFFECTS]);
    expect(at('record', 'class')?.enum).toEqual(['', ...MERGE_ASKED_BY]);
    expect(at('ruling', 'decision')?.enum).toEqual([...MERGE_EFFECTS, ...BASE_EFFECTS]);
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
  /** Fail every pull request read, or only the listed pull requests. */
  readonly unreadable?: boolean | readonly number[];
  /** Every pull request read after a merge fails. */
  readonly unreadableAfterMerge?: boolean;
  /** `gh pr merge` succeeds and the pull request stays open, as when the forge queues merges. */
  readonly queuesMerge?: boolean;
  /** Commits of the default branch the head lacks. */
  readonly behind?: number;
  /** The head conflicts with the default branch. */
  readonly conflicts?: boolean;
  /** CI on the default branch's head; green when unset. */
  readonly baseChecks?: 'green' | 'red' | 'pending';
  /** Pull requests, by number, that read back merged whatever `state` says. */
  readonly merged?: readonly number[];
  readonly closed?: readonly number[];
  /** What `gh pr list --author` reports open. */
  readonly ownPrs?: readonly { number: number; url: string; isDraft: boolean }[];
  /** `gh pr list --author` fails. */
  readonly ownPrsFail?: boolean;
  readonly baseUnreadable?: boolean;
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
  const rollupOf = state => ({ contexts: { totalCount: 1, nodes: [state === 'pending' ? { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null } : { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: state === 'green' ? 'SUCCESS' : 'FAILURE' }] } });
  const rollup = rollupOf(forgePr.checks);
  if (argv[1] === 'pr' && argv[2] === 'list') {
    answered();
    if (forgePr.ownPrsFail) return out(1, '', 'HTTP 502');
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
    appendFileSync('{ARTIFACTS}/forge-gh.log', 'snapshot\\n');
    const number = Number(String(argv.find(part => String(part).startsWith('number=')) ?? 'number=42').slice('number='.length));
    if (forgePr.unreadable === true || Array.isArray(forgePr.unreadable) && forgePr.unreadable.includes(number)) return out(1, '', 'HTTP 502');
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev' }, pullRequest: {
      url: ${JSON.stringify(PR_URL.replace(/42$/, ''))} + number, title: 'Fix the thing',
      state: (forgePr.merged ?? []).includes(number) ? 'MERGED' : (forgePr.closed ?? []).includes(number) ? 'CLOSED' : forgePr.state, isDraft: false,
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
    if (forgePr.baseUnreadable) return out(1, '', 'HTTP 502 reading base');
    return out(0, JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev', target: { oid: ${JSON.stringify(OLD)}, statusCheckRollup: rollupOf(forgePr.baseChecks ?? 'green') } } } } }));
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
  options: { pr?: FakePr; comments?: readonly GhCommentRow[]; args?: readonly string[]; artifacts?: Record<string, string>; preload?: string } = {}
): ScriptRun {
  return runPackScript(`merge-queue/scripts/${script}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    preload: forgePreload(options.pr ?? {}) + (options.preload ?? ''),
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
const ITEMS = JSON.stringify([{ item: SUBJECT, pr: PR, url: PR_URL, facts: FACTS, record: null }]);
const BASE_GREEN = { summary: 'dev is green', reran: false, attention: null };

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
  return { number: 42, action: 'merged', class: 'clear', head: HEAD, reran: false, reason: 'a small fix', brief: '', attention: null, ...overrides };
}

const FACTS_BASE_GREEN = { branch: 'dev', head: OLD, checks: { state: 'green', failing: [], pending: [] } };
const FACTS_BASE_RED = { branch: 'dev', head: OLD, checks: { state: 'red', failing: ['test'], pending: [] } };

function recordFacts(output: Record<string, unknown>): Record<string, string> {
  return {
    INPUTS_PATH: String(output.path), INPUTS_ITEMS: JSON.stringify(output.items),
    INPUTS_SETTLED: JSON.stringify(output.settled), INPUTS_BASE: JSON.stringify(output.base),
    INPUTS_BASE_ERROR: String(output.base_error), INPUTS_SWEEP: 'null',
  };
}

function recordInputs(
  decisions: readonly Record<string, unknown>[],
  base: Record<string, unknown> = BASE_GREEN,
  factsBase: Record<string, unknown> = FACTS_BASE_GREEN
): Record<string, string> {
  return {
    INPUTS_PATH: 'sweep',
    INPUTS_ITEMS: ITEMS,
    INPUTS_SETTLED: '[]',
    INPUTS_BASE: JSON.stringify(factsBase),
    INPUTS_SWEEP: JSON.stringify({ decisions, base, summary: 'swept' }),
  };
}

// A second claimed pull request, PR 43 on work item 8, that the gate merged.
const OTHER = { repo: PR.repo, number: 8 };
const OTHER_PR = { repo: PR.repo, number: 43 };
const OTHER_URL = PR_URL.replace(/42$/, '43');
const BOTH_ITEMS = JSON.stringify([
  { item: OTHER, pr: OTHER_PR, url: OTHER_URL, facts: { ...FACTS, pr: OTHER_PR, url: OTHER_URL }, record: null },
  ...JSON.parse(ITEMS),
]);
const HOLD = { id: 'hold', label: 'Hold merges', does: 'merges nothing until dev is green', effect: 'hold', ruling: '' };
const BASE_RED = {
  summary: 'lint red on dev after a rerun',
  reran: false,
  attention: { ...ATTENTION, what: 'dev is red since PR 43 merged', choices: [HOLD], recommendation: { ...ATTENTION.recommendation, choice: 'hold' } },
};

describe('the merge queue scripts', () => {
  test('facts claims the items the build queue finished and reads each pull request', () => {
    const at = install();
    seed(at, item());
    const picked = run(at, 'facts', {});
    const output = ok(picked) as { path: string; items: { facts: PrFacts }[]; gate: string };
    expect(output.path).toBe('sweep');
    expect(output.items[0]?.facts.verdict).toEqual({ state: 'ready', reviewed: HEAD, url: `${PR_URL}#issuecomment-1` });
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

  for (const choice of ['park', 'other']) {
    test(`an own PR answered ${choice} waits again only after its head changes`, () => {
      const at = install();
      const own = { ...newWorkItem(PR, AT), ...CLAIMED, facts: { own_pr: { url: PR_URL, at: AT } } };
      seed(at, own);
      const askAt = (head: string) => {
        const inputs = recordInputs([decision({ action: 'ask', head, attention: ATTENTION })]);
        const recorded = ok(run(at, 'record', {
          ...inputs,
          INPUTS_ITEMS: JSON.stringify([{ item: PR, pr: PR, url: PR_URL, facts: { ...FACTS, head_revision: head }, record: null, own_pr: true }]),
        }, { pr: { headRefOid: head } })) as { asked: { attention: MergeAttention } };
        const choices = recorded.asked.attention.choices;
        expect(choices.find(entry => entry.id === choice)?.does).toContain('different head');
        const ruled = run(at, 'ruling', { INPUTS_ASKED: JSON.stringify(recorded.asked), INPUTS_CHOICE: choice, INPUTS_TEXT: 'repair it' });
        expect(ok(ruled)).toMatchObject({ decision: 'park', section: '' });
        expect(ruled.bodies).toEqual([]);
      };
      askAt(HEAD);
      const parked = stored(at, PR.number);
      expect(parked.value?.facts.merge?.decisions.at(-1)).toMatchObject({ decision: 'answered: park', head: HEAD, answer: { choice, text: 'repair it' } });
      expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
      expect(stored(at, PR.number)).toEqual(parked);
      const picked = run(at, 'facts', {}, { pr: { headRefOid: OLD } });
      expect(ok(picked)).toMatchObject({ path: 'sweep', items: [{ item: PR, own_pr: true, facts: { head_revision: OLD } }] });
      expect(forgeCalls(picked).filter(call => call.includes('snapshot'))).toHaveLength(1);
      askAt(OLD);
      const parkedAgain = stored(at, PR.number);
      expect(ok(run(at, 'facts', {}, { pr: { headRefOid: OLD } }))).toMatchObject({ path: 'idle' });
      expect(stored(at, PR.number)).toEqual(parkedAgain);
      expect(parkedAgain.value?.facts.build).toBeUndefined();
    }, 60_000);
  }

  test('only a latest answered own-PR park can recover; other settlements need no head read', () => {
    const at = install();
    const parked = parkedOwn();
    const prior = parked.facts.merge;
    const last = prior.decisions[0];
    const cases: MergeRecord[] = [
      { ...prior, status: 'merged' },
      { ...prior, status: 'returned' },
      ...[
        { ...last, decision: UNREADABLE },
        { ...last, decision: 'parked' },
        { ...last, decision: 'superseded', head: null, answer: undefined },
        { ...last, head: null },
        { ...last, answer: undefined },
      ].map(entry => ({ ...prior, decisions: [...prior.decisions, entry] })),
    ];
    for (const [index, record] of cases.entries()) {
      const number = 50 + index;
      seed(at, { ...parked, subject: { ...PR, number }, facts: { own_pr: { url: PR_URL.replace(/42$/, String(number)), at: AT }, merge: record } });
    }
    const picked = run(at, 'facts', {}, { pr: { headRefOid: OLD } });
    expect(ok(picked)).toMatchObject({ path: 'idle' });
    expect(forgeCalls(picked).filter(call => call === 'snapshot')).toHaveLength(0);
  }, 60_000);

  for (const failure of ['read', 'invalid URL']) {
    test(`a failed recovery ${failure} leaves the parked item untouched while other work proceeds`, () => {
      const at = install();
      const parked = parkedOwn();
      const url = failure === 'read' ? PR_URL : 'invalid';
      seed(at, { ...parked, facts: { ...parked.facts, own_pr: { url, at: AT } } });
      seed(at, { ...item({ ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, pr_url: OTHER_URL })) }), subject: OTHER });
      const before = stored(at, PR.number);
      const picked = run(at, 'facts', {}, { pr: { unreadable: [PR.number] } });
      expect(picked.code).toBe(0);
      expect(picked.stderr).toContain(url);
      expect(picked.stderr.match(/cannot reconsider/g)).toHaveLength(1);
      expect(JSON.parse(picked.stdout)).toMatchObject({ path: 'sweep', items: [{ item: OTHER }], settled: [] });
      expect(stored(at, PR.number)).toEqual(before);
      expect(forgeCalls(picked).filter(call => call === 'snapshot')).toHaveLength(failure === 'read' ? 2 : 1);
    }, 60_000);
  }

  test('recovery preserves pinned approval and limits claims in configured order', () => {
    const at = install();
    seed(at, parkedOwn());
    seed(at, { ...item(), subject: OTHER, created_at: LATER });
    const sameHead = parkedOwn();
    seed(at, {
      ...sameHead,
      created_at: '2026-10-15T00:00:00.000Z',
      subject: { ...PR, number: 1 },
      facts: {
        own_pr: { url: PR_URL.replace(/42$/, '1'), at: AT },
        merge: { ...sameHead.facts.merge, decisions: [{ ...sameHead.facts.merge.decisions[0], head: OLD }] },
      },
    });
    const picked = run(at, 'facts', { INPUTS_LIMIT: '1', INPUTS_ORDER: '["created asc"]' }, { pr: { headRefOid: OLD } });
    expect(ok(picked)).toMatchObject({ items: [{ item: PR, record: { approval: { head: HEAD, at: AT } }, facts: { head_revision: OLD } }] });
    expect(stored(at, OTHER.number).value?.claim).toBeNull();
    expect(stored(at, 1).value?.claim).toBeNull();
    expect(stored(at, PR.number).value?.claim?.run_id).toBe('run-1');
    expect(forgeCalls(picked).filter(call => call === 'snapshot')).toHaveLength(2);
  }, 60_000);

  for (const status of ['running', 'unknown', 'failed']) {
    test(`recovery respects a ${status} claim owner`, () => {
      const at = install();
      seed(at, { ...parkedOwn(), claim: { run_id: 'owner', at: AT, requests: [] } });
      const picked = run(at, 'facts', { INTAKE_RUN_STATUSES: JSON.stringify(status === 'unknown' ? {} : { owner: status }) }, { pr: { headRefOid: OLD } });
      expect(picked.code).toBe(0);
      if (status === 'unknown') expect(picked.stderr).toContain('the engine reports no status');
      else expect(picked.stderr).toBe('');
      expect(JSON.parse(picked.stdout)).toMatchObject({ path: status === 'failed' ? 'sweep' : 'idle' });
      expect(forgeCalls(picked).filter(call => call === 'snapshot')).toHaveLength(status === 'failed' ? 1 : 0);
      expect(stored(at, PR.number).value?.claim?.run_id).toBe(status === 'failed' ? 'run-1' : 'owner');
    }, 60_000);
  }

  for (const concurrent of ['edit', 'answered', 'merged', 'superseded', 'claimed', 'build', 'pr']) {
    test(`recovery rechecks a concurrent ${concurrent} before retrying a conditional claim`, () => {
      const at = install();
      const parked = parkedOwn();
      seed(at, parked);
      const prior = parked.facts.merge;
      const last = prior.decisions[0];
      const changed: WorkItem = {
        ...parked,
        trust: 'maintainer',
        ...(concurrent === 'claimed' ? { claim: { run_id: 'other-owner', at: AT, requests: [] } } : {}),
        facts: { ...parked.facts,
          ...(concurrent === 'pr' ? { own_pr: { url: OTHER_URL, at: AT } } : {}),
          ...(concurrent === 'build' ? { build: { ...BUILT, status: 'next' as const } } : {}),
          merge: { ...prior,
            status: concurrent === 'merged' ? 'merged' : 'parked',
            decisions: [...prior.decisions, ...(concurrent === 'answered' ? [{ ...last, head: OLD }] : concurrent === 'superseded' ? [{ ...last, decision: 'superseded', head: null, answer: undefined }] : [])],
          },
        },
      };
      const preload = `
const beforeClaim = Bun.spawnSync.bind(Bun);
let raced = false;
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const state = argv.indexOf('state');
  if (!raced && state >= 0 && argv[state + 1] === 'put' && argv[state + 2] === 'work/42') {
    raced = true;
    const result = beforeClaim(argv, { ...settings, stdin: Buffer.from(${JSON.stringify(JSON.stringify(changed))}) });
    if (result.exitCode !== 0) throw new Error('concurrent write failed: ' + result.stderr.toString());
  }
  return beforeClaim(argv, settings);
} });`;
      const picked = run(at, 'facts', {}, { pr: { headRefOid: OLD }, preload });
      const recovers = concurrent === 'edit' || concurrent === 'pr';
      const output = ok(picked);
      expect(output).toMatchObject({ path: recovers ? 'sweep' : 'idle' });
      if (concurrent === 'pr') expect(output).toMatchObject({ items: [{ pr: OTHER_PR, facts: { pr: OTHER_PR } }] });
      const after = stored(at, PR.number).value!;
      expect(after.trust).toBe('maintainer');
      expect(after.facts).toEqual(changed.facts);
      expect(after.claim?.run_id ?? null).toBe(recovers ? 'run-1' : concurrent === 'claimed' ? 'other-owner' : null);
      expect(forgeCalls(picked).filter(call => call === 'snapshot')).toHaveLength(concurrent === 'pr' ? 2 : 1);
    }, 60_000);
  }

  test('a failed own-PR listing is noted and the sweep still takes the existing work', () => {
    const at = install('[{ "login": "Maintainer", "merge_queue": "own-prs" }]');
    seed(at, item());
    const picked = run(at, 'facts', {}, { pr: { ownPrsFail: true } });
    expect(picked.code).toBe(0);
    expect(picked.stderr).toContain('own-PR enrollment stopped');
    const output = JSON.parse(picked.stdout) as { items: { item: { number: number } }[] };
    expect(output.items.map(entry => entry.item.number)).toEqual([7]);
  }, 60_000);

  test('a red default branch with no queued pull request still reaches the sweep, so its question can be raised', () => {
    const at = install();
    const output = ok(run(at, 'facts', {}, { pr: { baseChecks: 'red' } })) as { path: string; items: unknown[]; base: { checks: { state: string } } };
    expect(output).toMatchObject({ path: 'sweep', items: [], base_error: '', base: { checks: { state: 'red' } } });
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2' }))).toMatchObject({ path: 'idle', base_error: '' });
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
    const output = ok(run(at, 'facts', {}, { comments: [forged] })) as { items: { facts: PrFacts }[] };
    expect(output.items[0]?.facts.verdict.state).toBe('none');
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

  test('a failed base read still records a no-PR settlement and releases its claim', () => {
    const at = install();
    seed(at, item({ ...BUILT, rounds: [] }));
    const picked = run(at, 'facts', {}, { pr: { baseUnreadable: true } });
    const output = ok(picked);
    expect(output).toMatchObject({ path: 'record', base: null, base_error: 'merge-queue facts: gh api graphql failed: HTTP 502 reading base' });
    const recorded = run(at, 'record', recordFacts(output));
    expect(recorded.code).toBe(1);
    expect(recorded.stderr).toContain(String(output.base_error));
    expect(recorded.stdout).toBe('');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'parked', decisions: [{
      decision: 'parked', reason: 'the build record names no pull request',
    }] } } });
    expect(merges(picked)).toEqual([]);
    expect(merges(recorded)).toEqual([]);
  }, 60_000);

  test.each([false, true])('a failed base read preserves the whole batch, including a competing claim: %s', loseClaim => {
    const at = install();
    const builtFor = (number: number): BuildRecord => ({
      ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, pr_url: PR_URL.replace(/42$/, String(number)) })),
    });
    seed(at, item({ ...BUILT, rounds: [] }));
    seed(at, { ...item(builtFor(43)), subject: { repo: PR.repo, number: 8 } });
    seed(at, { ...item(builtFor(44)), subject: { repo: PR.repo, number: 9 } });
    seed(at, { ...item(builtFor(45)), subject: { repo: PR.repo, number: 10 } });
    seed(at, { ...item(builtFor(46)), subject: { repo: PR.repo, number: 11 } });
    const own = parkedOwn();
    seed(at, { ...own, facts: { ...own.facts, merge: { ...own.facts.merge, status: 'waiting' } } });
    const picked = run(at, 'facts', {}, { pr: { baseUnreadable: true, merged: [43], closed: [44], unreadable: [45] } });
    const output = ok(picked) as Record<string, unknown> & { settled: MergeSettled[] };
    expect(output).toMatchObject({ path: 'record', base: null, items: [
      { item: { repo: PR.repo, number: 11 }, pr: { repo: PR.repo, number: 46 }, facts: { head_revision: HEAD } },
      { item: PR, pr: PR, own_pr: true, facts: { head_revision: HEAD } },
    ] });
    expect(output.settled.map(done => [done.item.number, done.status, done.decision]).sort()).toEqual([
      [7, 'parked', 'parked'], [8, 'merged', 'merged'], [9, 'parked', 'parked'], [10, 'waiting', UNREADABLE],
    ].sort());
    let competing: WorkItem | null = null;
    if (loseClaim) {
      competing = { ...stored(at).value!, claim: { ...CLAIMED.claim, run_id: 'other-run' } };
      seed(at, competing);
    }
    const companions = [11, PR.number].map(number => stored(at, number));
    const recorded = run(at, 'record', recordFacts(output), { pr: { unreadable: true } });
    expect(recorded.code).toBe(1);
    expect(recorded.stdout).toBe('');
    expect(recorded.stderr).toContain(String(output.base_error));
    expect(recorded.stderr).toContain('every other decision is recorded');
    for (const done of output.settled) {
      if (loseClaim && done.item.number === 7) continue;
      expect(stored(at, done.item.number).value).toMatchObject({ claim: null, facts: { merge: {
        status: done.status, pr: done.pr, decisions: [{ decision: done.decision, reason: done.reason }],
      } } });
    }
    expect([11, PR.number].map(number => stored(at, number))).toEqual(companions);
    if (loseClaim) {
      expect(stored(at).value).toEqual(competing);
      expect(recorded.stderr).toContain('work/7 is no longer claimed by this run');
    }
    expect(forgeCalls(recorded)).toEqual([]);
    expect(merges(picked)).toEqual([]);
  }, 60_000);

  test('an unreadable base with an empty queue still fails record visibly', () => {
    const at = install();
    const output = ok(run(at, 'facts', {}, { pr: { baseUnreadable: true } }));
    expect(output).toMatchObject({ path: 'record', base: null, items: [], settled: [] });
    const recorded = run(at, 'record', recordFacts(output));
    expect(recorded.code).toBe(1);
    expect(recorded.stderr).toContain(String(output.base_error));
    expect(recorded.stdout).toBe('');
    expect(forgeCalls(recorded)).toEqual([]);
  }, 60_000);

  test('the gate refuses an unreadable base and merges nothing', () => {
    const at = install();
    const gated = run(at, 'gate', {}, { pr: { baseUnreadable: true }, args: [
      '--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge',
    ] });
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain('gh api graphql failed: HTTP 502 reading base');
    expect(merges(gated)).toEqual([]);
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

  test('the gate refuses a verdict given at another head, and merges nothing', () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const stale = run(at, 'gate', {}, { args, comments: [{ ...REVIEWED, body: reviewCommentBody(OLD, true, '# Review report') }] });
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).refusals).toEqual([`its review verdict is for ${OLD}, not ${HEAD}`]);
    expect(merges(stale)).toEqual([]);
  }, 60_000);

  test("the gate refuses while the default branch's CI is red, and merges nothing; pending does not hold it", () => {
    const at = install();
    const args = ['--method', 'squash', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const red = run(at, 'gate', {}, { args, pr: { baseChecks: 'red' } });
    expect(red.code).toBe(1);
    expect(JSON.parse(red.stdout).refusals).toEqual([`the default branch dev is red at ${OLD} (test)`]);
    expect(merges(red)).toEqual([]);
    const pending = run(at, 'gate', {}, { args, pr: { baseChecks: 'pending' } });
    expect(ok(pending).refusals).toEqual([]);
    expect(merges(pending)).toHaveLength(1);
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

  test('a second consecutive unreadable pull request parks, releases its claim, and leaves the rest of the batch readable', () => {
    const at = install();
    seed(at, item());
    seed(at, { ...item({ ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, pr_url: OTHER_URL })) }), subject: OTHER });
    for (const status of ['waiting', 'parked'] as const) {
      const output = ok(run(at, 'facts', {}, { pr: { unreadable: [PR.number] } })) as { path: string; items: { item: typeof SUBJECT }[]; settled: MergeSettled[] };
      expect(output).toMatchObject({ path: 'sweep', settled: [{ item: SUBJECT, pr: PR, status, decision: UNREADABLE }] });
      expect(output.items.map(entry => entry.item)).toEqual([OTHER]);
      expect(output.settled[0]?.reason).toContain('HTTP 502');
      ok(run(at, 'record', {
        ...recordInputs([decision({ number: OTHER_PR.number, action: 'wait', reason: 'CI pending' })]),
        INPUTS_ITEMS: JSON.stringify(output.items),
        INPUTS_SETTLED: JSON.stringify(output.settled),
      }));
      expect(stored(at, OTHER.number).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' } } });
      const doc = stored(at).value as WorkItem;
      expect(doc).toMatchObject({ claim: null, facts: { merge: { status } } });
      expect(doc.facts.merge?.decisions.at(-1)).toMatchObject({ decision: UNREADABLE, reason: output.settled[0]?.reason });
      expect(doc.facts.merge?.decisions).toHaveLength(status === 'waiting' ? 1 : 2);
      expect(mergeWaits(doc)).toBe(status === 'waiting');
    }
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'sweep', items: [{ item: OTHER }], settled: [] });
    const parked = stored(at).value as WorkItem;
    const readyAt = new Date(Date.parse(parked.facts.merge?.at ?? '') + 1).toISOString();
    seed(at, { ...parked, facts: { ...parked.facts, build: { ...BUILT, at: readyAt } } });
    expect(mergeWaits(stored(at).value as WorkItem)).toBe(true);
    for (const status of ['waiting', 'parked'] as const) {
      const output = ok(run(at, 'facts', {}, { pr: { unreadable: [PR.number] } })) as { settled: MergeSettled[] };
      expect(output.settled).toMatchObject([{ item: SUBJECT, status, decision: UNREADABLE }]);
      ok(run(at, 'record', {
        INPUTS_PATH: 'record', INPUTS_ITEMS: '[]', INPUTS_SETTLED: JSON.stringify(output.settled), INPUTS_SWEEP: 'null',
      }));
      expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status } } });
      expect(mergeWaits(stored(at).value as WorkItem)).toBe(status === 'waiting');
    }
  }, 60_000);

  test('a successful read and sweep decision break the consecutive unreadable sequence', () => {
    const at = install();
    seed(at, item());
    const failAndRecord = () => {
      const output = ok(run(at, 'facts', {}, { pr: { unreadable: true } })) as { settled: MergeSettled[] };
      expect(output.settled).toMatchObject([{ status: 'waiting', decision: UNREADABLE }]);
      ok(run(at, 'record', { INPUTS_PATH: 'record', INPUTS_ITEMS: '[]', INPUTS_SETTLED: JSON.stringify(output.settled), INPUTS_SWEEP: 'null' }));
    };
    failAndRecord();
    const readable = ok(run(at, 'facts', {}));
    expect(readable).toMatchObject({ path: 'sweep', settled: [] });
    ok(run(at, 'record', { ...recordInputs([decision({ action: 'wait', reason: 'CI pending' })]), INPUTS_ITEMS: JSON.stringify(readable.items) }));
    expect(stored(at).value?.facts.merge?.decisions.at(-1)?.decision).toBe('wait (clear)');
    failAndRecord();
    const doc = stored(at).value as WorkItem;
    expect(doc.claim).toBeNull();
    expect(doc.facts.merge?.decisions).toHaveLength(4);
    expect(mergeWaits(doc)).toBe(true);
  }, 60_000);

  test.each(['failed', 'cancelled', 'base read failed'] as const)('a successful PR read resets unreadability when later work %s', failure => {
    const at = install();
    seed(at, item());
    const first = ok(run(at, 'facts', {}, { pr: { unreadable: true } })) as { settled: MergeSettled[] };
    ok(run(at, 'record', { INPUTS_PATH: 'record', INPUTS_ITEMS: '[]', INPUTS_SETTLED: JSON.stringify(first.settled), INPUTS_SWEEP: 'null' }));
    const before = stored(at).value as WorkItem;
    const readable = run(at, 'facts', { WORKFLOW_ID: 'readable-run' }, { pr: { baseUnreadable: failure === 'base read failed' } });
    if (failure === 'base read failed') {
      expect(ok(readable)).toMatchObject({ path: 'record', base: null, base_error: 'merge-queue facts: gh api graphql failed: HTTP 502 reading base' });
    } else {
      expect(ok(readable)).toMatchObject({ path: 'sweep', settled: [] });
    }
    const reset = stored(at).value as WorkItem;
    expect(reset).toMatchObject({ claim: { run_id: 'readable-run' }, facts: { merge: { status: 'waiting' } } });
    expect(reset.facts.merge?.decisions.at(-1)).toMatchObject({ decision: 'readable', head: HEAD });
    expect(reset.facts.merge?.decisions[0]).toEqual(before.facts.merge?.decisions[0]);
    const next = ok(run(at, 'facts', {
      WORKFLOW_ID: 'next-run',
      INTAKE_RUN_STATUSES: JSON.stringify({ 'readable-run': failure === 'cancelled' ? 'cancelled' : 'failed' }),
    }, { pr: { unreadable: true } })) as { settled: MergeSettled[] };
    expect(next.settled).toMatchObject([{ status: 'waiting', decision: UNREADABLE }]);
    const after = stored(at).value as WorkItem;
    expect(after.facts.merge?.decisions[0]).toEqual(before.facts.merge?.decisions[0]);
    expect(after.claim?.run_id).toBe('next-run');
  }, 60_000);

  test('a claimed merge the forge does not show fails the record after every other decision is written', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const inputs = (base: Record<string, unknown>) => ({ ...recordInputs([decision({ number: 43 }), decision({})], base), INPUTS_ITEMS: BOTH_ITEMS });
    const unmerged = run(at, 'record', inputs(BASE_GREEN), { pr: { merged: [43] } });
    expect(unmerged.code).not.toBe(0);
    expect(unmerged.stderr).toContain(`the sweep says it merged ${PR_URL}, but it reads back open; every other decision is recorded`);
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)' }] } } });
    const claimed = stored(at).value as WorkItem;
    expect(claimed).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ decision: 'claimed merged, not merged (clear)' }] } } });
    expect(mergeWaits(claimed)).toBe(true);

    // Closed, not merged, under a red default branch, and PR 43's work item is no longer this run's.
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, { claim: { run_id: 'another-run', at: AT, requests: [] } }), subject: OTHER });
    const closed = run(at, 'record', inputs(BASE_RED), { pr: { state: 'CLOSED', merged: [43] } });
    expect(closed.code).not.toBe(0);
    expect(closed.stderr).toContain(`the sweep says it merged ${PR_URL}, but it reads back closed`);
    expect(closed.stderr).toContain('the default branch is red and was not raised (lint red on dev after a rerun)');
    expect(closed.stderr).toContain('PR 43: not recorded, the next sweep decides it again (work/8 is no longer claimed by this run); every other decision is recorded');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'parked' } } });
  }, 60_000);

  test('a merge the forge reads back is recorded and released at its head, whatever the sweep says', () => {
    const at = install();
    const merged = { state: 'MERGED' } as const;
    const released = { merged: [42], attention: '', class: '', asked: null };
    // Declared merged; declared at another head; merged by hand, declared wait; merged by hand under an ask.
    const cases = [
      [decision({}), BASE_GREEN],
      [decision({ head: OLD }), BASE_GREEN],
      [decision({ action: 'wait', reason: 'CI pending' }), BASE_GREEN],
      [decision({ action: 'ask', attention: ATTENTION, brief: 'rework PR 42' }), BASE_GREEN],
    ] as const;
    for (const [decided, base] of cases) {
      seed(at, item(BUILT, undefined, CLAIMED));
      expect(ok(run(at, 'record', recordInputs([decided], base), { pr: merged }))).toMatchObject(released);
      expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)', head: HEAD }] } } });
      expect(mergeWaits(stored(at).value as WorkItem)).toBe(false);
    }
  }, 60_000);

  test('a return without a brief or an ask without its question is refused: it waits, and the record fails after writing the rest', () => {
    const at = install();
    for (const [declared, refusal] of [
      [decision({ action: 'return', brief: ' ', reason: 'CI red in its test' }), 'the sweep returned pull request 42 with no brief'],
      [decision({ action: 'ask', class: 'unclear', attention: null, brief: 'rework PR 42' }), 'the sweep asked about pull request 42 with no question'],
    ] as const) {
      seed(at, item(BUILT, undefined, CLAIMED));
      const refused = run(at, 'record', recordInputs([declared]));
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(refusal);
      const doc = stored(at).value as WorkItem;
      expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' }, build: { status: 'ready' } } });
      expect(doc.facts.merge?.decisions.at(-1)?.reason).toContain(refusal);
    }
  }, 60_000);

  test('a red default branch the sweep neither reran nor raised fails the record; a rerun waits for its result', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const silent = run(at, 'record', recordInputs([decision({ action: 'wait', reason: 'dev is red' })], BASE_GREEN, FACTS_BASE_RED));
    expect(silent.code).not.toBe(0);
    expect(silent.stderr).toContain(`the default branch dev is red at ${OLD} (test), and the sweep neither reran it nor raised it`);
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' } } });
    seed(at, item(BUILT, undefined, CLAIMED));
    ok(run(at, 'record', recordInputs([decision({ action: 'wait', reason: 'dev is red; reran' })], { ...BASE_GREEN, reran: true }, FACTS_BASE_RED)));
  }, 60_000);

  test('a red default branch with no pull request waiting raises its hold question', () => {
    const at = install();
    const inputs = { ...recordInputs([], BASE_RED, FACTS_BASE_RED), INPUTS_ITEMS: '[]' };
    const raised = ok(run(at, 'record', inputs));
    expect(raised).toMatchObject({ merged: [], class: 'base', options: [{ id: 'hold', label: 'Hold merges' }], asked: { by: 'base' } });
    expect(raised.attention).toContain('dev is red since PR 43 merged');
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

  test.each([
    { name: 'empty', brief: '', returnOnly: false },
    { name: 'whitespace-only', brief: ' \n ', returnOnly: true },
  ])('an ask with an $name brief raises its question without return effects and other parks', ({ brief, returnOnly }) => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const rework = { id: 'revise-scope', label: 'Rework it', does: 'sends it back', effect: 'return', ruling: '' } as const;
    const attention: MergeAttention = {
      ...ATTENTION,
      recommendation: { ...ATTENTION.recommendation, choice: returnOnly ? rework.id : 'merge' },
      choices: [...(returnOnly ? [] : ATTENTION.choices), rework],
    };
    const output = ok(run(at, 'record', {
      ...recordInputs([decision({ action: 'ask', class: 'unclear', attention, brief }), decision({ number: 43 })]),
      INPUTS_ITEMS: BOTH_ITEMS,
    }, { pr: { merged: [43] } })) as {
      attention: string;
      options: { id: string; label: string }[];
      asked: { attention: MergeAttention };
    };
    expect(output).toMatchObject({ merged: [43], class: 'pr', asked: { by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief } });
    const prepared = output.asked.attention;
    expect(prepared.choices.map(choice => choice.effect)).not.toContain('return');
    expect(prepared.choices.map(choice => choice.id)).toEqual(returnOnly ? ['other'] : ['merge', 'park', 'other']);
    expect(prepared.choices.find(choice => choice.id === 'other')).toMatchObject({ effect: 'park' });
    expect(output.options).toEqual(prepared.choices.map(({ id, label }) => ({ id, label })));
    expect(() => checkAttention(prepared)).not.toThrow();
    if (returnOnly) {
      expect(prepared.recommendation.choice).toBe('other');
      expect(prepared.recommendation).toMatchObject({
        evidence: 'Return is unavailable because the sweep supplied no build brief.',
        confidence: 'high',
        would_change: 'A nonblank build brief would make return available.',
      });
      expect(output.attention).toContain(prepared.why);
      expect(output.attention).toContain('Recommendation: `other`** (high confidence)');
      expect(output.attention).toContain('Evidence: Return is unavailable because the sweep supplied no build brief.');
      expect(output.attention).toContain('What would change it: A nonblank build brief would make return available.');
    } else expect(prepared.recommendation).toEqual(attention.recommendation);
    for (const part of [attention.what, attention.why, PR_URL, 'no build brief']) {
      expect(output.attention).toContain(part);
    }
    if (returnOnly) expect(output.attention).toContain('Recommendation: `other`');
    expect(output.attention).not.toContain('`revise-scope` (Rework it)');
    expect(output.attention).toContain('until the build queue readies the item again');
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'run-1' }, facts: { merge: { status: 'asking' } } });
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged' } } });

    const calls = join(at.checkout, 'calls.jsonl');
    const words = 'Hold this while I reconsider the scope.';
    const ruled = run(at, 'ruling', {
      INPUTS_ASKED: JSON.stringify(output.asked), INPUTS_CHOICE: 'other', INPUTS_TEXT: words, ARCHON_CALL_LOG: calls,
    });
    expect(ok(ruled).decision).toBe('park');
    expect(ruled.bodies[0]).toContain(words);
    expect(stored(at).value).toMatchObject({
      claim: null,
      facts: { build: { status: 'ready' }, merge: { status: 'parked', decisions: expect.arrayContaining([
        expect.objectContaining({ answer: expect.objectContaining({ choice: 'other', text: words }) }),
      ]) } },
    });
    expect(launchOf(calls)).toBeUndefined();
  }, 60_000);

  test.each([
    { recommended: 'merge', brief: '', name: 'merge with an empty brief' },
    { recommended: 'return', brief: '', name: 'return with an empty brief' },
    { recommended: 'return', brief: ' \n ', name: 'return with a whitespace-only brief' },
    { recommended: 'return', brief: 'Rework PR 42.', name: 'return with a nonblank brief' },
  ])("an own pull request's ask recommending $name offers no return and its other parks", ({ recommended, brief }) => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const own = JSON.stringify(JSON.parse(ITEMS).map((entry: Record<string, unknown>) => ({ ...entry, own_pr: true })));
    const attention = { ...ATTENTION, recommendation: { ...ATTENTION.recommendation, choice: recommended } };
    const inputs = recordInputs([decision({ action: 'ask', class: 'unclear', attention, brief })]);
    const asked = ok(run(at, 'record', { ...inputs, INPUTS_ITEMS: own })) as { attention: string; asked: { attention: MergeAttention } };
    expect(() => checkAttention(asked.asked.attention)).not.toThrow();
    expect(asked.asked.attention.recommendation.choice).toBe(recommended === 'return' ? 'other' : recommended);
    if (recommended === 'return') {
      const prepared = asked.asked.attention;
      expect(prepared.recommendation).toMatchObject({
        evidence: 'Return is unavailable because no build round owns this pull request.',
        confidence: 'high',
        would_change: 'A build round owning this pull request and a nonblank build brief would make return available.',
      });
      expect(asked.attention).toContain(prepared.why);
      expect(asked.attention).toContain('Recommendation: `other`** (high confidence)');
      expect(asked.attention).toContain('Evidence: Return is unavailable because no build round owns this pull request.');
      expect(asked.attention).toContain('What would change it: A build round owning this pull request and a nonblank build brief would make return available.');
    } else expect(asked.asked.attention.recommendation).toEqual(attention.recommendation);
    expect(asked.asked.attention.choices.map(choice => choice.effect)).not.toContain('return');
    expect(asked.asked.attention.choices.find(choice => choice.id === 'other')?.effect).toBe('park');
  }, 60_000);

  test('an own pull request is never handed to the build queue: a return waits for the next sweep instead', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const own = JSON.stringify(JSON.parse(ITEMS).map((entry: Record<string, unknown>) => ({ ...entry, own_pr: true })));
    const inputs = recordInputs([decision({ action: 'return', brief: 'fix the red test', reason: 'CI red in its own test' })]);
    const held = run(at, 'record', { ...inputs, INPUTS_ITEMS: own });
    expect(held.code).not.toBe(0);
    expect(held.stderr).toContain('the sweep returned own pull request 42, which no build round owns; it waits for the next sweep');
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' }, build: { status: 'ready' } } });
    expect(doc.facts.merge?.decisions.at(-1)?.reason).toContain('the sweep returned own pull request 42, which no build round owns');
    expect(buildWaits(doc)).toBe(false);
  }, 60_000);

  test('a red default branch takes the run\'s one question, and the pull request\'s ask waits for the next sweep', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const inputs = recordInputs([decision({ number: 43 }), decision({ action: 'ask', class: 'unclear', attention: ATTENTION, brief: 'rework PR 42' })], BASE_RED);
    const raised = ok(run(at, 'record', { ...inputs, INPUTS_ITEMS: BOTH_ITEMS }, { pr: { merged: [43] } }));
    expect(raised).toMatchObject({ merged: [43], class: 'base', options: [{ id: 'hold', label: 'Hold merges' }], asked: { by: 'base' } });
    expect(raised.attention).toContain('dev is red since PR 43 merged');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ decision: 'ask (not raised this run) (unclear)' }] } } });
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged' } } });
  }, 60_000);

  test('a decision for a pull request the run did not claim is noted and skipped, and the rest is still recorded', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const extra = run(at, 'record', recordInputs([decision({ number: 7, action: 'merged' }), decision({ action: 'wait', reason: 'CI pending' })]));
    expect(extra.code).toBe(0);
    expect(extra.stderr).toContain('the sweep decided PR 7, which this run did not claim; not recorded');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ reason: 'CI pending' }] } } });
  }, 60_000);

  const ASKED = JSON.stringify({ by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', attention: ATTENTION });
  const SELECTED = { INPUTS_ORDER: '["created asc"]', INPUTS_LIMIT: '2', INPUTS_MERGE_METHOD: 'merge' };
  const launchOf = (calls: string): string[] | undefined =>
    readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');

  test("a maintainer's merge approves the pull request at the head they were asked about", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(ok(run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'merge', INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls }))).toMatchObject({ decision: 'merge', section: '' });
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', approval: { head: HEAD } } } });
    expect(mergeWaits(doc)).toBe(true);
    // The approval is acted on at once: a sweep starts on the answered run's config and input selections.
    expect(launchOf(calls)).toEqual(
      expect.arrayContaining(['archon-merge-queue', 'order=["created asc"]', 'limit=2', 'merge_method=merge', '--config-from-run', 'run-1', '--detach'])
    );
  }, 60_000);

  test('a return writes its ruling into the issue body and the build round starts from it', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const ruled = run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'return', INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls });
    const heading = ok(ruled).section as string;
    expect(heading).toMatch(/^Current scope \(maintainer ruling on the merge queue's question on PR 42, \d{4}-\d{2}-\d{2}\)$/);
    // The returned round starts at once on the build queue's own selections: no merge-queue selection crosses over.
    const launch = launchOf(calls);
    expect(launch).toEqual(expect.arrayContaining(['archon-build-queue', 'number=7', '--config-from-run', 'run-1', '--detach']));
    expect(launch?.filter(arg => /^(order|limit|merge_method)=/.test(arg))).toEqual([]);
    expect(ruled.bodies).toEqual([`The contract.\n\n\n## ${heading}\n\nKeep the old prompt wording.\n`]);
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'returned' }, build: { status: 'next' } } });
    expect(doc.facts.build?.brief).toContain('rework PR 42');
    expect(doc.facts.build?.brief).toContain(heading);
  }, 60_000);

  test("an answer on an own pull request writes no issue body and still applies its effect", () => {
    const at = install();
    const own = { repo: PR.repo, number: PR.number };
    seed(at, { ...item(undefined, merge('asking'), CLAIMED), subject: own });
    const asked = JSON.stringify({ by: 'pr', item: own, pr: PR, head: HEAD, brief: '', attention: withOther(ATTENTION, 'park') });
    const ruled = run(at, 'ruling', { INPUTS_ASKED: asked, INPUTS_CHOICE: 'other', INPUTS_TEXT: 'I will fix R1 on the branch.' });
    expect(ok(ruled)).toMatchObject({ decision: 'park', section: '' });
    expect(ruled.bodies).toEqual([]);
    expect(stored(at, PR.number).value?.facts.merge?.decisions.at(-1)?.answer?.text).toBe('I will fix R1 on the branch.');
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
