import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from './temp-roots';
import type { Closure } from '../../workflows/sdlc/.shared/close';
import { stateGet, statePut } from '../../workflows/sdlc/.shared/state';
import {
  assertNoSelfPromotion,
  bodyDigest,
  claimItem,
  decideIntake,
  type IntakeRequest,
  type IssueFacts,
  mirrorLabels,
  newWorkItem,
  parseWorkItem,
  PICKUP_ORDER,
  sortCandidates,
  type TriageFacts,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import { parseMaintainerList, parseMaintainers } from '../../workflows/sdlc/.shared/maintainers';
import {
  gitCheckout,
  hostCli,
  type TrackerComment,
  type TrackerIssue,
  labelWrites,
  packScriptRunner,
  PR,
  type ScriptRun,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const AT = '2026-10-14T00:00:00.000Z';
const BODY = 'An issue body';
const DIGEST = bodyDigest(BODY);
const MAINTAINERS = parseMaintainers('["Maintainer"]');
const SUBJECT = { repo: PR.repo, number: 7 };

function triaged(overrides: Partial<TriageFacts> = {}): TriageFacts {
  return {
    verdict: { contract: 'READY', route: 'deliver' },
    pull_request: null,
    type: { value: 'feature', reason: 'r' },
    size: { value: 's', reason: 'r' },
    complexity: { value: 'low', reason: 'r' },
    importance: { value: 'medium', reason: 'r' },
    urgency: { value: 'none', reason: 'r' },
    at: AT,
    run_id: 'earlier',
    ...overrides,
  };
}

function item(overrides: Partial<WorkItem> = {}, requests: IntakeRequest[] = []): WorkItem {
  return {
    ...newWorkItem(SUBJECT, AT),
    claim: { run_id: 'run', at: AT, requests },
    ...overrides,
  };
}

function labelRequest(label: string, actor: string | null, digest = DIGEST): IntakeRequest {
  return { at: AT, run_id: 'event', action: 'added', label, actor, body_digest: digest };
}

function issue(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return { author: 'stranger', labels: [], state: 'open', digest: DIGEST, ...overrides };
}

const decide = (doc: WorkItem, facts: IssueFacts) =>
  decideIntake(doc, facts, MAINTAINERS, AT, 'run');

describe('the intake decision', () => {
  test('an outside item gets archon-needs-maintainer and no agent node', () => {
    for (const author of ['stranger', null]) {
      const decision = decide(item(), issue({ author }));
      expect(decision).toMatchObject({
        path: 'outside',
        trust: 'outside',
        stage: 'needs_maintainer',
      });
      expect(mirrorLabels({ ...item(), stage: decision.stage })).toEqual([
        'archon-needs-maintainer',
      ]);
    }
  });

  test('a listed author is a maintainer, case-insensitively, and an untriaged item is triaged', () => {
    expect(decide(item(), issue({ author: 'MAINTAINER' }))).toMatchObject({
      path: 'triage',
      trust: 'maintainer',
    });
  });

  test('a source that does not report authors refuses rather than guessing trust', () => {
    expect(() => decide(item(), issue({ author: undefined }))).toThrow(
      'does not report issue authors'
    );
  });

  test('a route label added by a login not in maintainers.json promotes nothing', () => {
    for (const actor of ['stranger', null]) {
      const decision = decide(
        item({ trust: 'outside', stage: 'needs_maintainer' }, [
          labelRequest('archon-ready', actor),
        ]),
        issue({ labels: ['archon-ready'] })
      );
      expect(decision).toMatchObject({ path: 'outside', promoted: null });
      expect(decision.notes).toEqual([
        expect.objectContaining({
          outcome: 'refused',
          summary: expect.stringContaining(actor ?? 'unknown account'),
        }),
      ]);
    }
  });

  test("a maintainer's request label promotes an outside item, pinned to the body it was recorded at", () => {
    const doc = item({ trust: 'outside', stage: 'needs_maintainer' }, [
      labelRequest('archon-triage', 'maintainer'),
    ]);
    const decision = decide(doc, issue({ labels: ['archon-triage'] }));
    expect(decision).toMatchObject({
      path: 'triage',
      promoted: { by: 'maintainer', label: 'archon-triage', pin: { body_digest: DIGEST } },
    });
    const stale = item({ trust: 'outside', stage: 'needs_maintainer' }, [
      labelRequest('archon-triage', 'maintainer', bodyDigest('the body before an edit')),
    ]);
    const refused = decide(stale, issue({ labels: ['archon-triage'] }));
    expect(refused).toMatchObject({ path: 'outside', promoted: null });
    expect(refused.notes[0]?.summary).toContain('body changed after the request');
  });

  test('a promoted item whose body digest changed is demoted, with the reason recorded', () => {
    const promoted = {
      at: AT,
      via: 'label' as const,
      by: 'maintainer',
      label: 'archon-triage',
      pin: { body_digest: DIGEST },
    };
    const doc = item({
      trust: 'outside',
      stage: 'deliver',
      promoted,
      facts: { triage: triaged() },
    });
    const edited = bodyDigest('an edited body');
    const decision = decide(doc, issue({ digest: edited, labels: ['archon-ready'] }));
    expect(decision).toMatchObject({ path: 'outside', stage: 'needs_maintainer', promoted: null });
    expect(decision.notes).toEqual([
      expect.objectContaining({
        outcome: 'demoted',
        summary: expect.stringContaining(`pinned ${DIGEST}, now ${edited}`),
      }),
    ]);
  });

  test("the pack's own label write is an echo, and recorded trust never changes", () => {
    // The install wrote archon-ready on a promoted outside item; its event comes back
    // with the install's own login, which is not on the list. It is neither refused
    // nor a promotion.
    const promoted = {
      at: AT,
      via: 'label' as const,
      by: 'maintainer',
      label: 'archon-triage',
      pin: { body_digest: DIGEST },
    };
    const doc = item(
      { trust: 'outside', stage: 'deliver', promoted, facts: { triage: triaged() } },
      [labelRequest('archon-ready', 'install')]
    );
    expect(decide(doc, issue({ author: 'maintainer', labels: ['archon-ready'] }))).toMatchObject({
      path: 'quiet',
      trust: 'outside',
      notes: [],
    });
  });

  test("a maintainer's route label on a maintainer item is reconciled; archon-triage re-triages", () => {
    const base = {
      trust: 'maintainer' as const,
      stage: 'deliver' as const,
      facts: { triage: triaged() },
    };
    const reconciled = decide(
      item(base, [labelRequest('archon-plan', 'maintainer')]),
      issue({ labels: ['archon-plan'] })
    );
    expect(reconciled).toMatchObject({ path: 'quiet', stage: 'deliver' });
    expect(reconciled.notes[0]).toMatchObject({ outcome: 'reconciled' });
    expect(
      decide(
        item(base, [labelRequest('archon-triage', 'maintainer')]),
        issue({ labels: ['archon-triage'] })
      ).path
    ).toBe('triage');
  });

  test('a request label removed before intake reads it is void', () => {
    const decision = decide(
      item({ trust: 'outside', stage: 'needs_maintainer' }, [
        labelRequest('archon-triage', 'maintainer'),
      ]),
      issue()
    );
    expect(decision).toMatchObject({ path: 'outside', promoted: null });
    expect(decision.notes[0]).toMatchObject({ outcome: 'void' });
  });

  test('the outcome refuses to add a request label to an outside item no maintainer promoted', () => {
    const outside = item({
      trust: 'outside',
      facts: { intake: { body_digest: DIGEST, at: AT, run_id: 'run', waiting: [] } },
    });
    expect(() => assertNoSelfPromotion(outside, ['archon-ready'])).toThrow(
      'no maintainer promoted'
    );
    expect(() => assertNoSelfPromotion(outside, ['archon-needs-maintainer'])).not.toThrow();
    expect(() =>
      assertNoSelfPromotion({ ...outside, trust: 'maintainer' }, ['archon-ready'])
    ).not.toThrow();
  });
});

describe('pickup', () => {
  test('candidates sort by the keys, untriaged after triaged and oldest first, then by number', () => {
    const at = (number: number, created: string, triage?: TriageFacts) => ({
      doc: { ...newWorkItem({ repo: PR.repo, number }, created), facts: triage ? { triage } : {} },
    });
    const sorted = sortCandidates(
      [
        at(1, '2026-01-03', undefined),
        at(2, '2026-01-01', undefined),
        at(3, '2026-01-05', triaged({ urgency: { value: 'none', reason: 'r' } })),
        at(4, '2026-01-05', triaged({ urgency: { value: 'now', reason: 'r' } })),
        at(
          5,
          '2026-01-05',
          triaged({ urgency: { value: 'now', reason: 'r' }, size: { value: 'l', reason: 'r' } })
        ),
        at(0, '2026-01-01', undefined),
      ],
      PICKUP_ORDER
    );
    expect(sorted.map(entry => entry.doc.subject.number)).toEqual([4, 5, 3, 0, 2, 1]);
  });

  test('an item whose last attempt failed sorts after every other waiting item', () => {
    const released = {
      ...newWorkItem({ repo: PR.repo, number: 1 }, '2026-01-01'),
      facts: { triage: triaged({ urgency: { value: 'now', reason: 'r' } }) },
      history: [{ at: AT, stage: 'intake' as const, run_id: 'r', outcome: 'released', summary: '' }],
    };
    const fresh = newWorkItem({ repo: PR.repo, number: 2 }, '2026-02-01');
    const order = (docs: WorkItem[]) =>
      sortCandidates(
        docs.map(doc => ({ doc })),
        PICKUP_ORDER
      ).map(entry => entry.doc.subject.number);
    expect(order([released, fresh])).toEqual([2, 1]);
    // A decision recorded after the release means the item's last attempt finished.
    const recovered = {
      ...released,
      facts: { ...released.facts, intake: { body_digest: DIGEST, at: '2026-10-15T00:00:00.000Z', run_id: 'later', waiting: [] } },
    };
    expect(order([recovered, fresh])).toEqual([1, 2]);
  });

  test('the maintainer list is an array of logins; anything else refuses', () => {
    expect([...parseMaintainers('[" Wirasm ", "Other"]')]).toEqual(['wirasm', 'other']);
    expect(() => parseMaintainers('{"maintainers": []}')).toThrow('JSON array of forge logins');
    expect(() => parseMaintainers('[""]')).toThrow('JSON array of forge logins');
    const list = parseMaintainerList('["Alice", { "login": " Wirasm ", "merge_queue": "own-prs" }]');
    expect([...list.logins]).toEqual(['alice', 'wirasm']);
    expect([...list.ownPrs]).toEqual(['wirasm']);
    expect(() => parseMaintainerList('[{ "login": "x", "merge_queue": "all" }]')).toThrow('JSON array of forge logins');
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
  git(checkout, 'checkout', '-q', '-b', 'policy');
  mkdirSync(join(checkout, '.archon/sdlc/policy'), { recursive: true });
  writeFileSync(join(checkout, '.archon/sdlc/policy/maintainers.json'), '["Maintainer"]\n');
  git(checkout, 'add', '.archon/sdlc/policy/maintainers.json');
  git(checkout, 'commit', '-q', '-m', 'maintainers');
  git(checkout, 'push', '-q', 'upstream', 'HEAD:dev');
  git(checkout, 'checkout', '-q', 'feature');
  const home = track(mkdtempSync(join(tmpdir(), 'archon-intake-home-')));
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

interface Event {
  readonly runId: string;
  readonly author?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly action?: string;
  readonly label?: string;
  readonly actor?: string;
  readonly issueLabels?: readonly string[];
  readonly statuses?: Record<string, string>;
  readonly state?: 'open' | 'closed';
  readonly stateReason?: string;
  readonly writeLost?: boolean;
  /** Other issues on the tracker, such as the original a duplicate links to. */
  readonly others?: readonly TrackerIssue[];
  /** Comments already on the tracker's issues. */
  readonly comments?: readonly TrackerComment[];
}

function run(
  at: Install,
  script: string,
  event: Event,
  inputs: Record<string, string> = {}
): ScriptRun {
  return runPackScript(`intake/scripts/${script}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON], fakeForge: true },
    tracker: {
      issue: {
        number: 7,
        author: event.author ?? 'Maintainer',
        body: event.body ?? BODY,
        state: event.state ?? 'open',
        state_reason: event.stateReason,
      },
      issueLabels: event.issueLabels ?? [],
      repositoryLabels: [],
      writeLost: event.writeLost,
      issues: event.others,
      comments: event.comments,
    },
    inputs: {
      ...at.env,
      WORKFLOW_ID: event.runId,
      INTAKE_RUN_STATUSES: JSON.stringify(event.statuses ?? {}),
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_NUMBER: '7',
      INPUTS_KIND: event.kind ?? 'issue',
      INPUTS_ACTION: event.action ?? 'opened',
      INPUTS_LABEL: event.label ?? '',
      INPUTS_LABEL_ACTOR: event.actor ?? '',
      ...inputs,
    },
  });
}

function facts(at: Install, event: Event): { run: ScriptRun; output: Record<string, unknown> } {
  const result = run(at, 'facts', event);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return { run: result, output: JSON.parse(result.stdout) as Record<string, unknown> };
}

const READY_VERDICT = {
  INPUTS_CONTRACT: 'READY',
  INPUTS_ROUTE: 'deliver',
  INPUTS_PULL_REQUEST: 'null',
  INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
  INPUTS_SIZE: '{"value":"s","reason":"one script"}',
  INPUTS_COMPLEXITY: '{"value":"low","reason":"clear"}',
  INPUTS_IMPORTANCE: '{"value":"high","reason":"on direction"}',
  INPUTS_URGENCY: '{"value":"soon","reason":"next release"}',
  INPUTS_LABELS: '["archon-ready","archon-size-s","archon-type-feature"]',
  INPUTS_SUMMARY: 'Ready to deliver',
  INPUTS_CLOSURE: 'null',
  INPUTS_RELATED: '[{"url":"https://ghe.example.com/example/repo/issues/5","relation":"an earlier attempt, closed"}]',
  INPUTS_REPORT: '{"type":"archon_artifact","run_id":"run-1","path":"triage.md"}',
};
const SKIPPED_TRIAGE = Object.fromEntries(Object.keys(READY_VERDICT).map(key => [key, 'null']));

const ISSUE_URL = 'https://ghe.example.com/example/repo/issues/7';
const ORIGINAL_URL = 'https://ghe.example.com/example/repo/issues/3';
const ORIGINAL: TrackerIssue = { number: 3, title: 'The original', body: 'Its body', state: 'OPEN' };
const MERGED_URL = 'https://ghe.example.com/example/repo/pull/5';

function closeVerdict(closure: Closure): Record<string, string> {
  return {
    ...READY_VERDICT,
    INPUTS_CONTRACT: 'NO_ACTION',
    INPUTS_ROUTE: 'no_action',
    INPUTS_LABELS: '["archon-close","archon-type-feature"]',
    INPUTS_CLOSURE: JSON.stringify(closure),
  };
}
const DUPLICATE_VERDICT = closeVerdict({
  kind: 'duplicate',
  url: ORIGINAL_URL,
  original: { repo: PR.repo, number: 3 },
});

/** A refused close writes nothing on the forge but the BLOCKED labels, and stores why. */
function expectLeftToMaintainer(at: Install, applied: ScriptRun, refused: string): void {
  expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
  expect([...applied.closes, ...applied.comments]).toEqual([]);
  expect(labelWrites(applied, 7)).toEqual({ add: ['archon-blocked', 'archon-size-s', 'archon-type-feature'], remove: [] });
  const doc = stored(at).value;
  expect(doc).toMatchObject({
    stage: 'blocked',
    claim: null,
    facts: { triage: { verdict: { contract: 'BLOCKED' } } },
  });
  expect(doc.history.at(-1)).toMatchObject({
    verdict: 'BLOCKED',
    summary: expect.stringContaining(refused),
  });
}

function outcome(
  at: Install,
  event: Event,
  decided: Record<string, unknown>,
  verdict: Record<string, string>
): ScriptRun {
  return run(at, 'outcome', event, {
    INPUTS_PATH: String(decided.path),
    INPUTS_ITEM: JSON.stringify(decided.item),
    INPUTS_DECISION: JSON.stringify(decided.decision),
    ...verdict,
  });
}

function stored(at: Install): { revision: number; value: WorkItem } {
  const [command, ...prefix] = hostCli();
  const result = spawnSync(command, [...prefix, 'state', 'get', 'work/7'], {
    cwd: at.checkout,
    env: { ...process.env, ...at.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(result.stdout) as { revision: number; value: unknown };
  return { revision: parsed.revision, value: parseWorkItem(parsed.value) };
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

describe('the intake scripts', () => {
  test('a trusted item is triaged, its work item holds the five fields, and it carries the route label', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    expect(decided).toMatchObject({
      path: 'triage',
      item: SUBJECT,
      decision: { trust: 'maintainer' },
    });
    expect(stored(at).value.claim?.run_id).toBe('run-1');

    const applied = outcome(at, { runId: 'run-1' }, decided, READY_VERDICT);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(labelWrites(applied, 7)).toEqual({ add: ['archon-ready', 'archon-size-s', 'archon-type-feature'], remove: [] });
    const doc = stored(at).value;
    expect(doc).toMatchObject({ stage: 'deliver', trust: 'maintainer', claim: null, requests: [] });
    expect(doc.facts.triage).toMatchObject({
      verdict: { contract: 'READY', route: 'deliver' },
      type: { value: 'feature' },
      size: { value: 's' },
      complexity: { value: 'low' },
      importance: { value: 'high' },
      urgency: { value: 'soon' },
    });
    // Related work is stored for later rounds; the run-only fields are not.
    expect(doc.facts.triage?.related).toEqual([
      { url: 'https://ghe.example.com/example/repo/issues/5', relation: 'an earlier attempt, closed' },
    ]);
    expect(Object.keys(doc.facts.triage ?? {}).sort()).toEqual(
      ['at', 'complexity', 'importance', 'pull_request', 'related', 'run_id', 'size', 'type', 'urgency', 'verdict']
    );
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'deliver',
      verdict: 'READY',
      report: { path: 'triage.md' },
    });
  }, 60_000);

  test('a second pickup at the same work-item revision skips the item', () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    const claimedRevision = stored(at).revision;
    // A pull request's event records no request, so this run is only a pickup.
    const second = facts(at, {
      runId: 'run-2',
      kind: 'pr',
      statuses: { 'run-1': 'running' },
    }).output;
    expect(second).toMatchObject({ path: 'idle', item: null });
    expect(stored(at).revision).toBe(claimedRevision);

    // The same race in-process: a pickup that read the item before run-1's claim
    // loses the conditional write and skips the item.
    const unclaimed = {
      ...stored(at).value,
      claim: null,
      requests: [labelRequest('archon-triage', 'maintainer')],
    };
    expect(
      inProcess(at, () =>
        claimItem({ name: 'work/7', revision: claimedRevision - 1, doc: unclaimed, lease: null }, AT, 'run-3')
      )
    ).toBeNull();
    expect(stored(at).value.claim?.run_id).toBe('run-1');
  }, 60_000);

  test("a failed run keeps its claim; the next pickup releases a cancelled run's claim and queues its requests again", () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    // A failed run can resume, so its lease, and with it the claim, stands.
    const held = facts(at, { runId: 'run-2', kind: 'pr', statuses: { 'run-1': 'failed' } }).output;
    expect(held).toMatchObject({ path: 'idle', item: null });
    expect(stored(at).value.claim?.run_id).toBe('run-1');
    const decided = facts(at, {
      runId: 'run-2',
      kind: 'pr',
      statuses: { 'run-1': 'cancelled' },
    }).output;
    expect(decided).toMatchObject({ path: 'triage', item: SUBJECT });
    const doc = stored(at).value;
    expect(doc.claim).toMatchObject({
      run_id: 'run-2',
      requests: [expect.objectContaining({ run_id: 'run-1', action: 'opened' })],
    });
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'released',
      summary: expect.stringContaining('run-1, which ended without finishing'),
    });
  }, 60_000);
  function idleOutcome(at: Install, event: Event): string {
    // A skipped document is noted on stderr as well, so only the exit codes are pinned.
    const picked = run(at, 'facts', event);
    expect(picked.code).toBe(0);
    expect(JSON.parse(picked.stdout)).toMatchObject({ path: 'idle', item: null });
    const result = run(at, 'outcome', event, { INPUTS_PATH: 'idle', INPUTS_ITEM: 'null', INPUTS_DECISION: 'null' });
    expect(result.code).toBe(0);
    return (JSON.parse(result.stdout) as { summary: string }).summary;
  }

  test('a claim whose run holds no lease stays held, and the idle pass names it and the run', () => {
    const at = install();
    const held = { ...newWorkItem(SUBJECT, AT), claim: { run_id: 'ghost-run', at: AT, requests: [] } };
    inProcess(at, () => statePut('work/7', held, 0));
    const summary = idleOutcome(at, { runId: 'run-1', kind: 'pr' });
    expect(stored(at).value.claim?.run_id).toBe('ghost-run');
    expect(summary).toContain('work/7');
    expect(summary).toContain('ghost-run');
  }, 60_000);

  test('a request label added while the item is claimed stays on the issue for the next pickup', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    // The label lands before its own run records the request.
    const applied = outcome(
      at,
      { runId: 'run-1', issueLabels: ['archon-triage'] },
      decided,
      READY_VERDICT
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(labelWrites(applied, 7).remove).toEqual([]);
  }, 60_000);

  test('labels that fail to write leave the stage stored and the claim held, and the next pickup writes them', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    const failed = outcome(at, { runId: 'run-1', writeLost: true }, decided, READY_VERDICT);
    expect(failed.code).not.toBe(0);
    expect(stored(at).value).toMatchObject({
      stage: 'deliver',
      claim: { run_id: 'run-1' },
    });

    const retried = facts(at, { runId: 'run-2', kind: 'pr', statuses: { 'run-1': 'cancelled' } });
    expect(retried.output).toMatchObject({ path: 'quiet', item: SUBJECT });
    expect(stored(at).value.claim).toMatchObject({
      run_id: 'run-2',
      requests: [expect.objectContaining({ run_id: 'run-1', action: 'opened' })],
    });
    const applied = outcome(at, { runId: 'run-2' }, retried.output, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(labelWrites(applied, 7)).toEqual({ add: ['archon-ready', 'archon-size-s', 'archon-type-feature'], remove: [] });
    expect(stored(at).value).toMatchObject({ stage: 'deliver', claim: null, requests: [] });
  }, 60_000);

  test('a promoted item whose body changes while triage runs is demoted, unlabelled and left open', () => {
    const at = install();
    const outside = { author: 'stranger' };
    expect(
      outcome(
        at,
        { ...outside, runId: 'run-1' },
        facts(at, { ...outside, runId: 'run-1' }).output,
        SKIPPED_TRIAGE
      ).code
    ).toBe(0);
    const promote = {
      ...outside,
      action: 'added',
      label: 'archon-triage',
      actor: 'Maintainer',
      issueLabels: ['archon-triage', 'archon-needs-maintainer'],
    };
    const decided = facts(at, { ...promote, runId: 'run-2', statuses: { 'run-1': 'completed' } })
      .output;
    expect(decided).toMatchObject({ path: 'triage', decision: { promoted: { by: 'Maintainer' } } });

    const applied = outcome(
      at,
      { ...promote, runId: 'run-2', body: 'An edited body', others: [ORIGINAL] },
      decided,
      DUPLICATE_VERDICT
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(labelWrites(applied, 7)).toEqual({ add: [], remove: ['archon-triage'] });
    expect([...applied.closes, ...applied.comments]).toEqual([]);
    const doc = stored(at).value;
    expect(doc).toMatchObject({ stage: 'needs_maintainer', promoted: null, claim: null });
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'demoted',
      summary: expect.stringContaining('during triage'),
    });
  }, 60_000);

  test('a duplicate is closed as one, linked to its original, and the original links back', () => {
    const at = install();
    const event = { runId: 'run-1', others: [ORIGINAL] };
    const applied = outcome(at, event, facts(at, event).output, DUPLICATE_VERDICT);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.closes).toEqual([{ number: 7, state: 'closed', state_reason: 'duplicate' }]);
    expect(applied.comments).toEqual([
      { issue: 7, body: expect.stringContaining(ORIGINAL_URL) },
      { issue: 3, body: expect.stringContaining(ISSUE_URL) },
    ]);
    expect(stored(at).value).toMatchObject({ stage: 'close', claim: null });
  }, 60_000);

  test('a close repeated after it stopped short writes no second comment and finishes', () => {
    const event = { runId: 'run-1', others: [ORIGINAL] };
    const first = install();
    const written = outcome(first, event, facts(first, event).output, DUPLICATE_VERDICT).comments;
    expect(written).toHaveLength(2);

    // The tracker as a run that stopped after its comments left it.
    const comments = written.map((row, index) => ({ id: 500 + index, ...row }));
    const at = install();
    const repeated = outcome(at, { ...event, comments }, facts(at, event).output, DUPLICATE_VERDICT);
    expect({ code: repeated.code, stderr: repeated.stderr }).toEqual({ code: 0, stderr: '' });
    expect(repeated.comments).toEqual([]);
    expect(repeated.closes).toEqual([{ number: 7, state: 'closed', state_reason: 'duplicate' }]);
  }, 60_000);

  test('a close repeated after the item closed finishes without writing', () => {
    const at = install();
    const event = { runId: 'run-1', others: [ORIGINAL] };
    const decided = facts(at, event).output;
    const closed = { ...event, state: 'closed' as const, stateReason: 'duplicate' };
    const repeated = outcome(at, closed, decided, DUPLICATE_VERDICT);
    expect({ code: repeated.code, stderr: repeated.stderr }).toEqual({ code: 0, stderr: '' });
    expect([...repeated.closes, ...repeated.comments]).toEqual([]);
    expect(stored(at).value).toMatchObject({ stage: 'close', claim: null });
  }, 60_000);

  test('an item someone closed for another reason is refused before any comment', () => {
    const at = install();
    const event = { runId: 'run-1', others: [ORIGINAL] };
    const decided = facts(at, event).output;
    const closed = { ...event, state: 'closed' as const, stateReason: 'not_planned' };
    const applied = outcome(at, closed, decided, DUPLICATE_VERDICT);
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toContain('already closed for another reason');
    expect([...applied.closes, ...applied.comments]).toEqual([]);
  }, 60_000);

  test('a duplicate of a closed issue closes nothing; the policy leaves it to a maintainer', () => {
    const at = install();
    const event = { runId: 'run-1', others: [{ ...ORIGINAL, state: 'CLOSED' as const }] };
    const applied = outcome(at, event, facts(at, event).output, DUPLICATE_VERDICT);
    expectLeftToMaintainer(at, applied, `${ORIGINAL_URL} is closed`);
  }, 60_000);

  test('an item declared a duplicate of itself closes nothing', () => {
    const at = install();
    const self = closeVerdict({ kind: 'duplicate', url: ISSUE_URL, original: SUBJECT });
    const applied = outcome(at, { runId: 'run-1' }, facts(at, { runId: 'run-1' }).output, self);
    expectLeftToMaintainer(at, applied, 'cannot be closed as a duplicate of itself');
  }, 60_000);

  test('a duplicate of a pull request closes nothing; an open pull request is continued', () => {
    const at = install();
    const pull: TrackerIssue = { number: 5, title: 'A change', body: '', state: 'OPEN', pull: true };
    const event = { runId: 'run-1', others: [pull] };
    const applied = outcome(
      at,
      event,
      facts(at, event).output,
      closeVerdict({ kind: 'duplicate', url: MERGED_URL, original: { repo: PR.repo, number: 5 } })
    );
    expectLeftToMaintainer(at, applied, 'repo#5 is a pull request, not an issue');
  }, 60_000);

  test('a NO_ACTION verdict that arrives without its closure is refused', () => {
    const at = install();
    const applied = outcome(
      at,
      { runId: 'run-1' },
      facts(at, { runId: 'run-1' }).output,
      { ...DUPLICATE_VERDICT, INPUTS_CLOSURE: 'null' }
    );
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toContain('only that one, carries a closure');
    expect(labelWrites(applied, 7)).toEqual({ add: [], remove: [] });
  }, 60_000);

  test('a delivered item is closed as completed, linked to the merged change', () => {
    const at = install();
    const applied = outcome(
      at,
      { runId: 'run-1' },
      facts(at, { runId: 'run-1' }).output,
      closeVerdict({ kind: 'delivered', url: MERGED_URL })
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.closes).toEqual([{ number: 7, state: 'closed', state_reason: 'completed' }]);
    expect(applied.comments).toEqual([{ issue: 7, body: expect.stringContaining(MERGED_URL) }]);
  }, 60_000);

  test('a duplicate whose declared URL is not its original closes nothing', () => {
    const at = install();
    const event = { runId: 'run-1', others: [ORIGINAL] };
    const applied = outcome(
      at,
      event,
      facts(at, event).output,
      closeVerdict({
        kind: 'duplicate',
        url: 'https://ghe.example.com/example/repo/issues/4',
        original: { repo: PR.repo, number: 3 },
      })
    );
    expectLeftToMaintainer(at, applied, 'not https://ghe.example.com/example/repo/issues/4');
  }, 60_000);

  test('a blocked item closes nothing', () => {
    const at = install();
    const applied = outcome(
      at,
      { runId: 'run-1' },
      facts(at, { runId: 'run-1' }).output,
      {
        ...READY_VERDICT,
        INPUTS_CONTRACT: 'BLOCKED',
        INPUTS_ROUTE: 'no_action',
        INPUTS_LABELS: '["archon-blocked","archon-size-s","archon-type-feature"]',
        INPUTS_CLOSURE: 'null',
      }
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect([...applied.closes, ...applied.comments]).toEqual([]);
    expect(stored(at).value).toMatchObject({ stage: 'blocked', claim: null });
  }, 60_000);

  test('a closed issue is recorded and its labels are left alone', () => {
    const at = install();
    const closed = { author: 'stranger', state: 'closed' as const, issueLabels: ['archon-ready'] };
    const decided = facts(at, { ...closed, runId: 'run-1' }).output;
    expect(decided).toMatchObject({ path: 'closed', decision: { trust: null } });
    const applied = outcome(at, { ...closed, runId: 'run-1' }, decided, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(labelWrites(applied, 7)).toEqual({ add: [], remove: [] });
    const doc = stored(at).value;
    expect(doc).toMatchObject({ stage: 'new', trust: null, claim: null, requests: [] });
    expect(doc.history.at(-1)).toMatchObject({ outcome: 'closed' });
  }, 60_000);

  test('a label that requests nothing, such as the pack writing a type label, queues nothing', () => {
    const at = install();
    const first = facts(at, { runId: 'run-1' }).output;
    expect(outcome(at, { runId: 'run-1' }, first, READY_VERDICT).code).toBe(0);
    const revision = stored(at).revision;
    const echo = facts(at, {
      runId: 'run-2',
      action: 'added',
      label: 'archon-type-feature',
      actor: 'install',
      statuses: { 'run-1': 'completed' },
    }).output;
    expect(echo).toMatchObject({ path: 'idle' });
    expect(stored(at).revision).toBe(revision);
  }, 60_000);

  test('a failed run that resumes still holds its claim and writes its outcome', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    facts(at, { runId: 'run-2', kind: 'pr', statuses: { 'run-1': 'failed' } });
    const resumed = outcome(at, { runId: 'run-1', statuses: { 'run-1': 'running' } }, decided, READY_VERDICT);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: 0, stderr: '' });
    expect(stored(at).value).toMatchObject({ stage: 'deliver', claim: null });
    // Clearing the claim gave the run's lease back in the same write.
    expect(inProcess(at, () => stateGet('work/7')).lease).toBeNull();
  }, 60_000);
});
