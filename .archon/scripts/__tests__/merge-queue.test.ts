import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { BuildRecord } from '../../workflows/sdlc/.shared/build';
import {
  gateRefusals,
  type MergeAttention,
  type MergeRecord,
  mergeWaits,
  type PrFacts,
  MERGE_QUEUE_FORGE_OPERATIONS,
} from '../../workflows/sdlc/.shared/merge';
import { REVIEW_MARKER, readReviewStamp, reviewCommentBody } from '../../workflows/sdlc/.shared/review-comment';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
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

describe('the merge record and the gate', () => {
  test('the gate passes only a Ready verdict and green CI at a pinned head that contains the default branch or merges into it cleanly, on a default branch that is not red', () => {
    expect(gateRefusals(FACTS, HEAD, BASE, FORGE)).toEqual([]);
    const refused = (facts: Partial<PrFacts>, head = HEAD) => gateRefusals({ ...FACTS, ...facts }, head, BASE, FORGE);
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
    const lease = doc.claim === null ? undefined : 'take';
    expect(statePut(name, doc, stateGet(name).revision, lease)).toBe('ok');
  });
}

function stored(at: Install, number = SUBJECT.number): { revision: number; value: WorkItem | null } {
  return inProcess(at, () => {
    const read = stateGet(`work/${String(number)}`);
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
  /** The head `pr.merge-state` reports, when it answers about another commit than `pr.view`. */
  readonly mergeStateHead?: string;
  /** The revision `checks.state` reports, when it answers about another commit than `pr.view`. */
  readonly checksRevision?: string;
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
  // The harness's forge resolves a pull request URL.
  if (op === 'resolve') return null;
  if (op === 'metadata') return out(true, { capabilities: ${JSON.stringify(MERGE_QUEUE_FORGE_OPERATIONS)} });
  if (op === 'checks.commit') return forgePr.baseUnreadable ? failed('HTTP 502 reading base') : out(true, { repo: request.repo, branch: 'dev', revision: ${JSON.stringify(OLD)}, units: units(forgePr.baseChecks ?? 'green') });
  if (op === 'pr.merge') {
    if (request.conditions.head !== forgePr.headRefOid) return failed('Head branch was modified', { op, target: ref, outcome: 'refused' });
    if (forgePr.queuesMerge) return failed('the pull request reads back open', { op, target: ref, outcome: 'verification_failed', leaveBehind: 'a queued merge' });
    forgePr.state = 'MERGED';
    forgePr.mergeCommit = '3333333333333333333333333333333333333333';
    return out(true, { target: ref, outcome: 'applied', changed: true, method: request.method, conditions: request.conditions, enforcedConditions: ['head'], landed: { commit: forgePr.landsNoCommit ? null : forgePr.mergeCommit, tree: null, parents: null } });
  }
  if (op === 'pr.view') {
    appendFileSync('{ARTIFACTS}/forge-gh.log', 'snapshot\\n');
    const url = ${JSON.stringify(PR_URL.replace(/42$/, ''))} + ref.number;
    return out(true, { title: 'Fix the thing', body: '', pr: { schemaVersion: 1, repo: ref.repo, number: ref.number, url, head: 'feature', base: 'dev', is_draft: false, state: state(), head_repo: ref.repo, head_revision: forgePr.headRefOid, base_revision: null, maintainer_can_modify: null } });
  }
  if (op === 'pr.merge-state') return out(true, { ref, head_revision: forgePr.mergeStateHead ?? forgePr.headRefOid, default_branch: 'dev', default_revision: ${JSON.stringify(OLD)}, behind: forgePr.behind ?? 0, mergeable: forgePr.conflicts ? 'conflict' : 'clean', merge_commit: state() === 'merged' ? forgePr.mergeCommit : null });
  if (op === 'checks.state') return out(true, { ref, revision: forgePr.checksRevision ?? forgePr.headRefOid, units: units(forgePr.checks) });
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
  script: 'facts' | 'gate' | 'record' | 'ruling',
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
      INPUTS_MERGE_METHOD: 'squash',
      INPUTS_CI: 'forge',
      ...inputs,
    },
  });
}

