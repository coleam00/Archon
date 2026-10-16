import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateArtifactPointers } from '../../../packages/workflows/src/artifact-pointer';
import type { WorkflowRun } from '../../../packages/workflows/src/schemas';
import {
  ANSWER_DECISIONS,
  APPLY_DECISIONS,
  ASKED_BY,
  BUILD_EFFECTS,
  BUILD_PATHS,
  type BuildAttention,
  type BuildRecord,
  type BuildRound,
  buildWaits,
  countedRounds,
  GIVE_UP_DECISIONS,
  ROUTE_DECISIONS,
} from '../../workflows/sdlc/.shared/build';
import { CONFIDENCES, checkAttention, chosen, renderAttention } from '../../workflows/sdlc/.shared/queue';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import {
  applyDecision,
  decideIntake,
  newWorkItem,
  parseWorkItem,
  type TriageFacts,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import { type GhApiIssue, gitCheckout, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

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

  test('the rounds since a re-triage or a maintainer answer count toward the give-up decision', () => {
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

  test("the paths, decisions, classes, effects and confidences are archon-build-queue's own", () => {
    type Enum = { enum: string[] };
    type AttentionSchema = {
      properties: {
        recommendation: { properties: { confidence: Enum } };
        choices: { items: { properties: { effect: Enum } } };
      };
    };
    const workflow = Bun.YAML.parse(
      readFileSync(join(PACK, 'build-queue/archon-build-queue.yaml'), 'utf8')
    ) as { nodes: { id: string; output_format?: { properties: Record<string, unknown> } }[] };
    const field = (id: string, name: string) =>
      workflow.nodes.find(node => node.id === id)?.output_format?.properties[name] as
        | (Enum & AttentionSchema)
        | undefined;
    expect(field('facts', 'path')?.enum).toEqual([...BUILD_PATHS]);
    expect(field('route', 'decision')?.enum).toEqual([...ROUTE_DECISIONS]);
    expect(field('answer', 'decision')?.enum).toEqual([...ANSWER_DECISIONS]);
    expect(field('give-up', 'decision')?.enum).toEqual([...GIVE_UP_DECISIONS]);
    expect(field('apply', 'decision')?.enum).toEqual([...APPLY_DECISIONS]);
    expect(field('apply', 'class')?.enum).toEqual(['', ...ASKED_BY]);
    expect(field('ruling', 'decision')?.enum).toEqual([...BUILD_EFFECTS]);
    for (const id of ['route', 'answer', 'give-up']) {
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
      INTAKE_STATE_CWD: checkout,
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
  script: 'facts' | 'apply' | 'ruling',
  inputs: Record<string, string>,
  options: { issue?: GhApiIssue; pr?: { state?: 'OPEN' | 'CLOSED' | 'MERGED'; headRefOid?: string }; writeLost?: boolean } = {}
): ScriptRun {
  return runPackScript(`build-queue/scripts/${script}`, {
    cwd: at.checkout,
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
      INPUTS_ROUND_LIMIT: '3',
      INPUTS_MODE: 'live',
      INPUTS_NUMBER: '',
      INPUTS_REPLAY: '[]',
      INPUTS_AS_OF: '',
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

function applyInputs(answer: Record<string, unknown>, giveUp: Record<string, unknown> | null = null): Record<string, string> {
  return {
    INPUTS_PATH: 'route',
    INPUTS_ITEM: JSON.stringify(SUBJECT),
    INPUTS_RECORDED: 'null',
    INPUTS_ROUTE: JSON.stringify({ decision: 'launch', brief: 'deliver 7', reason: 'a contract', attention: null }),
    INPUTS_ENDING: JSON.stringify(ENDING),
    INPUTS_ANSWER: JSON.stringify(answer),
    INPUTS_GIVE_UP: giveUp === null ? 'null' : JSON.stringify(giveUp),
  };
}

const CONTINUE = { decision: 'continue', brief: 'continue PR 42 on R1', push: null, reason: 'R1 is correctable', attention: null };
const ASK = { decision: 'ask', brief: 'continue PR 42 under the ruling', push: null, reason: 'the plan asks to relax a constraint', attention: ATTENTION };

describe('the build queue scripts', () => {
  test("facts claims a triaged item without taking intake's requests, and writes the issue the agents read", () => {
    const at = install();
    const request = { at: AT, run_id: 'event', action: 'edited' as const, label: null, actor: null, body_digest: null };
    seed(at, triaged({ requests: [request] }));
    const picked = run(at, 'facts', {});
    expect(ok(picked)).toMatchObject({ path: 'route', item: SUBJECT, url: ISSUE_URL, brief: '', at_cap: false });
    expect(stored(at).value).toMatchObject({ claim: { run_id: 'run-1', requests: [] }, requests: [request] });
    expect(readFileSync(join(picked.artifacts, 'build/issue.md'), 'utf8')).toContain('The contract.');
    // The item is now claimed, so the next pickup finds nothing.
    expect(ok(run(at, 'facts', { WORKFLOW_ID: 'run-2', INTAKE_RUN_STATUSES: '{"run-1":"running"}' }))).toMatchObject({ path: 'idle', item: null });
  }, 60_000);

  test("facts starts on an item intake wrote, carrying intake's triage report as a plain reference", async () => {
    const at = install();
    const fresh = newWorkItem(SUBJECT, AT);
    const source = { author: 'maintainer', labels: [], state: 'open' as const, digest: 'sha256:x' };
    const decision = decideIntake(fresh, source, new Set(['maintainer']), AT, 'intake-run');
    // Triage emits its report as the engine's artifact pointer to intake's own run.
    const pointer = { type: 'archon_artifact', run_id: 'intake-run', path: 'triage.md' };
    const { at: _at, run_id: _runId, ...verdict } = TRIAGE;
    seed(at, applyDecision(fresh, decision, { ...verdict, closure: null, labels: [], summary: 's', report: pointer }, false, AT, 'intake-run'));
    const output = ok(run(at, 'facts', {}));
    // The validator reads the current run's id only, unless a pointer names that run.
    expect(await validateArtifactPointers(output, { id: 'run-1' } as WorkflowRun)).toBeNull();
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

  test('items intake has not routed, and items the queue finished, are never picked up', () => {
    const at = install();
    seed(at, triaged({ stage: 'needs_contract' }));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    seed(at, triaged({}, record({ status: 'ready' })));
    expect(ok(run(at, 'facts', {}))).toMatchObject({ path: 'idle' });
    expect(stored(at).value?.claim).toBeNull();
  }, 60_000);

  test('a closed issue is parked without an agent', () => {
    const at = install();
    seed(at, triaged());
    expect(ok(run(at, 'facts', {}, { issue: { state: 'closed' } }))).toMatchObject({ path: 'closed' });
    const applied = ok(
      run(at, 'apply', {
        INPUTS_PATH: 'closed',
        INPUTS_ITEM: JSON.stringify(SUBJECT),
        INPUTS_RECORDED: 'null',
        INPUTS_ROUTE: 'null',
        INPUTS_ENDING: 'null',
        INPUTS_ANSWER: 'null',
        INPUTS_GIVE_UP: 'null',
      })
    );
    expect(applied).toMatchObject({ decision: 'parked', attention: '' });
    expect(stored(at).value).toMatchObject({ claim: null, facts: { build: { status: 'parked', rounds: [] } } });
  }, 60_000);

  test('a continue records the round and the brief the next launch starts from, and releases the claim', () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = run(at, 'apply', applyInputs(CONTINUE));
    expect(ok(applied)).toMatchObject({ decision: 'continue', attention: '', options: [], asked: null });
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
      ],
      asked: { attention: ATTENTION, brief: 'continue PR 42 under the ruling', by: 'stop' },
    });
    expect(applied.attention).toBe(renderAttention('Build queue, issue 7: stop decision', ATTENTION));
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

  test("give-up's scope question replaces another round", () => {
    const at = install();
    seed(at, triaged(CLAIMED));
    const applied = ok(
      run(at, 'apply', applyInputs(CONTINUE, { decision: 'ask', reason: 'each review found new defects', attention: ATTENTION }))
    );
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
    const ruled = run(at, 'ruling', {
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_ASKED: ASKED,
      INPUTS_CHOICE: 'relax',
      INPUTS_TEXT: 'Only for this item.',
    });
    const output = ok(ruled);
    const heading = output.section as string;
    expect(heading).toMatch(/^Current scope \(ruling on the build queue's question on a stopped run, \d{4}-\d{2}-\d{2}\)$/);
    expect(ruled.bodies).toEqual([
      `The contract.\n\n\n## ${heading}\n\nSynthesis and publish may gate on head_matches too.\n\nThe answer's text: Only for this item.\n`,
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

describe('eval mode', () => {
  const OLD = 'The contract as it stood when the round ended.';
  const EDITS = [
    { editedAt: '2026-10-16T05:26:29Z', diff: 'The contract with the later ruling.' },
    { editedAt: '2026-10-16T05:23:54Z', diff: OLD },
    { editedAt: '2026-01-01T00:00:00Z', diff: 'The contract at creation.' },
  ];

  test('replays the last round on the body as it was then, and claims and writes nothing', () => {
    const at = install();
    seed(at, triaged());
    const before = stored(at).revision;
    const rounds = [round('r1', '2026-10-16T03:00:00.000Z'), round('r2', '2026-10-16T04:00:00.000Z'), round('r3', '2026-10-16T05:25:31.000Z', 'needs_human')];
    const decided = run(
      at,
      'facts',
      { INPUTS_MODE: 'eval', INPUTS_NUMBER: '7', INPUTS_REPLAY: JSON.stringify(rounds), INPUTS_AS_OF: '2026-10-16T05:25:31Z' },
      { issue: { body: 'The contract with the later ruling.', history: { edits: EDITS } } }
    );
    expect(ok(decided)).toMatchObject({ path: 'answer', recorded: rounds[2], rounds: rounds.slice(0, 2), at_cap: true });
    const issue = readFileSync(join(decided.artifacts, 'build/issue.md'), 'utf8');
    expect(issue).toContain(OLD);
    expect(issue).not.toContain('later ruling');

    const applied = run(at, 'apply', { ...applyInputs(ASK), INPUTS_MODE: 'eval', INPUTS_ENDING: 'null', INPUTS_RECORDED: JSON.stringify(rounds[2]) });
    expect(ok(applied)).toMatchObject({
      decision: 'asked',
      attention: '',
      options: [],
      asked: null,
      evaluation: { decision: { kind: 'asked', by: 'stop' }, round: rounds[2] },
    });
    expect(applied.gh.filter(call => !call.startsWith('api repos') && !call.startsWith('api graphql'))).toEqual([]);
    expect(stored(at).revision).toBe(before);
  }, 60_000);

  test('a time written with an offset reads the revision at that instant, and text that is not a time refuses', () => {
    const at = install();
    const history = { issue: { body: 'The contract with the later ruling.', history: { edits: EDITS } } };
    // 07:25:31+02:00 is 05:25:31Z: after the old revision, before the later ruling.
    const offset = run(at, 'facts', { INPUTS_MODE: 'eval', INPUTS_NUMBER: '7', INPUTS_AS_OF: '2026-10-16T07:25:31+02:00' }, history);
    ok(offset);
    expect(readFileSync(join(offset.artifacts, 'build/issue.md'), 'utf8')).toContain(OLD);
    const bad = run(at, 'facts', { INPUTS_MODE: 'eval', INPUTS_NUMBER: '7', INPUTS_AS_OF: 'yesterday' }, history);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('"yesterday" is not a time');
  }, 60_000);

  test('a time before every readable revision refuses rather than judging other text', () => {
    const at = install();
    const early = run(
      at,
      'facts',
      { INPUTS_MODE: 'eval', INPUTS_NUMBER: '7', INPUTS_AS_OF: '2025-12-31T00:00:00Z' },
      { issue: { history: { edits: EDITS } } }
    );
    expect(early.code).not.toBe(0);
    expect(early.stderr).toContain('did not exist at 2025-12-31T00:00:00Z');
  }, 60_000);
});
