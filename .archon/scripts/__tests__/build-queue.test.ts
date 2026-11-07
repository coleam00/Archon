import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  type BuildAttention,
  type BuildRecord,
  type BuildRound,
  buildWaits,
  countedRounds,
  itemPullRequest,
} from '../../workflows/sdlc/.shared/build';
import { reviewCommentBody } from '../../workflows/sdlc/.shared/review-comment';
import { mergeWaits } from '../../workflows/sdlc/.shared/merge';
import { attentionWait, withOther } from '../../workflows/sdlc/.shared/queue';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import {
  newWorkItem,
  parseWorkItem,
  type TriageFacts,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import {
  type TrackerSubject, type TrackerComment, type TrackerPr, type ScriptOptions, type ScriptRun,
  forgeCalls, forgePrRecord, gitCheckout, hostCli, labelWrites, PACK, packScriptRunner, PR,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const AT = '2026-10-16T00:00:00.000Z';
const LATER = '2026-10-16T01:00:00.000Z';
const SUBJECT = { repo: PR.repo, number: 7 };
const ISSUE_URL = 'https://ghe.example.com/example/repo/issues/7';

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

function round(runId: string, at: string, reason = 'review_open'): BuildRound {
  return {
    run_id: runId,
    at,
    delivered: false,
    reason,
    pr_url: 'https://ghe.example.com/example/repo/pull/42',
    summary: `Not ready: ${reason}`,
    artifacts: `/runs/${runId}`,
  };
}

function record(overrides: Partial<BuildRecord> = {}): BuildRecord {
  return { status: 'next', brief: 'continue', rounds: [], decisions: [], at: LATER, ...overrides };
}

function triaged(overrides: Partial<WorkItem> = {}, build?: BuildRecord): WorkItem {
  return {
    ...newWorkItem(SUBJECT, AT),
    stage: 'deliver',
    trust: 'maintainer',
    facts: { triage: TRIAGE, ...(build === undefined ? {} : { build }) },
    ...overrides,
  };
}

const ATTENTION: BuildAttention = {
  what: 'Issue 7: the plan asks to relax the one-gate constraint.',
  why: 'Relaxing it delivers the outcome; keeping it leaves the stop unreachable.',
  recommendation: {
    choice: 'relax',
    why: 'the outcome needs downstream gates',
    evidence: 'plan.md open question 1',
    confidence: 'medium',
    would_change: 'a design that stops synthesis with one gate',
  },
  choices: [
    {
      id: 'relax',
      label: 'Relax it',
      does: 'continues with gates downstream',
      effect: 'continue',
      ruling: 'Synthesis and publish may gate on head_matches too.',
    },
    { id: 'park', label: 'Park it', does: 'stops working the item', effect: 'park', ruling: '' },
  ],
  if_unanswered: 'The item waits; nothing else is blocked.',
  links: ['https://ghe.example.com/example/repo/pull/42'],
};

describe('the build record', () => {
  test('an item waits on a launch stage until the queue finishes, parks or asks, and a re-triage starts it over', () => {
    expect(buildWaits(triaged())).toBe(true);
    expect(buildWaits(triaged({}, record()))).toBe(true);
    for (const status of ['ready', 'parked', 'asking'] as const) {
      expect(buildWaits(triaged({}, record({ status })))).toBe(false);
    }
    const retriaged = triaged({}, record({ status: 'parked' }));
    expect(
      buildWaits({ ...retriaged, facts: { ...retriaged.facts, triage: { ...TRIAGE, at: '2026-10-16T02:00:00.000Z' } } })
    ).toBe(true);
    for (const stage of ['new', 'needs_maintainer', 'split', 'needs_contract', 'blocked', 'close'] as const) {
      expect(buildWaits(triaged({ stage }))).toBe(false);
    }
  });

  test("an item's recorded pull request URL from another repository is refused, not guessed around", () => {
    const foreign = { ...round('r1', AT), pr_url: 'https://ghe.example.com/someone/else/pull/42' };
    expect(() => itemPullRequest([foreign], TRIAGE, PR.repo)).toThrow('is not a pull request of ghe.example.com/example/repo');
  });

  test("a fresh round's replacement pull request wins over the superseded one and triage's stale reference", () => {
    const replacement = { ...round('r2', LATER), pr_url: 'https://ghe.example.com/example/repo/pull/43' };
    expect(itemPullRequest([round('r1', AT), replacement], { ...TRIAGE, pull_request: 42 }, PR.repo)).toEqual({ repo: PR.repo, number: 43 });
  });

  test('an unresolved create refuses PR selection until a later round identifies the PR', () => {
    const unresolved = { ...round('r2', AT), reason: 'pr_create_unresolved', pr_url: '' };
    for (const prior of [[], [round('r1', AT)]]) {
      expect(() => itemPullRequest([...prior, unresolved], TRIAGE, PR.repo)).toThrow('unresolved PR create');
    }
    expect(itemPullRequest([unresolved, round('r3', AT)], TRIAGE, PR.repo)).toEqual(PR);
  });

  test('a newer re-triage settles an unresolved create: its PR overrides an older one, and no PR opens a new one', () => {
    const unresolved = { ...round('r2', AT), reason: 'pr_create_unresolved', pr_url: '' };
    for (const prior of [[], [round('r1', AT)]]) {
      for (const at of ['2026-10-15T23:00:00.000Z', AT]) {
        expect(() => itemPullRequest([...prior, unresolved], { ...TRIAGE, at, pull_request: 43 }, PR.repo)).toThrow('unresolved PR create');
      }
      const newer = { ...TRIAGE, at: '2026-10-16T03:00:00.000Z', pull_request: 43 };
      expect(itemPullRequest([...prior, unresolved], newer, PR.repo)).toEqual({ ...PR, number: 43 });
      expect(itemPullRequest([...prior, unresolved], { ...newer, pull_request: null }, PR.repo)).toBeNull();
    }
  });

  test('the rounds since a re-triage or a maintainer answer count toward the round cap', () => {
    const rounds = [round('a', '2026-10-16T00:30:00.000Z'), round('b', '2026-10-16T01:30:00.000Z'), round('c', '2026-10-16T02:30:00.000Z')];
    expect(countedRounds(triaged({}, record({ rounds })))).toBe(3);
    const answered = record({
      rounds,
      decisions: [
        {
          at: '2026-10-16T02:00:00.000Z',
          run_id: 'b',
          decision: 'answered: continue',
          reason: 'Relax it',
          links: [],
          answer: { choice: 'relax', text: '', at: '2026-10-16T02:00:00.000Z' },
        },
      ],
    });
    expect(countedRounds(triaged({}, answered))).toBe(1);
  });
});

// --- the scripts, run as the engine runs them --------------------------------------

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');

interface Install {
  readonly checkout: string;
  readonly env: Record<string, string>;
}

function install(): Install {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), 'archon-build-home-')));
  return {
    checkout,
    env: {
      ARCHON_HOME: home,
      HOME: home,
      DATABASE_URL: '',
      ARCHON_TELEMETRY_DISABLED: '1',
      INTAKE_STATE_CWD: checkout, INTAKE_HOST_CLI: JSON.stringify(hostCli()),
    },
  };
}

