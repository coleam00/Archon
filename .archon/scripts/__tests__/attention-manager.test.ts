import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { stateDocumentNameSchema } from '../../../packages/workflows/src/state-document-store';
import { validateStructuredOutput } from '../../../packages/workflows/src/structured-output';
import {
  type AgentDecision,
  isEscalated,
  parseAutonomy,
  parseQueueItem,
  type QueueItem,
  recordName,
  resolveOutcome,
} from '../../workflows/sdlc/.shared/attention';
import { CLI_ENTRY, gitCheckout, PACK, packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-runs.ts');
const WORKFLOW = join(PACK, 'attention-manager/archon-attention-manager.yaml');
const MANAGER = 'manager-run-1';

function queueItem(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'attention',
    runId,
    workflow: 'archon-build-queue',
    project: null,
    fanOut: null,
    revision: 1,
    labels: { build: 'stop' },
    pausedAt: '2026-10-16T14:00:00.000Z',
    context: { artifactsDir: `/runs/${runId}`, transcript: null, workingPath: null, branch: null },
    node: 'ask',
    occurrence: `occ-${runId}`,
    message: 'Keep the cap or extend it?',
    form: 'select',
    options: [{ id: 'keep-cap', label: 'Keep' }, { id: 'extend' }],
    ...overrides,
  };
}

const CLEAR: AgentDecision = {
  decision: 'answer',
  choice: 'keep-cap',
  ruling: 'Keep the hard cap.',
  sources: ['engineering.md §fail-clearly'],
  confidence: 'high',
  reason: 'the engineering document settles it',
};

// --- the pure rules ------------------------------------------------------------------

describe('the attention manager rules', () => {
  const item = parseQueueItem(queueItem('run-a'));

  test('only select attention items are readable and the maintainer label identifies escalation', () => {
    expect(isEscalated(item.labels)).toBe(false);
    expect(isEscalated(parseQueueItem(queueItem('run-a', { labels: { build: 'stop', attention: 'maintainer' } })).labels)).toBe(true);
    expect(() => parseQueueItem(queueItem('run-a', { form: 'message', options: [] }))).toThrow('not select');
    expect(() => parseQueueItem(queueItem('run-a', { kind: 'awaiting_response' }))).toThrow('not an attention item');
    expect(() => parseQueueItem(queueItem('run-a', { options: [] }))).toThrow('declares no options');
  });

  test('an answer it cannot back is escalated; a clean one answers only with autonomy answer', () => {
    expect(resolveOutcome(item, { ...CLEAR, decision: 'escalate' }, 'answer')).toEqual({ outcome: 'escalated', override: '' });
    expect(resolveOutcome(item, { ...CLEAR, choice: 'Keep' }, 'answer')).toMatchObject({ outcome: 'escalated', override: expect.stringContaining('does not declare') });
    expect(resolveOutcome(item, { ...CLEAR, sources: [] }, 'answer')).toMatchObject({ outcome: 'escalated', override: expect.stringContaining('cite') });
    expect(resolveOutcome(item, { ...CLEAR, confidence: 'low' }, 'answer')).toMatchObject({ outcome: 'escalated', override: expect.stringContaining('low confidence') });
    expect(resolveOutcome(item, CLEAR, 'answer')).toEqual({ outcome: 'answered', override: '' });
    expect(resolveOutcome(item, CLEAR, 'none')).toEqual({ outcome: 'recommended', override: '' });
  });

  test('record keys conform to the engine state-name contract, including legacy pauses', () => {
    for (const occurrence of ['pause-1', 'legacy:ask', 'legacy:Step_1', 'encoded-abc', 'a/b', 'a'.repeat(500), '💬']) {
      const name = recordName('run-a', occurrence);
      expect(stateDocumentNameSchema.safeParse(name).success).toBe(true);
      expect(recordName('run-a', occurrence)).toBe(name);
    }
    const runIds = ['a'.repeat(165), 'a'.repeat(166), 'a'.repeat(167), ...Array.from({ length: 128 }, (_, code) => `run${String.fromCharCode(code)}id`)];
    for (const runId of runIds) {
      expect(stateDocumentNameSchema.safeParse(recordName(runId, 'pause-1')).success).toBe(true);
    }
    expect(recordName('run-a', 'legacy:ask')).not.toBe(recordName('run-a', 'legacy/ask'));
    expect(recordName('run-a', 'encoded-abc')).not.toBe(recordName('run-a', 'abc'));
    expect(recordName('a/b', 'c')).not.toBe(recordName('a', 'b/c'));

  });

  test('autonomy defaults to none and refuses anything outside its vocabulary', () => {
    expect(parseAutonomy('')).toBe('none');
    expect(parseAutonomy('answer')).toBe('answer');
    expect(() => parseAutonomy('yes')).toThrow('autonomy must be one of none, answer');
  });
});

