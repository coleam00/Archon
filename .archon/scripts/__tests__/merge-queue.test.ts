import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { BuildRecord } from '../../workflows/sdlc/.shared/build';
import { gateRefusals, type MergeRecord, type MergeStart, type PrFacts } from '../../workflows/sdlc/.shared/merge';
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
    // Whether an open thread holds the merge is the judge's call, not the gate's.
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
  const checkout = gitCheckout(track);
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

function seed(at: Install, doc: WorkItem): void {
  const name = `work/${String(doc.subject.number)}`;
  inProcess(at, () => expect(state.put(name, doc, { ifRevision: state.get(name).revision }).ok).toBe(true));
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
  readonly checks?: 'green' | 'pending' | 'red' | 'unknown';
  readonly threads?: number;
  /** The default branch's head as the pull request's merge state reports it. */
  readonly defaultRevision?: string;
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
  readonly baseUnreadable?: boolean;
  /** The head `pr.merge-state` reports, when it answers about another commit than `pr.view`. */
  readonly mergeStateHead?: string;
  /** The revision `checks.state` reports, when it answers about another commit than `pr.view`. */
  readonly checksRevision?: string;
  /** The paths `pr.files` reports the pull request changes. */
  readonly files?: readonly string[];
  /** The revision `pr.files` reports, when the head moved between the gate's reads. */
  readonly filesRevision?: string;
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
  const state = () => forgePr.state.toLowerCase();
  // The harness's forge resolves a pull request URL.
  if (op === 'resolve') return null;
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
  if (op === 'pr.merge-state') return out(true, { ref, head_revision: forgePr.mergeStateHead ?? forgePr.headRefOid, default_branch: 'dev', default_revision: forgePr.defaultRevision ?? ${JSON.stringify(OLD)}, behind: forgePr.behind ?? 0, mergeable: forgePr.conflicts ? 'conflict' : 'clean', merge_commit: state() === 'merged' ? forgePr.mergeCommit : null });
  if (op === 'checks.state') return out(true, { ref, revision: forgePr.checksRevision ?? forgePr.headRefOid, units: units(forgePr.checks) });
  if (op === 'pr.files') return out(true, { ref, head_revision: forgePr.filesRevision ?? forgePr.headRefOid, files: (forgePr.files ?? []).map(path => ({ path, previous_path: null, status: 'modified', patch: null })) });
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
  script: 'facts' | 'settle',
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
      RUN_ITEM_KEY: 'issue-7',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
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

const FACTS_BASE = { branch: 'dev', head: OLD, checks: { state: 'green', failing: [], pending: [] } } as const;

/** What the facts node hands settle on the judge path. */
const START: MergeStart = {
  path: 'judge',
  item: SUBJECT,
  pr: PR,
  url: PR_URL,
  facts: FACTS,
  base: FACTS_BASE,
  record: null,
  validation: null,
  protected: [],
  lane: 'auto',
  ci: 'forge',
  answer: null,
  settled: null,
};

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: 'merge', class: 'clear', head: HEAD, reran: false, reason: 'a small fix', brief: '', ask: null, ...overrides };
}

type RunOptions = NonNullable<Parameters<typeof run>[3]>;

/** Run the settle node on a seeded item, with the judge's decision. */
function settle(at: Install, judged: Record<string, unknown> | null, options: RunOptions = {}, start: Partial<MergeStart> = {}, inputs: Record<string, string> = {}): ScriptRun {
  if (stored(at).value === null) seed(at, item());
  const judgment = judged === null ? null : { decision: judged, base: 'dev is green' };
  return run(at, 'settle', { INPUTS_START: JSON.stringify({ ...START, ...start }), INPUTS_JUDGED: JSON.stringify(judgment), ...inputs }, options);
}

/** Declare `merge` at `head` and report what the gate did: the run's outcome, and the recorded reason. */
function gate(at: Install, options: RunOptions = {}, start: Partial<MergeStart> = {}, inputs: Record<string, string> = {}, head = HEAD): { result: ScriptRun; outcome: unknown; reason: string } {
  const result = settle(at, decision({ head }), options, start, inputs);
  const outcome = ok(result).outcome;
  return { result, outcome, reason: stored(at).value?.facts.merge?.decisions.at(-1)?.reason ?? '' };
}

