import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { BuildRecord } from '../../workflows/sdlc/.shared/build';
import {
  gateRefusals,
  type MergeAsk,
  type MergeRecord,
  type MergeSettled,
  mergeWaits,
  type PrFacts,
  MERGE_QUEUE_FORGE_OPERATIONS,
  UNREADABLE,
} from '../../workflows/sdlc/.shared/merge';
import { REVIEW_MARKER, readReviewStamp, reviewCommentBody } from '../../workflows/sdlc/.shared/review-comment';
import { state } from 'archon:script';
import { newWorkItem, parseWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { type TrackerComment, gitCheckout, hostCli, packScriptRunner, PR, PR_URL, type ScriptRun } from './deliver-checks-harness';

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
  verdict: { state: 'ready', reviewed: HEAD, url: `${PR_URL}#issuecomment-1`, contract: 'complete' },
};

const BASE = { head: OLD, checks: { state: 'green', failing: [], pending: [] } } as const;
const FORGE = { mode: 'forge' } as const;
const AUTO = { manual: false, protected: [], approved: null } as const;

describe('the merge record and the gate', () => {
  test('the gate passes only a Ready verdict and green CI at a pinned head that contains the default branch or merges into it cleanly, on a default branch that is not red', () => {
    expect(gateRefusals(FACTS, HEAD, BASE, FORGE, AUTO)).toEqual([]);
    const refused = (facts: Partial<PrFacts>, head = HEAD) => gateRefusals({ ...FACTS, ...facts }, head, BASE, FORGE, AUTO);
    expect(refused({ verdict: { ...FACTS.verdict, reviewed: OLD } })).toEqual([`its review verdict is for ${OLD}, not ${HEAD}`]);
    expect(refused({ verdict: { ...FACTS.verdict, state: 'unstamped' } })).toEqual(['its review verdict is unstamped']);
    expect(refused({ verdict: { state: 'not_ready', reviewed: HEAD, url: null, contract: null } })).toEqual(['its review verdict is not_ready']);
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

  test('under the manual lane, or with a protected path changed, the gate passes only with an approval at exactly the head', () => {
    const lane = (overrides: Partial<Parameters<typeof gateRefusals>[4]>) => gateRefusals(FACTS, HEAD, BASE, FORGE, { ...AUTO, ...overrides });
    expect(lane({ manual: true })).toEqual(['the merge lane is manual and no maintainer approved it at this head']);
    expect(lane({ manual: true, approved: OLD })).toHaveLength(1);
    expect(lane({ manual: true, approved: HEAD })).toEqual([]);
    expect(lane({ protected: ['.pack/a.yaml'] })).toEqual(['it changes protected paths (.pack/a.yaml) and no maintainer approved it at this head']);
    expect(lane({ protected: ['.pack/a.yaml'], approved: HEAD })).toEqual([]);
  });

  test('a review comment carries the reviewed commit, the verdict and the contract coverage in stamped lines; an older one has none', () => {
    expect(readReviewStamp(reviewCommentBody(HEAD, true, 'complete', '# Report'))).toEqual({ reviewed: HEAD, ready: true, contract: 'complete', report: '# Report' });
    expect(readReviewStamp(reviewCommentBody(HEAD, false, 'open', '# Report'))?.ready).toBe(false);
    // Ready does not imply complete: a Ready review that left an operator check open reads back open.
    expect(readReviewStamp(reviewCommentBody(HEAD, true, 'open', '# Report'))).toMatchObject({ ready: true, contract: 'open' });
    expect(readReviewStamp(`${REVIEW_MARKER}\nReviewed commit: \`${HEAD}\`\nVerdict: ready\n\n# Report`)).toEqual({
      reviewed: HEAD,
      ready: true,
      contract: null,
      report: '# Report',
    });
    expect(readReviewStamp(`${REVIEW_MARKER}\nReviewed commit: \`${HEAD}\`\n\n# Report`)).toEqual({
      reviewed: HEAD,
      ready: null,
      contract: null,
      report: '# Report',
    });
    expect(readReviewStamp('Verdict: ready')).toBeNull();
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

/** Store the item; a claimed one takes its run's lease, as a real claim does. */
function seed(at: Install, doc: WorkItem): void {
  const name = `work/${String(doc.subject.number)}`;
  inProcess(at, () => {
    if (doc.claim !== null) process.env.WORKFLOW_ID = doc.claim.run_id;
    const lease = doc.claim === null ? {} : { lease: 'take' as const };
    expect(state.put(name, doc, { ifRevision: state.get(name).revision, ...lease }).ok).toBe(true);
  });
}

function stored(at: Install, number = SUBJECT.number): { revision: number; value: WorkItem | null } {
  return inProcess(at, () => {
    const read = state.get(`work/${String(number)}`);
    return { revision: read.revision, value: read.value === null ? null : parseWorkItem(read.value) };
  });
}

/** The pull request the forge reports, and what a merge does to it. */
interface FakePr {
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly headRefOid?: string;
  /** CI at the head; `unknown` is a forge unit state that is neither green nor pending. */
  readonly checks?: 'green' | 'red' | 'unknown';
  readonly threads?: number;
  /** Fail every pull request read, or only the listed pull requests. */
  readonly unreadable?: boolean | readonly number[];
  /** The merge is accepted and the pull request stays open, as when the forge queues merges. */
  readonly queuesMerge?: boolean;
  /** The merge is applied but names no landed commit, which the contract allows. */
  readonly landsNoCommit?: boolean;
  /** Commits of the default branch the head lacks. */
  readonly behind?: number;
  /** The head conflicts with the default branch. */
  readonly conflicts?: boolean;
  /** CI on the default branch's head; green when unset. */
  readonly baseChecks?: 'green' | 'red' | 'pending';
  /** Pull requests, by number, that read back merged whatever `state` says. */
  readonly merged?: readonly number[];
  readonly baseUnreadable?: boolean;
  /** Merge-queue operations the forge plugin's metadata leaves out. */
  readonly missingOps?: readonly string[];
  /** The head `pr.merge-state` reports, when it answers about another commit than `pr.view`. */
  readonly mergeStateHead?: string;
  /** The revision `checks.state` reports, when it answers about another commit than `pr.view`. */
  readonly checksRevision?: string;
  /** The paths `pr.files` reports the pull request changes. */
  readonly files?: readonly string[];
}

/**
 * Answers the merge queue's `archon forge` operations through the fake archon command,
 * logging each call it answers to `{ARTIFACTS}/forge-gh.log`.
 */
function forgePreload(pr: FakePr): string {
  return `
const forgePr = { state: 'OPEN', headRefOid: ${JSON.stringify(HEAD)}, checks: 'green', threads: 0, mergeCommit: null, ...${JSON.stringify(pr)} };
const harness = Bun.spawnSync.bind(Bun);
const forgeOp = (op, request) => {
  appendFileSync('{ARTIFACTS}/forge-gh.log', 'forge ' + op + (op === 'pr.merge' ? ' ' + request.method + ' ' + request.conditions.head : '') + '\\n');
  const out = (ok, value) => ({ exitCode: ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(ok ? { operationId: 'op', ok, result: { op, value } } : { operationId: 'op', ok, ...value })), stderr: Buffer.from('') });
  const failed = (message, mutation) => out(false, { error: { kind: 'forge_error', message }, ...(mutation ? { mutation } : {}) });
  const ref = request.ref ?? request.subject?.ref ?? request.selector?.ref;
  const units = state => [{ unit: { kind: 'check', id: '1', name: 'test' }, state }];
  const state = () => (forgePr.merged ?? []).includes(ref.number) ? 'merged' : forgePr.state.toLowerCase();
  const unreadable = () => forgePr.unreadable === true || Array.isArray(forgePr.unreadable) && forgePr.unreadable.includes(ref.number);
  // The harness's forge resolves a pull request URL.
  if (op === 'resolve') return null;
  if (op === 'check') {
    const unsupported = request.operations.filter(name => (forgePr.missingOps ?? []).includes(name));
    return unsupported.length === 0 ? out(true, request) : out(false, { error: { kind: 'unsupported_op', message: 'plugin fake does not support ' + unsupported.join(', ') }, unsupported });
  }
  if (op === 'checks.commit') return forgePr.baseUnreadable ? failed('HTTP 502 reading base') : out(true, { repo: request.repo, branch: 'dev', revision: ${JSON.stringify(OLD)}, units: units(forgePr.baseChecks ?? 'green') });
  if (op === 'pr.merge') {
    if (request.conditions.head !== forgePr.headRefOid) return failed('Head branch was modified', { op, target: ref, outcome: 'refused' });
    if (forgePr.queuesMerge) return failed('the pull request reads back open', { op, target: ref, outcome: 'verification_failed', leaveBehind: 'a queued merge' });
    forgePr.state = 'MERGED';
    forgePr.mergeCommit = '3333333333333333333333333333333333333333';
    return out(true, { target: ref, outcome: 'applied', changed: true, method: request.method, conditions: request.conditions, enforcedConditions: ['head'], landed: { commit: forgePr.landsNoCommit ? null : forgePr.mergeCommit, tree: null, parents: null } });
  }
  if (unreadable()) return failed('HTTP 502');
  if (op === 'pr.view') {
    appendFileSync('{ARTIFACTS}/forge-gh.log', 'snapshot\\n');
    const url = ${JSON.stringify(PR_URL.replace(/42$/, ''))} + ref.number;
    return out(true, { title: 'Fix the thing', body: '', pr: { schemaVersion: 1, repo: ref.repo, number: ref.number, url, head: 'feature', base: 'dev', is_draft: false, state: state(), head_repo: ref.repo, head_revision: forgePr.headRefOid, base_revision: null, maintainer_can_modify: null } });
  }
  if (op === 'pr.merge-state') return out(true, { ref, head_revision: forgePr.mergeStateHead ?? forgePr.headRefOid, default_branch: 'dev', default_revision: ${JSON.stringify(OLD)}, behind: forgePr.behind ?? 0, mergeable: forgePr.conflicts ? 'conflict' : 'clean', merge_commit: state() === 'merged' ? forgePr.mergeCommit : null });
  if (op === 'checks.state') return out(true, { ref, revision: forgePr.checksRevision ?? forgePr.headRefOid, units: units(forgePr.checks) });
  if (op === 'pr.files') return out(true, { ref, head_revision: forgePr.headRefOid, files: (forgePr.files ?? []).map(path => ({ path, previous_path: null, status: 'modified', patch: null })) });
  if (op === 'pr.threads') return out(true, { ref, threads: Array.from({ length: forgePr.threads }, (_, index) => ({ id: 'thread-' + index, resolved: false, comments: [{ url: 'thread' }] })) });
  if (op === 'workitem.comments') return out(true, { comments: comments.filter(row => row.issue === undefined).map(row => ({
    id: String(row.id), body: row.body, url: ${JSON.stringify(PR_URL)} + '#issuecomment-' + row.id,
    author: row.author === undefined ? null : { host: ref.repo.host, id: '1', login: row.author },
  })) });
  // Issue reads and writes go to the harness's stateful fake forge.
  return null;
};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[1] === ${JSON.stringify(FAKE_ARCHON)} && argv[2] === 'forge') return forgeOp(argv[3], JSON.parse(readFileSync(argv[argv.indexOf('--data-file') + 1], 'utf8'))) ?? harness(argv, settings);
  return harness(argv, settings);
} });
`;
}

const REVIEWED: TrackerComment = { id: 1, author: 'Maintainer', body: reviewCommentBody(HEAD, true, 'complete', '# Review report') };

function run(
  at: Install,
  script: 'facts' | 'merge' | 'record' | 'ruling',
  inputs: Record<string, string>,
  options: { pr?: FakePr; comments?: readonly TrackerComment[]; args?: readonly string[]; artifacts?: Record<string, string>; preload?: string } = {}
): ScriptRun {
  return runPackScript(`merge-queue/scripts/${script}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    preload: forgePreload(options.pr ?? {}) + (options.preload ?? ''),
    tracker: { issue: { number: 7, author: 'Maintainer', body: 'The contract.' }, comments: options.comments ?? [REVIEWED] },
    args: options.args,
    artifacts: options.artifacts,
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_LIMIT: '10',
      INPUTS_MERGE_LANE: 'auto',
      INPUTS_PROTECTED_PATHS: '',
      INPUTS_MERGE_METHOD: 'squash',
      INPUTS_CI: 'forge',
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
  return forgeCalls(result).filter(call => call.startsWith('forge pr.merge '));
}

const CLAIMED = { claim: { run_id: 'run-1', at: AT, requests: [] } };
const ITEMS = JSON.stringify([{ item: SUBJECT, pr: PR, url: PR_URL, facts: FACTS, record: null }]);
const BASE_GREEN = { summary: 'dev is green' };

const QUESTION: MergeAsk = {
  question: `PR 42 changes the SDLC pack; merge it?\n\nMerging changes every pack run; holding it leaves the fix out.\n\n${PR_URL}`,
  options: [
    { id: 'merge', label: 'Merge it', does: 'merges it once the gate passes at this head', value: { effect: 'merge', ruling: '' } },
    { id: 'return', label: 'Rework it', does: 'sends it back to the build queue', value: { effect: 'return', ruling: 'Keep the old prompt wording.' } },
    { id: 'park', label: 'Park it', does: 'stops working it', value: { effect: 'park', ruling: '' } },
  ],
  recommendation: { option: 'merge', why: 'reviewed Ready', confidence: 'medium' },
};

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
  return { number: 42, action: 'merge', class: 'clear', head: HEAD, reran: false, reason: 'a small fix', brief: '', ask: null, ...overrides };
}

const FACTS_BASE_GREEN = { branch: 'dev', head: OLD, checks: { state: 'green', failing: [], pending: [] } };
const FACTS_BASE_RED = { ...FACTS_BASE_GREEN, checks: { state: 'red', failing: ['lint'], pending: [] } };

function recordInputs(
  decisions: readonly Record<string, unknown>[],
  base: Record<string, unknown> = BASE_GREEN
): Record<string, string> {
  return {
    INPUTS_PATH: 'sweep',
    INPUTS_ITEMS: ITEMS,
    INPUTS_SETTLED: '[]',
    INPUTS_BASE: JSON.stringify(base === BASE_RED ? FACTS_BASE_RED : FACTS_BASE_GREEN),
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
const BASE_RED = { summary: 'lint fails in src/a.ts, which PR 43 changed; revert PR 43 or fix forward' };

type GateOptions = NonNullable<Parameters<typeof run>[3]>;

/** Run the merge node with PR 42 declared `merge` at `head`. */
function gate(at: Install, options: GateOptions = {}, inputs: Record<string, string> = {}, head = HEAD): ScriptRun {
  const sweep = { decisions: [decision({ head })], base: BASE_GREEN, summary: 'swept' };
  return run(at, 'merge', { INPUTS_ITEMS: ITEMS, INPUTS_SWEEP: JSON.stringify(sweep), ...inputs }, options);
}

/** What the merge node reported for PR 42. */
function gated(result: ScriptRun): { number: number; head: string; refusals: string[]; merge_commit: string | null } {
  const [only] = (ok(result) as { gated: { number: number; head: string; refusals: string[]; merge_commit: string | null }[] }).gated;
  expect(only).toMatchObject({ number: 42, head: HEAD });
  return only as { number: number; head: string; refusals: string[]; merge_commit: string | null };
}

describe('the merge queue scripts', () => {
  test('the gate refuses an unreadable base and merges nothing', () => {
    const at = install();
    const unread = gate(at, { pr: { baseUnreadable: true } });
    expect(gated(unread).refusals[0]).toContain('forge checks.commit failed: HTTP 502 reading base');
    expect(merges(unread)).toEqual([]);
  }, 60_000);

  test('the gate refuses two trusted review comments and merges nothing', () => {
    const at = install();
    const duplicate = gate(at, { comments: [REVIEWED, { ...REVIEWED, id: 2 }] });
    expect(gated(duplicate).refusals).toEqual(['its review verdict is duplicate']);
    expect(merges(duplicate)).toEqual([]);
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

  test('a declared merge the gate refused waits with its reasons, a closed one parks, and every other decision is recorded', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, CLAIMED), subject: OTHER });
    const refused = JSON.stringify([{ number: 42, head: HEAD, refusals: ['CI at its head is red (test)'], merge_commit: null }]);
    const inputs = { ...recordInputs([decision({ number: 43 }), decision({})]), INPUTS_ITEMS: BOTH_ITEMS, INPUTS_GATED: refused };
    expect(ok(run(at, 'record', inputs, { pr: { merged: [43] } }))).toMatchObject({ merged: [43], healthy: true });
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)' }] } } });
    const waiting = stored(at).value as WorkItem;
    expect(waiting).toMatchObject({
      claim: null,
      facts: { merge: { status: 'waiting', decisions: [{ decision: 'merge refused (clear)', reason: 'not merged: CI at its head is red (test)' }] } },
    });
    expect(mergeWaits(waiting)).toBe(true);

    // Closed, not merged, and PR 43's work item is no longer this run's.
    seed(at, item(BUILT, undefined, CLAIMED));
    seed(at, { ...item(BUILT, undefined, { claim: { run_id: 'another-run', at: AT, requests: [] } }), subject: OTHER });
    const closed = run(at, 'record', inputs, { pr: { state: 'CLOSED', merged: [43] } });
    expect(closed.code).toBe(0);
    expect((JSON.parse(closed.stdout) as { summary: string }).summary).toContain('PR 43: not recorded, the next sweep decides it again (work/8 is no longer claimed by this run)');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'parked' } } });
  }, 60_000);

  test('the gate fails visibly and merges nothing when the maintainer list cannot be read', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const revision = 'dev:.archon/sdlc/policy/maintainers.json';
    const objectId = spawnSync('git', ['rev-parse', revision], { cwd: at.checkout, encoding: 'utf8' }).stdout.trim();
    const object = join(at.checkout, '.git/objects', objectId.slice(0, 2), objectId.slice(2));
    expect(existsSync(object)).toBe(true);
    const before = stored(at);
    const result = gate(at, {
      preload: `
        import { unlinkSync } from 'node:fs';
        const gitWithPolicy = Bun.spawnSync.bind(Bun);
        Bun.spawnSync = (argv, settings) => {
          const result = gitWithPolicy(argv, settings);
          if (argv[0] === 'git' && argv[1] === 'fetch' && result.exitCode === 0) unlinkSync(${JSON.stringify(object)});
          return result;
        };
      `,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('git show');
    expect(result.stderr).toContain('failed:');
    expect(stored(at)).toEqual(before);
    expect(merges(result)).toEqual([]);
  }, 60_000);

  test('a maintainer refresh failure records settlements and leaves open companions untouched', () => {
    const at = install();
    seed(at, item());
    seed(at, { ...item({ ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, pr_url: PR_URL.replace(/42$/, '43') })) }), subject: OTHER });
    const picked = ok(run(at, 'facts', {}, { pr: { merged: [43] } }));
    expect(picked).toMatchObject({ items: [{ pr: PR }], settled: [{ item: OTHER, status: 'merged' }] });
    const companion = stored(at);
    const recorded = run(at, 'record', {
      ...recordInputs([decision({})]),
      INPUTS_ITEMS: JSON.stringify(picked.items),
      INPUTS_SETTLED: JSON.stringify(picked.settled),
    }, { preload: `
      const beforeFetch = Bun.spawnSync.bind(Bun);
      Bun.spawnSync = (argv, settings) => {
        if (argv[0] === 'git' && argv[1] === 'fetch') {
          const configured = beforeFetch(['git', 'config', 'remote.upstream.uploadpack', 'false'], settings);
          if (configured.exitCode !== 0) throw new Error(configured.stderr.toString());
        }
        return beforeFetch(argv, settings);
      };
    ` });
    expect(recorded.code).toBe(1);
    expect(recorded.stderr).toContain('git fetch');
    expect(recorded.stderr).toContain('failed:');
    expect(stored(at, 8).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged' } } });
    expect(stored(at)).toEqual(companion);
    expect(forgeCalls(recorded)).toEqual([]);
  }, 60_000);

  test('record completes after a remote advance while another fetch holds the tracking ref lock', () => {
    const at = install();
    git(at.checkout, 'remote', 'rename', 'upstream', 'origin');
    const writer = track(mkdtempSync(join(tmpdir(), 'archon-merge-writer-')));
    const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: at.checkout, encoding: 'utf8' }).stdout.trim();
    git(writer, 'clone', '-q', remote, '.');
    git(writer, 'config', 'user.email', 'test@example.com');
    git(writer, 'config', 'user.name', 'Test');
    git(writer, 'commit', '-q', '--allow-empty', '-m', 'remote advanced');
    git(writer, 'push', '-q', 'origin', 'dev');
    const lock = join(at.checkout, '.git/refs/remotes/origin/dev.lock');
    writeFileSync(lock, 'held by another fetch\n');

    seed(at, item(BUILT, undefined, CLAIMED));
    expect(ok(run(at, 'record', recordInputs([decision({})]), { pr: { state: 'MERGED' } }))).toMatchObject({ merged: [42] });
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ head: HEAD }] } } });
    expect(readFileSync(lock, 'utf8')).toBe('held by another fetch\n');
  }, 60_000);

  test('a merge the forge reads back is recorded and released at its head, whatever the sweep says', () => {
    const at = install();
    const merged = { state: 'MERGED' } as const;
    const released = { merged: [42], question: '', kind: '', asked: null, healthy: true };
    // Declared merged; declared at another head; merged by hand, declared wait; merged by hand under an ask.
    const cases = [
      [decision({}), BASE_GREEN],
      [decision({ head: OLD }), BASE_GREEN],
      [decision({ action: 'wait', reason: 'CI pending' }), BASE_GREEN],
      [decision({ action: 'ask', ask: QUESTION, brief: 'rework PR 42' }), BASE_GREEN],
    ] as const;
    for (const [decided, base] of cases) {
      seed(at, item(BUILT, undefined, CLAIMED));
      expect(ok(run(at, 'record', recordInputs([decided], base), { pr: merged }))).toMatchObject(released);
      expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)', head: HEAD }] } } });
      expect(mergeWaits(stored(at).value as WorkItem)).toBe(false);
    }
  }, 60_000);

  test("an asked pull request keeps its claim, and the wait gets the sweep's question, options and recommendation unchanged, with its labels", () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const asked = { item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', ask: QUESTION };
    const raised = ok(run(at, 'record', recordInputs([decision({ action: 'ask', class: 'unclear', ask: QUESTION, brief: 'rework PR 42' })])));
    expect(raised).toEqual({ merged: [], summary: 'swept\nPR 42: ask', ...QUESTION, kind: 'approve', item: '7', pr: '42', asked, healthy: true });
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'run-1' }, facts: { merge: { status: 'asking' } } });
  }, 60_000);

  test('a red default branch asks nobody: the sweep ends not healthy, with its diagnosis, and the pull request waits', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const held = ok(run(at, 'record', recordInputs([decision({ action: 'wait', reason: 'dev is red' })], BASE_RED)));
    expect(held).toMatchObject({ healthy: false, merged: [], question: '', options: [], recommendation: null, asked: null });
    expect(held.summary).toContain(`The default branch dev is red at ${OLD} (lint); nothing merges until it is green. ${BASE_RED.summary}`);
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting' } } });
  }, 60_000);

  test('an idle run that finds a stored item no pickup can act on ends not healthy and names it', () => {
    const at = install();
    const idle = { INPUTS_PATH: 'idle', INPUTS_ITEMS: '[]', INPUTS_SETTLED: '[]', INPUTS_BASE: JSON.stringify(FACTS_BASE_GREEN), INPUTS_SWEEP: 'null' };
    expect(ok(run(at, 'record', idle))).toMatchObject({ healthy: true, summary: 'No pull request waits for the merge queue.' });
    inProcess(at, () => expect(state.put('work/9', { not: 'a work item' }, { ifRevision: 0 }).ok).toBe(true));
    const stuck = ok(run(at, 'record', idle));
    expect(stuck).toMatchObject({ healthy: false, question: '' });
    expect(stuck.summary).toContain('work/9 (its document does not parse');
  }, 60_000);

  test('record says what merged, on which lane, and what went back to the build queue', () => {
    const at = install();
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const said = () =>
      readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
        .filter(argv => argv[1] === 'notice')
        .map(argv => ({ text: argv.at(-1), labels: argv.filter((_, index) => argv[index - 1] === '--label') }));
    seed(at, item(BUILT, undefined, CLAIMED));
    ok(run(at, 'record', { ...recordInputs([decision({})]), ARCHON_CALL_LOG: calls }, { pr: { state: 'MERGED' } }));
    expect(said()).toEqual([{ text: `PR 42 merged at ${HEAD} (auto)`, labels: ['stage=merge', 'kind=merged', 'item=7', 'pr=42', 'lane=auto'] }]);

    // Merged at the head a maintainer approved: the manual lane.
    writeFileSync(calls, '');
    seed(at, item(BUILT, undefined, CLAIMED));
    const approved = JSON.stringify([{ ...(JSON.parse(ITEMS) as object[])[0], record: { ...merge('waiting'), approval: { head: HEAD, at: AT } } }]);
    ok(run(at, 'record', { ...recordInputs([decision({})]), INPUTS_ITEMS: approved, ARCHON_CALL_LOG: calls }, { pr: { state: 'MERGED' } }));
    expect(said()).toEqual([{ text: `PR 42 merged at ${HEAD} (approved)`, labels: ['stage=merge', 'kind=merged', 'item=7', 'pr=42', 'lane=manual'] }]);

    writeFileSync(calls, '');
    seed(at, item(BUILT, undefined, CLAIMED));
    ok(run(at, 'record', { ...recordInputs([decision({ action: 'return', reason: 'red in src/a.ts', brief: 'fix PR 42' })]), ARCHON_CALL_LOG: calls }));
    expect(said()).toEqual([{ text: 'PR 42 returned to build; red in src/a.ts', labels: ['stage=merge', 'kind=returned', 'item=7', 'pr=42'] }]);
  }, 60_000);

  test('a decision for a pull request the run did not claim is noted and skipped, and the rest is still recorded', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const extra = run(at, 'record', recordInputs([decision({ number: 7 }), decision({ action: 'wait', reason: 'CI pending' })]));
    expect(extra.code).toBe(0);
    expect(extra.stderr).toContain('the sweep decided PR 7, which this run did not claim; not recorded');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ reason: 'CI pending' }] } } });
  }, 60_000);

  const ASKED = JSON.stringify({ item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', ask: QUESTION });
  const SELECTED = { INPUTS_MERGE_QUEUE_BINDING: '/bindings/merge-queue.json', INPUTS_BUILD_QUEUE_BINDING: '/bindings/build-queue.json' };
  const fireOf = (calls: string): string[] | undefined =>
    readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[0] === 'trigger');
  const inputsOf = (fire: string[] | undefined): unknown => JSON.parse(readFileSync(fire?.[fire.indexOf('--inputs') + 1] ?? '', 'utf8'));

  test("a maintainer's merge approves the pull request at the head they were asked about", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(ok(run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_DECISION: 'merge', INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls }))).toMatchObject({ decision: 'merge', section: '' });
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', approval: { head: HEAD } } } });
    expect(mergeWaits(doc)).toBe(true);
    // The approval is acted on at once: a sweep starts through the merge queue's binding, once per answer.
    const fire = fireOf(calls);
    expect(fire?.slice(0, 6)).toEqual(['trigger', 'fire', '--config', '/bindings/merge-queue.json', '--delivery-id', 'merge-sweep:ghe.example.com/example/repo#7:run-1']);
    expect(inputsOf(fire)).toEqual({});
  }, 60_000);

  test('a return writes its ruling into the issue body and the build round starts from it', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const ruled = run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_DECISION: 'return', INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls });
    const heading = ok(ruled).section as string;
    expect(heading).toMatch(/^Current scope \(maintainer ruling on the merge queue's question on PR 42, \d{4}-\d{2}-\d{2}\)$/);
    // The returned round starts at once through the build queue's binding, for the item.
    const fire = fireOf(calls);
    expect(fire?.slice(0, 6)).toEqual(['trigger', 'fire', '--config', '/bindings/build-queue.json', '--delivery-id', 'build-round:ghe.example.com/example/repo#7:run-1']);
    expect(inputsOf(fire)).toEqual({ number: '7', repo_host: 'ghe.example.com', repo_path: 'example/repo' });
    expect(ruled.bodies).toEqual([`The contract.\n\n\n## ${heading}\n\nKeep the old prompt wording.\n`]);
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { merge: { status: 'returned' }, build: { status: 'next' } } });
    expect(doc.facts.build?.brief).toContain('rework PR 42');
    expect(doc.facts.build?.brief).toContain(heading);
  }, 60_000);

  test('an `other` answer, which names no option, parks a pull request the sweep wrote no brief for', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const asked = JSON.stringify({ ...(JSON.parse(ASKED) as object), brief: '' });
    const ruled = run(at, 'ruling', { INPUTS_ASKED: asked, INPUTS_DECISION: 'other', INPUTS_TEXT: 'Wait for the release.', ...SELECTED });
    expect(ok(ruled)).toMatchObject({ decision: 'park' });
    expect(ruled.bodies[0]).toContain("The maintainer's words: Wait for the release.");
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'parked' } } });
  }, 60_000);
});