/** Run pack code in this process against the install's state store. */
function inProcess<T>(at: Install, body: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, at.env, {
    ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]),
  });
  try {
    return body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** Store the item; a claimed one takes its run's lease, as a real claim does. */
function seed(at: Install, doc: WorkItem): void {
  inProcess(at, () => {
    const stored = stateGet('work/7');
    if (doc.claim !== null) process.env.WORKFLOW_ID = doc.claim.run_id;
    const lease = doc.claim === null ? undefined : 'take';
    expect(statePut('work/7', doc, stored.revision, lease)).toBe('ok');
  });
}

function stored(at: Install): { revision: number; value: WorkItem | null } {
  return inProcess(at, () => {
    const read = stateGet('work/7');
    return { revision: read.revision, value: read.value === null ? null : parseWorkItem(read.value) };
  });
}

function run(
  at: Install,
  script: 'facts' | 'blocked' | 'apply' | 'checkout' | 'ruling' | 'retriage',
  inputs: Record<string, string>,
  options: {
    issue?: TrackerSubject;
    pr?: TrackerPr;
    comments?: readonly TrackerComment[];
    writeLost?: boolean;
    preload?: ScriptOptions['preload'];
  } = {}
): ScriptRun {
  return runPackScript(`build-queue/scripts/${script}`, {
    cwd: at.checkout,
    preload: options.preload,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    tracker: {
      issue: { number: 7, author: 'Maintainer', body: 'The contract.', ...options.issue },
      issueLabels: ['archon-ready'],
      repositoryLabels: [],
      pr: { state: 'OPEN', headRefName: 'feature', ...options.pr },
      comments: options.comments,
      writeLost: options.writeLost,
    },
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_ROUND_LIMIT: '3',
      ...inputs,
    },
  });
}

function ok(result: ScriptRun): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const ENDING = { delivered: false, reason: 'review_open', pr_url: 'https://ghe.example.com/example/repo/pull/42', summary: 'Not ready: one finding' };
const CLAIMED = { claim: { run_id: 'run-1', at: AT, requests: [] } };

/** A run that named no item, whose operator set the build-queue binding. */
const SELECTED = { INPUTS_BUILD_QUEUE_BINDING: '/bindings/build-queue.json', INPUTS_NUMBER: '' };

/**
 * The next round fires the build-queue binding for the item it continues, keyed by the
 * item and this run alone, so a retry repeats the key and starts nothing twice.
 */