const ASK = {
  question: 'PR 42 changes the SDLC pack; merge it?',
  context: `Merging changes every pack run; holding it leaves the fix out. ${PR_URL}`,
  options: [
    { id: 'merge', does: 'merges it once the gate passes at this head', cost: 'every pack run changes' },
    { id: 'return', does: 'Keep the old prompt wording.', cost: 'another build round' },
  ],
  recommendation: { option: 'merge', why: 'reviewed Ready' },
};

/** A maintainer's answer, as the asks-settled binding passes it with the asking run's result. */
function answered(id: string, text = '', asked: { head: string; brief: string } = { head: HEAD, brief: 'rework PR 42' }): Record<string, string> {
  const option = id === 'other' ? { id, does: 'Do what the answer text says.' } : ASK.options.find(candidate => candidate.id === id) ?? { id, does: 'stops work on it' };
  return {
    INPUTS_DECISIONS: JSON.stringify([{ question: ASK.question, closedAs: 'answered', answer: { decision: id, text }, option, at: LATER }]),
    INPUTS_ASKED: JSON.stringify({ ...asked, number: 7 }),
  };
}

describe('the merge stage reads its item', () => {
  test('facts reads the pull request of the item the run is on, and a review comment from anyone but a listed maintainer is no verdict', () => {
    const at = install();
    seed(at, item());
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'judge', item: SUBJECT, pr: PR, facts: FACTS, base: FACTS_BASE });
    const forged = ok(run(at, 'facts', {}, { comments: [{ ...REVIEWED, author: 'outsider' }] })) as { facts: PrFacts };
    expect(forged.facts.verdict.state).toBe('none');
  }, 60_000);

  test('facts refuses an item the build queue would accept for another round, one already settled, and a run on no issue item', () => {
    const at = install();
    // Re-triaged after its build round began: the build queue's, whatever its build status says.
    seed(at, item(BUILT, undefined, { facts: { triage: { ...TRIAGE, at: LATER }, build: BUILT } }));
    expect(run(at, 'facts', {}).stderr).toContain("issue 7 is not the merge stage's");
    seed(at, item(BUILT, merge('merged')));
    expect(run(at, 'facts', {}).stderr).toContain('merge status merged');
    expect(run(at, 'facts', { RUN_ITEM_KEY: '' }).stderr).toContain('the run is on no item');
    expect(run(at, 'facts', { RUN_ITEM_KEY: 'pr-7' }).stderr).toContain('the run is on item pr-7');
  }, 60_000);

  test('a run a check woke waits again without the judge only while what it waited for is still not there at that commit', () => {
    const at = install();
    seed(at, item());
    const woken = (event: string, about: string, pr: FakePr): unknown =>
      ok(run(at, 'facts', { INPUTS_WAITED: JSON.stringify({ event, about }) }, { pr })).path;
    expect(woken('checks', HEAD, { checks: 'pending' })).toBe('wait');
    expect(woken('checks', HEAD, { checks: 'green' })).toBe('judge');
    expect(woken('checks', HEAD, { checks: 'red' })).toBe('judge');
    expect(woken('checks', OLD, { checks: 'pending' })).toBe('judge');
    expect(woken('base-checks', OLD, { baseChecks: 'red' })).toBe('wait');
    expect(woken('base-checks', OLD, {})).toBe('judge');
  }, 60_000);

  test('a pull request merged or closed before the run is settled without the judge', () => {
    const at = install();
    seed(at, item());
    const merged = ok(run(at, 'facts', {}, { pr: { state: 'MERGED' } })) as unknown as MergeStart;
    expect(merged).toMatchObject({ path: 'settle', settled: { status: 'merged' } });
    expect(ok(settle(at, null, { pr: { state: 'MERGED' } }, merged)).outcome).toBe('merged');
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'merged', decisions: [{ head: HEAD }] } } });
    seed(at, item());
    expect(ok(run(at, 'facts', {}, { pr: { state: 'CLOSED' } }))).toMatchObject({ path: 'settle', settled: { status: 'parked' } });
  }, 60_000);
});

