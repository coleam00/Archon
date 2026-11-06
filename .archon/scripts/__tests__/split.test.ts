import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { SPLIT_KINDS, splitMarker } from '../../workflows/sdlc/.shared/split';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import { mirrorLabels, newWorkItem, parseWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { type GhIssue, gitCheckout, hostCli, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
const SUBJECT = { repo: PR.repo, number: 7 };
const AT = '2026-10-30T00:00:00.000Z';

const TRIAGE: TriageFacts = {
  verdict: { contract: 'READY', route: 'split' },
  pull_request: null,
  type: { value: 'feature', reason: 'r' },
  size: { value: 'l', reason: 'r' },
  complexity: { value: 'medium', reason: 'r' },
  importance: { value: 'high', reason: 'r' },
  urgency: { value: 'none', reason: 'r' },
  at: AT,
  run_id: 'intake-run',
};

const PRD = { kind: 'prd', signal_command: 'bun run signal', window_days: 14 };
const ISSUES = [
  { key: 'measure', title: 'Measure the signal', body: 'The measurement contract.', size: 's', depends_on: [] },
  { key: 'feature', title: 'Ship the feature', body: 'The feature contract.', size: 'm', depends_on: ['measure'] },
];

interface Install {
  readonly checkout: string;
  readonly env: Record<string, string>;
}

function install(): Install {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), 'archon-split-home-')));
  return {
    checkout,
    env: {
      ARCHON_HOME: home,
      HOME: home,
      DATABASE_URL: '',
      ARCHON_TELEMETRY_DISABLED: '1',
      INTAKE_STATE_CWD: checkout,
      INTAKE_HOST_CLI: JSON.stringify(hostCli()),
    },
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

/** Store the item as a split queue run holding its claim finds it. */
function seed(at: Install, change: (doc: WorkItem) => WorkItem = doc => doc): void {
  inProcess(at, () => {
    const stored = stateGet('work/7');
    const current = stored.value === null ? newWorkItem(SUBJECT, AT) : parseWorkItem(stored.value);
    const doc = change({
      ...current,
      stage: 'split',
      trust: 'maintainer',
      claim: { run_id: 'run-1', at: AT, requests: [] },
      facts: { ...current.facts, triage: TRIAGE },
    });
    expect(statePut('work/7', doc, stored.revision)).toBe('ok');
  });
}

function stored(at: Install): WorkItem {
  return inProcess(at, () => parseWorkItem(stateGet('work/7').value));
}

function publish(
  at: Install,
  split: unknown,
  issues: readonly GhIssue[] = [],
  existing: unknown[] = [],
  planned: readonly unknown[] = ISSUES
): ScriptRun {
  return runPackScript('split/scripts/publish', {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: { issue: { number: 7, author: 'Maintainer', body: 'The PRD.' }, issueLabels: ['archon-split'], repositoryLabels: [], issues, comments: [] },
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_PATH: 'slice',
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_SPLIT: JSON.stringify(split),
      INPUTS_ISSUES: JSON.stringify(planned),
      INPUTS_EXISTING: JSON.stringify(existing),
      INPUTS_SUMMARY: 'Measure first.',
    },
  });
}

function ok(result: ScriptRun): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("the split kinds are the slice node's own enum", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'split/archon-split.yaml'), 'utf8')) as {
    nodes: { id: string; output_format?: { properties: { split: { anyOf: { properties: { kind: { enum: string[] } } }[] } } } }[];
  };
  const branches = workflow.nodes.find(node => node.id === 'slice')?.output_format?.properties.split.anyOf ?? [];
  expect(branches.flatMap(branch => branch.properties.kind.enum)).toEqual([...SPLIT_KINDS, 'whole']);
});