function expectNextRound(calls: string): void {
  const fire = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[0] === 'trigger');
  expect(fire?.slice(0, 6)).toEqual([
    'trigger', 'fire', '--config', '/bindings/build-queue.json', '--delivery-id', 'build-round:ghe.example.com/example/repo#7:run-1',
  ]);
  const inputs = fire?.[fire.indexOf('--inputs') + 1] ?? '';
  expect(JSON.parse(readFileSync(inputs, 'utf8'))).toEqual({ number: '7', repo_host: 'ghe.example.com', repo_path: 'example/repo' });
}

function applyInputs(answer: Record<string, unknown>): Record<string, string> {
  return {
    INPUTS_PATH: 'route',
    INPUTS_ITEM: JSON.stringify(SUBJECT),
    INPUTS_ROUTE: JSON.stringify({ decision: 'launch', brief: 'deliver 7', reason: 'a contract', attention: null }),
    INPUTS_ENDING: JSON.stringify(ENDING),
    INPUTS_ANSWER: JSON.stringify(answer),
  };
}

const CONTINUE = { decision: 'continue', brief: 'continue PR 42 on R1', push: null, reason: 'R1 is correctable', ask_class: 'scope', attention: null };
const ASK = { decision: 'ask', brief: 'continue PR 42 under the ruling', push: null, reason: 'the plan asks to relax a constraint', ask_class: 'stop', attention: ATTENTION };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
// matching: the head stays at the reviewed commit. prewrite: it moves before the ready
// write, so nothing is written. raced: it moves as the PR goes ready, so the queue puts
// the PR back to draft.
const READY_CASES = ['matching', 'prewrite', 'raced'] as const;
type ReadyCase = (typeof READY_CASES)[number];

function readyPreload(scenario: ReadyCase): string {
  return `
import { writeFileSync } from 'node:fs';
import { forgeOperation } from ${JSON.stringify(resolve(import.meta.dir, 'deliver-checks-harness.ts'))};
const scenario = ${JSON.stringify(scenario)};
const current = ${JSON.stringify(forgePrRecord({ head_revision: HEAD_A }))};
const calls = [];
const writes = [];
const delegate = Bun.spawnSync.bind(Bun);
const save = () => writeFileSync('{ARTIFACTS}/ready-state.json', JSON.stringify({ current, calls, writes }));
const response = op => {
  save();
  const stdout = forgeOperation(op, op === 'pr.view' ? { pr: current } : { target: { repo: current.repo, number: current.number }, outcome: 'applied', changed: true, pr: current });
  return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from('') };
};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const forgeAt = argv.indexOf('forge');
  if (forgeAt < 0 || !['pr.view', 'pr.ready', 'pr.draft'].includes(argv[forgeAt + 1])) return delegate(argv, settings);
  const op = argv[forgeAt + 1];
  calls.push(op);
  if (scenario === 'prewrite') current.head_revision = '${HEAD_B}';
  if (op === 'pr.ready') {
    current.is_draft = false;
    if (scenario === 'raced') current.head_revision = '${HEAD_B}';
  }
  if (op === 'pr.draft') current.is_draft = true;
  if (op !== 'pr.view') writes.push(op);
  return response(op);
} });
`;
}

interface ReadyObservation {
  current: { head_revision: string; is_draft: boolean; state: string };
  calls: string[];
  writes: string[];
}

