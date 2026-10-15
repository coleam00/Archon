import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import {
  TERMINAL_WORKFLOW_STATUSES,
  workflowRunStatusSchema,
} from '../../../packages/workflows/src/schemas/workflow-run';
import { BODY_SOURCES } from '../../workflows/sdlc/.shared/issue';
import {
  assertNoSelfPromotion,
  bodyDigest,
  claimDisposition,
  claimItem,
  decideIntake,
  INTAKE_PATHS,
  type IntakeDecision,
  type IntakeRequest,
  type IssueFacts,
  mirrorLabels,
  newWorkItem,
  parseMaintainers,
  parseMode,
  parseOrder,
  parseTrustInput,
  parseWorkItem,
  RANKS,
  sortCandidates,
  statePut,
  TRUST_INPUTS,
  TRUSTS,
  type TriageFacts,
  type TrustInput,
  updateClaimed,
  type WorkItem,
} from '../../workflows/sdlc/.shared/workitem';
import {
  forgeOperation,
  gitCheckout,
  type GhApiIssue,
  PACK,
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

const decide = (doc: WorkItem, facts: IssueFacts, trustInput?: TrustInput) =>
  decideIntake(doc, facts, MAINTAINERS, AT, 'run', trustInput);

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

  test("trust: outside decides a maintainer's new item as outside, without reading its author", () => {
    for (const author of ['Maintainer', undefined]) {
      expect(decide(item(), issue({ author }), 'outside')).toMatchObject({
        path: 'outside',
        trust: 'outside',
        stage: 'needs_maintainer',
      });
    }
  });

  test('trust: outside never rewrites recorded trust, and a maintainer can still promote', () => {
    expect(() => decide(item({ trust: 'maintainer' }), issue(), 'outside')).toThrow(
      'decided once'
    );
    const outside = item({ trust: 'outside', stage: 'needs_maintainer' }, [
      labelRequest('archon-triage', 'maintainer'),
    ]);
    expect(decide(outside, issue({ labels: ['archon-triage'] }), 'outside')).toMatchObject({
      path: 'triage',
      trust: 'outside',
      promoted: { by: 'maintainer' },
    });
  });

  test('mode and trust accept only their own values; empty is the default', () => {
    expect(parseMode('')).toBe('live');
    expect(parseMode('eval')).toBe('eval');
    expect(() => parseMode('dry')).toThrow('mode must be one of live, eval, not "dry"');
    expect(parseTrustInput('')).toBe('auto');
    expect(parseTrustInput('outside')).toBe('outside');
    expect(() => parseTrustInput('maintainer')).toThrow(
      'trust must be one of auto, outside, not "maintainer"'
    );
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

  test("the decision's fields, path and trust vocabularies are archon-intake's own", () => {
    type Enum = { enum: (string | null)[] };
    // Typed against IntakeDecision, so a field added to or dropped from it fails to compile.
    const fields: Record<keyof IntakeDecision, true> = {
      path: true,
      trust: true,
      promoted: true,
      stage: true,
      body_digest: true,
      labels: true,
      waiting: true,
      notes: true,
    };
    const workflow = Bun.YAML.parse(
      readFileSync(join(PACK, 'intake/archon-intake.yaml'), 'utf8')
    ) as {
      nodes: {
        id: string;
        output_format?: {
          properties: {
            path: Enum;
            decision?: { properties: { path: Enum; trust: Enum }; required: string[] };
            seen?: { properties: { body_from: Enum } };
            evaluation?: { properties: { trust_input: Enum } };
          };
        };
      }[];
    };
    const output = (id: string) => workflow.nodes.find(node => node.id === id)?.output_format;
    const schema = output('facts')?.properties.decision;
    const decision = schema?.properties;
    expect(Object.keys(decision ?? {}).sort()).toEqual(Object.keys(fields).sort());
    expect([...(schema?.required ?? [])].sort()).toEqual(Object.keys(fields).sort());
    expect(output('facts')?.properties.path.enum).toEqual(['idle', ...INTAKE_PATHS]);
    expect(decision?.path.enum).toEqual([...INTAKE_PATHS]);
    expect(decision?.trust.enum).toEqual([...TRUSTS, null]);
    expect(output('outcome')?.properties.path.enum).toEqual(['idle', ...INTAKE_PATHS]);
    expect(output('facts')?.properties.seen?.properties.body_from.enum).toEqual([...BODY_SOURCES]);
    expect(output('outcome')?.properties.evaluation?.properties.trust_input.enum).toEqual([
      ...TRUST_INPUTS,
    ]);
  });

  test("a claim is released only when its run's status is one the engine calls terminal", () => {
    for (const status of workflowRunStatusSchema.options)
      expect(claimDisposition(status)).toBe(
        TERMINAL_WORKFLOW_STATUSES.includes(status) ? 'release' : 'hold'
      );
    expect(claimDisposition(null)).toBe('hold');
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
        parseOrder('')
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
  readonly state?: 'open' | 'closed';
  readonly writeLost?: boolean;
}

function run(
  at: Install,
  script: string,
  event: Event,
  inputs: Record<string, string> = {}
): ScriptRun {
  return runPackScript(`intake/scripts/${script}`, {
    source: 'gh',
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    gh: {
      issue: {
        number: 7,
        author: event.author ?? 'Maintainer',
        body: event.body ?? BODY,
        state: event.state ?? 'open',
      },
      issueLabels: event.issueLabels ?? [],
      repositoryLabels: [],
      writeLost: event.writeLost,
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
    expect(
      inProcess(at, () =>
        claimItem({ name: 'work/7', revision: claimedRevision - 1, doc: unclaimed }, AT, 'run-3')
      )
    ).toBeNull();
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
  test('edits while an item is claimed queue one request, and a release keeps only the newest', () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    for (const runId of ['run-2', 'run-3']) {
      facts(at, { runId, action: 'edited', statuses: { 'run-1': 'running' } });
    }
    expect(stored(at).value.requests).toEqual([
      expect.objectContaining({ run_id: 'run-2', action: 'edited' }),
    ]);

    facts(at, { runId: 'run-4', kind: 'pr', statuses: { 'run-1': 'failed' } });
    expect(stored(at).value.claim?.requests).toEqual([
      expect.objectContaining({ run_id: 'run-2', action: 'edited' }),
    ]);
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
    expect(applied.gh.filter(call => call.includes('--remove-label'))).toEqual([]);
  }, 60_000);

  test('a request label added again after its request was claimed stays on the issue', () => {
    const at = install();
    const retriage = {
      action: 'added',
      label: 'archon-triage',
      actor: 'Maintainer',
      issueLabels: ['archon-triage'],
    };
    const decided = facts(at, { ...retriage, runId: 'run-1' }).output;
    facts(at, { ...retriage, runId: 'run-2', statuses: { 'run-1': 'running' } });

    const applied = outcome(at, { ...retriage, runId: 'run-1' }, decided, READY_VERDICT);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.includes('--remove-label'))).toEqual([]);
    expect(stored(at).value.requests).toEqual([
      expect.objectContaining({ run_id: 'run-2', label: 'archon-triage' }),
    ]);
  }, 60_000);

  test('a request label on the issue at pickup whose request queues after the outcome stays for the next pickup', () => {
    const at = install();
    // The label lands before facts reads the issue; its own run records the request
    // only after this run's outcome, so nothing in the store names it during the write.
    const decided = facts(at, { runId: 'run-1', issueLabels: ['archon-triage'] }).output;
    const applied = outcome(
      at,
      { runId: 'run-1', issueLabels: ['archon-triage'] },
      decided,
      READY_VERDICT
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.includes('--remove-label'))).toEqual([]);

    const retriage = facts(at, {
      runId: 'run-2',
      action: 'added',
      label: 'archon-triage',
      actor: 'Maintainer',
      issueLabels: ['archon-ready', 'archon-size-s', 'archon-type-feature', 'archon-triage'],
      statuses: { 'run-1': 'completed' },
    }).output;
    expect(retriage).toMatchObject({ path: 'triage', decision: { notes: [] } });
  }, 60_000);

  test("a route label on a maintainer's item that no request claims is removed at once", () => {
    const at = install();
    const stale = { issueLabels: ['archon-plan'] };
    const decided = facts(at, { ...stale, runId: 'run-1' }).output;
    const applied = outcome(at, { ...stale, runId: 'run-1' }, decided, READY_VERDICT);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.startsWith('issue edit'))).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-ready --add-label archon-size-s --add-label archon-type-feature --remove-label archon-plan',
    ]);
  }, 60_000);

  test('a request label on an outside item waits one pickup for its request, then is removed', () => {
    const at = install();
    const stale = { author: 'stranger', issueLabels: ['archon-plan'] };
    const first = facts(at, { ...stale, runId: 'run-1' }).output;
    const kept = outcome(at, { ...stale, runId: 'run-1' }, first, SKIPPED_TRIAGE);
    expect({ code: kept.code, stderr: kept.stderr }).toEqual({ code: 0, stderr: '' });
    expect(kept.gh.filter(call => call.includes('--remove-label'))).toEqual([]);
    expect(stored(at).value.facts.intake?.waiting).toEqual(['archon-plan']);

    const edited = {
      ...stale,
      action: 'edited',
      issueLabels: ['archon-plan', 'archon-needs-maintainer'],
    };
    const second = facts(at, { ...edited, runId: 'run-2', statuses: { 'run-1': 'completed' } });
    const removed = outcome(at, { ...edited, runId: 'run-2' }, second.output, SKIPPED_TRIAGE);
    expect({ code: removed.code, stderr: removed.stderr }).toEqual({ code: 0, stderr: '' });
    expect(removed.gh.filter(call => call.startsWith('issue edit'))).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --remove-label archon-plan',
    ]);
    expect(stored(at).value.facts.intake?.waiting).toEqual([]);
  }, 60_000);

  test('a claim keeps the newest label requests and one other request', () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    const labels = Array.from({ length: 60 }, (_, index) =>
      labelRequest('archon-triage', `account-${String(index)}`)
    );
    const edit = (runId: string): IntakeRequest => ({
      ...labelRequest('', null),
      run_id: runId,
      action: 'edited',
      label: null,
      body_digest: null,
    });
    const waiting = { ...newWorkItem(SUBJECT, AT), requests: [edit('a'), ...labels, edit('b')] };
    const { revision } = stored(at);
    const doc = inProcess(at, () => claimItem({ name: 'work/7', revision, doc: waiting }, AT, 'r'));
    expect(doc?.claim?.requests).toEqual([...labels.slice(-49), edit('b')]);
  }, 60_000);

  test('a claimed item written by its run keeps the newest label requests', () => {
    const at = install();
    facts(at, { runId: 'run-1' });
    const labels = Array.from({ length: 60 }, (_, index) =>
      labelRequest('archon-triage', `account-${String(index)}`)
    );
    const { revision, value } = stored(at);
    inProcess(at, () => {
      expect(statePut('work/7', { ...value, requests: labels }, revision)).toBe('ok');
      updateClaimed(SUBJECT, 'run-1', doc => doc);
    });
    expect(stored(at).value.requests).toEqual(labels.slice(-50));
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

    const retried = facts(at, { runId: 'run-2', kind: 'pr', statuses: { 'run-1': 'failed' } });
    expect(retried.output).toMatchObject({ path: 'quiet', item: SUBJECT });
    expect(stored(at).value.claim).toMatchObject({
      run_id: 'run-2',
      requests: [expect.objectContaining({ run_id: 'run-1', action: 'opened' })],
    });
    const applied = outcome(at, { runId: 'run-2' }, retried.output, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh).toContain(
      'issue edit 7 --repo ghe.example.com/example/repo --add-label archon-ready --add-label archon-size-s --add-label archon-type-feature'
    );
    expect(stored(at).value).toMatchObject({ stage: 'deliver', claim: null, requests: [] });
  }, 60_000);

  test('a promoted item whose body changes while triage runs is demoted and gets no route label', () => {
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
      { ...promote, runId: 'run-2', body: 'An edited body' },
      decided,
      READY_VERDICT
    );
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.startsWith('issue edit'))).toEqual([
      'issue edit 7 --repo ghe.example.com/example/repo --remove-label archon-triage',
    ]);
    const doc = stored(at).value;
    expect(doc).toMatchObject({ stage: 'needs_maintainer', promoted: null, claim: null });
    expect(doc.history.at(-1)).toMatchObject({
      outcome: 'demoted',
      summary: expect.stringContaining('during triage'),
    });
  }, 60_000);

  test('a closed issue is recorded and its labels are left alone', () => {
    const at = install();
    const closed = { author: 'stranger', state: 'closed' as const, issueLabels: ['archon-ready'] };
    const decided = facts(at, { ...closed, runId: 'run-1' }).output;
    expect(decided).toMatchObject({ path: 'closed', decision: { trust: null } });
    const applied = outcome(at, { ...closed, runId: 'run-1' }, decided, SKIPPED_TRIAGE);
    expect({ code: applied.code, stderr: applied.stderr }).toEqual({ code: 0, stderr: '' });
    expect(applied.gh.filter(call => call.startsWith('issue edit'))).toEqual([]);
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

  test('a run whose claim a pickup released refuses to write its outcome', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    facts(at, { runId: 'run-2', kind: 'pr', statuses: { 'run-1': 'failed' } });
    const late = outcome(at, { runId: 'run-1' }, decided, READY_VERDICT);
    expect(late.code).not.toBe(0);
    expect(late.stderr).toContain('no longer claimed by this run');
    expect(late.gh.filter(call => call.startsWith('issue edit'))).toEqual([]);
    expect(stored(at).value).toMatchObject({ stage: 'new', claim: { run_id: 'run-2' } });
  }, 60_000);
});