describe('the merge stage settles its item', () => {
  test('the gate refuses an unreadable base and merges nothing', () => {
    const at = install();
    const unread = settle(at, decision(), { pr: { baseUnreadable: true } });
    expect(unread.code).toBe(1);
    expect(unread.stderr).toContain('forge checks.commit failed: HTTP 502 reading base');
    expect(merges(unread)).toEqual([]);
  }, 60_000);

  test('the gate refuses two trusted review comments and merges nothing', () => {
    const duplicate = gate(install(), { comments: [REVIEWED, { ...REVIEWED, id: 2 }] });
    expect(duplicate).toMatchObject({ outcome: 'waiting', reason: 'not merged: its review verdict is duplicate' });
    expect(merges(duplicate.result)).toEqual([]);
  }, 60_000);

  test('the gate fails visibly and merges nothing when the maintainer list cannot be read', () => {
    const at = install();
    seed(at, item());
    const revision = 'dev:.archon/sdlc/policy/maintainers.json';
    const objectId = spawnSync('git', ['rev-parse', revision], { cwd: at.checkout, encoding: 'utf8' }).stdout.trim();
    const object = join(at.checkout, '.git/objects', objectId.slice(0, 2), objectId.slice(2));
    expect(existsSync(object)).toBe(true);
    const before = stored(at);
    const result = settle(at, decision(), {
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

  test('settle completes after a remote advance while another fetch holds the tracking ref lock', () => {
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

    expect(ok(settle(at, decision(), { pr: { state: 'MERGED' } })).outcome).toBe('merged');
    expect(readFileSync(lock, 'utf8')).toBe('held by another fetch\n');
  }, 60_000);

  test('a merge the forge reads back is recorded at its head, whatever the judge declared', () => {
    const at = install();
    // Declared at another head; merged by hand, declared wait; merged by hand under an ask.
    for (const judged of [decision({ head: OLD }), decision({ action: 'wait', reason: 'CI pending' }), decision({ action: 'ask', ask: ASK, brief: 'rework PR 42' })]) {
      seed(at, item());
      expect(ok(settle(at, judged, { pr: { state: 'MERGED' } }))).toMatchObject({ outcome: 'merged', asks: [], waits: [] });
      expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'merged', decisions: [{ decision: 'merged (clear)', head: HEAD }] } } });
    }
  }, 60_000);

  test('the gate merges pinned to the head it passed', () => {
    const merged = gate(install());
    expect(merged.outcome).toBe('merged');
    expect(merges(merged.result)).toEqual([`forge pr.merge squash ${HEAD}`]);
  }, 60_000);

  test('a merge the forge accepts but does not make, or one that names no landed commit, is recorded as not merged', () => {
    const queued = gate(install(), { pr: { queuesMerge: true } });
    expect(queued.outcome).toBe('waiting');
    expect(queued.reason).toContain('forge pr.merge verification_failed');
    const landed = gate(install(), { pr: { landsNoCommit: true } });
    expect(landed.outcome).toBe('waiting');
    expect(landed.reason).toContain('named no landed commit');
  }, 60_000);

  test('the gate refuses a head behind the default branch that conflicts, a red check, or a verdict given at another head, and merges nothing', () => {
    const red = gate(install(), { pr: { checks: 'red', threads: 1, behind: 2, conflicts: true } });
    expect(red.reason).toBe(`not merged: it lacks 2 commits of dev at ${OLD} and its merge is conflict; CI at its head is red (test)`);
    const stale = gate(install(), { comments: [{ ...REVIEWED, body: reviewCommentBody(OLD, true, 'complete', '# Review report') }] });
    expect(stale.reason).toBe(`not merged: its review verdict is for ${OLD}, not ${HEAD}`);
    // A check the forge reports neither green nor pending counts as failing.
    const unknown = gate(install(), { pr: { checks: 'unknown' } });
    expect(unknown.reason).toBe('not merged: CI at its head is red (test)');
    expect([red, stale, unknown].flatMap(refused => merges(refused.result))).toEqual([]);
  }, 60_000);

  test.each([
    ['merge state', { mergeStateHead: OLD }, 'moved while it was read'],
    ['checks', { checksRevision: OLD }, 'are not on its head'],
  ] as const)('a %s read at another commit than the head refuses the run, and merges nothing', (_, pr, reason) => {
    const moved = settle(install(), decision(), { pr });
    expect(moved.code).toBe(1);
    expect(moved.stderr).toContain(reason);
    expect(merges(moved)).toEqual([]);
  }, 60_000);

  test('a pull request that changes a protected path, or any under the manual lane, merges only with an approval at its head', () => {
    const at = install();
    const pack = { pr: { files: ['.archon/workflows/sdlc/.pack/pack.yaml', 'src/a.ts'] } };
    const protectedPaths = { INPUTS_PROTECTED_PATHS: '.archon/workflows/**, infra/**' };
    const refused = gate(at, pack, {}, protectedPaths);
    expect(refused.reason).toBe('not merged: it changes protected paths (.archon/workflows/sdlc/.pack/pack.yaml) and no maintainer approved it at this head');
    // A change outside them merges on the auto lane, and not under the manual one.
    const manual = gate(at, { pr: { files: ['src/a.ts'] } }, { lane: 'manual' }, protectedPaths);
    expect(manual.reason).toBe('not merged: the merge lane is manual and no maintainer approved it at this head');
    // A file list read at another commit says nothing about what merges.
    const moved = gate(at, { pr: { files: ['src/a.ts'], filesRevision: OLD } }, {}, protectedPaths);
    expect(moved.reason).toContain(`its changed files were read at ${OLD}, not ${HEAD}`);
    expect([refused, manual, moved].flatMap(run => merges(run.result))).toEqual([]);
    const approved = gate(at, pack, { lane: 'manual', record: { approval: { head: HEAD, at: AT } } }, protectedPaths);
    expect(approved.outcome).toBe('merged');
  }, 60_000);

  test("the gate refuses while the default branch's CI is red, and the item waits for a check at that commit; pending does not hold it", () => {
    const at = install();
    const red = gate(at, { pr: { baseChecks: 'red' } });
    expect(red.reason).toBe(`not merged: the default branch dev is red at ${OLD} (test)`);
    expect(ok(red.result).waits).toEqual([{ event: 'base-checks', about: OLD, within_minutes: 60 }]);
    expect(merges(red.result)).toEqual([]);
    seed(at, item());
    const pending = gate(at, { pr: { baseChecks: 'pending' } });
    expect(pending.outcome).toBe('merged');
  }, 60_000);

  test('a pull request whose checks still run ends waiting for a check at exactly its head, and one asked about leaves the ask and no wait', () => {
    const at = install();
    const waiting = ok(settle(at, decision({ action: 'wait', reason: 'CI pending' }), { pr: { checks: 'pending' } }));
    expect(waiting).toMatchObject({ outcome: 'waiting', asks: [], waits: [{ event: 'checks', about: HEAD, within_minutes: 60 }] });
    const asked = ok(settle(at, decision({ action: 'ask', class: 'unclear', ask: ASK, brief: 'rework PR 42' }), { pr: { checks: 'pending' } }));
    expect(asked).toMatchObject({ outcome: 'asked', number: 7, head: HEAD, brief: 'rework PR 42', asks: [{ ...ASK, artifacts: [] }], waits: [] });
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'asking' } } });
  }, 60_000);

  test('settle says what merged, on which lane, and what went back to the build queue', () => {
    const at = install();
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const said = () =>
      readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
        .filter(argv => argv[1] === 'notice')
        .map(argv => ({ text: argv.at(-1), labels: argv.filter((_, index) => argv[index - 1] === '--label') }));
    ok(settle(at, decision(), {}, {}, { ARCHON_CALL_LOG: calls }));
    expect(said()).toEqual([{ text: `PR 42 merged at ${HEAD} (auto)`, labels: ['stage=merge', 'kind=merged', 'item=7', 'pr=42', 'lane=auto'] }]);

    // Merged at the head a maintainer approved: the manual lane.
    writeFileSync(calls, '');
    seed(at, item());
    ok(settle(at, decision(), {}, { record: { approval: { head: HEAD, at: AT } } }, { ARCHON_CALL_LOG: calls }));
    expect(said()).toEqual([{ text: `PR 42 merged at ${HEAD} (approved)`, labels: ['stage=merge', 'kind=merged', 'item=7', 'pr=42', 'lane=manual'] }]);

    writeFileSync(calls, '');
    seed(at, item());
    const returned = ok(settle(at, decision({ action: 'return', reason: 'red in src/a.ts', brief: 'fix PR 42' }), {}, {}, { ARCHON_CALL_LOG: calls }));
    expect(returned).toMatchObject({ outcome: 'returned', number: 7 });
    expect(said()).toEqual([{ text: 'PR 42 returned to build; red in src/a.ts', labels: ['stage=merge', 'kind=returned', 'item=7', 'pr=42'] }]);
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'returned' }, build: { status: 'next', brief: 'fix PR 42' } } });
  }, 60_000);
});