describe('the build queue scripts', () => {
  describe('the ready transition', () => {
    test.each([...READY_CASES])('%s', scenario => {
      const at = install();
      seed(at, triaged(CLAIMED));
      const before = stored(at);
      const result = run(at, 'apply', {
        INPUTS_PATH: 'route',
        INPUTS_ITEM: JSON.stringify(SUBJECT),
        INPUTS_ROUTE: JSON.stringify({ decision: 'ready', ready_head: HEAD_A, reason: 'reviewed', brief: '', attention: null }),
        INPUTS_PULL_REQUEST: JSON.stringify(forgePrRecord({ head_revision: HEAD_A })),
        INPUTS_ENDING: 'null',
        INPUTS_ANSWER: 'null',
      }, { preload: readyPreload(scenario) });
      const observed = JSON.parse(readFileSync(join(result.artifacts, 'ready-state.json'), 'utf8')) as ReadyObservation;
      if (scenario === 'matching') {
        expect(ok(result).summary).toContain(`marked ready at ${HEAD_A}`);
        expect(observed.current).toMatchObject({ head_revision: HEAD_A, is_draft: false });
        expect(observed.writes).toEqual(['pr.ready']);
        expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'ready', decisions: [{ decision: 'ready' }] } } });
        return;
      }
      expect(result.code).not.toBe(0);
      expect(stored(at)).toEqual(before);
      expect(observed.writes).toEqual(scenario === 'prewrite' ? [] : ['pr.ready', 'pr.draft']);
      expect(observed.current.is_draft).toBe(true);
    });
  });

  test("facts claims a triaged item without taking intake's requests, and writes the issue the agents read", () => {
    const at = install();
    const request = { at: AT, run_id: 'event', action: 'edited' as const, label: null, actor: null, body_digest: null };
    seed(at, triaged({ requests: [request] }));
    const parentNumber = process.env.INPUTS_NUMBER;
    let picked: ScriptRun;
    try {
      process.env.INPUTS_NUMBER = '4807';
      picked = run(at, 'facts', {});
    } finally {
      if (parentNumber === undefined) delete process.env.INPUTS_NUMBER;
      else process.env.INPUTS_NUMBER = parentNumber;
    }
    expect(ok(picked)).toMatchObject({ path: 'route', item: SUBJECT, url: ISSUE_URL, brief: '', at_cap: false });
    expect(stored(at).value).toMatchObject({
      claim: { run_id: 'run-1', requests: [], branch: 'build/7-an-issue-run-1' },
      requests: [request],
    });
    expect(readFileSync(join(picked.artifacts, 'build/issue.md'), 'utf8')).toContain('The contract.');
    // The item is now claimed, so the next pickup finds nothing.
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: '{"run-1":"running"}' }))).toMatchObject({ path: 'idle', item: null });
  }, 60_000);

  test('facts verifies a PR explicitly reconciled by newer triage before continuing it', () => {
    const at = install();
    const unresolved = { ...round('r2', AT), reason: 'pr_create_unresolved', pr_url: '' };
    const doc = triaged({}, record({ status: 'parked', rounds: [unresolved] }));
    seed(at, { ...doc, facts: { ...doc.facts, triage: { ...TRIAGE, at: '2026-10-16T03:00:00.000Z', pull_request: 42 } } });
    const result = run(at, 'facts', {});
    expect(ok(result)).toMatchObject({ path: 'route', pull_request: { number: 42, state: 'open' }, continues: 42, branch: 'build/7-an-issue-run-1' });
    expect(forgeCalls(result).some(call => call.op === 'pr.view')).toBe(true);
  });

  test("facts puts an item with an open pull request on that pull request's branch, and names a first round's branch after the issue", () => {
    const at = install();
    // A failed round after the pull request's round opened none; the item's PR is still 42.
    const rounds = [round('r1', AT), { ...round('r2', LATER, 'failed'), pr_url: '' }];
    seed(at, triaged({}, record({ rounds })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'route', pull_request: { number: 42, state: 'open' }, continues: 42, branch: 'build/7-an-issue-run-1' });
    seed(at, triaged({ claim: null, facts: { triage: { ...TRIAGE, pull_request: 42 } } }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ pull_request: { number: 42 }, continues: 42, branch: 'build/7-an-issue-run-1' });
    seed(at, triaged({ claim: null }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ pull_request: null, continues: null, branch: 'build/7-an-issue-run-1' });
  }, 60_000);

  test('a closed pull request, or one from a fork, is not continued: the round gets a new branch', () => {
    const at = install();
    seed(at, triaged({}, record({ rounds: [round('r1', AT)] })));
    const closed = ok(run(at, 'facts', {}, { pr: { state: 'CLOSED' } }));
    expect(closed).toMatchObject({ pull_request: { number: 42, state: 'closed' }, continues: null, branch: 'build/7-an-issue-run-1' });
    seed(at, triaged({ claim: null }, record({ rounds: [round('r1', AT)] })));
    const fork = ok(run(at, 'facts', {}, { pr: { headRepositoryOwner: { login: 'someone-else' } } }));
    expect(fork).toMatchObject({
      pull_request: { number: 42, state: 'open', head_repo: { path: 'someone-else/repo' } },
      continues: null,
      branch: 'build/7-an-issue-run-1',
    });
  }, 60_000);

  test("releasing a cancelled round's claim records the pull request its branch opened, and the next round continues it", () => {
    const at = install();
    const branch = 'build/7-an-issue-run-1';
    const cancelled = { INTAKE_RUN_STATUSES: '{"run-1":"cancelled"}', WORKFLOW_ID: 'run-2' };
    seed(at, triaged({ claim: { run_id: 'run-1', at: AT, requests: [], branch } }));
    expect(ok(run(at, 'facts', cancelled, { pr: { headRefName: branch } }))).toMatchObject({ continues: 42 });
    expect(stored(at).value?.facts.build?.rounds).toEqual([
      expect.objectContaining({ run_id: 'run-1', delivered: false, reason: 'ended_undecided', pr_url: 'https://ghe.example.com/example/repo/pull/42' }),
    ]);
    // The run's pull request was closed before the release; it is still the run's round.
    seed(at, triaged({ claim: { run_id: 'run-1', at: AT, requests: [], branch } }));
    const picked = ok(run(at, 'facts', cancelled, { pr: { state: 'CLOSED', headRefName: branch } }));
    expect(stored(at).value?.facts.build?.rounds).toEqual([
      expect.objectContaining({ run_id: 'run-1', reason: 'ended_undecided', pr_url: 'https://ghe.example.com/example/repo/pull/42' }),
    ]);
    expect(picked).toMatchObject({ pull_request: { number: 42 }, continues: null, branch: 'build/7-an-issue-run-2' });
    // A run whose branch opened no pull request leaves no round.
    seed(at, triaged({ claim: { run_id: 'run-1', at: AT, requests: [], branch } }));
    expect(ok(run(at, 'facts', cancelled))).toMatchObject({ pull_request: null, continues: null });
    expect(stored(at).value?.facts.build).toBeUndefined();
  }, 60_000);

  test('items intake has not routed, and items the queue finished, are never picked up', () => {
    const at = install();
    seed(at, triaged({ stage: 'needs_contract' }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    seed(at, triaged({}, record({ status: 'ready' })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    expect(stored(at).value?.claim).toBeNull();
  }, 60_000);

  test('a blocked item judged unblocked gets archon-triage and an intake run, and is not listed again until its revisit is due', () => {
    const at = install();
    seed(at, triaged({ stage: 'blocked' }));
    const blocked = ok(run(at, 'blocked', { INPUTS_RETRIAGE_AS: 'maintainer' })).blocked;
    expect(blocked).toEqual([{ number: 7, summary: '' }]);
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const retriage = (judged: unknown[]) =>
      run(at, 'retriage', {
        INPUTS_BLOCKED: JSON.stringify(blocked),
        INPUTS_RETRIAGE: JSON.stringify(judged),
        INPUTS_RETRIAGE_AS: 'maintainer',
        ARCHON_CALL_LOG: calls,
      });
    expect(retriage([{ number: 9, reason: 'r' }]).stderr).toContain('issue 9, which it was not given');

    const sent = retriage([{ number: 7, reason: '#5 merged' }]);
    expect(ok(sent)).toMatchObject({ retriaged: [7] });
    expect(labelWrites(sent, 7).add).toEqual(['archon-triage']);
    const launch = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');
    expect(launch).toEqual(expect.arrayContaining(['archon-intake', 'number=7', 'action=added', 'label=archon-triage', 'label_actor=maintainer', '--detach']));
    expect(ok(run(at, 'blocked', { WORKFLOW_ID: 'run-2', INPUTS_RETRIAGE_AS: 'maintainer' })).blocked).toEqual([]);
  }, 60_000);

  test('a closed issue is parked without an agent', () => {
    const at = install();
    seed(at, triaged());
    expect(ok(run(at, 'facts', {}, { issue: { state: 'closed' } }))).toMatchObject({ path: 'closed' });
    const applied = ok(
      run(at, 'apply', {
        INPUTS_PATH: 'closed',
        INPUTS_ITEM: JSON.stringify(SUBJECT),
        INPUTS_ROUTE: 'null',
        INPUTS_ENDING: 'null',
        INPUTS_ANSWER: 'null',
      })
    );
    expect(applied).toMatchObject({ decision: 'parked', attention: '' });
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'parked', rounds: [] } } });
  }, 60_000);

  test('a continue records the round and the brief, releases the claim, and starts the next round at once', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const applied = run(at, 'apply', { ...applyInputs(CONTINUE), ...SELECTED, ARCHON_CALL_LOG: calls });
    expect(ok(applied)).toMatchObject({ decision: 'continue', attention: '', options: [], asked: null });
    expectNextRound(calls);
    expect(ok(applied).summary).toContain('its next round started at once (run fired-run)');
    const doc = stored(at).value;
    expect(doc).toMatchObject({
      claim: null,
      facts: {
        build: {
          status: 'next',
          brief: 'continue PR 42 on R1',
          rounds: [{ run_id: 'run-1', reason: 'review_open', artifacts: applied.artifacts }],
          decisions: [{ decision: 'continue', reason: 'R1 is correctable' }],
        },
      },
    });
    expect(buildWaits(doc as WorkItem)).toBe(true);
  }, 60_000);

  test('a continue whose next round fails to start leaves the item waiting for the next queue run', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = run(at, 'apply', {
      ...applyInputs(CONTINUE),
      ...SELECTED,
      ARCHON_RUN_REFUSES: '1',
    });
    expect(applied.code).toBe(0);
    expect(applied.stderr).toContain('its next round did not start');
    expect((JSON.parse(applied.stdout) as { summary: string }).summary).toContain('its next round did not start (refused), so the next queue run picks it up');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'next', brief: 'continue PR 42 on R1' } } });
  }, 60_000);

  test('an ask keeps the claim and raises one attention item carrying every field and the declared choices', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = ok(run(at, 'apply', applyInputs(ASK)));
    expect(applied).toMatchObject({
      decision: 'asked',
      class: 'stop',
      asked: { attention: withOther(ATTENTION, 'continue'), brief: 'continue PR 42 under the ruling', by: 'stop' },
    });
    // The wait carries the choices and the recommendation; the message carries the rest.
    const wait = attentionWait('Build queue, issue 7: stop decision', withOther(ATTENTION, 'continue'));
    expect(applied).toMatchObject({ attention: wait.message, options: wait.options, recommendation: wait.recommendation });
    expect((applied.options as { id: string }[]).map(option => option.id)).toEqual(['relax', 'park', 'other']);
    expect(applied.recommendation).toEqual({ option: 'relax', why: ATTENTION.recommendation.why, confidence: 'medium' });
    for (const part of [
      ATTENTION.what,
      ATTENTION.why,
      ATTENTION.recommendation.evidence,
      ATTENTION.recommendation.would_change,
      ATTENTION.if_unanswered,
      ATTENTION.links[0],
    ])
      expect(applied.attention).toContain(part);
    expect(stored(at).value).toMatchObject({
      claim: { run_id: 'run-1' },
      facts: { build: { status: 'asking', brief: '', decisions: [{ decision: 'ask stop' }] } },
    });
  }, 60_000);

  test('an attention item recommending a choice it does not offer refuses before any write', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const before = stored(at).revision;
    const bad = { ...ASK, attention: { ...ATTENTION, recommendation: { ...ATTENTION.recommendation, choice: 'merge' } } };
    const applied = run(at, 'apply', applyInputs(bad));
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toContain('"merge" is not offered');
    expect(stored(at).revision).toBe(before);
  }, 60_000);

  const PUSH = { push: { repo: PR.repo, number: PR.number } };

  function expectPushed(at: Install, applied: Record<string, unknown>): void {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: at.checkout, encoding: 'utf8' }).stdout.trim();
    const remote = spawnSync('git', ['ls-remote', 'upstream', 'refs/heads/feature'], { cwd: at.checkout, encoding: 'utf8' }).stdout;
    expect(remote.split(/\s+/)[0]).toBe(head);
    expect(applied.summary).toContain(`pushed ${head} to feature`);
    expect(stored(at).value?.facts.build?.decisions.at(-1)?.reason).toContain(`pushed ${head}`);
  }

  test("a continue that names its pull request pushes the checkout's commits and reads them back first", () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    expectPushed(at, ok(run(at, 'apply', applyInputs({ ...CONTINUE, ...PUSH }))));
  }, 60_000);

  test('a run that asks still pushes the commits the round left unpushed', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = ok(run(at, 'apply', applyInputs({ ...ASK, ...PUSH })));
    expect(applied).toMatchObject({ decision: 'asked', class: 'stop' });
    expectPushed(at, applied);
  }, 60_000);

  test('a done marks the item ready, pushes what the round left, and releases it for good', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const done = { decision: 'done', brief: '', ...PUSH, reason: 'Ready at the head and CI green', attention: null };
    const applied = ok(run(at, 'apply', applyInputs(done)));
    expect(applied).toMatchObject({ decision: 'ready', attention: '', asked: null });
    expectPushed(at, applied);
    const doc = stored(at).value;
    expect(doc).toMatchObject({ claim: null, facts: { build: { status: 'ready', brief: '', decisions: [{ decision: 'ready' }] } } });
    expect(doc?.facts.build?.rounds).toHaveLength(1);
    expect(buildWaits(doc as WorkItem)).toBe(false);
  }, 60_000);

  test('a closed pull request takes no push, and nothing is recorded', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const before = stored(at).revision;
    const applied = run(at, 'apply', applyInputs({ ...CONTINUE, push: { repo: PR.repo, number: PR.number } }), {
      pr: { state: 'CLOSED' },
    });
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toContain('is closed; nothing is pushed');
    expect(stored(at).revision).toBe(before);
  }, 60_000);

  const ASKED = JSON.stringify({ attention: ATTENTION, brief: 'continue PR 42 under the ruling', by: 'stop' });
  /** The answer's value: the wait returns the chosen choice itself. */
  const choiceOf = (asked: string, id: string): string =>
    JSON.stringify(
      (JSON.parse(asked) as { attention: { choices: { id: string }[] } }).attention.choices.find(choice => choice.id === id)
    );

  test("a maintainer's choice is written into the issue body as a dated scope section, and the next launch starts from it", () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const ruled = run(at, 'ruling', {
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_ASKED: ASKED,
      INPUTS_CHOICE: choiceOf(ASKED, 'relax'),
      INPUTS_TEXT: 'Only for this item.',
      ...SELECTED,
      ARCHON_CALL_LOG: calls,
    });
    const output = ok(ruled);
    // The answer continues the item at once through the build-queue binding.
    expectNextRound(calls);
    expect(output.summary).toContain('its next round started at once (run fired-run)');
    const heading = output.section as string;
    expect(heading).toMatch(/^Current scope \(maintainer ruling on the build queue's question on a stopped run, \d{4}-\d{2}-\d{2}\)$/);
    expect(ruled.bodies).toEqual([
      `The contract.\n\n\n## ${heading}\n\nSynthesis and publish may gate on head_matches too.\n\nThe maintainer's words: Only for this item.\n`,
    ]);
    const build = stored(at).value?.facts.build;
    expect(stored(at).value?.claim).toBeNull();
    expect(build).toMatchObject({ status: 'next', decisions: [{ decision: 'answered: continue', answer: { choice: 'relax', text: 'Only for this item.' } }] });
    expect(build?.brief).toContain('continue PR 42 under the ruling');
    expect(build?.brief).toContain(heading);
  }, 60_000);

  test('a park with no ruling and no words writes no section and stops working the item', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const ruled = run(at, 'ruling', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: ASKED, INPUTS_CHOICE: choiceOf(ASKED, 'park'), INPUTS_TEXT: '' });
    expect(ok(ruled)).toMatchObject({ decision: 'park', section: '' });
    expect(ruled.bodies).toEqual([]);
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'parked', brief: '' } } });
  }, 60_000);

  const READY = { id: 'operator-finishes', label: 'Done by hand', does: 'hands the PR on', effect: 'ready' as const, ruling: '' };
  const READY_ASKED = JSON.stringify({ attention: { ...ATTENTION, choices: [...ATTENTION.choices, READY] }, brief: 'b', by: 'stop' });

  test('a ready answer releases the item to the merge queue with the PR triage named', () => {
    const at = install();
    seed(at, triaged({ ...CLAIMED, facts: { triage: { ...TRIAGE, pull_request: 42 } } }, record({ status: 'asking', brief: '' })));
    expect(ok(run(at, 'ruling', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: READY_ASKED, INPUTS_CHOICE: choiceOf(READY_ASKED, 'operator-finishes'), INPUTS_TEXT: '' })).decision).toBe('ready');
    const doc = stored(at).value as WorkItem;
    expect(doc).toMatchObject({ claim: null, facts: { build: { status: 'ready' } } });
    expect(buildWaits(doc)).toBe(false);
    expect(mergeWaits(doc)).toBe(true);
  }, 60_000);

  test('a ready answer on an item with no pull request is refused before the issue body or the work item changes', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const before = stored(at);
    const asked = JSON.stringify({ attention: { ...ATTENTION, choices: [...ATTENTION.choices, { ...READY, ruling: 'Done by hand.' }] }, brief: 'b', by: 'stop' });
    const ruled = run(at, 'ruling', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: asked, INPUTS_CHOICE: choiceOf(asked, 'operator-finishes'), INPUTS_TEXT: '' });
    expect(ruled.code).not.toBe(0);
    expect(ruled.stderr).toContain('has no pull request');
    expect(ruled.bodies).toEqual([]);
    expect(stored(at)).toEqual(before);
  }, 60_000);

  test('a section that does not read back records nothing', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const before = stored(at).revision;
    const lost = run(
      at,
      'ruling',
      { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: ASKED, INPUTS_CHOICE: choiceOf(ASKED, 'relax'), INPUTS_TEXT: '' },
      { writeLost: true }
    );
    expect(lost.code).not.toBe(0);
    expect(lost.stderr).toContain('workitem.edit-body verification_failed');
    expect(stored(at).revision).toBe(before);
  }, 60_000);
});

