import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import {
  ANSWER_DECISIONS,
  APPLY_DECISIONS,
  ASKED_BY,
  BUILD_EFFECTS,
  BUILD_PATHS,
  type BuildAttention,
  type BuildRecord,
  type BuildRound,
  buildBranch,
  buildWaits,
  countedRounds,
  itemPullRequest,
  ROUTE_DECISIONS,
} from '../../workflows/sdlc/.shared/build';
import { BUILD_QUEUE_SELECTIONS } from '../../workflows/sdlc/.shared/launch';
import { CONFIDENCES, checkAttention, chosen, renderAttention, withOther } from '../../workflows/sdlc/.shared/queue';
import { MERGE_PICKUP } from '../../workflows/sdlc/.shared/merge';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import {
  applyDecision,
  INTAKE_PICKUP,
  read,
  releaseIfTerminal,
  decideIntake,
  newWorkItem,
  parseWorkItem,
  type TriageFacts,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import {
  type GhApiIssue, type GhPr, type ScriptOptions, type ScriptRun,
  forgePrRecord, gitCheckout, hostCli, PACK, packScriptRunner, PR,
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
    for (const stage of ['new', 'needs_maintainer', 'needs_contract', 'blocked', 'close'] as const) {
      expect(buildWaits(triaged({ stage }))).toBe(false);
    }
  });

  test("a first round's branch names the issue, cut to a readable slug, and the run", () => {
    expect(buildBranch(7, 'Fix: the Build queue -- reuses its own PR, a branch on every later round!', 'abcdef123456')).toBe(
      'build/7-fix-the-build-queue-reuses-its-own-pr-a-abcdef12'
    );
    expect(buildBranch(7, '!!!', 'abcdef123456')).toBe('build/7-abcdef12');
  });

  test("an item's recorded pull request URL from another repository is refused, not guessed around", () => {
    const foreign = { ...round('r1', AT), pr_url: 'https://ghe.example.com/someone/else/pull/42' };
    expect(() => itemPullRequest([foreign], TRIAGE, PR.repo)).toThrow('is not a pull request of ghe.example.com/example/repo');
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

  test('an attention item recommends a choice it offers, and an answer names a declared choice', () => {
    expect(() => checkAttention(ATTENTION)).not.toThrow();
    expect(() =>
      checkAttention({ ...ATTENTION, recommendation: { ...ATTENTION.recommendation, choice: 'other' } })
    ).toThrow('is not offered');
    expect(() =>
      checkAttention({ ...ATTENTION, choices: [ATTENTION.choices[0], ATTENTION.choices[0]] })
    ).toThrow('share one id');
    expect(chosen(ATTENTION, 'park').effect).toBe('park');
    expect(() => chosen(ATTENTION, 'approve')).toThrow('not one of the choices');
  });

  test("the paths, decisions, classes, effects and confidences are archon-build-round's own", () => {
    type Enum = { enum: string[] };
    type AttentionSchema = {
      properties: {
        recommendation: { properties: { confidence: Enum } };
        choices: { items: { properties: { effect: Enum } } };
      };
    };
    const workflow = Bun.YAML.parse(
      readFileSync(join(PACK, 'build-round/archon-build-round.yaml'), 'utf8')
    ) as { nodes: { id: string; output_format?: { properties: Record<string, unknown> } }[] };
    const field = (id: string, name: string) =>
      workflow.nodes.find(node => node.id === id)?.output_format?.properties[name] as
        | (Enum & AttentionSchema)
        | undefined;
    expect(field('facts', 'path')?.enum).toEqual([...BUILD_PATHS]);
    expect(field('route', 'decision')?.enum).toEqual([...ROUTE_DECISIONS]);
    expect(field('answer', 'decision')?.enum).toEqual([...ANSWER_DECISIONS]);
    expect(field('apply', 'decision')?.enum).toEqual([...APPLY_DECISIONS]);
    expect(field('apply', 'class')?.enum).toEqual(['', ...ASKED_BY]);
    expect(field('ruling', 'decision')?.enum).toEqual([...BUILD_EFFECTS]);
    for (const id of ['route', 'answer']) {
      const attention = field(id, 'attention')?.properties;
      expect(attention?.choices.items.properties.effect.enum).toEqual([...BUILD_EFFECTS]);
      expect(attention?.recommendation.properties.confidence.enum).toEqual([...CONFIDENCES]);
    }
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

function seed(at: Install, doc: WorkItem): void {
  inProcess(at, () => {
    const stored = stateGet('work/7');
    expect(statePut('work/7', doc, stored.revision)).toBe('ok');
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
  script: 'facts' | 'apply' | 'checkout' | 'ruling' | 'retriage' | 'admit' | 'dispatch' | 'settle',
  inputs: Record<string, string>,
  options: {
    issue?: GhApiIssue;
    pr?: GhPr;
    writeLost?: boolean;
    source?: ScriptOptions['source'];
    preload?: ScriptOptions['preload'];
    artifacts?: ScriptOptions['artifacts'];
  } = {}
): ScriptRun {
  return runPackScript(`${['admit', 'apply', 'checkout', 'ruling'].includes(script) ? 'build-round' : 'build-queue'}/scripts/${script}`, {
    cwd: at.checkout,
    source: options.source,
    preload: options.preload,
    artifacts: options.artifacts,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: {
      issue: { number: 7, author: 'Maintainer', body: 'The contract.', ...options.issue },
      issueLabels: ['archon-ready'],
      repositoryLabels: [],
      pr: { state: 'OPEN', headRefName: 'feature', ...options.pr },
      writeLost: options.writeLost,
    },
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_ORDER: '',
      INPUTS_NUMBER: '',
      INPUTS_RETRIAGE_AS: '',
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

/** Non-default selections on a run that named no item, so its own `number` is empty. */
const SELECTED = { INPUTS_ORDER: '["size asc"]', INPUTS_RETRIAGE_AS: 'maintainer', INPUTS_ROUND_LIMIT: '5', INPUTS_NUMBER: '' };

/** The next round keeps the run's config and selections, and targets the item it continues. */
function expectNextRound(calls: string): void {
  const launch = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');
  expect(launch).toEqual(
    expect.arrayContaining([
      'archon-build-queue', 'order=["size asc"]', 'retriage_as=maintainer', 'round_limit=5', 'number=7',
      '--config-from-run', 'run-1', '--detach',
    ])
  );
  expect(launch?.filter(arg => arg.startsWith('number='))).toEqual(['number=7']);
}

function applyInputs(answer: Record<string, unknown>, atCap = false): Record<string, string> {
  return {
    INPUTS_PATH: 'route',
    INPUTS_ITEM: JSON.stringify(SUBJECT),
    INPUTS_ROUTE: JSON.stringify({ decision: 'launch', brief: 'deliver 7', reason: 'a contract', attention: null }),
    INPUTS_ENDING: JSON.stringify(ENDING),
    INPUTS_ANSWER: JSON.stringify(answer),
    INPUTS_AT_CAP: String(atCap),
  };
}

const CONTINUE = { decision: 'continue', brief: 'continue PR 42 on R1', push: null, reason: 'R1 is correctable', attention: null };
const ASK = { decision: 'ask', brief: 'continue PR 42 under the ruling', push: null, reason: 'the plan asks to relax a constraint', attention: ATTENTION };

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const READY_CASES = [
  'matching', 'prewrite', 'raced', 'moved-again', 'already-draft',
  'closed', 'merged', 'refused', 'unknown', 'readback-failed', 'diagnostic-failed',
] as const;
type ReadyCase = (typeof READY_CASES)[number];

function readyPreload(source: 'gh' | 'forge', scenario: ReadyCase): string {
  return `
import { writeFileSync } from 'node:fs';
import { forgeOperation, forgeFailure } from ${JSON.stringify(resolve(import.meta.dir, 'deliver-checks-harness.ts'))};
const scenario = ${JSON.stringify(scenario)};
const selected = ${JSON.stringify(source)};
const current = ${JSON.stringify(forgePrRecord({ head_revision: HEAD_A }))};
const calls = [];
const writes = [];
let readyReturned = false;
let correctionStarted = false;
let correctionFailed = false;
let failReadback = false;
const delegate = Bun.spawnSync.bind(Bun);
const save = () => writeFileSync('{ARTIFACTS}/ready-state.json', JSON.stringify({ current, calls, writes }));
const response = (op, failure) => {
  save();
  const ghRow = {
    number: current.number, url: current.url, state: current.state.toUpperCase(),
    isDraft: current.is_draft, headRefOid: current.head_revision,
    headRefName: current.head, baseRefName: current.base,
    headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'example' },
    maintainerCanModify: null,
  };
  const stdout = selected === 'forge'
    ? failure ? forgeFailure(op, scenario === 'unknown' ? 'outcome_unknown' : scenario === 'readback-failed' ? 'verification_failed' : 'refused', failure, { leaveBehind: 'draft state may have changed' })
      : forgeOperation(op, op === 'pr.view' ? { pr: current } : { target: { repo: current.repo, number: current.number }, outcome: 'applied', changed: writes.at(-1) === op, pr: current })
    : op === 'pr.view' ? JSON.stringify(ghRow) : '';
  return { exitCode: failure ? 1 : 0, stdout: Buffer.from(stdout), stderr: Buffer.from(failure ?? '') };
};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const isGh = argv[0] === 'gh' && argv[1] === 'pr';
  const forgeAt = argv.indexOf('forge');
  const isForge = forgeAt >= 0 && ['pr.view', 'pr.ready', 'pr.draft'].includes(argv[forgeAt + 1]);
  if (!isGh && !isForge) return delegate(argv, settings);
  if ((selected === 'gh') !== isGh) throw new Error('unexpected forge source');
  const op = isGh ? argv[2] === 'view' ? 'pr.view' : argv.includes('--undo') ? 'pr.draft' : 'pr.ready' : argv[forgeAt + 1];
  calls.push(op);
  if (scenario === 'prewrite') current.head_revision = '${HEAD_B}';
  if (readyReturned && !correctionStarted) {
    correctionStarted = true;
    if (scenario === 'moved-again') current.head_revision = '${HEAD_C}';
    if (scenario === 'already-draft') current.is_draft = true;
    if (scenario === 'closed' || scenario === 'merged') current.state = scenario;
  }
  if (op === 'pr.view') {
    if (failReadback) { failReadback = false; return response(op, 'read-back unavailable'); }
    if (correctionFailed && scenario === 'diagnostic-failed') return response(op, 'diagnostic unavailable');
    if (writes.includes('pr.ready')) readyReturned = true;
    return response(op);
  }
  if (op === 'pr.ready') {
    writes.push(op);
    current.is_draft = false;
    if (scenario !== 'matching') current.head_revision = '${HEAD_B}';
    if (selected === 'forge') readyReturned = true;
    return response(op);
  }
  if (current.state !== 'open') { correctionFailed = true; return response(op, 'cannot draft ' + current.state); }
  if (current.is_draft) return response(op);
  writes.push(op);
  if (['refused', 'unknown', 'diagnostic-failed'].includes(scenario)) {
    correctionFailed = true;
    if (scenario === 'refused') current.head_revision = '${HEAD_C}';
    return response(op, 'draft permission denied; mutation evidence retained');
  }
  current.is_draft = true;
  if (scenario === 'readback-failed') {
    correctionFailed = true;
    if (selected === 'forge') return response(op, 'read-back unavailable');
    failReadback = true;
  }
  return response(op);
} });
`;
}

interface ReadyObservation {
  current: { head_revision: string; is_draft: boolean; state: string };
  calls: string[];
  writes: string[];
}

function failedCorrection(scenario: ReadyCase): boolean {
  return ['refused', 'unknown', 'diagnostic-failed', 'closed', 'merged', 'readback-failed'].includes(scenario);
}

function expectCorrectionError(result: ScriptRun, observed: ReadyObservation, scenario: ReadyCase, source: 'gh' | 'forge'): void {
  expect(result.stderr).toContain('draft correction failed');
  expect(result.stderr).toContain('Inspect');
  const expectedError = scenario === 'closed' || scenario === 'merged' ? scenario
    : scenario === 'readback-failed' ? 'read-back unavailable' : 'draft permission denied; mutation evidence retained';
  expect(result.stderr).toContain(expectedError);
  expect(observed.calls.at(-1)).toBe('pr.view');
  if (source === 'forge') expect(result.stderr).toContain('draft state may have changed');
  if (scenario === 'unknown') expect(result.stderr).toContain('outcome_unknown');
  if (scenario === 'readback-failed' && source === 'forge') expect(result.stderr).toContain('verification_failed');
  if (scenario === 'diagnostic-failed') {
    expect(result.stderr).toContain('final state unknown');
    expect(result.stderr).toContain('diagnostic unavailable');
  } else {
    expect(result.stderr).toContain(`observed ${observed.current.state}, draft=${String(observed.current.is_draft)} at ${observed.current.head_revision}`);
    if (scenario === 'refused') expect(observed.current.head_revision).toBe(HEAD_C);
  }
}

function expectDraftObservation(result: ScriptRun, observed: ReadyObservation, scenario: ReadyCase): void {
  expect(observed.current.is_draft).toBe(true);
  expect(result.stderr).toContain('observed open, draft=true');
  if (scenario === 'moved-again') {
    expect(observed.current.head_revision).toBe(HEAD_C);
    expect(result.stderr).toContain(HEAD_C);
  }
}

describe('the build queue scripts', () => {
  describe('the ready transition', () => {
    for (const source of ['gh', 'forge'] as const) {
      test.each(READY_CASES.filter(scenario => source === 'forge' || scenario !== 'unknown'))(`${source}: %s`, scenario => {
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
          INPUTS_AT_CAP: 'false',
        }, { source, preload: readyPreload(source, scenario) });
        const observed = JSON.parse(readFileSync(join(result.artifacts, 'ready-state.json'), 'utf8')) as ReadyObservation;
        if (scenario === 'matching') {
          expect(ok(result).summary).toContain(`marked ready at ${HEAD_A}`);
          expect(observed.current).toMatchObject({ head_revision: HEAD_A, is_draft: false });
          expect(observed.writes).toEqual(['pr.ready']);
          expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'ready', decisions: [{ decision: 'ready' }] } } });
          return;
        }
        if (scenario === 'raced') expect(observed.current.is_draft).toBe(true);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(stored(at)).toEqual(before);
        expect(result.stderr).toContain(HEAD_A);
        expect(result.stderr).toContain(HEAD_B);
        if (scenario === 'prewrite') {
          expect(observed.writes).toEqual([]);
          return;
        }
        const noDraftWrite = ['already-draft', 'closed', 'merged'].includes(scenario);
        expect(observed.writes).toEqual(noDraftWrite ? ['pr.ready'] : ['pr.ready', 'pr.draft']);
        if (failedCorrection(scenario)) expectCorrectionError(result, observed, scenario, source);
        else expectDraftObservation(result, observed, scenario);
        if (scenario === 'readback-failed') expect(observed.current.is_draft).toBe(true);
        if (['refused', 'unknown', 'diagnostic-failed'].includes(scenario)) expect(observed.current.is_draft).toBe(false);
        expect(observed.calls.filter(op => op === 'pr.draft')).toHaveLength(source === 'gh' && noDraftWrite ? 0 : 1);
      });
    }
  });

  test("facts claims a triaged item without taking intake's requests", () => {
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
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'run-1', requests: [] }, requests: [request] });
    // The item is now claimed, so the next pickup finds nothing.
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: '{"run-1":"running"}' }))).toMatchObject({ path: 'idle', item: null });
  }, 60_000);

  test("facts starts on an item intake wrote, carrying intake's triage report as a plain reference", () => {
    const at = install();
    const fresh = newWorkItem(SUBJECT, AT);
    const source = { author: 'maintainer', labels: [], state: 'open' as const, digest: 'sha256:x' };
    const decision = decideIntake(fresh, source, new Set(['maintainer']), AT, 'intake-run');
    // Triage emits its report as the engine's artifact pointer to intake's own run.
    const pointer = { type: 'archon_artifact', run_id: 'intake-run', path: 'triage.md' };
    const { at: _at, run_id: _runId, ...verdict } = TRIAGE;
    seed(at, applyDecision(fresh, decision, { ...verdict, closure: null, labels: [], summary: 's', report: pointer }, false, AT, 'intake-run'));
    const output = ok(run(at, 'facts', {}));
    // A tagged pointer would have to name this run; the output carries none.
    expect(JSON.stringify(output)).not.toContain('archon_artifact');
    expect((output.record as WorkItem).history.at(-1)?.report).toEqual({ run_id: 'intake-run', path: 'triage.md' });
    expect(stored(at).value?.history.at(-1)?.report).toEqual(pointer);
  }, 60_000);

  test('the round about to run reaches the cap when the rounds since the last scope change fill the limit', () => {
    const at = install();
    const rounds = [round('r1', '2026-10-16T02:00:00.000Z'), round('r2', '2026-10-16T03:00:00.000Z')];
    seed(at, triaged({}, record({ rounds })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'route', at_cap: true });
    seed(at, triaged({ claim: null }, record({ rounds: rounds.slice(0, 1) })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'route', at_cap: false });
    const answered = { at: '2026-10-16T03:30:00.000Z', run_id: 'r2', decision: 'answered: continue', reason: 'Relax it', links: [], answer: { choice: 'relax', text: '', at: '2026-10-16T03:30:00.000Z' } };
    seed(at, triaged({ claim: null }, record({ rounds, decisions: [answered] })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'route', at_cap: false });
  }, 60_000);

  test("facts puts an item with an open pull request on that pull request's branch, and names a first round's branch after the issue", () => {
    const at = install();
    // A failed round after the pull request's round opened none; the item's PR is still 42.
    const rounds = [round('r1', AT), { ...round('r2', LATER, 'failed'), pr_url: '' }];
    seed(at, triaged({}, record({ rounds })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'route', pull_request: { number: 42, state: 'open' }, continues: 42, branch: 'feature' });
    seed(at, triaged({ claim: null, facts: { triage: { ...TRIAGE, pull_request: 42 } } }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ pull_request: { number: 42 }, continues: 42, branch: 'feature' });
    seed(at, triaged({ claim: null }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ pull_request: null, continues: null, branch: 'build/7-an-issue-run-1' });
  }, 60_000);

  test('a second round before PR creation reuses the prior worker branch', () => {
    const at = install();
    seed(at, triaged({}, record({ rounds: [{ ...round('worker-previous', AT), pr_url: '' }] })));
    expect(ok(run(at, 'facts', {
      RUN_DETAILS: JSON.stringify({ 'worker-previous': { workflow_name: 'archon-build-round', metadata: { inputs: { selected_branch: 'build/7-first-pickup' } } } }),
    }))).toMatchObject({ branch: 'build/7-first-pickup', continues: null });
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

  test('items intake has not routed, and items the queue finished, are never picked up', () => {
    const at = install();
    seed(at, triaged({ stage: 'needs_contract' }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    seed(at, triaged({}, record({ status: 'ready' })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    expect(stored(at).value?.claim).toBeNull();
  }, 60_000);

  test('a named item is claimed ahead of one that sorts first, and one that cannot be built refuses with why', () => {
    const at = install();
    const urgent = { ...triaged(), subject: { ...SUBJECT, number: 8 }, facts: { triage: { ...TRIAGE, urgency: { value: 'high', reason: 'r' } } } };
    inProcess(at, () => expect(statePut('work/8', urgent, stateGet('work/8').revision)).toBe('ok'));
    seed(at, triaged());
    expect(ok(run(at, 'facts', { INPUTS_NUMBER: '7' }))).toMatchObject({ path: 'route', item: SUBJECT });
    seed(at, triaged({ stage: 'blocked' }));
    const refused = run(at, 'facts', { WORKFLOW_ID: 'run-2', INPUTS_NUMBER: '7' });
    expect(refused.stderr).toContain('issue 7 does not wait for the build queue: stage blocked');
    expect(stored(at).value?.claim).toBeNull();
  }, 60_000);

  test('a blocked item judged unblocked gets archon-triage and an intake run, and is not listed again until its revisit is due', () => {
    const at = install();
    seed(at, triaged({ stage: 'blocked' }));
    const blocked = ok(run(at, 'facts', { INPUTS_RETRIAGE_AS: 'maintainer' })).blocked;
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
    expect(sent.gh).toContain(`issue edit 7 --repo ${PR.repo.host}/${PR.repo.path} --add-label archon-triage`);
    const launch = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');
    expect(launch).toEqual(expect.arrayContaining(['archon-intake', 'number=7', 'action=added', 'label=archon-triage', 'label_actor=maintainer', '--detach']));
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2', INPUTS_RETRIAGE_AS: 'maintainer' })).blocked).toEqual([]);
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
        INPUTS_AT_CAP: 'false',
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
    // The next round runs on the run config and the input selections this run started with.
    expectNextRound(calls);
    expect(ok(applied).summary).toContain('next round started at once (run launched-archon-build-queue)');
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
      ARCHON_RUN_REFUSES: '1',
    });
    expect(applied.code).toBe(0);
    expect(applied.stderr).toContain('the next round did not start');
    expect((JSON.parse(applied.stdout) as { summary: string }).summary).toContain('the next queue run picks it up');
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'next', brief: 'continue PR 42 on R1' } } });
  }, 60_000);

  test('an ask keeps the claim and raises one attention item carrying every field and the declared choices', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = ok(run(at, 'apply', applyInputs(ASK)));
    expect(applied).toMatchObject({
      decision: 'asked',
      class: 'stop',
      options: [
        { id: 'relax', label: 'Relax it' },
        { id: 'park', label: 'Park it' },
        { id: 'other', label: 'Something else' },
      ],
      asked: { attention: withOther(ATTENTION, 'continue'), brief: 'continue PR 42 under the ruling', by: 'stop' },
    });
    expect(applied.attention).toBe(renderAttention('Build queue, issue 7: stop decision', withOther(ATTENTION, 'continue')));
    for (const part of [
      ATTENTION.what,
      ATTENTION.why,
      'Recommendation: `relax`** (medium confidence)',
      ATTENTION.recommendation.evidence,
      ATTENTION.recommendation.would_change,
      '`park` (Park it): stops working the item',
      ATTENTION.if_unanswered,
      ATTENTION.links[0],
    ])
      expect(applied.attention).toContain(part);
    expect(stored(at).value).toMatchObject({
      claim: { run_id: 'run-1' },
      facts: { build: { status: 'asking', brief: '', decisions: [{ decision: 'ask stop' }] } },
    });
  }, 60_000);

  test("at the round cap an answer's question is the scope question", () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = ok(run(at, 'apply', applyInputs({ ...ASK, brief: 'continue PR 42 on R1', reason: 'each review found new defects' }, true)));
    expect(applied).toMatchObject({ decision: 'asked', class: 'scope', asked: { brief: 'continue PR 42 on R1', by: 'scope' } });
    expect(stored(at).value?.facts.build).toMatchObject({ status: 'asking', decisions: [{ decision: 'ask scope' }] });
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

  test("a maintainer's choice is written into the issue body as a dated scope section, and the next launch starts from it", () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-calls-'))), 'calls.jsonl');
    const ruled = run(at, 'ruling', {
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_ASKED: ASKED,
      INPUTS_CHOICE: 'relax',
      INPUTS_TEXT: 'Only for this item.',
      ...SELECTED,
      ARCHON_CALL_LOG: calls,
    });
    const output = ok(ruled);
    // The answer continues the item at once, on the run config and input selections the answered run started with.
    expectNextRound(calls);
    expect(output.summary).toContain('next round started at once (run launched-archon-build-queue)');
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

  test("the queue owns 'other': an agent-declared one is replaced by the queue's", () => {
    const declared = { ...ATTENTION, choices: [...ATTENTION.choices, { id: 'other', label: 'x', does: 'x', effect: 'park' as const, ruling: 'x' }] };
    const others = withOther(declared, 'continue').choices.filter(choice => choice.id === 'other');
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ effect: 'continue', ruling: '' });
  });

  test("an 'other' answer writes its text as the ruling and continues the item", () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const asked = JSON.stringify({ attention: withOther(ATTENTION, 'continue'), brief: 'continue PR 42 under the ruling', by: 'stop' });
    const ruled = run(at, 'ruling', {
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_ASKED: asked,
      INPUTS_CHOICE: 'other',
      INPUTS_TEXT: 'Keep the field and fix the review findings by class.',
    });
    const output = ok(ruled);
    expect(output.decision).toBe('continue');
    expect(ruled.bodies[0]).toContain("The maintainer's words: Keep the field and fix the review findings by class.");
    expect(stored(at).value?.facts.build).toMatchObject({ status: 'next' });
    expect(stored(at).value?.facts.build?.brief).toContain(output.section as string);
  }, 60_000);

  test('a park with no ruling and no words writes no section and stops working the item', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const ruled = run(at, 'ruling', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'park', INPUTS_TEXT: '' });
    expect(ok(ruled)).toMatchObject({ decision: 'park', section: '' });
    expect(ruled.bodies).toEqual([]);
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'parked', brief: '' } } });
  }, 60_000);

  test('an answer that is not a declared choice, or a section that does not read back, records nothing', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ status: 'asking', brief: '' })));
    const before = stored(at).revision;
    const unknown = run(at, 'ruling', { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'approve', INPUTS_TEXT: '' });
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('"approve" is not one of the choices');
    const lost = run(
      at,
      'ruling',
      { INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_ASKED: ASKED, INPUTS_CHOICE: 'relax', INPUTS_TEXT: '' },
      { writeLost: true }
    );
    expect(lost.code).not.toBe(0);
    expect(lost.stderr).toContain('does not read back with the section');
    expect(stored(at).revision).toBe(before);
  }, 60_000);
});

