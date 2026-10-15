import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import {
  AGENT_OUTCOMES,
  type AgentDecision,
  checkDecisions,
  type DecisionRecord,
  parseDecisionRecord,
  renderDecisions,
} from '../../workflows/sdlc/.shared/discoveries';
import { latestVerdictOf, relayedDiscoveries } from '../../workflows/sdlc/.shared/report';
import { type GhIssue, gitCheckout, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
const CLI_ENTRY = resolve(import.meta.dir, '../../../packages/cli/src/cli.ts');
const REPO = PR.repo;
const RUN = 'aaaaaaaa-0000-4000-8000-000000000001';

function record(title: string): Record<string, unknown> {
  return { title, claim: `${title}, claimed`, evidence: ['a.ts:1'], relation: 'unrelated', source_nodes: ['implement'] };
}

/** A run's artifact directory: an optional review verdict, then raw records. */
function runArtifacts(
  root: string,
  id: string,
  shape: { verdict?: Record<string, unknown>[]; before?: Record<string, unknown>[]; after?: Record<string, unknown>[] }
): string {
  const dir = join(root, 'artifacts', 'runs', id);
  mkdirSync(join(dir, 'discoveries'), { recursive: true });
  const old = new Date('2026-10-14T00:00:00Z');
  const verdictAt = new Date('2026-10-14T01:00:00Z');
  const late = new Date('2026-10-14T02:00:00Z');
  if (shape.before !== undefined) {
    writeFileSync(join(dir, 'discoveries/implement.json'), JSON.stringify(shape.before));
    utimesSync(join(dir, 'discoveries/implement.json'), old, old);
  }
  if (shape.verdict !== undefined) {
    mkdirSync(join(dir, 'nodes'));
    // An earlier verdict that the later one supersedes.
    writeFileSync(join(dir, 'nodes/first.md'), JSON.stringify({ discoveries: [record('superseded')] }));
    writeFileSync(
      join(dir, 'nodes/first.meta.json'),
      JSON.stringify({ nodeId: 'review', outputType: 'review-report', path: 'nodes/first.md', runId: id, producedAt: old.toISOString(), size: 1 })
    );
    writeFileSync(join(dir, 'nodes/review.md'), JSON.stringify({ ready: true, discoveries: shape.verdict }));
    utimesSync(join(dir, 'nodes/review.md'), verdictAt, verdictAt);
    writeFileSync(
      join(dir, 'nodes/review.meta.json'),
      JSON.stringify({ nodeId: 'review', outputType: 'review-report', path: 'nodes/review.md', runId: id, producedAt: verdictAt.toISOString(), size: 1 })
    );
    writeFileSync(
      join(dir, 'nodes/plan.meta.json'),
      JSON.stringify({ nodeId: 'plan', outputType: 'plan', path: 'nodes/plan.md', runId: id, producedAt: late.toISOString(), size: 1 })
    );
  }
  if (shape.after !== undefined) {
    writeFileSync(join(dir, 'discoveries/structure.json'), JSON.stringify(shape.after));
    utimesSync(join(dir, 'discoveries/structure.json'), late, late);
  }
  return dir;
}

describe("a run's discoveries", () => {
  test('the latest verdict, plus raw records written after it; a record it judged is not raised again', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-')));
    const dir = runArtifacts(root, RUN, {
      before: [record('judged by review')],
      verdict: [record('certified')],
      after: [record('written after review')],
    });
    const relayed = relayedDiscoveries(dir, latestVerdictOf(dir));
    expect(relayed.problems).toEqual([]);
    expect(relayed.records.map(entry => [entry.ref, entry.title, entry.reviewed])).toEqual([
      ['review#0', 'certified', true],
      ['discoveries/structure.json#0', 'written after review', false],
    ]);
  });

  test('without a review, every raw record; an unreadable file is a named problem', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-')));
    const dir = runArtifacts(root, RUN, { before: [record('one'), record('two')] });
    writeFileSync(join(dir, 'discoveries/broken.json'), '{');
    expect(latestVerdictOf(dir)).toBeUndefined();
    const relayed = relayedDiscoveries(dir, undefined);
    expect(relayed.records.map(entry => entry.ref)).toEqual(['discoveries/implement.json#0', 'discoveries/implement.json#1']);
    expect(relayed.problems).toEqual([expect.stringContaining('broken.json')]);
  });
});