// --- the scripts, run as the engine runs them ----------------------------------------

interface Install {
  readonly checkout: string;
  readonly queue: string;
  readonly env: Record<string, string>;
}

function install(items: Record<string, unknown>[]): Install {
  const checkout = gitCheckout({}, track);
  const home = track(mkdtempSync(join(tmpdir(), 'archon-attention-home-')));
  const queue = join(home, 'queue.json');
  writeFileSync(queue, JSON.stringify(items));
  return {
    checkout,
    queue,
    env: { ARCHON_HOME: home, HOME: home, DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: '1', INTAKE_STATE_CWD: checkout, ATTENTION_QUEUE: queue },
  };
}

type Script = 'facts' | 'apply';

function script(at: Install, name: Script, inputs: Record<string, string>): ScriptRun {
  return runPackScript(`attention-manager/scripts/${name}`, {
    cwd: at.checkout,
    forge: { kind: 'command', argv: [process.execPath, FAKE_ARCHON] },
    inputs: { ...at.env, WORKFLOW_ID: MANAGER, INPUTS_MODE: 'live', INPUTS_AUTONOMY: 'answer', INPUTS_ITEM: '', ...inputs },
  });
}

/** A script that succeeded, with output its node's declared schema admits. */
function ok(result: ScriptRun, name: Script): Record<string, unknown> {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as { nodes: { id: string; output_format?: Record<string, unknown> }[] };
  expect(validateStructuredOutput(output, workflow.nodes.find(node => node.id === name)?.output_format ?? {})).toEqual({ valid: true });
  return output;
}

/** Facts, then apply with this agent decision, as one live run. */
function pass(at: Install, agent: AgentDecision, inputs: Record<string, string> = {}): { facts: Record<string, unknown>; apply: Record<string, unknown> } {
  const facts = ok(script(at, 'facts', inputs), 'facts');
  const apply = ok(
    script(at, 'apply', { ...inputs, INPUTS_PATH: String(facts.path), INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(agent) }),
    'apply'
  );
  return { facts, apply };
}

function cli(at: Install, args: string[], input = ''): { status: number | null; value: Record<string, unknown> } {
  const result = spawnSync(process.execPath, ['--no-env-file', CLI_ENTRY, ...args], {
    cwd: at.checkout,
    env: { ...process.env, ...at.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input,
    encoding: 'utf8',
  });
  return { status: result.status, value: JSON.parse(result.stdout) as Record<string, unknown> };
}

function stored(at: Install, runId: string): unknown {
  return cli(at, ['state', 'get', recordName(runId, `occ-${runId}`)]).value.value ?? null;
}

/** Every answer and label call the fake queue received. */
function writes(at: Install): string[][] {
  const log = `${at.queue}.calls.jsonl`;
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as string[])
    .filter(argv => argv[1] === 'answer' || argv[2] === 'label');
}

function queue(at: Install): QueueItem[] {
  return JSON.parse(readFileSync(at.queue, 'utf8')) as QueueItem[];
}

