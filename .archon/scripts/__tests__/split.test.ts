import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { filedIssues, SPLIT_KINDS, splitMarker } from '../../workflows/sdlc/.shared/split';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import { mirrorLabels, newWorkItem, parseWorkItem, type TriageFacts, type WorkItem } from '../../workflows/sdlc/.shared/workitem';
import { gitCheckout, hostCli, labelWrites, PACK, packScriptRunner, PR, type ScriptRun, type TrackerIssue } from './deliver-checks-harness';

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

const ISSUES = [
  { key: 'measure', title: 'Measure the signal', body: 'The measurement contract.' },
  { key: 'feature', title: 'Ship the thin slice', body: 'The slice contract.' },
];
const LATER = [{ title: 'Widen to every route', signal: 'the slice moves the median' }];

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
  { issues = [], existing = [], planned = ISSUES, later = [] }: { issues?: TrackerIssue[]; existing?: unknown[]; planned?: unknown[]; later?: unknown[] } = {}
): ScriptRun {
  return runPackScript('split/scripts/publish', {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    tracker: { issue: { number: 7, author: 'Maintainer', body: 'The PRD.' }, issueLabels: ['archon-split'], issues },
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'run-1',
      INPUTS_PATH: 'slice',
      INPUTS_ITEM: JSON.stringify(SUBJECT),
      INPUTS_SPLIT: JSON.stringify(split),
      INPUTS_ISSUES: JSON.stringify(planned),
      INPUTS_LATER: JSON.stringify(later),
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
  test('files the current phase once, records later phases unfiled, and a rerun files none again', () => {
    const at = install();
    seed(at);
    const first = publish(at, { kind: 'prd' }, { later: LATER });
    expect(ok(first)).toMatchObject({ path: 'slice', item: 7, kind: 'prd' });
    expect(first.createdIssues.map(issue => [issue.number, issue.title])).toEqual([
      [100, 'Measure the signal'],
      [101, 'Ship the thin slice'],
    ]);
    expect(first.createdIssues[0]?.body).toBe(`${splitMarker(7, 'measure')}\n\nThe measurement contract.`);
    expect(first.comments).toEqual([{ issue: 7, body: expect.stringContaining('- Widen to every route. Filed once the earlier work shows: the slice moves the median') }]);
    expect(labelWrites(first, 7).add).toContain('archon-prd');
    expect(first.closes).toEqual([]);
    expect(stored(at)).toMatchObject({ claim: null, facts: { split: { status: 'done', kind: 'prd' } } });

    // A re-triage sends the item back; the next split lists the same keys.
    seed(at);
    expect(publish(at, { kind: 'prd' }, { issues: [...first.createdIssues] }).createdIssues).toEqual([]);
  });

  test('an issue filed before a stop, but not recorded, is recovered by its marker', () => {
    const at = install();
    seed(at);
    const filed: TrackerIssue = { number: 100, title: 'Measure the signal', body: `${splitMarker(7, 'measure')}\n\nThe measurement contract.`, state: 'OPEN' };
    const run = publish(at, { kind: 'bundle' }, { issues: [filed] });
    ok(run);
    expect(run.createdIssues.map(issue => issue.title)).toEqual(['Ship the thin slice']);
    // A bundle is closed with its list; it gets no PRD label.
    expect(run.closes).toEqual([{ number: 7, state: 'closed', state_reason: 'completed' }]);
    expect(labelWrites(run, 7).add).not.toContain('archon-prd');
    expect(filedIssues(stored(at).facts.split).map(issue => issue.number)).toEqual([100, 101]);
  });

  test('an epic stays open', () => {
    const at = install();
    seed(at);
    const run = publish(at, { kind: 'epic' });
    ok(run);
    expect(run.closes).toEqual([]);
    expect(labelWrites(run, 7).add).not.toContain('archon-prd');
  });

  test('an open existing issue is adopted and never filed; a closed one files nothing', () => {
    const at = install();
    seed(at);
    const owner: TrackerIssue = { number: 50, title: 'The light route', body: 'Owned elsewhere.', state: 'OPEN' };
    const run = publish(at, { kind: 'prd' }, { issues: [owner], existing: [{ number: 50, why: 'it owns the light route' }], planned: [] });
    expect(ok(run)).toMatchObject({ adopted: [{ number: 50, why: 'it owns the light route' }] });
    expect(run.createdIssues).toEqual([]);
    expect(run.comments[0]?.body).toContain('- #50 it owns the light route');

    const other = install();
    seed(other);
    const closed = publish(other, { kind: 'prd' }, { issues: [{ ...owner, state: 'CLOSED' }], existing: [{ number: 50, why: 'w' }] });
    expect(closed.code).not.toBe(0);
    expect(closed.stderr).toContain('existing issue 50 is closed, not open');
    expect(closed.createdIssues).toEqual([]);
  });

  test('an item judged one work item files nothing and moves to its build route', () => {
    const at = install();
    seed(at);
    const run = publish(at, { kind: 'whole', route: 'plan' }, { planned: [] });
    expect(ok(run)).toMatchObject({ kind: 'whole', issues: [] });
    expect(run.createdIssues).toEqual([]);
    expect(run.comments).toEqual([{ issue: 7, body: expect.stringContaining('Measure first.') }]);
    expect(labelWrites(run, 7)).toEqual({ add: ['archon-plan'], remove: ['archon-split'] });
    const doc = stored(at);
    expect(doc).toMatchObject({ stage: 'plan', claim: null, facts: { split: { status: 'whole', route: 'plan' } } });
    expect(doc.history.at(-1)).toMatchObject({ stage: 'split', outcome: 'whole', summary: 'Measure first.' });
    // Intake's mirror of the document agrees with the labels publish wrote.
    expect(mirrorLabels(doc)).toContain('archon-plan');
    expect(mirrorLabels(doc)).not.toContain('archon-split');
  });

  test('an item an earlier split filed issues from cannot be built whole', () => {
    const at = install();
    seed(at);
    const first = publish(at, { kind: 'prd' });
    ok(first);
    seed(at);
    const run = publish(at, { kind: 'whole', route: 'plan' }, { issues: [...first.createdIssues], planned: [] });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('the item is already split into #100, #101, so it cannot be built whole');
    expect(run.comments).toEqual([]);
    expect(stored(at).stage).toBe('split');
  });
});