// --- the decision record and the pre-write check -----------------------------------

const ISSUE = { repo: REPO, number: 7 };
const FILED = { kind: 'filed', issue: ISSUE, body: 'b' } as const;
const PENDING = { kind: 'filed', issue: null, body: 'b' } as const;

function stored(key: string, decision: DecisionRecord['decision']): DecisionRecord {
  return {
    version: 1,
    key,
    title: 'a defect',
    decision,
    reason: 'r',
    verified_at: 'sha',
    at: '2026-10-15T00:00:00Z',
    refs: [`${RUN}:review#0`],
    question: null,
  };
}

function decideSchema(): Record<string, unknown> {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'discoveries/archon-discoveries.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: Record<string, unknown> }[];
  };
  return workflow.nodes.find(node => node.id === 'decide')?.output_format ?? {};
}

describe('the decision record', () => {
  test('round-trips through its parser and renders one section per key', () => {
    const value = stored('known-defect', { kind: 'tracked', issue: ISSUE, comment: null });
    expect(parseDecisionRecord('discoveries/decisions/known-defect', JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(renderDecisions([value])).toContain('## known-defect');
  });

  test('a malformed decision refuses, naming the document, rather than reading as undecided', () => {
    const name = 'discoveries/decisions/known-defect';
    for (const decision of [{ kind: 'filed', issue: ISSUE }, { kind: 'tracked', issue: null }, { kind: 'reported' }]) {
      expect(() => parseDecisionRecord(name, { ...stored('known-defect', { kind: 'dropped' }), decision })).toThrow(name);
    }
    expect(() => parseDecisionRecord('discoveries/decisions/other', stored('known-defect', { kind: 'dropped' }))).toThrow('key');
    // A hand-seeded ref without its run refuses here, by name, not later in rendering.
    expect(() => parseDecisionRecord(name, { ...stored('known-defect', { kind: 'dropped' }), refs: ['manual'] })).toThrow(
      `${name} is not a decision record: a ref is not of the form <run-id>:<ref>`
    );
  });

  test('every queued ref is decided exactly once, and a key with an issue is never filed again', () => {
    const drop = (key: string, refs: string[]): AgentDecision => ({ outcome: 'drop', key, refs, title: 't', reason: 'r' });
    const queued = ['run:review#0', 'run:review#1'];
    expect(checkDecisions(queued, [drop('first-key', queued)], new Map())).toEqual([]);
    expect(checkDecisions(queued, [drop('first-key', ['run:review#0'])], new Map())).toEqual(['run:review#1 has no decision']);
    expect(checkDecisions(queued, [drop('first-key', queued), drop('second-key', ['run:review#1', 'run:other#0'])], new Map())).toEqual([
      'run:review#1 is decided under both first-key and second-key',
      'run:other#0 (key second-key) is not a queued ref',
    ]);
    const file: AgentDecision = { outcome: 'file', key: 'first-key', refs: queued, title: 't', body: 'b', reason: 'r' };
    for (const issued of [stored('first-key', FILED), stored('first-key', { kind: 'tracked', issue: ISSUE, comment: null })]) {
      expect(checkDecisions(queued, [file], new Map([['first-key', issued]]))).toEqual([
        'key first-key already has an issue; it is never filed again',
      ]);
    }
    // A dropped key may be filed when new evidence reopens it; an unfinished filing is only ever filed.
    expect(checkDecisions(queued, [file], new Map([['first-key', stored('first-key', { kind: 'dropped' })]]))).toEqual([]);
    const pending = new Map([['first-key', stored('first-key', PENDING)]]);
    expect(checkDecisions(queued, [file], pending)).toEqual([]);
    expect(checkDecisions(queued, [drop('first-key', queued)], pending)).toEqual([
      'key first-key has an unfinished filing; it can only be filed',
    ]);
    const unposted = new Map([['first-key', stored('first-key', { kind: 'tracked', issue: ISSUE, comment: 'evidence' })]]);
    expect(checkDecisions(queued, [drop('first-key', queued)], unposted)).toEqual([
      'key first-key has an unposted evidence comment; it can only be tracked',
    ]);
  });

  test("the decide node's output schema admits exactly the agent's outcomes", () => {
    const schema = decideSchema();
    const items = (schema.properties as { decisions: { items: { anyOf: { properties: { outcome: { enum: string[] } } }[] } } })
      .decisions.items.anyOf;
    expect(items.map(branch => branch.properties.outcome.enum).flat().sort()).toEqual([...AGENT_OUTCOMES].sort());
    const base = { key: 'some-defect', refs: [`${RUN}:review#0`], title: 'A defect' };
    const examples: AgentDecision[] = [
      { ...base, outcome: 'file', body: 'The brief.', reason: 'r' },
      { ...base, outcome: 'track', issue: ISSUE, comment: null, reason: 'r' },
      { ...base, outcome: 'track', issue: ISSUE, comment: 'More evidence.', reason: 'r' },
      { ...base, outcome: 'drop', reason: 'r' },
      { ...base, outcome: 'ask', question: 'q', recommendation: 'r' },
    ];
    for (const example of examples) {
      expect(validateStructuredOutput({ decisions: [example], summary: 's' }, schema)).toEqual({ valid: true });
    }
    expect(validateStructuredOutput({ decisions: [{ ...base, outcome: 'drop', body: 'b', reason: 'r' }], summary: 's' }, schema).valid).toBe(false);
  });
});

// --- the scripts, run as the engine runs them ----------------------------------------

interface Install {
  readonly checkout: string;
  readonly outputRoot: string;
  readonly env: Record<string, string>;
}

function install(): Install {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-home-')));
  const outputRoot = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-runs-')));
  return {
    checkout,
    outputRoot,
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout },
  };
}

function listing(at: Install, ids: string[]): string {
  return JSON.stringify(
    ids.map((id, index) => ({
      id,
      workflow_name: 'archon-ship',
      status: 'completed',
      completed_at: new Date(Date.parse('2026-10-14T03:00:00Z') + index * 60_000).toISOString(),
      output_root: at.outputRoot,
    }))
  );
}

interface Pass {
  readonly runId: string;
  readonly runs: string[];
  readonly mode?: 'live' | 'eval';
  readonly statuses?: Record<string, string>;
  readonly issues?: GhIssue[];
  readonly subject?: { state: 'open' | 'closed' };
}

type Script = 'facts' | 'outcome' | 'answer';

function script(at: Install, name: Script, pass: Pass, inputs: Record<string, string> = {}, artifacts: Record<string, string> = {}): ScriptRun {
  return runPackScript(`discoveries/scripts/${name}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: { issue: { number: 7, state: pass.subject?.state ?? 'open' }, issues: pass.issues ?? [] },
    artifacts,
    inputs: {
      ...at.env,
      WORKFLOW_ID: pass.runId,
      INTAKE_RUN_STATUSES: JSON.stringify(pass.statuses ?? {}),
      RUN_LISTING: listing(at, pass.runs),
      INPUTS_REPO_HOST: REPO.host,
      INPUTS_REPO_PATH: REPO.path,
      INPUTS_MODE: pass.mode ?? 'live',
      INPUTS_SINCE: '',
      INPUTS_UNTIL: '',
      INPUTS_LIMIT: '20',
      ...inputs,
    },
  });
}

/** A script that succeeded, with output its node's declared schema admits. */
function ok(result: ScriptRun, name: Script): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'discoveries/archon-discoveries.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: Record<string, unknown> }[];
  };
  const schema = workflow.nodes.find(node => node.id === name)?.output_format ?? {};
  expect(validateStructuredOutput(output, schema)).toEqual({ valid: true });
  return output;
}

/** The refs a facts run queued. */
function queued(facts: ScriptRun): string[] {
  const queue = JSON.parse(readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8')) as {
    runs: { records: { ref: string }[] }[];
  };
  return queue.runs.flatMap(run => run.records.map(entry => entry.ref));
}

/** Run facts, then the outcome over its queue with these decisions. */
function decide(at: Install, pass: Pass, decisions: (refs: string[]) => AgentDecision[]): { facts: ScriptRun; outcome: ScriptRun } {
  const facts = script(at, 'facts', pass);
  const output = ok(facts, 'facts');
  const outcome = script(
    at,
    'outcome',
    pass,
    { INPUTS_PATH: String(output.path), INPUTS_DECISIONS: JSON.stringify(decisions(queued(facts))), INPUTS_SUMMARY: 'summary' },
    { 'drain/queue.json': readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8') }
  );
  return { facts, outcome };
}

function cli(at: Install, args: string[], input?: string): { status: number | null; value: Record<string, unknown> } {
  const result = spawnSync(process.execPath, ['--no-env-file', CLI_ENTRY, ...args], {
    cwd: at.checkout,
    env: { ...process.env, ...at.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input: input ?? '',
    encoding: 'utf8',
  });
  return { status: result.status, value: JSON.parse(result.stdout) as Record<string, unknown> };
}

function state(at: Install, name: string): unknown {
  return cli(at, ['state', 'get', name]).value.value ?? null;
}

function seed(at: Install, value: DecisionRecord): void {
  expect(cli(at, ['state', 'put', `discoveries/decisions/${value.key}`, '--if-revision', '0'], JSON.stringify(value)).status).toBe(0);
}

function documents(at: Install, prefix = 'discoveries/'): unknown[] {
  return (cli(at, ['state', 'list', '--prefix', prefix]).value.documents as unknown[]) ?? [];
}

const fileIt = (key: string) => (refs: string[]): AgentDecision[] => [
  { outcome: 'file', key, refs, title: 'A new defect', body: 'The brief.', reason: 'real at the base' },
];

describe('the discoveries scripts', () => {
  test('a live pass files the issue with its marker, records each decision, and a second pass finds nothing to do', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new'), record('covered'), record('fixed')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'file', key: 'new-defect', refs: [refs[0] as string], title: 'A new defect', body: 'The brief.', reason: 'real' },
      { outcome: 'track', key: 'covered-defect', refs: [refs[1] as string], title: 'Covered', issue: ISSUE, comment: 'A new reproduction.', reason: 'issue 7 covers it' },
      { outcome: 'drop', key: 'fixed-defect', refs: [refs[2] as string], title: 'Fixed', reason: 'fixed at the base' },
    ]);
    expect(queued(facts)).toEqual([`${RUN}:review#0`, `${RUN}:review#1`, `${RUN}:review#2`]);
    const applied = ok(outcome, 'outcome');
    expect(outcome.createdIssues).toEqual([
      expect.objectContaining({ title: 'A new defect', body: expect.stringMatching(/^<!-- archon-discovery new-defect -->\nThe brief\./) }),
    ]);
    expect(outcome.comments).toEqual([{ issue: 7, body: '<!-- archon-discovery covered-defect -->\nA new reproduction.' }]);
    expect(applied.dropped).toEqual([{ key: 'fixed-defect', reason: 'fixed at the base' }]);
    expect(state(at, 'discoveries/decisions/new-defect')).toMatchObject({
      decision: { kind: 'filed', issue: { number: 100 } },
      refs: [`${RUN}:review#0`],
    });
    expect(state(at, 'discoveries/decisions/covered-defect')).toMatchObject({ decision: { kind: 'tracked', issue: { number: 7 } } });
    expect(state(at, `discoveries/runs/${RUN}`)).toEqual({ version: 1, claim: null });

    const again = script(at, 'facts', { runId: 'pass-2', runs: [RUN] });
    expect(ok(again, 'facts')).toMatchObject({ path: 'idle' });
    expect(readFileSync(join(again.artifacts, 'drain/discovery-decisions.md'), 'utf8')).toContain('## new-defect');
  }, 60_000);

  test('a filing interrupted after its create is finished from the marker, and nothing is filed twice', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new'), record('other')] });
    const marker = '<!-- archon-discovery new-defect -->';
    // An earlier pass wrote the record and created the issue, then stopped.
    seed(at, { ...stored('new-defect', { ...PENDING, body: `${marker}\nThe brief.` }), refs: [`${RUN}:review#0`] });
    const existing: GhIssue = { number: 50, title: 'A defect', body: `${marker}\nThe brief.`, state: 'OPEN' };
    const { facts, outcome } = decide(at, { runId: 'pass-2', runs: [RUN], issues: [existing] }, refs => [
      { outcome: 'drop', key: 'other-key', refs, title: 'Other', reason: 'fixed' },
    ]);
    // A pending filing already settles its ref; only the other record is queued.
    expect(queued(facts)).toEqual([`${RUN}:review#1`]);
    expect(ok(outcome, 'outcome').written).toEqual([
      { key: 'new-defect', outcome: 'file', url: 'https://ghe.example.com/example/repo/issues/50' },
    ]);
    expect(outcome.createdIssues).toEqual([]);
    expect(state(at, 'discoveries/decisions/new-defect')).toMatchObject({ decision: { kind: 'filed', issue: { number: 50 } } });
  }, 60_000);

  test('an idle pass finishes the filing and the evidence comment an earlier pass left owed', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new'), record('covered')] });
    const marker = '<!-- archon-discovery new-defect -->';
    // An earlier pass wrote both records, then stopped before either public write.
    seed(at, { ...stored('new-defect', { ...PENDING, body: `${marker}\nThe brief.` }), refs: [`${RUN}:review#0`] });
    seed(at, { ...stored('covered-defect', { kind: 'tracked', issue: ISSUE, comment: 'A new reproduction.' }), refs: [`${RUN}:review#1`] });
    const facts = script(at, 'facts', { runId: 'pass-2', runs: [RUN] });
    expect(ok(facts, 'facts')).toMatchObject({ path: 'idle' });
    const outcome = script(
      at,
      'outcome',
      { runId: 'pass-2', runs: [RUN] },
      { INPUTS_PATH: 'idle', INPUTS_DECISIONS: 'null', INPUTS_SUMMARY: 'null' },
      { 'drain/queue.json': readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8') }
    );
    expect(ok(outcome, 'outcome').written).toEqual([
      { key: 'covered-defect', outcome: 'track', url: expect.stringContaining('/issues/7#issuecomment-') },
      { key: 'new-defect', outcome: 'file', url: 'https://ghe.example.com/example/repo/issues/100' },
    ]);
    expect(outcome.createdIssues).toEqual([expect.objectContaining({ body: `${marker}\nThe brief.` })]);
    expect(outcome.comments).toEqual([{ issue: 7, body: '<!-- archon-discovery covered-defect -->\nA new reproduction.' }]);
    expect(state(at, 'discoveries/decisions/new-defect')).toMatchObject({ decision: { issue: { number: 100 } } });
    expect(state(at, 'discoveries/decisions/covered-defect')).toMatchObject({ decision: { comment: null } });
  }, 60_000);

  test('a refused pass writes nothing: a second issue for a key, a closed tracking issue, a missing ref', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one'), record('two')] });
    seed(at, { ...stored('filed-defect', FILED), refs: ['bbbbbbbb-0000-4000-8000-000000000009:review#0'] });
    const cases: [Pass, (refs: string[]) => AgentDecision[], string][] = [
      [{ runId: 'pass-1', runs: [RUN] }, fileIt('filed-defect'), 'already has an issue'],
      [
        { runId: 'pass-2', runs: [RUN], subject: { state: 'closed' }, statuses: { 'pass-1': 'failed' } },
        refs => [{ outcome: 'track', key: 'new-key', refs, title: 't', issue: ISSUE, comment: null, reason: 'r' }],
        'which is not open',
      ],
      [
        { runId: 'pass-3', runs: [RUN], statuses: { 'pass-2': 'failed' } },
        refs => [{ outcome: 'drop', key: 'new-key', refs: refs.slice(1), title: 't', reason: 'r' }],
        'has no decision',
      ],
    ];
    const before = JSON.stringify(documents(at, 'discoveries/decisions/'));
    for (const [pass, decisions, why] of cases) {
      const { outcome } = decide(at, pass, decisions);
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(why);
      expect([outcome.createdIssues, outcome.comments]).toEqual([[], []]);
      expect(JSON.stringify(documents(at, 'discoveries/decisions/'))).toBe(before);
    }
  }, 120_000);

  test('a claim is kept while its run may still finish, and released once it ended', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one')] });
    expect(ok(script(at, 'facts', { runId: 'pass-1', runs: [RUN] }), 'facts')).toMatchObject({ path: 'decide' });
    for (const status of ['paused', 'running']) {
      expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': status } }), 'facts')).toMatchObject({ path: 'idle' });
    }
    const released = script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'cancelled' } });
    expect(queued(released)).toEqual([`${RUN}:review#0`]);
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-2' } });
  }, 60_000);

  test('limit caps the runs one pass claims, oldest first', () => {
    const at = install();
    const ids = [RUN, 'aaaaaaaa-0000-4000-8000-000000000002'];
    for (const id of ids) runArtifacts(at.outputRoot, id, { verdict: [record('one')] });
    const facts = script(at, 'facts', { runId: 'pass-1', runs: ids }, { INPUTS_LIMIT: '1' });
    expect(queued(facts)).toEqual([`${RUN}:review#0`]);
    expect(state(at, `discoveries/runs/${ids[1]}`)).toBeNull();
  }, 60_000);

  test('an asked record keeps its run claimed by the asking run, and the answer is stored on the record', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('unclear'), record('clear')] });
    const { outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'ask', key: 'unclear-scope', refs: [refs[0] as string], title: 'Unclear', question: 'In scope?', recommendation: 'Drop it.' },
      { outcome: 'drop', key: 'clear-drop', refs: [refs[1] as string], title: 'Clear', reason: 'fixed' },
    ]);
    expect(ok(outcome, 'outcome')).toMatchObject({ asked: ['unclear-scope'], question: expect.stringContaining('1. unclear-scope: In scope?') });
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' } });
    // While the asking run waits, no pass takes the run and asks again.
    expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'paused' } }), 'facts')).toMatchObject({ path: 'idle' });

    ok(script(at, 'answer', { runId: 'pass-1', runs: [] }, { INPUTS_KEYS: '["unclear-scope"]', INPUTS_TEXT: 'Out of scope.' }), 'answer');
    expect(state(at, 'discoveries/decisions/unclear-scope')).toMatchObject({
      decision: { kind: 'asked' },
      question: { text: 'In scope?', answer: { text: 'Out of scope.' } },
    });
    // Once the asking run ended, the next pass decides only the asked record, with the answer in memory.
    const next = script(at, 'facts', { runId: 'pass-3', runs: [RUN], statuses: { 'pass-1': 'completed' } });
    expect(queued(next)).toEqual([`${RUN}:review#0`]);
    expect(readFileSync(join(next.artifacts, 'drain/discovery-decisions.md'), 'utf8')).toContain('Out of scope.');
  }, 60_000);

  test('eval writes no state document, issue or comment, decides settled records again, and returns every decision', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one')] });
    ok(decide(at, { runId: 'pass-1', runs: [RUN] }, fileIt('new-defect')).outcome, 'outcome');
    const before = documents(at);
    const { facts, outcome } = decide(at, { runId: 'eval-1', runs: [RUN], mode: 'eval' }, fileIt('new-defect'));
    expect(queued(facts)).toEqual([`${RUN}:review#0`]);
    const evaluated = ok(outcome, 'outcome');
    expect(evaluated.evaluation).toEqual({
      decisions: [expect.objectContaining({ outcome: 'file', key: 'new-defect' })],
      problems: ['key new-defect already has an issue; it is never filed again'],
    });
    expect([outcome.createdIssues, outcome.comments]).toEqual([[], []]);
    expect(documents(at)).toEqual(before);
  }, 60_000);

  test('an input outside its vocabulary refuses before anything is read', () => {
    const at = install();
    for (const inputs of [{ INPUTS_MODE: 'dry' }, { INPUTS_SINCE: 'yesterday' }, { INPUTS_LIMIT: '0' }]) {
      const result = script(at, 'facts', { runId: 'pass-1', runs: [] }, inputs);
      expect(result.code).toBe(1);
      expect(result.gh).toEqual([]);
    }
    expect(documents(at)).toEqual([]);
  }, 60_000);
});

describe('the discoveries workflow', () => {
  test('the pack ships no trigger binding: it runs only when started by hand or by a binding an operator adds', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
      );
    const binding = files(PACK).filter(
      path => !path.endsWith('.md') && /"bindingId"|intervalSeconds|bindingId:/.test(readFileSync(path, 'utf8'))
    );
    expect(binding).toEqual([]);
  });
});
