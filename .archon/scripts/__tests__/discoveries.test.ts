import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { AGENT_OUTCOMES, type AgentDecision, checkDecisions, parseRunDocument } from '../../workflows/sdlc/.shared/discoveries';
import { latestVerdictOf, relayedDiscoveries } from '../../workflows/sdlc/.shared/report';
import { type GhIssue, gitCheckout, hostCli, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
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

// --- the run document and the pre-write check ---------------------------------------

const ISSUE = { repo: REPO, number: 7 };

function decideSchema(): Record<string, unknown> {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'discoveries/archon-discoveries.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: Record<string, unknown> }[];
  };
  return workflow.nodes.find(node => node.id === 'decide')?.output_format ?? {};
}

describe("a drained run's document", () => {
  test('round-trips through its parser, and one that does not parse refuses, naming the document', () => {
    const name = `discoveries/runs/${RUN}`;
    const value = {
      version: 1 as const,
      claim: null,
      decided: [`${RUN}:review#0`],
      questions: [{ keys: ['k-one'], refs: [`${RUN}:review#1`], text: 'q', recommendation: 'r', answer: { text: 'a', at: 'now' } }],
    };
    expect(parseRunDocument(name, JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(parseRunDocument(name, { version: 1, claim: null })).toEqual({ version: 1, claim: null });
    for (const bad of [{ version: 2, claim: null }, { version: 1, claim: null, decided: 'x' }, { version: 1, claim: null, questions: [{ text: 'q' }] }]) {
      expect(() => parseRunDocument(name, bad)).toThrow(name);
    }
  });

  test('every queued ref is decided exactly once', () => {
    const drop = (key: string, refs: string[]): AgentDecision => ({ outcome: 'drop', key, refs, title: 't', reason: 'r' });
    const queued = ['run:review#0', 'run:review#1'];
    expect(checkDecisions(queued, [drop('first-key', queued)])).toEqual([]);
    expect(checkDecisions(queued, [drop('first-key', ['run:review#0'])])).toEqual(['run:review#1 has no decision']);
    expect(checkDecisions(queued, [drop('first-key', queued), drop('second-key', ['run:review#1', 'run:other#0'])])).toEqual([
      'run:review#1 is decided under both first-key and second-key',
      'run:other#0 (key second-key) is not a queued ref',
    ]);
  });

  test("the decide node's output schema names exactly the agent's outcomes", () => {
    const schema = decideSchema();
    const items = (schema.properties as { decisions: { items: { anyOf: { properties: { outcome: { enum: string[] } } }[] } } })
      .decisions.items.anyOf;
    expect(items.map(branch => branch.properties.outcome.enum).flat().sort()).toEqual([...AGENT_OUTCOMES].sort());
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
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout, INTAKE_HOST_CLI: JSON.stringify(hostCli()) },
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
      INPUTS_SINCE: '',
      INPUTS_UNTIL: '',
      INPUTS_LIMIT: '20',
      ...inputs,
    },
  });
}

/** A script that succeeded. `scripts/sdlc-output-conformance.test.ts` validates its output schema. */
function ok(result: ScriptRun): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as Record<string, unknown>;
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
  const output = ok(facts);
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
  const [command, ...prefix] = hostCli();
  const result = spawnSync(command, [...prefix, ...args], {
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

function seed(at: Install, name: string, value: unknown): void {
  expect(cli(at, ['state', 'put', name, '--if-revision', '0'], JSON.stringify(value)).status).toBe(0);
}

function documents(at: Install, prefix = 'discoveries/'): unknown[] {
  return (cli(at, ['state', 'list', '--prefix', prefix]).value.documents as unknown[]) ?? [];
}

const fileIt = (key: string) => (refs: string[]): AgentDecision[] => [
  { outcome: 'file', key, refs, title: 'A new defect', body: 'The brief.', reason: 'real at the base' },
];

describe('the discoveries scripts', () => {
  test('a live pass files the issue with its marker, records the decided refs on the run, and a second pass finds nothing to do', () => {
    const at = install();
    const writer = track(mkdtempSync(join(tmpdir(), 'archon-discoveries-writer-')));
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(writer, 'clone', '-q', git(at.checkout, 'remote', 'get-url', 'upstream'), '.');
    git(writer, 'config', 'user.email', 'test@example.com');
    git(writer, 'config', 'user.name', 'Test');
    git(writer, 'commit', '-q', '--allow-empty', '-m', 'remote advanced');
    git(writer, 'push', '-q', 'origin', 'dev');
    const fresh = git(writer, 'rev-parse', 'HEAD');
    expect(git(at.checkout, 'rev-parse', 'HEAD')).not.toBe(fresh);
    expect(git(at.checkout, 'rev-parse', 'refs/remotes/upstream/dev')).not.toBe(fresh);
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new'), record('covered'), record('fixed')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'file', key: 'new-defect', refs: [refs[0] as string], title: 'A new defect', body: 'The brief.', reason: 'real' },
      { outcome: 'track', key: 'covered-defect', refs: [refs[1] as string], title: 'Covered', issue: ISSUE, comment: 'A new reproduction.', reason: 'issue 7 covers it' },
      { outcome: 'drop', key: 'fixed-defect', refs: [refs[2] as string], title: 'Fixed', reason: 'fixed at the base' },
    ]);
    expect(queued(facts)).toEqual([`${RUN}:review#0`, `${RUN}:review#1`, `${RUN}:review#2`]);
    expect(ok(facts).base).toEqual({ branch: 'dev', sha: fresh });
    const queue = JSON.parse(readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8'));
    expect(queue.base).toEqual({ branch: 'dev', sha: fresh });
    const applied = ok(outcome);
    expect(outcome.createdIssues).toEqual([
      expect.objectContaining({ title: 'A new defect', body: expect.stringMatching(/^<!-- archon-discovery new-defect -->\nThe brief\./) }),
    ]);
    expect(outcome.createdIssues[0]?.body).toContain(`verified at ${fresh} by the archon-discoveries workflow`);
    expect(outcome.comments).toEqual([{ issue: 7, body: '<!-- archon-discovery covered-defect -->\nA new reproduction.' }]);
    expect(applied.dropped).toEqual([{ key: 'fixed-defect', reason: 'fixed at the base' }]);
    expect(state(at, `discoveries/runs/${RUN}`)).toEqual({
      version: 1,
      claim: null,
      decided: [`${RUN}:review#0`, `${RUN}:review#1`, `${RUN}:review#2`],
      questions: [],
    });
    expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN] }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('filing a key whose issue already exists recovers it by its marker, so nothing is filed twice', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('new')] });
    const existing: GhIssue = { number: 50, title: 'A defect', body: '<!-- archon-discovery new-defect -->\nThe brief.', state: 'OPEN' };
    const { outcome } = decide(at, { runId: 'pass-2', runs: [RUN], issues: [existing] }, fileIt('new-defect'));
    expect(ok(outcome).written).toEqual([{ key: 'new-defect', outcome: 'file', url: 'https://ghe.example.com/example/repo/issues/50' }]);
    expect(outcome.createdIssues).toEqual([]);
  }, 60_000);

  test('a run drained before runs kept their own memory counts as decided', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('old')] });
    seed(at, `discoveries/runs/${RUN}`, { version: 1, claim: null });
    expect(ok(script(at, 'facts', { runId: 'pass-1', runs: [RUN] }))).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('facts reads every run document in one state call, not one per run', () => {
    const at = install();
    const ids = Array.from({ length: 4 }, (_, index) => `aaaaaaaa-0000-4000-8000-00000000001${String(index)}`);
    for (const id of ids) {
      runArtifacts(at.outputRoot, id, { verdict: [record('one')] });
      seed(at, `discoveries/runs/${id}`, { version: 1, claim: null, decided: [`${id}:review#0`] });
    }
    const log = join(track(mkdtempSync(join(tmpdir(), 'archon-discoveries-calls-'))), 'calls.jsonl');
    const facts = script(at, 'facts', { runId: 'pass-2', runs: ids }, { ARCHON_CALL_LOG: log });
    expect(ok(facts)).toMatchObject({ path: 'idle' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(argv => argv[0] === 'state')).toEqual([['state', 'list', '--prefix', 'discoveries/runs/', '--values']]);
  }, 60_000);

  test('a refused pass writes nothing: a closed tracking issue, a missing ref', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one'), record('two')] });
    const cases: [Pass, (refs: string[]) => AgentDecision[], string][] = [
      [
        { runId: 'pass-1', runs: [RUN], subject: { state: 'closed' } },
        refs => [{ outcome: 'track', key: 'new-key', refs, title: 't', issue: ISSUE, comment: null, reason: 'r' }],
        'which is not open',
      ],
      [
        { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'failed' } },
        refs => [{ outcome: 'drop', key: 'new-key', refs: refs.slice(1), title: 't', reason: 'r' }],
        'has no decision',
      ],
    ];
    for (const [pass, decisions, why] of cases) {
      const { outcome } = decide(at, pass, decisions);
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(why);
      expect([outcome.createdIssues, outcome.comments]).toEqual([[], []]);
      expect(state(at, `discoveries/runs/${RUN}`)).not.toHaveProperty('decided');
    }
  }, 120_000);

  test('a claim is kept while its run may still finish, and released once it ended', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('one')] });
    expect(ok(script(at, 'facts', { runId: 'pass-1', runs: [RUN] }))).toMatchObject({ path: 'decide' });
    for (const status of ['paused', 'running']) {
      expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': status } }))).toMatchObject({ path: 'idle' });
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

  test('an asked record keeps its run claimed by the asking run, and the answer reaches the next pass', () => {
    const at = install();
    runArtifacts(at.outputRoot, RUN, { verdict: [record('unclear'), record('clear')] });
    const { facts, outcome } = decide(at, { runId: 'pass-1', runs: [RUN] }, refs => [
      { outcome: 'ask', key: 'unclear-scope', refs: [refs[0] as string], title: 'Unclear', question: 'In scope?', recommendation: 'Drop it.' },
      { outcome: 'drop', key: 'clear-drop', refs: [refs[1] as string], title: 'Clear', reason: 'fixed' },
    ]);
    expect(ok(outcome)).toMatchObject({ asked: ['unclear-scope'], question: expect.stringContaining('1. unclear-scope: In scope?') });
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({ claim: { run_id: 'pass-1' }, decided: [`${RUN}:review#1`] });
    // While the asking run waits, no pass takes the run and asks again.
    expect(ok(script(at, 'facts', { runId: 'pass-2', runs: [RUN], statuses: { 'pass-1': 'paused' } }))).toMatchObject({ path: 'idle' });

    const queue = { 'drain/queue.json': readFileSync(join(facts.artifacts, 'drain/queue.json'), 'utf8') };
    ok(script(at, 'answer', { runId: 'pass-1', runs: [] }, { INPUTS_KEYS: '["unclear-scope"]', INPUTS_TEXT: 'Out of scope.' }, queue));
    expect(state(at, `discoveries/runs/${RUN}`)).toMatchObject({
      questions: [{ keys: ['unclear-scope'], text: 'In scope?', answer: { text: 'Out of scope.' } }],
    });
    // Once the asking run ended, the next pass decides only the asked record, with the answer beside it.
    const next = script(at, 'facts', { runId: 'pass-3', runs: [RUN], statuses: { 'pass-1': 'completed' } });
    expect(queued(next)).toEqual([`${RUN}:review#0`]);
    expect(readFileSync(join(next.artifacts, 'drain/queue.json'), 'utf8')).toContain('Out of scope.');
  }, 60_000);

  test('an input outside its vocabulary refuses before anything is read', () => {
    const at = install();
    const refused: Record<string, string>[] = [{ INPUTS_SINCE: 'yesterday' }, { INPUTS_LIMIT: '0' }];
    for (const inputs of refused) {
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