describe('the build queue checkout', () => {
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  test("a round fast-forwards its selected PR branch without replacing local history", () => {
    const at = install();
    // A reused named checkout may lag the published PR head.
    git(at.checkout, 'push', '-q', 'upstream', 'feature');
    const head = git(at.checkout, 'rev-parse', 'feature');
    git(at.checkout, 'reset', '--hard', 'dev');
    const result = run(
      at,
      'checkout',
      { INPUTS_BRANCH: 'feature', INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: JSON.stringify({ repo: PR.repo, number: 42 }) },
      { pr: { headRefOid: head } }
    );
    expect(ok(result)).toEqual({ head });
    expect(git(at.checkout, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);
});

describe('build checkout refusal', () => {

  for (const condition of ['wrong branch', 'dirty', 'local commit', 'diverged'] as const) {
    test(`checkout retains ${condition} without replacing HEAD or files`, () => {
      const at = install();
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: at.checkout, encoding: 'utf8' });
        expect(result.status).toBe(0);
        return result.stdout.trim();
      };
      git('push', '-q', 'upstream', 'feature');
      let remoteHead = git('rev-parse', 'HEAD');
      if (condition === 'wrong branch') git('checkout', '-q', 'dev');
      if (condition === 'dirty') writeFileSync(join(at.checkout, 'local.txt'), 'keep me');
      if (condition === 'local commit' || condition === 'diverged') {
        git('commit', '--allow-empty', '-qm', 'local work');
        if (condition === 'diverged') {
          git('branch', 'saved-work');
          git('push', '-q', 'upstream', 'saved-work');
          git('checkout', '-qb', 'remote-work', remoteHead);
          git('commit', '--allow-empty', '-qm', 'remote work');
          remoteHead = git('rev-parse', 'HEAD');
          git('push', '-q', 'upstream', 'HEAD:refs/heads/feature');
          git('checkout', '-q', 'feature');
        }
      }
      const head = git('rev-parse', 'HEAD');
      const status = git('status', '--porcelain');
      const refused = run(at, 'checkout', {
        INPUTS_BRANCH: 'feature', INPUTS_CONTINUES: '42', INPUTS_PULL_REQUEST: JSON.stringify({ repo: PR.repo, number: 42 }),
      }, { pr: { headRefOid: remoteHead } });
      expect(refused.code).not.toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain')).toBe(status);
    }, 60_000);
  }

});