describe("a maintainer's answer", () => {
  /** The run the answer starts: facts reads it, and settle acts on what facts hands on. */
  function answer(at: Install, inputs: Record<string, string>, judged: Record<string, unknown> | null = null): { start: MergeStart; settled: ScriptRun } {
    const start = ok(run(at, 'facts', inputs)) as unknown as MergeStart;
    return { start, settled: settle(at, judged, {}, start, inputs) };
  }

  test('a merge approves the pull request at the head that was asked about, and at no other', () => {
    const at = install();
    const manual = { INPUTS_MERGE_LANE: 'manual' };
    seed(at, item(BUILT, merge('asking')));
    const approved = answer(at, { ...answered('merge'), ...manual }, decision());
    expect(approved.start).toMatchObject({ path: 'judge', record: { approval: { head: HEAD, at: LATER } } });
    expect(ok(approved.settled).outcome).toBe('merged');
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'merged', approval: { head: HEAD } } } });

    seed(at, item(BUILT, merge('asking')));
    const moved = answer(at, { ...answered('merge', '', { head: OLD, brief: '' }), ...manual }, decision());
    expect(ok(moved.settled).outcome).toBe('waiting');
    expect(merges(moved.settled)).toEqual([]);
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'waiting', approval: { head: OLD } } } });
  }, 60_000);

  test('a return writes its ruling into the issue body, and the build round starts from it', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking')));
    const { start, settled } = answer(at, answered('return'));
    expect(start).toMatchObject({ path: 'settle', settled: { status: 'returned' } });
    expect(ok(settled)).toMatchObject({ outcome: 'returned', number: 7 });
    const body = settled.bodies[0] ?? '';
    const heading = /## (Current scope \(maintainer ruling on the merge stage's question on PR 42, \d{4}-\d{2}-\d{2}\))/.exec(body)?.[1] ?? '';
    expect(body).toBe(`The contract.\n\n\n## ${heading}\n\nKeep the old prompt wording.\n`);
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ facts: { merge: { status: 'returned' }, build: { status: 'next' } } });
    expect(doc.facts.build?.brief).toContain('rework PR 42');
    expect(doc.facts.build?.brief).toContain(heading);
  }, 60_000);

  test('a free-text answer returns a pull request the judge wrote a brief for, and parks one it wrote none for', () => {
    const at = install();
    seed(at, item(BUILT, merge('asking')));
    const returned = answer(at, answered('other', 'Split the migration out.'));
    expect(ok(returned.settled).outcome).toBe('returned');
    expect(returned.settled.bodies[0]).toContain("The maintainer's words: Split the migration out.");

    seed(at, item(BUILT, merge('asking')));
    const parked = answer(at, answered('other', 'Wait for the release.', { head: HEAD, brief: '' }));
    expect(ok(parked.settled).outcome).toBe('parked');
    expect(stored(at).value).toMatchObject({ facts: { merge: { status: 'parked' } } });
  }, 60_000);
});

describe('the gate under ci: none', () => {
  const none = (validation: { head: string; passed: boolean }): Partial<MergeStart> => ({ ci: 'none', validation });

  test('a passing validation recorded at the head merges it, whatever the forge checks say', () => {
    const merged = gate(install(), { pr: { checks: 'red' } }, none({ head: HEAD, passed: true }));
    expect(merged.outcome).toBe('merged');
    expect(merges(merged.result)).toEqual([`forge pr.merge squash ${HEAD}`]);
  }, 60_000);

  test('a validation for another head, or a failed one, refuses and merges nothing', () => {
    const stale = gate(install(), {}, none({ head: OLD, passed: true }));
    expect(stale.reason).toBe(`not merged: its validation is for ${OLD}, not ${HEAD}`);
    const red = gate(install(), {}, none({ head: HEAD, passed: false }));
    expect(red.reason).toBe(`not merged: its validation at ${HEAD} failed`);
    expect([...merges(stale.result), ...merges(red.result)]).toEqual([]);
  }, 60_000);
});