/** The answer's value: the wait returns the chosen choice itself. */
function choiceOf(asked: string, id: string): string {
  const { attention } = JSON.parse(asked) as { attention: { choices: { id: string }[] } };
  return JSON.stringify(attention.choices.find(choice => choice.id === id));
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
const BASE_GREEN = { summary: 'dev is green', attention: null };

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

function recordInputs(
  decisions: readonly Record<string, unknown>[],
  base: Record<string, unknown> = BASE_GREEN
): Record<string, string> {
  return {
    INPUTS_PATH: 'sweep',
    INPUTS_ITEMS: ITEMS,
    INPUTS_SETTLED: '[]',
    INPUTS_BASE: JSON.stringify(FACTS_BASE_GREEN),
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
  summary: 'lint red on dev',
  attention: { ...ATTENTION, what: 'dev is red since PR 43 merged', choices: [HOLD], recommendation: { ...ATTENTION.recommendation, choice: 'hold' } },
};

describe('the merge queue scripts', () => {
  test('the gate refuses an unreadable base and merges nothing', () => {
    const at = install();
    const gated = run(at, 'gate', {}, { pr: { baseUnreadable: true }, args: [
      '--method', 'squash', '--ci', 'forge', '--pr', PR_URL, '--head', HEAD, '--merge',
    ] });
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain('forge checks.commit failed: HTTP 502 reading base');
    expect(merges(gated)).toEqual([]);
  }, 60_000);

  test('the gate refuses two trusted review comments and merges nothing', () => {
    const at = install();
    const args = ['--method', 'squash', '--ci', 'forge', '--pr', PR_URL, '--head', HEAD, '--merge'];
    const duplicate = run(at, 'gate', {}, { args, comments: [REVIEWED, { ...REVIEWED, id: 2 }] });
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.stdout).refusals).toEqual(['its review verdict is duplicate']);
    expect(merges(duplicate)).toEqual([]);
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
    expect(closed.stderr).toContain('the default branch is red and was not raised (lint red on dev)');
    expect(closed.stderr).toContain('PR 43: not recorded, the next sweep decides it again (work/8 is no longer claimed by this run); every other decision is recorded');
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
    const result = run(at, 'gate', {}, {
      args: ['--pr', PR_URL, '--head', HEAD, '--method', 'squash', '--ci', 'forge', '--merge'],
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

  test('a decision for a pull request the run did not claim is noted and skipped, and the rest is still recorded', () => {
    const at = install();
    seed(at, item(BUILT, undefined, CLAIMED));
    const extra = run(at, 'record', recordInputs([decision({ number: 7, action: 'merged' }), decision({ action: 'wait', reason: 'CI pending' })]));
    expect(extra.code).toBe(0);
    expect(extra.stderr).toContain('the sweep decided PR 7, which this run did not claim; not recorded');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { merge: { status: 'waiting', decisions: [{ reason: 'CI pending' }] } } });
  }, 60_000);

  const ASKED = JSON.stringify({ by: 'pr', item: SUBJECT, pr: PR, head: HEAD, brief: 'rework PR 42', attention: ATTENTION });
  const SELECTED = { INPUTS_MERGE_QUEUE_BINDING: '/bindings/merge-queue.json', INPUTS_BUILD_QUEUE_BINDING: '/bindings/build-queue.json' };
  const fireOf = (calls: string): string[] | undefined =>
    readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[0] === 'trigger');
  const inputsOf = (fire: string[] | undefined): unknown => JSON.parse(readFileSync(fire?.[fire.indexOf('--inputs') + 1] ?? '', 'utf8'));

  test("a maintainer's merge approves the pull request at the head they were asked about", () => {
    const at = install();
    seed(at, item(BUILT, merge('asking'), CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    expect(ok(run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: choiceOf(ASKED, 'merge'), INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls }))).toMatchObject({ decision: 'merge', section: '' });
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
    const ruled = run(at, 'ruling', { INPUTS_ASKED: ASKED, INPUTS_CHOICE: choiceOf(ASKED, 'return'), INPUTS_TEXT: '', ...SELECTED, ARCHON_CALL_LOG: calls });
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
});

describe('the merge queue facts and gate', () => {
  const on = (at: Install, script: 'facts' | 'gate', options: Parameters<typeof run>[3] = {}, inputs: Record<string, string> = {}) =>
    run(at, script, inputs, options);
  const args = ['--method', 'squash', '--ci', 'forge', '--pr', PR_URL, '--head', HEAD, '--merge'];

  test('facts claims the items the build queue finished and reads each pull request', () => {
    const at = install();
    seed(at, item());
    const output = ok(on(at, 'facts')) as { path: string; items: { facts: PrFacts }[]; gate: string };
    expect(output.path).toBe('sweep');
    expect(output.items[0]?.facts).toEqual(FACTS);
    expect(output.gate).toContain('gate.ts');
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
    const gated = on(install(), 'gate', { args });
    expect(ok(gated)).toEqual({ pr: PR_URL, head: HEAD, refusals: [], merge_commit: '3333333333333333333333333333333333333333' });
    expect(merges(gated)).toEqual([
      `forge pr.merge squash ${HEAD}`,
    ]);
  }, 60_000);

  test('a merge the forge accepts but does not make leaves no receipt, and the gate fails', () => {
    const gated = on(install(), 'gate', { args, pr: { queuesMerge: true } });
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain('forge pr.merge verification_failed');
    expect(merges(gated)).toHaveLength(1);
  }, 60_000);

  test('an applied merge that names no landed commit fails the gate rather than reading like a refusal', () => {
    const gated = on(install(), 'gate', { args, pr: { landsNoCommit: true } });
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain('named no landed commit');
    expect(merges(gated)).toHaveLength(1);
  }, 60_000);

  test('the gate refuses a head behind the default branch that conflicts, or a red check, and merges nothing', () => {
    const red = on(install(), 'gate', { args, pr: { checks: 'red', threads: 1, behind: 2, conflicts: true } });
    expect(JSON.parse(red.stdout).refusals).toEqual([
      `it lacks 2 commits of dev at ${OLD} and its merge is conflict`,
      'CI at its head is red (test)',
    ]);
    expect(merges(red)).toEqual([]);
  }, 60_000);

  test('the gate refuses a verdict given at another head, and merges nothing', () => {
    const stale = on(install(), 'gate', { args, comments: [{ ...REVIEWED, body: reviewCommentBody(OLD, true, 'complete', '# Review report') }] });
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).refusals).toEqual([`its review verdict is for ${OLD}, not ${HEAD}`]);
    expect(merges(stale)).toEqual([]);
  }, 60_000);

  test("the gate refuses while the default branch's CI is red, and merges nothing; pending does not hold it", () => {
    const at = install();
    const red = on(at, 'gate', { args, pr: { baseChecks: 'red' } });
    expect(red.code).toBe(1);
    expect(JSON.parse(red.stdout).refusals).toEqual([`the default branch dev is red at ${OLD} (test)`]);
    expect(merges(red)).toEqual([]);
    const pending = on(at, 'gate', { args, pr: { baseChecks: 'pending' } });
    expect(ok(pending).refusals).toEqual([]);
    expect(merges(pending)).toHaveLength(1);
  }, 60_000);
});

describe('the gate under ci: none', () => {
  const args = ['--method', 'squash', '--ci', 'none', '--item', '7', '--pr', PR_URL, '--head', HEAD, '--merge'];
  const validated = (validation: { head: string; passed: boolean }): WorkItem =>
    item({ ...BUILT, rounds: BUILT.rounds.map(round => ({ ...round, validation })) });

  test('a passing validation recorded at the head merges it, whatever the forge checks say', () => {
    const at = install();
    seed(at, validated({ head: HEAD, passed: true }));
    const gated = run(at, 'gate', {}, { args, pr: { checks: 'red' } });
    expect(ok(gated).refusals).toEqual([]);
    expect(merges(gated)).toEqual([`forge pr.merge squash ${HEAD}`]);
  }, 60_000);

  test('a validation for another head, or a failed one, refuses and merges nothing', () => {
    const at = install();
    seed(at, validated({ head: OLD, passed: true }));
    const stale = run(at, 'gate', {}, { args });
    expect(JSON.parse(stale.stdout).refusals).toEqual([`its validation is for ${OLD}, not ${HEAD}`]);
    seed(at, validated({ head: HEAD, passed: false }));
    const red = run(at, 'gate', {}, { args });
    expect(JSON.parse(red.stdout).refusals).toEqual([`its validation at ${HEAD} failed`]);
    expect([...merges(stale), ...merges(red)]).toEqual([]);
  }, 60_000);
});

describe('the merge queue on the forge', () => {
  test.each([
    ['merge state', { mergeStateHead: OLD }, 'moved while it was read'],
    ['checks', { checksRevision: OLD }, 'are not on its head'],
  ] as const)('the gate refuses %s read at another commit than the head, and merges nothing', (_, pr, reason) => {
    const gated = run(install(), 'gate', {}, { pr, args: ['--method', 'squash', '--ci', 'forge', '--pr', PR_URL, '--head', HEAD, '--merge'] });
    expect(gated.code).not.toBe(0);
    expect(gated.stderr).toContain(reason);
    expect(merges(gated)).toEqual([]);
  }, 60_000);

  test('the gate counts a check the forge reports neither green nor pending as failing, and merges nothing', () => {
    const gated = run(install(), 'gate', {}, { pr: { checks: 'unknown' }, args: ['--method', 'squash', '--ci', 'forge', '--pr', PR_URL, '--head', HEAD, '--merge'] });
    expect(gated.code).toBe(1);
    expect(JSON.parse(gated.stdout).refusals).toEqual(['CI at its head is red (test)']);
    expect(merges(gated)).toEqual([]);
  }, 60_000);
});