describe('build pickup and worker handoff', () => {
  test('pickup selections are declared on the worker with the same defaults', () => {
    const inputs = (name: string) => (Bun.YAML.parse(
      readFileSync(join(PACK, `${name}/archon-${name}.yaml`), 'utf8')
    ) as { inputs: Record<string, { default?: string }> }).inputs;
    const pickup = inputs('build-queue');
    const worker = inputs('build-round');
    expect(Object.keys(pickup).sort()).toEqual([...BUILD_QUEUE_SELECTIONS, 'number', 'repo_host', 'repo_path'].sort());
    expect(Object.keys(worker).sort()).toEqual([...Object.keys(pickup), 'pickup_run', 'selected_branch'].sort());
    for (const name of BUILD_QUEUE_SELECTIONS) expect(worker[name]?.default).toBe(pickup[name].default);
  });

  const workerInputs = {
    WORKFLOW_ID: 'worker-1', INPUTS_NUMBER: '7', INPUTS_PICKUP_RUN: 'run-1', INPUTS_SELECTED_BRANCH: 'feature',
  };

  test('pickup facts agree with the worker facts contract', () => {
    const schema = (name: string) => {
      const workflow = Bun.YAML.parse(readFileSync(join(PACK, `${name === 'archon-build-round' ? 'build-round' : 'build-queue'}/${name}.yaml`), 'utf8')) as {
        nodes: { id: string; output_format?: unknown }[];
      };
      return workflow.nodes.find(node => node.id === 'facts')?.output_format;
    };
    const queue = schema('archon-build-queue') as { properties: Record<string, unknown> };
    const worker = schema('archon-build-round') as { properties: Record<string, unknown> };
    for (const [key, value] of Object.entries(queue.properties)) expect(value).toEqual(worker.properties[key]);
  });

  test('admission transfers the expected pickup claim and appends the worker atomically, and resume keeps it', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ rounds: [round('previous', AT)] })));
    const admitted = run(at, 'admit', workerInputs);
    expect(ok(admitted)).toMatchObject({ branch: 'feature', continues: 42 });
    expect(readFileSync(join(admitted.artifacts, 'build/issue.md'), 'utf8')).toContain('The contract.');
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'worker-1' }, links: { runs: ['worker-1'] } });
    const revision = stored(at).revision;
    expect(ok(run(at, 'admit', workerInputs))).toMatchObject({ branch: 'feature' });
    expect(stored(at).revision).toBe(revision);
  }, 60_000);

  test('first pickup selects the build branch before a worker can admit, without creating a run branch', () => {
    const at = install();
    seed(at, triaged());
    const pickup = ok(run(at, 'facts', {}));
    expect(pickup.branch).toBe('build/7-an-issue-run-1');
    const git = spawnSync('git', ['checkout', '-qb', String(pickup.branch)], { cwd: at.checkout, encoding: 'utf8' });
    expect(git.status).toBe(0);
    expect(ok(run(at, 'admit', { ...workerInputs, INPUTS_SELECTED_BRANCH: String(pickup.branch) })))
      .toMatchObject({ branch: pickup.branch, continues: null });
    expect(spawnSync('git', ['branch', '--list', 'archon*'], { cwd: at.checkout, encoding: 'utf8' }).stdout).toBe('');
  }, 60_000);

  test('admission refuses a different claim, wrong item, wrong checkout or a lost conditional write before delivery', () => {
    const at = install();
    seed(at, triaged(CLAIMED, record({ rounds: [round('previous', AT)] })));
    const before = stored(at).revision;
    expect(run(at, 'admit', { ...workerInputs, INPUTS_PICKUP_RUN: 'other' }).stderr).toContain('no longer claimed');
    expect(run(at, 'admit', { ...workerInputs, INPUTS_REPO_PATH: 'other/repo' }).stderr).toContain('another repository');
    expect(run(at, 'admit', { ...workerInputs, INPUTS_SELECTED_BRANCH: 'wrong' }).stderr).toContain('not on selected branch');
    const lost = run(at, 'admit', workerInputs, {
      preload: `
const spawnAdmission = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, options) => {
  if (argv.includes('state') && argv.includes('put')) return { exitCode: 3, stdout: Buffer.from(''), stderr: Buffer.from('') };
  return spawnAdmission(argv, options);
}});
`,
    });
    expect(lost.stderr).toContain('changed during admission');
    expect(stored(at).revision).toBe(before);
  }, 60_000);

  test('build pickup holds failed and paused build claims, while failed intake and merge claims remain releasable', () => {
    const at = install();
    for (const workflow of ['archon-build-queue', 'archon-build-round', 'archon-intake', 'archon-merge-queue']) {
      for (const status of ['failed', 'paused']) {
        seed(at, triaged(CLAIMED));
        const result = run(at, 'facts', {
          WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: JSON.stringify({ 'run-1': status }),
          INTAKE_RUN_WORKFLOWS: JSON.stringify({ 'run-1': workflow }),
        });
        expect(result.code).toBe(0);
        expect(stored(at).value?.claim?.run_id).toBe(
          status === 'failed' && !workflow.startsWith('archon-build-') ? 'run-2' : 'run-1'
        );
      }
    }
    seed(at, triaged(CLAIMED));
    expect(run(at, 'facts', { WORKFLOW_ID: 'run-2' }).stderr).toContain('no status');
    expect(stored(at).value?.claim?.run_id).toBe('run-1');
  }, 60_000);

  test('intake and merge pickups cannot release a failed build worker', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    for (const pickup of [INTAKE_PICKUP, MERGE_PICKUP]) {
      inProcess(at, () => {
        process.env.INTAKE_RUN_STATUSES = JSON.stringify({ 'run-1': 'failed' });
        process.env.INTAKE_RUN_WORKFLOWS = JSON.stringify({ 'run-1': 'archon-build-round' });
        const item = read('work/7');
        if (item === undefined) throw new Error('missing item');
        expect(releaseIfTerminal(item, LATER, 'another-run', pickup).doc.claim?.run_id).toBe('run-1');
      });
    }
  }, 60_000);

  test('a pickup resumed after claiming selects its own item again', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ item: SUBJECT, path: 'route' });
  }, 60_000);

  test('a known admitted receipt is reused, and an uncertain launch never starts another worker', () => {
    const at = install();
    seed(at, triaged({ claim: { run_id: 'worker-1', at: AT, requests: [] }, links: { runs: ['worker-1'] } }));
    const inputs = { INPUTS_PATH: 'route', INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_BRANCH: 'feature' };
    const reused = run(at, 'dispatch', inputs, { artifacts: { 'build/dispatch.json': JSON.stringify({ run_id: 'worker-1' }) } });
    expect(ok(reused)).toMatchObject({ run_id: 'worker-1' });
    seed(at, triaged(CLAIMED));
    const uncertain = run(at, 'dispatch', inputs, { artifacts: { 'build/dispatch-started.json': '{}' } });
    expect(uncertain.code).not.toBe(0);
    expect(uncertain.stderr).toContain('uncertain worker launch');
    expect(uncertain.stderr).toContain('explicitly abandon pickup run-1 after verifying no worker exists');
    expect(stored(at).value?.claim?.run_id).toBe('run-1');
  }, 60_000);

  test('a missing receipt is recovered from the admitted worker link and launch inputs', () => {
    const at = install();
    seed(at, triaged({ claim: null, links: { runs: ['worker-1'] } }));
    const result = run(at, 'dispatch', {
      INPUTS_PATH: 'route', INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_BRANCH: 'feature',
      RUN_DETAILS: JSON.stringify({ 'worker-1': { workflow_name: 'archon-build-round', metadata: { inputs: { pickup_run: 'run-1' } } } }),
    }, { artifacts: { 'build/dispatch-started.json': '{}' } });
    expect(ok(result)).toMatchObject({ run_id: 'worker-1' });
  }, 60_000);

  test('admission timeout keeps the pickup claim and the worker receipt for resume', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const result = run(at, 'dispatch', {
      INPUTS_PATH: 'route', INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_BRANCH: 'feature',
    }, { preload: 'let dispatchTime = 0; Date.now = () => dispatchTime += 31_000;' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('worker launched-archon-build-round has not acknowledged admission');
    expect(stored(at).value?.claim?.run_id).toBe('run-1');
    expect(readFileSync(join(result.artifacts, 'build/dispatch.json'), 'utf8')).toBe('{"run_id":"launched-archon-build-round"}');
  }, 60_000);

  test('the pickup settles a closed item without admitting a worker', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    expect(ok(run(at, 'settle', { INPUTS_PATH: 'closed', INPUTS_ITEM: JSON.stringify(SUBJECT) }))).toMatchObject({ summary: 'Issue 7: parked. the issue is closed' });
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'parked' } } });
  }, 60_000);

  test('dispatch passes the selected branch literally and observes admission through the work item', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const calls = join(track(mkdtempSync(join(tmpdir(), 'archon-dispatch-calls-'))), 'calls.jsonl');
    // The CLI boundary admits the child before returning its launch receipt.
    const result = run(at, 'dispatch', {
      ...SELECTED, INPUTS_PATH: 'route', INPUTS_ITEM: JSON.stringify(SUBJECT), INPUTS_BRANCH: 'feature', ARCHON_CALL_LOG: calls,
    }, { preload: `
import { stateGet as getDispatchState, statePut as putDispatchState } from ${JSON.stringify(resolve(PACK, '.shared/state.ts'))};
const spawnDispatch = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, options) => {
  const result = spawnDispatch(argv, options);
  if (argv.includes('workflow') && argv.includes('run') && argv.includes('archon-build-round')) {
    const stored = getDispatchState('work/7');
    putDispatchState('work/7', { ...stored.value, claim: { run_id: 'launched-archon-build-round', at: '${AT}', requests: [] }, links: { runs: ['launched-archon-build-round'] } }, stored.revision);
  }
  return result;
}});
` });
    expect(ok(result)).toMatchObject({ run_id: 'launched-archon-build-round' });
    const launch = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(argv => argv[1] === 'run');
    expect(launch).toEqual(expect.arrayContaining(['archon-build-round', '--branch', 'feature', 'selected_branch=feature', 'pickup_run=run-1', 'order=["size asc"]', 'retriage_as=maintainer', 'round_limit=5', '--config-from-run', 'run-1']));
    expect(readFileSync(join(result.artifacts, 'build/dispatch.json'), 'utf8')).toBe('{"run_id":"launched-archon-build-round"}');
  }, 60_000);
});