// --- eval mode -------------------------------------------------------------------

const CREATED = { title: 'The title it was opened with', body: 'The body it was opened with' };

/**
 * Run an intake script in eval mode. The forge fake has no response, so any `archon`
 * call (every state read and write) is logged in `run.forge` and fails; `run.gh` logs
 * every gh call. Those two logs are the write proof.
 */
function evalRun(
  at: Install,
  script: 'facts' | 'outcome',
  ghIssue: GhApiIssue,
  inputs: Record<string, string> = {},
  options: { source?: string; response?: string } = {}
): ScriptRun {
  return runPackScript(`intake/scripts/${script}`, {
    cwd: at.checkout,
    source: options.source ?? 'gh',
    forge: { kind: 'fake', ...(options.response ? { response: options.response } : {}) },
    gh: { issue: { number: 7, ...ghIssue }, issueLabels: ['archon-ready'], repositoryLabels: [] },
    inputs: {
      ...at.env,
      WORKFLOW_ID: 'eval-run',
      INPUTS_REPO_HOST: PR.repo.host,
      INPUTS_REPO_PATH: PR.repo.path,
      INPUTS_NUMBER: '7',
      INPUTS_KIND: 'issue',
      INPUTS_ACTION: 'opened',
      INPUTS_LABEL: '',
      INPUTS_LABEL_ACTOR: '',
      INPUTS_ORDER: '',
      INPUTS_MODE: 'eval',
      ...inputs,
    },
  });
}

