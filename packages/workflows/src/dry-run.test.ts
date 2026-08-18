import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, formatDryRunTrace, loadDryRunStubs } from './dry-run';
import { buildAiProfile } from './model-validation';
import { expandWorkflowIncludes } from './include-expander';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'archon-dry-run-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'stubs.yaml');
  writeFileSync(path, content);
  return path;
}

describe('loadDryRunStubs', () => {
  test('loads scalar and structured node outputs', async () => {
    const result = await loadDryRunStubs(
      temporaryFile('classify: BUG\ndetails:\n  severity: high\n  count: 2\n')
    );

    expect(result).toEqual({ classify: 'BUG', details: { severity: 'high', count: 2 } });
  });

  test('rejects missing, list, multi-document, and invalid-value files', async () => {
    await expect(loadDryRunStubs('/definitely/missing/stubs.yaml')).rejects.toThrow(
      'Dry-run stub file not found'
    );
    await expect(loadDryRunStubs(temporaryFile('- one\n- two\n'))).rejects.toThrow(
      'expected one YAML mapping'
    );
    await expect(loadDryRunStubs(temporaryFile('one: value\n---\ntwo: value\n'))).rejects.toThrow(
      'expected one YAML mapping'
    );
    await expect(loadDryRunStubs(temporaryFile('node: 42\n'))).rejects.toThrow(
      'Invalid dry-run stub file'
    );
  });
});