describe('split publish', () => {
  test('files each issue once with its marker and dependency, and a rerun files none again', () => {
    const at = install();
    seed(at);
    const first = publish(at, PRD);
    expect(ok(first)).toMatchObject({ path: 'slice', item: 7, kind: 'prd' });
    expect(first.createdIssues.map(issue => [issue.number, issue.title])).toEqual([
      [100, 'Measure the signal'],
      [101, 'Ship the feature'],
    ]);
    expect(first.createdIssues[0]?.body.split('\n')[0]).toBe(splitMarker(7, 'measure'));
    expect(first.createdIssues[1]?.body).toEndWith('The feature contract.\n\nDepends on: #100');
    expect(first.comments).toEqual([{ issue: 7, body: expect.stringContaining('- #100 Measure the signal\n- #101 Ship the feature') }]);
    expect(first.gh.some(call => call.includes('--add-label archon-prd'))).toBe(true);
    expect(first.closes).toEqual([]);
    const split = stored(at).facts.split;
    expect(split).toMatchObject({ status: 'done', kind: 'prd', signal_command: 'bun run signal', window_days: 14 });
    expect(split?.issues.map(issue => [issue.key, issue.number])).toEqual([['measure', 100], ['feature', 101]]);
    expect(stored(at).claim).toBeNull();

    // A re-triage sends the item back; the second split lists the same keys.
    seed(at);
    expect(publish(at, PRD, first.createdIssues).createdIssues).toEqual([]);
  });

  test('an issue filed before a stop, but not recorded, is recovered by its marker from one scan', () => {
    const at = install();
    seed(at);
    const filed: GhIssue = {
      number: 100,
      title: 'Measure the signal',
      body: `${splitMarker(7, 'measure')}\n\nThe measurement contract.`,
      state: 'OPEN',
    };
    const run = publish(at, { kind: 'bundle' }, [filed]);
    ok(run);
    expect(run.createdIssues.map(issue => issue.title)).toEqual(['Ship the feature']);
    // Both unrecorded keys are looked up in one listing of the repository's issues.
    expect(run.gh.filter(call => call.includes('issues?state=all'))).toHaveLength(1);
    expect(run.createdIssues[0]?.body).toEndWith('Depends on: #100');
    // A bundle is closed with its list; it gets no PRD label.
    expect(run.closes).toEqual([{ number: 7, state: 'closed', state_reason: 'completed' }]);
    expect(run.gh.some(call => call.includes('archon-prd'))).toBe(false);
    expect(stored(at).facts.split).toMatchObject({ status: 'done', kind: 'bundle', signal_command: null });
  });

  test('an existing issue the outcome depends on is recorded as adopted and never filed', () => {
    const at = install();
    seed(at);
    const owner: GhIssue = { number: 50, title: 'The light route', body: 'Owned elsewhere.', state: 'OPEN' };
    const run = publish(at, PRD, [owner], [{ number: 50, why: 'it owns the light route' }]);
    expect(ok(run)).toMatchObject({ adopted: [{ number: 50, why: 'it owns the light route' }] });
    expect(run.createdIssues.map(issue => issue.number)).toEqual([101, 102]);
    expect(run.comments[0]?.body).toContain('- #50 it owns the light route');
    const split = stored(at).facts.split;
    expect(split?.issues.map(issue => issue.number)).toEqual([101, 102]);
    expect(split?.status === 'done' ? split.adopted : null).toEqual([
      { number: 50, url: 'https://ghe.example.com/example/repo/issues/50', why: 'it owns the light route' },
    ]);
  });

  test('an epic stays open after its split and gets no PRD label', () => {
    const at = install();
    seed(at);
    const run = publish(at, { kind: 'epic' });
    expect(ok(run)).toMatchObject({ kind: 'epic' });
    expect(run.createdIssues).toHaveLength(2);
    expect(run.closes).toEqual([]);
    expect(run.gh.some(call => call.includes('archon-prd'))).toBe(false);
    expect(run.comments[0]?.body).toContain('It stays open until they merge.');
  });

  test('an item judged one work item files nothing and moves to its build route', () => {
    const at = install();
    seed(at);
    const run = publish(at, { kind: 'whole', route: 'plan' }, [], [], []);
    expect(ok(run)).toMatchObject({ kind: 'whole', issues: [] });
    expect(run.createdIssues).toEqual([]);
    expect(run.closes).toEqual([]);
    expect(run.comments).toEqual([{ issue: 7, body: expect.stringContaining('Measure first.') }]);
    expect(run.gh.some(call => call.includes('--add-label archon-plan') && call.includes('--remove-label archon-split'))).toBe(true);
    const doc = stored(at);
    expect(doc).toMatchObject({ stage: 'plan', claim: null, facts: { split: { status: 'whole', route: 'plan', reason: 'Measure first.' } } });
    // Intake's mirror of the document agrees with the labels publish wrote.
    expect(mirrorLabels(doc)).toContain('archon-plan');
    expect(mirrorLabels(doc)).not.toContain('archon-split');
  });

  test('an item judged one work item that still lists issues files nothing', () => {
    const at = install();
    seed(at);
    const run = publish(at, { kind: 'whole', route: 'deliver' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('an item built whole lists no issues');
    expect(run.createdIssues).toEqual([]);
    expect(stored(at).stage).toBe('split');
  });

  test('an item an earlier split filed issues from cannot be built whole', () => {
    const at = install();
    seed(at);
    const first = publish(at, PRD);
    ok(first);
    seed(at);
    const run = publish(at, { kind: 'whole', route: 'plan' }, first.createdIssues, [], []);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the item is already split into #100, #101, so it cannot be built whole');
    expect(run.comments).toEqual([]);
    expect(stored(at).stage).toBe('split');
  });

  test('a closed issue listed as an existing dependency files nothing', () => {
    const at = install();
    seed(at);
    const done: GhIssue = { number: 50, title: 'The light route', body: 'Closed.', state: 'CLOSED' };
    const run = publish(at, PRD, [done], [{ number: 50, why: 'it owns the light route' }]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('existing issue 50 is closed, not open');
    expect(run.createdIssues).toEqual([]);
  });

  test('a list whose dependency is neither filed nor listed earlier files nothing', () => {
    const at = install();
    seed(at);
    const run = runPackScript('split/scripts/publish', {
      cwd: at.checkout,
      forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
      gh: { issue: { number: 7, body: 'The PRD.' }, issues: [] },
      inputs: {
        ...at.env,
        WORKFLOW_ID: 'run-1',
        INPUTS_PATH: 'slice',
        INPUTS_ITEM: JSON.stringify(SUBJECT),
        INPUTS_SPLIT: JSON.stringify(PRD),
        INPUTS_ISSUES: JSON.stringify([...ISSUES].reverse()),
        INPUTS_EXISTING: '[]',
        INPUTS_SUMMARY: 's',
      },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('feature depends on measure, which is neither filed nor listed before it');
    expect(run.createdIssues).toEqual([]);
  });
});