describe('the attention manager scripts', () => {
  test('a clear item is answered once with its declared choice and a signed ruling, and recorded', () => {
    const at = install([queueItem('run-a')]);
    const { facts, apply } = pass(at, CLEAR);
    expect(facts).toMatchObject({ path: 'decide', item: { runId: 'run-a' } });
    expect(apply).toMatchObject({ decision: 'answered', record: recordName('run-a', 'occ-run-a') });
    const [answer] = writes(at);
    expect(answer?.slice(0, 7)).toEqual(['workflow', 'answer', 'run-a', '--occurrence', 'occ-run-a', '--choose', 'keep-cap']);
    expect(answer?.[8]).toBe(
      `The attention manager answered this from the project's documents (run ${MANAGER}): Keep the hard cap.\n\nSources: engineering.md §fail-clearly`
    );
    expect(writes(at)).toHaveLength(1);
    expect(queue(at)).toEqual([]);
    expect(stored(at, 'run-a')).toMatchObject({ outcome: 'answered', run_id: MANAGER, agent: CLEAR, applied: { result: 'ok' } });
  }, 60_000);

  test('an escalation labels the item for a person, reads it back, and answers nothing', () => {
    const at = install([queueItem('run-a')]);
    const { apply } = pass(at, { ...CLEAR, decision: 'escalate', sources: [] });
    expect(apply.decision).toBe('escalated');
    expect(writes(at)).toEqual([['workflow', 'attention', 'label', 'run-a', '--occurrence', 'occ-run-a', '--set', 'attention=maintainer', '--json']]);
    expect(queue(at)[0]?.labels).toEqual({ build: 'stop', attention: 'maintainer' });
    expect(stored(at, 'run-a')).toMatchObject({ outcome: 'escalated', applied: { result: 'ok' } });
  }, 60_000);

  test('an escalated item and a decided item are skipped, oldest first among the rest', () => {
    const at = install([
      queueItem('run-c', { pausedAt: '2026-10-16T12:00:00.000Z' }),
      queueItem('run-a', { pausedAt: '2026-10-16T10:00:00.000Z', labels: { attention: 'maintainer' } }),
      queueItem('run-b', { pausedAt: '2026-10-16T11:00:00.000Z' }),
      queueItem('run-m', { pausedAt: '2026-10-16T09:00:00.000Z', form: 'message', options: [] }),
    ]);
    expect(ok(script(at, 'facts', {}), 'facts')).toMatchObject({ item: { runId: 'run-b' } });
    expect(cli(at, ['state', 'put', recordName('run-b', 'occ-run-b'), '--if-revision', '0'], '{"version":1}').status).toBe(0);
    expect(ok(script(at, 'facts', {}), 'facts')).toMatchObject({ item: { runId: 'run-c' } });
    expect(cli(at, ['state', 'put', recordName('run-c', 'occ-run-c'), '--if-revision', '0'], '{"version":1}').status).toBe(0);
    expect(ok(script(at, 'facts', {}), 'facts')).toEqual({ path: 'idle', item: null, policy_defaults: expect.any(String) });
  }, 60_000);

  test('autonomy none records the recommendation and labels it for a person', () => {
    const at = install([queueItem('run-a')]);
    expect(pass(at, CLEAR, { INPUTS_AUTONOMY: 'none' }).apply.decision).toBe('recommended');
    expect(writes(at)).toEqual([['workflow', 'attention', 'label', 'run-a', '--occurrence', 'occ-run-a', '--set', 'attention=maintainer', '--json']]);
    expect(queue(at)[0]?.labels.attention).toBe('maintainer');
    expect(stored(at, 'run-a')).toMatchObject({ outcome: 'recommended', autonomy: 'none', applied: { result: 'ok' } });
    expect(ok(script(at, 'facts', { INPUTS_AUTONOMY: 'none' }), 'facts')).toMatchObject({ path: 'idle' });
  }, 60_000);

  test('a write the queue refuses is recorded and ends the run as moved', () => {
    const at = install([queueItem('run-a')]);
    const { apply } = pass(at, CLEAR, { ATTENTION_MOVED: '1' });
    expect(apply.decision).toBe('moved');
    expect(stored(at, 'run-a')).toMatchObject({ outcome: 'answered', applied: { result: 'refused', detail: 'pause moved' } });
  }, 60_000);

  for (const agent of [CLEAR, { ...CLEAR, decision: 'escalate' } satisfies AgentDecision]) {
    for (const change of ['label', 'occurrence', 'closed'] as const) {
      test(`${agent.decision}: apply leaves a pause ${change} changed after pickup alone`, () => {
        const at = install([queueItem('run-a')]);
        const facts = ok(script(at, 'facts', {}), 'facts');
        const changed = change === 'closed' ? [] : [queueItem('run-a', change === 'label'
          ? { labels: { attention: 'maintainer' } } : { occurrence: 'new-pause' })];
        writeFileSync(at.queue, JSON.stringify(changed));
        const apply = ok(script(at, 'apply', { INPUTS_PATH: 'decide', INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(agent) }), 'apply');
        expect(apply.decision).toBe('moved');
        expect(writes(at)).toEqual([]);
        expect(stored(at, 'run-a')).toBeNull();
      }, 60_000);
    }
    for (const [mode, result] of [['ATTENTION_REFUSE', 'refused'], ['ATTENTION_LOST', 'unconfirmed'], ['ATTENTION_THROW', null]] as const) {
      test(`${agent.decision}: ${mode} fails visibly and retries only after its owner ends`, () => {
        const at = install([queueItem('run-a')]);
        const facts = ok(script(at, 'facts', {}), 'facts');
        const applied = script(at, 'apply', { [mode]: '1', INPUTS_PATH: 'decide', INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(agent) });
        expect(applied.code).toBe(1);
        expect(applied.stderr).toContain(mode === 'ATTENTION_REFUSE' ? 'still-open pause' : mode === 'ATTENTION_LOST' ? 'accepted the write' : 'failed');
        expect(stored(at, 'run-a')).toMatchObject({ applied: result === null ? null : { result } });
        for (const status of [undefined, 'running', 'paused']) {
          const statuses = status === undefined ? {} : { [MANAGER]: status };
          const inputs = { INTAKE_RUN_STATUSES: JSON.stringify(statuses) };
          expect(ok(script(at, 'facts', inputs), 'facts').path).toBe('idle');
          expect(ok(script(at, 'apply', { ...inputs, INPUTS_PATH: 'decide', INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(agent) }), 'apply').decision).toBe('moved');
        }
        expect(writes(at)).toHaveLength(1);
        expect(pass(at, agent, { INTAKE_RUN_STATUSES: JSON.stringify({ [MANAGER]: 'failed' }), WORKFLOW_ID: 'retry-manager' }).apply.decision).toBe(agent.decision === 'answer' ? 'answered' : 'escalated');
        expect(stored(at, 'run-a')).toMatchObject({ run_id: 'retry-manager', applied: { result: 'ok' } });
      }, 60_000);
    }
  }

  test('a legacy occurrence is picked and labelled instead of silently skipped', () => {
    const at = install([queueItem('run-a', { occurrence: 'legacy:ask' })]);
    expect(pass(at, { ...CLEAR, decision: 'escalate' }).apply.decision).toBe('escalated');
    expect(writes(at)[0]).toContain('legacy:ask');
    expect(cli(at, ['state', 'get', recordName('run-a', 'legacy:ask')]).value.value).toMatchObject({ item: { occurrence: 'legacy:ask' }, applied: { result: 'ok' } });
  }, 60_000);

  test('an item another run already recorded is left alone, with no queue write', () => {
    const at = install([queueItem('run-a')]);
    const facts = ok(script(at, 'facts', {}), 'facts');
    // Another run's record lands between this run's facts and its apply.
    expect(cli(at, ['state', 'put', recordName('run-a', 'occ-run-a'), '--if-revision', '0'], '{"version":1}').status).toBe(0);
    const apply = ok(script(at, 'apply', { INPUTS_PATH: 'decide', INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(CLEAR) }), 'apply');
    expect(apply.decision).toBe('moved');
    expect(writes(at)).toEqual([]);
    expect(stored(at, 'run-a')).toEqual({ version: 1 });
  }, 60_000);

  test('eval decides the given item, reads no queue, writes nothing, and returns the write live would make', () => {
    const at = install([]);
    const item = JSON.stringify(queueItem('run-a', { labels: { build: 'route' } }));
    const facts = ok(script(at, 'facts', { INPUTS_MODE: 'eval', INPUTS_ITEM: item }), 'facts');
    expect(facts).toMatchObject({ path: 'decide', item: { runId: 'run-a' } });
    const apply = ok(
      script(at, 'apply', { INPUTS_MODE: 'eval', INPUTS_PATH: 'decide', INPUTS_ITEM: JSON.stringify(facts.item), INPUTS_DECISION: JSON.stringify(CLEAR) }),
      'apply'
    );
    expect(apply).toMatchObject({
      decision: 'answered',
      record: '',
      evaluation: { item: { run_id: 'run-a', labels: { build: 'route' } }, outcome: 'answered', write: { answer: { choice: 'keep-cap' } } },
    });
    expect(existsSync(`${at.queue}.calls.jsonl`)).toBe(false);
    expect(cli(at, ['state', 'list', '--prefix', 'attention-manager/']).value.documents).toEqual([]);
  }, 60_000);

  test('an input outside its vocabulary refuses before the queue is read', () => {
    const at = install([queueItem('run-a')]);
    const refused: Record<string, string>[] = [{ INPUTS_MODE: 'dry' }, { INPUTS_AUTONOMY: 'yes' }, { INPUTS_ITEM: JSON.stringify(queueItem('run-a')) }];
    for (const inputs of refused) {
      expect(script(at, 'facts', inputs).code).toBe(1);
    }
    expect(existsSync(`${at.queue}.calls.jsonl`)).toBe(false);
  }, 60_000);
});

describe('the attention manager workflow', () => {
  test('the deciding node certifies the TypeScript decision shape and vocabulary', () => {
    const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as { nodes: { id: string; output_format: Record<string, unknown> }[] };
    const schema = workflow.nodes.find(node => node.id === 'decide')?.output_format;
    const properties = {
      decision: { type: 'string', enum: Object.keys({ answer: true, escalate: true } satisfies Record<AgentDecision['decision'], true>) },
      choice: { type: 'string' },
      ruling: { type: 'string', pattern: '\\S' },
      sources: { type: 'array', items: { type: 'string', pattern: '\\S' } },
      confidence: { type: 'string', enum: Object.keys({ low: true, medium: true, high: true } satisfies Record<AgentDecision['confidence'], true>) },
      reason: { type: 'string', pattern: '\\S' },
    } satisfies Record<keyof AgentDecision, unknown>;
    expect(schema).toEqual({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  });

  test('no node waits for an answer, so a manager run can never be an item it answers', () => {
    const workflow = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as { nodes: Record<string, unknown>[] };
    expect(workflow.nodes.filter(node => 'wait' in node || 'approval' in node)).toEqual([]);
  });
});
