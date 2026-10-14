import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  assertNoSelfPromotion,
  bodyDigest,
  claimDisposition,
  claimItem,
  decideIntake,
  type IntakeRequest,
  type IssueFacts,
  mirrorLabels,
  newWorkItem,
  parseMaintainers,
  parseOrder,
  parseWorkItem,
  RANKS,
  sortCandidates,
  type TriageFacts,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import { gitCheckout, PACK, packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

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
      facts: { intake: { body_digest: DIGEST, at: AT, run_id: 'run' } },
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
  test('order accepts the default and refuses unknown keys and directions', () => {
    expect(parseOrder('')).toEqual([
      { key: 'urgency', direction: 'desc' },
      { key: 'importance', direction: 'desc' },
      { key: 'size', direction: 'asc' },
      { key: 'created', direction: 'asc' },
    ]);
    expect(() => parseOrder('["age desc"]')).toThrow('is not');
    expect(() => parseOrder('["size up"]')).toThrow('is not');
  });

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
      parseOrder('')
    );
    expect(sorted.map(entry => entry.doc.subject.number)).toEqual([4, 5, 3, 0, 2, 1]);
  });

  test("the rank orders are the triage node's own enums", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(PACK, 'triage/archon-triage.yaml'), 'utf8')
    ) as {
      nodes: {
        id: string;
        output_format?: {
          properties: Record<string, { properties: { value: { enum: string[] } } }>;
        };
      }[];
    };
    const fields =
      workflow.nodes.find(node => node.id === 'triage')?.output_format?.properties ?? {};
    for (const [key, ranks] of Object.entries(RANKS))
      expect(fields[key]?.properties.value.enum).toEqual([...ranks]);
  });

  test('a claim held by a pending, running or paused run, or one the engine cannot find, is held', () => {
    for (const status of ['pending', 'running', 'paused', null])
      expect(claimDisposition(status)).toBe('hold');
    for (const status of ['completed', 'failed', 'cancelled'])
      expect(claimDisposition(status)).toBe('release');
  });

  test('the maintainer list is an array of logins; anything else refuses', () => {
    expect([...parseMaintainers('[" Wirasm ", "Other"]')]).toEqual(['wirasm', 'other']);
    expect(() => parseMaintainers('{"maintainers": []}')).toThrow('JSON array of forge logins');
    expect(() => parseMaintainers('[""]')).toThrow('JSON array of forge logins');
  });
});

// --- the scripts, run as the engine runs them --------------------------------------

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
const CLI_ENTRY = resolve(import.meta.dir, '../../../packages/cli/src/cli.ts');

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
      INTAKE_STATE_CWD: checkout,
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
}