describe('dryRunWorkflow', () => {
  test('hydrates object stubs and resolves workflow and strict output variables', async () => {
    const workflow = makeTestWorkflow({
      name: 'structured',
      nodes: [
        {
          id: 'classify',
          prompt: 'Classify $ARGUMENTS',
          output_format: { type: 'object', properties: { kind: { type: 'string' } } },
        },
        {
          id: 'use',
          prompt: 'Handle $classify.output.kind for $USER_MESSAGE',
          depends_on: ['classify'],
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: 'issue 2100',
      cwd: process.cwd(),
      stubs: { classify: { kind: 'BUG' }, use: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.resolvedText).toBe('Handle BUG for issue 2100');
    expect(result.summary).toBe('done');
  });

  test('loads and resolves command-file prompt text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-command-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'commands', 'inspect.md'), 'Inspect $ARGUMENTS');
    const workflow = makeTestWorkflow({
      name: 'command-text',
      nodes: [{ id: 'inspect', command: 'inspect' }],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: 'issue 2100',
      cwd,
      stubs: { inspect: 'done' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Inspect issue 2100');
  });

  test('distinguishes false and malformed when expressions', async () => {
    const workflow = makeTestWorkflow({
      name: 'conditions',
      nodes: [
        { id: 'source', prompt: 'source' },
        { id: 'false', prompt: 'false', depends_on: ['source'], when: "$source.output == 'NO'" },
        { id: 'malformed', prompt: 'bad', depends_on: ['source'], when: '$source ???' },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { source: 'YES' },
    });

    expect(result.trace.map(entry => [entry.nodeId, entry.state, entry.reason])).toEqual([
      ['source', 'stubbed', undefined],
      ['false', 'skipped', 'when_condition_false'],
      ['malformed', 'skipped', 'when_condition_parse_error'],
    ]);
    expect(result.missingStubs).toEqual([]);
  });

  test('applies all trigger rules after failed and skipped upstream nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'triggers',
      nodes: [
        { id: 'ok', prompt: 'ok' },
        { id: 'skip', prompt: 'skip', when: "$ok.output == 'never'" },
        { id: 'fail', prompt: 'missing' },
        { id: 'all_success', prompt: 'a', depends_on: ['ok', 'skip'] },
        { id: 'one_success', prompt: 'b', depends_on: ['ok', 'fail'], trigger_rule: 'one_success' },
        {
          id: 'none_failed',
          prompt: 'c',
          depends_on: ['ok', 'skip'],
          trigger_rule: 'none_failed_min_one_success',
        },
        { id: 'all_done', prompt: 'd', depends_on: ['skip', 'fail'], trigger_rule: 'all_done' },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { ok: 'yes', one_success: 'one', none_failed: 'none', all_done: 'done' },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states.all_success).toBe('skipped');
    expect(states.one_success).toBe('stubbed');
    expect(states.none_failed).toBe('stubbed');
    expect(states.all_done).toBe('stubbed');
  });

  test('keeps whole-output references lenient and fails strict unknown fields', async () => {
    const workflow = makeTestWorkflow({
      name: 'strict-refs',
      nodes: [
        { id: 'producer', prompt: 'p', output_format: { type: 'object', properties: { ok: {} } } },
        { id: 'whole', prompt: 'whole=$unknown.output', depends_on: ['producer'] },
        { id: 'strict', prompt: 'strict=$producer.output.typo', depends_on: ['producer'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { producer: { ok: true }, whole: 'ok', strict: 'unused' },
    });

    expect(result.trace.find(entry => entry.nodeId === 'whole')?.resolvedText).toBe('whole=');
    expect(result.trace.find(entry => entry.nodeId === 'strict')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('not declared'),
    });
    expect(result.unusedStubs).toEqual(['strict']);
  });

  test('requires stubs only for reachable AI and default code nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'reachable',
      nodes: [
        { id: 'gate', prompt: 'gate' },
        { id: 'unreachable', prompt: 'no', depends_on: ['gate'], when: "$gate.output == 'NO'" },
        { id: 'code', bash: 'printf hello', depends_on: ['gate'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { gate: 'YES' },
    });

    expect(result.missingStubs).toEqual(['code']);
    expect(result.trace.find(entry => entry.nodeId === 'unreachable')?.state).toBe('skipped');
  });

  test('executes bash only with execCode and captures failures', async () => {
    const success = makeTestWorkflow({
      name: 'bash-ok',
      nodes: [{ id: 'code', bash: 'printf hello' }],
    });
    const successResult = await dryRunWorkflow({
      workflow: success,
      userMessage: '',
      cwd: process.cwd(),
      execCode: true,
    });
    expect(successResult).toMatchObject({ outcome: 'completed', summary: 'hello' });
    expect(successResult.trace[0]).toMatchObject({
      state: 'completed',
      reason: 'executed locally',
    });

    const failure = makeTestWorkflow({
      name: 'bash-fail',
      nodes: [{ id: 'code', bash: 'echo nope >&2; exit 7' }],
    });
    const failureResult = await dryRunWorkflow({
      workflow: failure,
      userMessage: '',
      cwd: process.cwd(),
      execCode: true,
    });
    expect(failureResult.outcome).toBe('failed');
    expect(failureResult.trace[0]).toMatchObject({ state: 'failed', reason: 'nope' });
  });

  test('auto-approves or pauses approval gates', async () => {
    const workflow = makeTestWorkflow({
      name: 'approval',
      nodes: [
        { id: 'before', prompt: 'before' },
        { id: 'gate', approval: { message: 'Review $before.output' }, depends_on: ['before'] },
        { id: 'after', prompt: 'after', depends_on: ['gate'] },
      ],
    });
    const automatic = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { before: 'result', after: 'done' },
    });
    expect(automatic.trace.find(entry => entry.nodeId === 'gate')).toMatchObject({
      state: 'completed',
      reason: 'auto-approved',
    });

    const paused = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { before: 'result', after: 'unused' },
      pauseAtGates: true,
    });
    expect(paused.outcome).toBe('paused');
    expect(paused.trace.at(-1)).toMatchObject({ nodeId: 'gate', state: 'paused' });
    expect(paused.unusedStubs).toEqual(['after']);
  });

  test('simulates loop completion and max-iteration failure', async () => {
    const completing = makeTestWorkflow({
      name: 'loop-ok',
      nodes: [
        {
          id: 'review',
          loop: { prompt: 'Review $LOOP_PREV_OUTPUT', until: 'DONE', max_iterations: 3 },
        },
      ],
    });
    const completed = await dryRunWorkflow({
      workflow: completing,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { review: '<promise>DONE</promise>' },
    });
    expect(completed.trace[0]).toMatchObject({
      state: 'stubbed',
      reason: 'completion signal after 1 iteration(s)',
    });

    const failed = await dryRunWorkflow({
      workflow: completing,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { review: 'keep going' },
    });
    expect(failed.outcome).toBe('failed');
    expect(failed.trace[0]?.reason).toContain('exceeded max iterations (3)');
    expect(failed.trace[0]?.reason).toContain("completion signal 'DONE'");
  });

  test('a loop driven only by until_bash simulates as complete, naming the unevaluated channel', async () => {
    // The simulator executes nothing, so `until_bash` is unobservable (#2563).
    // Reporting the max-iterations failure a real run would not produce is the worse
    // lie, so the loop is assumed to complete and the reason says why.
    const workflow = makeTestWorkflow({
      name: 'loop-deterministic',
      nodes: [
        {
          id: 'fix',
          loop: { prompt: 'Fix the tests', max_iterations: 3, until_bash: 'bun run test' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { fix: 'no sentinel here' },
    });

    expect(result.outcome).not.toBe('failed');
    expect(result.trace[0]).toMatchObject({ state: 'stubbed' });
    expect(result.trace[0]?.reason).toContain('assumed complete after 1 iteration(s)');
    expect(result.trace[0]?.reason).toContain('until_bash');
  });

  test('evaluates until_field exactly rather than guessing (#2563)', async () => {
    // The stub is hydrated onto NodeOutput.structuredOutput, so the simulator can
    // apply the engine's own `=== true` rule instead of assuming. Guessing would be
    // strictly worse here than in the until_bash case the docblock justifies.
    const workflow = makeTestWorkflow({
      name: 'judgment-loop',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: { prompt: 'work', max_iterations: 3, until_field: 'done' },
        },
      ],
    });

    const done = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { triage: { done: true } },
    });
    expect(done.outcome).not.toBe('failed');
    expect(done.trace[0]?.reason).toContain("'done' is true after 1 iteration(s)");

    // false must NOT be assumed complete — the channel is decidable and says no.
    const notDone = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { triage: { done: false } },
    });
    expect(notDone.outcome).toBe('failed');
    expect(notDone.trace[0]?.reason).toContain('exceeded max iterations (3)');
    expect(notDone.trace[0]?.reason).toContain("'done' ever being true");
  });

  test('until: plus until_field does not report a failure the real run would not produce', async () => {
    // Regression: the simulator only knew `until`, so an object stub (which carries
    // no prose sentinel) reported a max-iterations failure even though `until_field`
    // was satisfied.
    const workflow = makeTestWorkflow({
      name: 'both-channels',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: { prompt: 'work', until: 'DONE', max_iterations: 3, until_field: 'done' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { triage: { done: true } },
    });
    expect(result.outcome).not.toBe('failed');
    expect(result.trace[0]?.reason).toContain("'done' is true");
  });

  test('until: plus until_bash assumes completion when the stub carries no sentinel', async () => {
    // Behaviour CHANGE, recorded deliberately (#2563). Before, this combination
    // simulated as a max-iterations failure because only `until` was evaluated. Now
    // the unevaluable `until_bash` triggers the documented assumption, because the
    // real run's check may well have fired. The shipped `archon-adversarial-dev`
    // default declares exactly this pair, so the old verdict was a failure the real
    // run would not produce. The trade: a dry run can no longer prove a prose stub
    // trips `until:` on a loop that also declares `until_bash`.
    const workflow = makeTestWorkflow({
      name: 'signal-and-bash',
      nodes: [
        {
          id: 'sprint',
          loop: {
            prompt: 'work',
            until: 'ALL_SPRINTS_COMPLETE',
            until_bash: 'grep -q complete state.json',
            max_iterations: 3,
          },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { sprint: 'still working, no sentinel here' },
    });

    expect(result.outcome).not.toBe('failed');
    expect(result.trace[0]?.reason).toContain('assumed complete after 1 iteration(s)');
    expect(result.trace[0]?.reason).toContain('until_bash');
  });

  test('a until_field-only loop is not credited to until_bash it never declared', async () => {
    // Regression: the "assumed complete" fallback blamed `until_bash` unconditionally,
    // naming a channel the author had not written.
    const workflow = makeTestWorkflow({
      name: 'field-only',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: { prompt: 'work', max_iterations: 2, until_field: 'done' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { triage: { done: true } },
    });
    expect(result.trace[0]?.reason).not.toContain('until_bash');
  });

  test('simulates loop-group body outputs without leaking iteration state', async () => {
    const workflow = makeTestWorkflow({
      name: 'loop-group',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              { id: 'draft', prompt: 'draft' },
              { id: 'finish', prompt: 'finish $draft.output', depends_on: ['draft'] },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { draft: 'fresh', finish: 'DONE' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.map(entry => entry.nodeId)).toEqual(['draft', 'finish', 'group']);
    expect(result.trace[1]?.resolvedText).toBe('finish fresh');
  });

  test('represents cancellation and unsupported subworkflows visibly', async () => {
    const cancelled = makeTestWorkflow({
      name: 'cancel',
      nodes: [
        { id: 'stop', cancel: 'not safe' },
        { id: 'later', prompt: 'later', depends_on: ['stop'] },
      ],
    });
    const cancelledResult = await dryRunWorkflow({
      workflow: cancelled,
      userMessage: '',
      cwd: process.cwd(),
    });
    expect(cancelledResult.outcome).toBe('cancelled');
    expect(cancelledResult.trace).toHaveLength(1);

    const child = makeTestWorkflow({ name: 'child', nodes: [{ id: 'child', workflow: 'other' }] });
    const childResult = await dryRunWorkflow({
      workflow: child,
      userMessage: '',
      cwd: process.cwd(),
    });
    expect(childResult).toMatchObject({ outcome: 'failed' });
    expect(childResult.trace[0]?.reason).toContain('does not execute reachable workflow nodes');
  });

  test('formats a stable human trace', async () => {
    const workflow = makeTestWorkflow({ name: 'format', nodes: [{ id: 'node', prompt: 'hello' }] });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { node: 'world' },
    });

    expect(formatDryRunTrace(result)).toContain('STUBBED   node (prompt)');
    expect(formatDryRunTrace(result)).toContain('Outcome: completed');
  });
});

// ---------------------------------------------------------------------------
// Per-node resolution reporting (#1764 Task 3).
//
// The answer to "I can't tell what provider this node will run on", and the reason
// requiring provider+model on every node was rejected: legibility instead of redundancy.
// ---------------------------------------------------------------------------

describe('dryRunWorkflow — effective provider/model per node', () => {
  const config = {
    assistant: 'claude',
    assistants: { claude: { model: 'claude-default' }, codex: { model: 'codex-default' } },
    commands: {},
    defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
  };
  const aiProfile = buildAiProfile('claude', {
    repoTiers: { large: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' } },
  });

  async function trace(nodes: unknown[]) {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({ name: 'resolve', nodes }),
      userMessage: 'go',
      cwd: process.cwd(),
      stubs: Object.fromEntries((nodes as { id: string }[]).map(n => [n.id, 'ok'])),
      config,
      aiProfile,
    });
    return new Map(result.trace.map(e => [e.nodeId, e.resolution]));
  }

  test('reports a node-declared provider/model, and the config fallback for one that declares nothing', async () => {
    const byId = await trace([
      { id: 'bare', prompt: 'p' },
      { id: 'own', prompt: 'p', provider: 'codex' },
    ]);

    expect(byId.get('bare')).toMatchObject({
      provider: 'claude',
      model: 'claude-default',
      providerFrom: 'default assistant',
    });
    expect(byId.get('own')).toMatchObject({
      provider: 'codex',
      model: 'codex-default',
      providerFrom: 'node',
      modelFrom: 'assistant config',
    });
  });

  test('reports a tier keyword resolved through the profile, with its effort', async () => {
    const byId = await trace([{ id: 'tiered', prompt: 'p', model: 'large' }]);
    expect(byId.get('tiered')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      providerFrom: 'model ref',
      modelFrom: 'model ref',
      effort: 'xhigh',
      effortFrom: 'model ref',
    });
  });

  test('names the workflow a composed node was authored in', async () => {
    const block = makeTestWorkflow({
      name: 'blk',
      provider: 'codex',
      nodes: [{ id: 'work', prompt: 'p' }],
    });
    const parent = makeTestWorkflow({
      name: 'parent',
      nodes: [{ id: 'inc', include: 'blk' }],
    });
    const { workflows } = expandWorkflowIncludes(
      new Map([
        ['blk', block],
        ['parent', parent],
      ])
    );

    const result = await dryRunWorkflow({
      workflow: workflows.get('parent')!,
      userMessage: 'go',
      cwd: process.cwd(),
      stubs: { inc__work: 'ok' },
      config,
      aiProfile,
    });

    // After the collapse the value lives ON the node, so `providerFrom` is 'node' —
    // `authoredIn` is what tells the reader which file put it there.
    expect(result.trace[0].resolution).toMatchObject({
      provider: 'codex',
      providerFrom: 'node',
      authoredIn: 'blk',
    });
  });

  test('non-AI nodes carry no resolution, and the text trace renders the report', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'mixed',
        nodes: [
          { id: 'shell', bash: 'echo hi' },
          { id: 'think', prompt: 'p', provider: 'codex' },
        ],
      }),
      userMessage: 'go',
      cwd: process.cwd(),
      stubs: { shell: 'hi', think: 'ok' },
      config,
      aiProfile,
    });

    expect(result.trace.find(e => e.nodeId === 'shell')?.resolution).toBeUndefined();
    expect(formatDryRunTrace(result)).toContain('runs on: codex (node) / codex-default');
  });
});