function evalOutcome(
  at: Install,
  decided: Record<string, unknown>,
  verdict: Record<string, string>,
  trust = ''
): ScriptRun {
  return evalRun(
    at,
    'outcome',
    {},
    {
      INPUTS_PATH: String(decided.path),
      INPUTS_ITEM: JSON.stringify(decided.item),
      INPUTS_DECISION: JSON.stringify(decided.decision),
      INPUTS_SEEN: JSON.stringify(decided.seen),
      INPUTS_TRUST: trust,
      INPUTS_PROPOSED_EDITS: '{"title":"","body":""}',
      INPUTS_BLOCKED_REASON: '""',
      INPUTS_BLOCKED_BY: '[]',
      ...verdict,
    }
  );
}

const ISSUE_READ = /^api --hostname ghe\.example\.com repos\/example\/repo\/issues\/\d+$/;
const HISTORY_READ = /^api graphql --hostname ghe\.example\.com -f query=query\(/;

function outputSchema(id: 'facts' | 'outcome'): Record<string, unknown> {
  const workflow = Bun.YAML.parse(
    readFileSync(join(PACK, 'intake/archon-intake.yaml'), 'utf8')
  ) as { nodes: { id: string; output_format?: Record<string, unknown> }[] };
  return workflow.nodes.find(node => node.id === id)?.output_format ?? {};
}

function succeeded(run: ScriptRun, id: 'facts' | 'outcome'): Record<string, unknown> {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
  const output = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(validateStructuredOutput(output, outputSchema(id))).toEqual({ valid: true });
  return output;
}

/** Only issue reads: the REST view and the GraphQL history query. */
function readsOnly(run: ScriptRun): void {
  expect(run.forge).toEqual([]);
  for (const call of run.gh) {
    expect(ISSUE_READ.test(call) || HISTORY_READ.test(call)).toBe(true);
  }
}

describe('eval mode', () => {
  test("a maintainer's item is decided at creation and triaged on its creation text, with no write", () => {
    const at = install();
    const facts = evalRun(at, 'facts', {
      author: 'Maintainer',
      title: 'A title edited later',
      body: 'A body edited to name the fix',
      history: { createdBody: CREATED.body, createdTitle: CREATED.title },
    });
    const decided = succeeded(facts, 'facts');
    expect(decided).toMatchObject({
      path: 'triage',
      item: SUBJECT,
      target: `# ${CREATED.title}\n\n${CREATED.body}`,
      decision: { trust: 'maintainer', body_digest: bodyDigest(CREATED.body), labels: [] },
      seen: { title: CREATED.title, body_from: 'creation' },
    });
    expect(String(decided.target)).not.toContain('issues/7');
    expect(String(decided.target)).not.toContain('edited');
    readsOnly(facts);
    expect(facts.gh).toHaveLength(2);

    const outcome = evalOutcome(at, decided, READY_VERDICT);
    const result = succeeded(outcome, 'outcome');
    expect(outcome.gh).toEqual([]);
    expect(outcome.forge).toEqual([]);
    expect(result).toMatchObject({
      path: 'triage',
      stage: 'deliver',
      trust: 'maintainer',
      labels: ['archon-ready', 'archon-size-s', 'archon-type-feature'],
      evaluation: {
        trust_input: 'auto',
        seen: { body_from: 'creation' },
        labels: { add: ['archon-ready', 'archon-size-s', 'archon-type-feature'], remove: [] },
        reasons: [expect.objectContaining({ outcome: 'deliver', verdict: 'READY' })],
        triage: {
          contract: 'READY',
          route: 'deliver',
          pull_request: null,
          type: { value: 'feature' },
          size: { value: 's' },
          complexity: { value: 'low' },
          importance: { value: 'high' },
          urgency: { value: 'soon' },
          proposed_edits: { title: '', body: '' },
          report: { path: 'triage.md' },
        },
      },
    });
  }, 60_000);

  test('an outside item, and a maintainer\'s item run with trust: outside, take the outside path with no write', () => {
    const at = install();
    for (const [author, trust] of [
      ['stranger', ''],
      ['Maintainer', 'outside'],
    ] as const) {
      const facts = evalRun(at, 'facts', { author }, { INPUTS_TRUST: trust });
      const decided = succeeded(facts, 'facts');
      expect(decided).toMatchObject({
        path: 'outside',
        decision: { trust: 'outside' },
        seen: { body_from: 'creation' },
      });
      readsOnly(facts);

      const outcome = evalOutcome(at, decided, SKIPPED_TRIAGE, trust);
      expect(succeeded(outcome, 'outcome')).toMatchObject({
        stage: 'needs_maintainer',
        labels: ['archon-needs-maintainer'],
        evaluation: {
          trust_input: trust || 'auto',
          triage: null,
          reasons: [expect.objectContaining({ outcome: 'needs_maintainer' })],
        },
      });
      expect([...outcome.gh, ...outcome.forge]).toEqual([]);
    }
  }, 60_000);

  test('a body whose creation revision cannot be recovered is shown as it is now, and says so', () => {
    const unrecoverable: NonNullable<GhApiIssue['history']>[] = [
      { createdBody: null },
      { firstEditedBody: 'A later revision' },
    ];
    for (const history of unrecoverable) {
      const at = install();
      const decided = succeeded(evalRun(at, 'facts', { body: 'The body now', history }), 'facts');
      expect(decided).toMatchObject({
        target: '# An issue\n\nThe body now',
        seen: { body_from: 'current' },
      });
    }
  }, 60_000);

  test('the forge source has no edit history, so it shows the current text, and only reads', () => {
    const at = install();
    const run = evalRun(
      at,
      'facts',
      {},
      {},
      {
        source: 'forge',
        response: forgeOperation('workitem.view', {
          ref: SUBJECT,
          kind: 'issue',
          title: 'Forge title',
          body: 'Forge body',
          url: 'https://ghe.example.com/example/repo/issues/7',
          state: 'closed',
          labels: ['archon-ready'],
          author: { login: 'Maintainer' },
        }),
      }
    );
    // A closed issue is decided as it was opened.
    expect(succeeded(run, 'facts')).toMatchObject({
      path: 'triage',
      target: '# Forge title\n\nForge body',
      seen: { body_from: 'current' },
    });
    expect(run.gh).toEqual([]);
    expect(run.forge.length).toBeGreaterThan(0);
    for (const call of run.forge) expect(call.startsWith('forge workitem.view')).toBe(true);
  }, 60_000);

  test('a value outside the mode or trust vocabulary refuses the run before any call', () => {
    const at = install();
    for (const [inputs, message] of [
      [{ INPUTS_TRUST: 'maintainer' }, 'trust must be one of auto, outside'],
      [{ INPUTS_MODE: 'dry' }, 'mode must be one of live, eval'],
    ] as const) {
      const run = evalRun(at, 'facts', {}, inputs);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(message);
      expect([...run.gh, ...run.forge]).toEqual([]);
    }
  }, 60_000);

  test('an eval run that fails part way has written nothing', () => {
    const at = install();
    // The fake knows only issue 7, so the read refuses.
    const unreadable = evalRun(at, 'facts', {}, { INPUTS_NUMBER: '8' });
    expect(unreadable.code).not.toBe(0);
    readsOnly(unreadable);

    const decided = succeeded(evalRun(at, 'facts', { author: 'Maintainer' }), 'facts');
    // The triage path with no verdict refuses in the outcome.
    const unjudged = evalOutcome(at, decided, SKIPPED_TRIAGE);
    expect(unjudged.code).not.toBe(0);
    expect(unjudged.stderr).toContain('has no triage verdict');
    expect([...unjudged.gh, ...unjudged.forge]).toEqual([]);
  }, 60_000);
});

describe('trust: outside in live', () => {
  test('refuses an item whose trust is recorded as maintainer, and leaves it recorded', () => {
    const at = install();
    const decided = facts(at, { runId: 'run-1' }).output;
    expect(outcome(at, { runId: 'run-1' }, decided, READY_VERDICT).code).toBe(0);
    const edited = run(
      at,
      'facts',
      { runId: 'run-2', action: 'edited', statuses: { 'run-1': 'completed' } },
      { INPUTS_TRUST: 'outside' }
    );
    expect(edited.code).not.toBe(0);
    expect(edited.stderr).toContain('decided once');
    expect(stored(at).value.trust).toBe('maintainer');
  }, 60_000);
});