function run(
  at: Install,
  script: string,
  event: Event,
  inputs: Record<string, string> = {}
): ScriptRun {
  return runPackScript(`intake/scripts/${script}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: {
      issue: { number: 7, author: event.author ?? 'Maintainer', body: event.body ?? BODY },
      issueLabels: event.issueLabels ?? [],
      repositoryLabels: [],
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
      INPUTS_ORDER: '',
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
  INPUTS_CONTRACT: '"READY"',
  INPUTS_ROUTE: '"deliver"',
  INPUTS_PULL_REQUEST: 'null',
  INPUTS_TYPE: '{"value":"feature","reason":"new behavior"}',
  INPUTS_SIZE: '{"value":"s","reason":"one script"}',
  INPUTS_COMPLEXITY: '{"value":"low","reason":"clear"}',
  INPUTS_IMPORTANCE: '{"value":"high","reason":"on direction"}',
  INPUTS_URGENCY: '{"value":"soon","reason":"next release"}',
  INPUTS_LABELS: '["archon-ready","archon-size-s","archon-type-feature"]',
  INPUTS_SUMMARY: '"Ready to deliver"',
  INPUTS_REPORT: '{"type":"archon_artifact","run_id":"run-1","path":"triage.md"}',
};
const SKIPPED_TRIAGE = Object.fromEntries(Object.keys(READY_VERDICT).map(key => [key, 'null']));

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
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', CLI_ENTRY, 'state', 'get', 'work/7'],
    {
      cwd: at.checkout,
      env: { ...process.env, ...at.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
      encoding: 'utf8',
    }
  );
  const parsed = JSON.parse(result.stdout) as { revision: number; value: unknown };
  return { revision: parsed.revision, value: parseWorkItem(parsed.value) };
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
    expect(applied.gh).toContain(
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-ready --add-label archon-size-s --add-label archon-type-feature'
    );
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
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'deliver',
      verdict: 'READY',
      report: { path: 'triage.md' },
    });
  }, 60_000);

  test('an outside item gets archon-needs-maintainer and no route label', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1', author: 'stranger' }).output;
    expect(decided).toMatchObject({
      path: 'outside',
      decision: { trust: 'outside', stage: 'needs_maintainer' },
    });

    const applied = outcome(at, { runId: 'run-1', author: 'stranger' }, decided, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    const edits = applied.gh.filter(call => call.startsWith('issue edit'));
    expect(edits).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-needs-maintainer',
    ]);
    expect(stored(at).value).toMatchObject({
      stage: 'needs_maintainer',
      trust: 'outside',
      claim: null,
    });
  }, 60_000);

  test('a route label added by a login not in maintainers.json promotes nothing', () => {
    const at = install();
    const first = facts(at, { runId: 'run-1', author: 'stranger' }).output;
    expect(outcome(at, { runId: 'run-1', author: 'stranger' }, first, SKIPPED_TRIAGE).code).toBe(0);

    const labelled = {
      author: 'stranger',
      action: 'added',
      label: 'archon-ready',
      issueLabels: ['archon-ready'],
    };
    const decided = facts(at, {
      ...labelled,
      runId: 'run-2',
      actor: 'stranger',
      statuses: { 'run-1': 'completed' },
    }).output;
    expect(decided).toMatchObject({ path: 'outside', decision: { promoted: null } });
    const applied = outcome(at, { ...labelled, runId: 'run-2' }, decided, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    // The unrequested route label is reconciled away.
    expect(applied.gh.filter(call => call.startsWith('issue edit'))).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-needs-maintainer --remove-label archon-ready',
    ]);
    expect(stored(at).value.history.map(entry => entry.outcome)).toContain('refused');
  }, 60_000);

  test('a promoted item whose body digest changed is demoted, with the reason recorded', () => {
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
    const decided = facts(at, {
      ...promote,
      runId: 'run-2',
      statuses: { 'run-1': 'completed' },
    }).output;
    expect(decided).toMatchObject({
      path: 'triage',
      decision: { promoted: { by: 'Maintainer', pin: { body_digest: DIGEST } } },
    });
    const triagedRun = outcome(at, { ...promote, runId: 'run-2' }, decided, READY_VERDICT);
    expect({ code: triagedRun.code, stderr: triagedRun.stderr }).toEqual({ code: 0, stderr: '' });
    expect(stored(at).value).toMatchObject({
      stage: 'deliver',
      promoted: { pin: { body_digest: DIGEST } },
    });

    const edit = {
      ...outside,
      action: 'edited',
      body: 'An edited body',
      issueLabels: ['archon-ready', 'archon-size-s', 'archon-type-feature'],
    };
    const demoted = facts(at, {
      ...edit,
      runId: 'run-3',
      statuses: { 'run-2': 'completed' },
    }).output;
    expect(demoted).toMatchObject({
      path: 'outside',
      decision: { promoted: null, stage: 'needs_maintainer' },
    });
    const applied = outcome(at, { ...edit, runId: 'run-3' }, demoted, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.startsWith('issue edit'))).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-needs-maintainer --remove-label archon-ready --remove-label archon-size-s --remove-label archon-type-feature',
    ]);
    const doc = stored(at).value;
    expect(doc).toMatchObject({ stage: 'needs_maintainer', promoted: null });
    expect(doc.history).toContainEqual(
      expect.objectContaining({
        outcome: 'demoted',
        summary: expect.stringContaining(`pinned ${DIGEST}, now ${bodyDigest('An edited body')}`),
      })
    );
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
    const saved = { ...process.env };
    Object.assign(process.env, at.env, {
      ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]),
    });
    try {
      expect(
        claimItem({ name: 'work/7', revision: claimedRevision - 1, doc: unclaimed }, AT, 'run-3')
      ).toBeNull();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    expect(stored(at).value.claim?.run_id).toBe('run-1');
  }, 60_000);

  test("the next pickup releases a failed run's claim and queues its requests again", () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    const decided = facts(at, {
      runId: 'run-2',
      kind: 'pr',
      statuses: { 'run-1': 'failed' },
    }).output;
    expect(decided).toMatchObject({ path: 'triage', item: SUBJECT });
    const doc = stored(at).value;
    expect(doc.claim).toMatchObject({
      run_id: 'run-2',
      requests: [expect.objectContaining({ run_id: 'run-1', action: 'opened' })],
    });
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'released',
      summary: expect.stringContaining('run-1, which ended failed'),
    });
  }, 60_000);
});