describe('the build queue checkout', () => {
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  /** What checkout emitted, after checking it carries exactly the keys its node's output format requires. */
  function emitted(result: ScriptRun): unknown {
    const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'build-queue/archon-build-queue.yaml'), 'utf8')) as {
      nodes: { id: string; output_format?: { required: string[] } }[];
    };
    const output = ok(result) as Record<string, unknown>;
    const required = workflow.nodes.find(node => node.id === 'checkout')?.output_format?.required;
    expect(Object.keys(output).sort()).toEqual([...(required ?? [])].sort());
    return output;
  }

  test('a continued round starts at the PR head on its queue branch and reports the head its last review named', () => {
    const at = install();
    git(at.checkout, 'checkout', '-q', 'dev');
    mkdirSync(join(at.checkout, '.archon/sdlc/policy'), { recursive: true });
    writeFileSync(join(at.checkout, '.archon/sdlc/policy/maintainers.json'), '["Maintainer"]\n');
    git(at.checkout, 'add', '.archon/sdlc/policy/maintainers.json');
    git(at.checkout, 'commit', '-q', '-m', 'maintainers');
    git(at.checkout, 'push', '-q', 'upstream', 'HEAD:dev');
    git(at.checkout, 'push', '-q', 'upstream', 'feature');
    const head = git(at.checkout, 'rev-parse', 'feature');
    // The review judged an older commit; the pull request gained commits after it.
    const reviewed = git(at.checkout, 'rev-parse', 'feature~1');
    const branch = 'build/7-continued-round';
    git(at.checkout, 'checkout', '-q', '-b', branch, 'dev');
    const result = run(
      at,
      'checkout',
      { INPUTS_CANDIDATE: '42', INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: JSON.stringify({ repo: PR.repo, number: 42 }) },
      { pr: { headRefOid: head }, comments: [{ id: 1, author: 'Maintainer', body: reviewCommentBody(reviewed, false, 'open', '# Review report') }] }
    );
    expect(emitted(result)).toEqual({ head, reviewed, pull_request: 42 });
    const inputs = { INPUTS_CANDIDATE: '42', INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: JSON.stringify({ repo: PR.repo, number: 42 }) };
    // A pull request never reviewed has no baseline, and is not mistaken for one reviewed at its head.
    expect(emitted(run(at, 'checkout', inputs, { pr: { headRefOid: head } }))).toEqual({ head, reviewed: null, pull_request: 42 });
    const review = { id: 1, author: 'Maintainer', body: reviewCommentBody(reviewed, false, 'open', '# Review report') };
    const duplicate = run(at, 'checkout', inputs, { pr: { headRefOid: head }, comments: [review, { ...review, id: 2 }] });
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toContain('more than one trusted review comment');
    expect(git(at.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(at.checkout, 'branch', '--show-current')).toBe(branch);

    // The review is read through `archon forge`, from this preload's comments.
    const forgeComments = [{ id: '1', body: review.body, url: 'https://ghe.example.com/example/repo/pull/42#issuecomment-1', author: { host: PR.repo.host, id: '1', login: 'Maintainer' } }];
    const forge = `
const harness = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[2] !== 'forge') return harness(argv, settings);
  const op = argv[3];
  const value = op === 'pr.view'
    ? { title: 'Fix', body: '', pr: { schemaVersion: 1, repo: ${JSON.stringify(PR.repo)}, number: 42, url: 'https://ghe.example.com/example/repo/pull/42', head: 'feature', base: 'dev', is_draft: false, state: 'open', head_repo: ${JSON.stringify(PR.repo)}, head_revision: ${JSON.stringify(head)}, base_revision: null, maintainer_can_modify: null } }
    : op === 'workitem.comments' ? { comments: ${JSON.stringify(forgeComments)} } : null;
  const body = value === null ? { operationId: 'op', ok: false, error: { kind: 'forge_error', message: 'unexpected ' + op } } : { operationId: 'op', ok: true, result: { op, value } };
  return { exitCode: value === null ? 1 : 0, stdout: Buffer.from(JSON.stringify(body)), stderr: Buffer.from('') };
} });
`;
    expect(emitted(run(at, 'checkout', inputs, { preload: forge, pr: { headRefOid: head } }))).toEqual({ head, reviewed, pull_request: 42 });
  }, 60_000);

  test('a round route declares fresh stays on the base and tells ship none, and route cannot name a pull request facts did not offer', () => {
    const at = install();
    git(at.checkout, 'push', '-q', 'upstream', 'feature');
    git(at.checkout, 'checkout', '-q', 'dev');
    const base = git(at.checkout, 'rev-parse', 'HEAD');
    const pr = JSON.stringify({ repo: PR.repo, number: 42 });
    const item = JSON.stringify(SUBJECT);
    expect(emitted(run(at, 'checkout', { INPUTS_ITEM: item, INPUTS_CANDIDATE: '42', INPUTS_CONTINUES: 'null', INPUTS_PULL_REQUEST: pr }))).toEqual({ head: null, reviewed: null, pull_request: 'none' });
    expect(git(at.checkout, 'rev-parse', 'HEAD')).toBe(base);
    // A pull request facts never offered, such as a fork's, is not left to ship's triage either.
    expect(emitted(run(at, 'checkout', { INPUTS_ITEM: item, INPUTS_CANDIDATE: 'null', INPUTS_CONTINUES: 'null', INPUTS_PULL_REQUEST: pr }))).toEqual({ head: null, reviewed: null, pull_request: 'none' });
    expect(emitted(run(at, 'checkout', { INPUTS_ITEM: item, INPUTS_CANDIDATE: 'null', INPUTS_CONTINUES: 'null', INPUTS_PULL_REQUEST: 'null' }))).toEqual({ head: null, reviewed: null, pull_request: null });
    expect(run(at, 'checkout', { INPUTS_ITEM: item, INPUTS_CANDIDATE: 'null', INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: pr }).code).not.toBe(0);
  }, 60_000);

  test('a fresh round refuses a checkout left off the base, such as an adopted one at the superseded head', () => {
    const at = install();
    git(at.checkout, 'push', '-q', 'upstream', 'feature');
    const head = git(at.checkout, 'rev-parse', 'feature');
    const pr = JSON.stringify({ repo: PR.repo, number: 42 });
    const result = run(at, 'checkout', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_CANDIDATE: '42', INPUTS_CONTINUES: 'null', INPUTS_PULL_REQUEST: pr });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("a fresh round must start on dev, but the checkout's HEAD is not on it");
    expect(git(at.checkout, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);
});