describe('the merge queue facts and gate', () => {
  const on = (at: Install, script: 'facts', options: GateOptions = {}, inputs: Record<string, string> = {}) =>
    run(at, script, inputs, options);

  test('facts claims the items the build queue finished and reads each pull request', () => {
    const at = install();
    seed(at, item());
    const output = ok(on(at, 'facts')) as { path: string; items: { facts: PrFacts }[] };
    expect(output.path).toBe('sweep');
    expect(output.items[0]?.facts).toEqual(FACTS);
    expect(stored(at).value?.claim?.run_id).toBe('run-1');
    expect(ok(on(at, 'facts', {}, { WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: '{"run-1":"running"}' }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('a review comment from anyone but a listed maintainer is no verdict', () => {
    const at = install();
    seed(at, item());
    const forged = { ...REVIEWED, author: 'outsider' };
    const output = ok(on(at, 'facts', { comments: [forged] })) as { items: { facts: PrFacts }[] };
    expect(output.items[0]?.facts.verdict.state).toBe('none');
  }, 60_000);

  test('the gate merges pinned to the head it passed', () => {
    const merged = gate(install());
    expect(gated(merged)).toEqual({ number: 42, head: HEAD, refusals: [], merge_commit: '3333333333333333333333333333333333333333' });
    expect(merges(merged)).toEqual([
      `forge pr.merge squash ${HEAD}`,
    ]);
  }, 60_000);

  test('a merge the forge accepts but does not make leaves no receipt, and is reported as not merged', () => {
    const queued = gate(install(), { pr: { queuesMerge: true } });
    expect(gated(queued)).toMatchObject({ merge_commit: null, refusals: [expect.stringContaining('forge pr.merge verification_failed')] });
    expect(merges(queued)).toHaveLength(1);
  }, 60_000);

  test('an applied merge that names no landed commit is reported as not completed, for the read-back to settle', () => {
    const landed = gate(install(), { pr: { landsNoCommit: true } });
    expect(gated(landed)).toMatchObject({ merge_commit: null, refusals: [expect.stringContaining('named no landed commit')] });
    expect(merges(landed)).toHaveLength(1);
  }, 60_000);

  test('the gate refuses a head behind the default branch that conflicts, or a red check, and merges nothing', () => {
    const red = gate(install(), { pr: { checks: 'red', threads: 1, behind: 2, conflicts: true } });
    expect(gated(red).refusals).toEqual([
      `it lacks 2 commits of dev at ${OLD} and its merge is conflict`,
      'CI at its head is red (test)',
    ]);
    expect(merges(red)).toEqual([]);
  }, 60_000);

  test('the gate refuses a verdict given at another head, and merges nothing', () => {
    const stale = gate(install(), { comments: [{ ...REVIEWED, body: reviewCommentBody(OLD, true, 'complete', '# Review report') }] });
    expect(gated(stale).refusals).toEqual([`its review verdict is for ${OLD}, not ${HEAD}`]);
    expect(merges(stale)).toEqual([]);
  }, 60_000);

  test('a pull request that changes a protected path, or any under the manual lane, merges only with an approval at its head', () => {
    const at = install();
    seed(at, item());
    const pack = { pr: { files: ['.archon/workflows/sdlc/.pack/pack.yaml', 'src/a.ts'] } };
    const protectedPaths = { INPUTS_PROTECTED_PATHS: '.archon/workflows/**, infra/**' };
    const refused = gate(at, pack, protectedPaths);
    expect(gated(refused).refusals).toEqual(['it changes protected paths (.archon/workflows/sdlc/.pack/pack.yaml) and no maintainer approved it at this head']);
    expect(merges(refused)).toEqual([]);
    // A change outside them merges on the auto lane, and not under the manual one.
    expect(gated(gate(at, { pr: { files: ['src/a.ts'] } }, { ...protectedPaths, INPUTS_MERGE_LANE: 'manual' })).refusals).toEqual([
      'the merge lane is manual and no maintainer approved it at this head',
    ]);
    seed(at, item(BUILT, { ...merge('waiting'), approval: { head: HEAD, at: AT } }));
    const approved = gate(at, pack, { ...protectedPaths, INPUTS_MERGE_LANE: 'manual' });
    expect(gated(approved).refusals).toEqual([]);
    expect(merges(approved)).toEqual([`forge pr.merge squash ${HEAD}`]);
  }, 60_000);

  test("the gate refuses while the default branch's CI is red, and merges nothing; pending does not hold it", () => {
    const at = install();
    const red = gate(at, { pr: { baseChecks: 'red' } });
    expect(gated(red).refusals).toEqual([`the default branch dev is red at ${OLD} (test)`]);
    expect(merges(red)).toEqual([]);
    const pending = gate(at, { pr: { baseChecks: 'pending' } });
    expect(gated(pending).refusals).toEqual([]);
    expect(merges(pending)).toHaveLength(1);
  }, 60_000);
});

describe('the gate under ci: none', () => {
  const NONE = { INPUTS_CI: 'none' };
  const validated = (validation: { head: string; passed: boolean }): WorkItem =>
    item({ ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, validation })) });

  test('a passing validation recorded at the head merges it, whatever the forge checks say', () => {
    const at = install();
    seed(at, validated({ head: HEAD, passed: true }));
    const merged = gate(at, { pr: { checks: 'red' } }, NONE);
    expect(gated(merged).refusals).toEqual([]);
    expect(merges(merged)).toEqual([`forge pr.merge squash ${HEAD}`]);
  }, 60_000);

  test('a validation for another head, or a failed one, refuses and merges nothing', () => {
    const at = install();
    seed(at, validated({ head: OLD, passed: true }));
    const stale = gate(at, {}, NONE);
    expect(gated(stale).refusals).toEqual([`its validation is for ${OLD}, not ${HEAD}`]);
    seed(at, validated({ head: HEAD, passed: false }));
    const red = gate(at, {}, NONE);
    expect(gated(red).refusals).toEqual([`its validation at ${HEAD} failed`]);
    expect([...merges(stale), ...merges(red)]).toEqual([]);
  }, 60_000);
});

describe('the merge queue on the forge', () => {
  test('facts refuses a plugin without every merge-queue operation before claiming anything', () => {
    const at = install();
    seed(at, item());
    const refused = run(at, 'facts', {}, { pr: { missingOps: ['pr.merge-state'] } });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('does not support pr.merge-state');
    expect(forgeCalls(refused)).toEqual(['forge check']);
    expect(stored(at).value?.claim ?? null).toBeNull();
    expect(stored(at).value?.facts.merge).toBeUndefined();
  }, 60_000);

  test('the facts and the merge use exactly the operations the plugin must advertise, besides the sweep agent\'s rerun', () => {
    const at = install();
    seed(at, item());
    const facts = run(at, 'facts', {}, {});
    const merged = gate(at);
    expect([facts.code, merged.code]).toEqual([0, 0]);
    const used = [...forgeCalls(facts), ...forgeCalls(merged)];
    // `resolve` runs no preflight: the host refuses it on a plugin that cannot resolve a URL.
    const preflighted = used.filter(call => call.startsWith('forge ') && !['forge check', 'forge resolve'].includes(call));
    expect(new Set(preflighted.map(call => call.split(' ')[1]))).toEqual(
      // The sweep agent, not a script, reruns a pull request's failed checks.
      new Set(MERGE_QUEUE_FORGE_OPERATIONS.filter(op => op !== 'checks.rerun'))
    );
  }, 60_000);

  test.each([
    ['merge state', { mergeStateHead: OLD }, 'moved while it was read'],
    ['checks', { checksRevision: OLD }, 'are not on its head'],
  ] as const)('the gate refuses %s read at another commit than the head, and merges nothing', (_, pr, reason) => {
    const moved = gate(install(), { pr });
    expect(gated(moved).refusals[0]).toContain(reason);
    expect(merges(moved)).toEqual([]);
  }, 60_000);

  test('the gate counts a check the forge reports neither green nor pending as failing, and merges nothing', () => {
    const unknown = gate(install(), { pr: { checks: 'unknown' } });
    expect(gated(unknown).refusals).toEqual(['CI at its head is red (test)']);
    expect(merges(unknown)).toEqual([]);
  }, 60_000);
});
