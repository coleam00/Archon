import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, formatDryRunTrace, loadDryRunStubs } from './dry-run';

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
