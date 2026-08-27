import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import {
  createDryRunStubScaffold,
  dryRunWorkflow,
  formatDryRunTrace,
  loadDryRunStubs,
  writeDryRunStubScaffold,
} from './dry-run';
import type { DryRunResolution } from './dry-run';
import { buildAiProfile } from './model-validation';
import { resolveWorkflowModelScope } from './node-model-resolution';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDefinition } from './schemas';

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

function composedReviewWorkflow(gateNodes: unknown[], includeWhen?: string): WorkflowDefinition {
  const block = makeTestWorkflow({
    name: 'review-block',
    nodes: [
      { id: 'entry', bash: 'echo entry' },
      {
        id: 'optional',
        bash: 'echo optional',
        depends_on: ['entry'],
        when: "$entry.output == 'never'",
      },
      { id: 'required', bash: 'echo required', depends_on: ['entry'] },
      {
        id: 'synthesize',
        bash: 'echo synthesize',
        depends_on: ['optional', 'required'],
        trigger_rule: 'all_done',
      },
    ],
  });
  const parent = makeTestWorkflow({
    name: 'parent',
    nodes: [
      ...gateNodes,
      {
        id: 'review',
        include: 'review-block',
        depends_on: ['gate'],
        ...(includeWhen !== undefined ? { when: includeWhen } : {}),
      },
      { id: 'consumer', bash: 'echo consumer', depends_on: ['review'] },
    ],
  });
  return makeTestComposedWorkflow([block, parent], 'parent');
}

describe('loadDryRunStubs', () => {
  test('loads scalar and structured node outputs', async () => {
    const result = await loadDryRunStubs(
      temporaryFile('classify: BUG\ndetails:\n  severity: high\n  count: 2\n')
    );

    expect(result).toEqual({ classify: 'BUG', details: { severity: 'high', count: 2 } });
  });

  test('rejects missing, list, and multi-document files', async () => {
    await expect(loadDryRunStubs('/definitely/missing/stubs.yaml')).rejects.toThrow(
      'Dry-run stub file not found'
    );
    await expect(loadDryRunStubs(temporaryFile('- one\n- two\n'))).rejects.toThrow(
      'expected one YAML mapping'
    );
    await expect(loadDryRunStubs(temporaryFile('one: value\n---\ntwo: value\n'))).rejects.toThrow(
      'expected one YAML mapping'
    );
  });

  test('rejects a fixture file with a targeted message instead of mis-reading it (#2772)', async () => {
    await expect(
      loadDryRunStubs(temporaryFile('fixture:\n  expect: completed\nnode-a: "stub"\n'))
    ).rejects.toThrow("this is a fixture file; run it with 'workflow test'");
    await expect(
      loadDryRunStubs(temporaryFile('exec-code: false\nnode-a: "stub"\n'))
    ).rejects.toThrow('workflow test');
  });
});

describe('dry-run stub scaffolding and sparse defaults (#2624)', () => {
  test('writes YAML-native schema placeholders for flattened and loop-group node ids', async () => {
    const block = makeTestWorkflow({
      name: 'review-block',
      nodes: [
        {
          id: 'classify',
          prompt: 'classify',
          output_format: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['bug', 'feature'] },
              summary: { type: 'string', minLength: 5 },
              ready: { type: 'boolean' },
              score: { type: 'number', minimum: 2 },
              labels: { type: 'array', minItems: 1, items: { type: 'string' } },
              meta: {
                type: 'object',
                properties: { reviewed: { type: 'boolean' } },
                required: ['reviewed'],
              },
            },
            required: ['kind', 'summary', 'ready', 'score', 'labels', 'meta'],
          },
        },
        {
          id: 'group',
          loop_group: {
            until: 'TODO',
            max_iterations: 2,
            nodes: [
              { id: 'draft', prompt: 'draft' },
              { id: 'finish', prompt: 'finish', depends_on: ['draft'] },
            ],
          },
          depends_on: ['classify'],
        },
      ],
    });
    const parent = makeTestWorkflow({
      name: 'parent',
      nodes: [
        { id: 'review', include: 'review-block' },
        { id: 'approve', approval: { message: 'approve' }, depends_on: ['review'] },
        { id: 'stop', cancel: 'stop', depends_on: ['approve'] },
      ],
    });
    const workflow = makeTestComposedWorkflow([block, parent], 'parent');
    const directory = mkdtempSync(join(tmpdir(), 'archon-dry-run-scaffold-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'fixtures', 'stubs.yaml');

    const written = await writeDryRunStubScaffold(workflow, path);
    const loaded = await loadDryRunStubs(path);

    expect(loaded).toEqual(written);
    expect(Object.keys(loaded).sort()).toEqual(['draft', 'finish', 'review__classify']);
    expect(loaded.review__classify).toEqual({
      kind: 'bug',
      summary: 'TTTTT',
      ready: false,
      score: 2,
      labels: ['TODO'],
      meta: { reviewed: false },
    });
    expect(await Bun.file(path).text()).toContain('ready: false');
    await expect(writeDryRunStubScaffold(workflow, path)).rejects.toThrow(
      'stub scaffold already exists'
    );
  });

  test('does not leave a partial file when a placeholder cannot satisfy the schema', async () => {
    const workflow = makeTestWorkflow({
      name: 'unsupported-placeholder',
      nodes: [
        {
          id: 'strict',
          prompt: 'strict',
          output_format: {
            type: 'object',
            properties: { code: { type: 'string', pattern: '^OK$' } },
            required: ['code'],
          },
        },
      ],
    });
    const directory = mkdtempSync(join(tmpdir(), 'archon-dry-run-scaffold-fail-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'stubs.yaml');

    await expect(writeDryRunStubScaffold(workflow, path)).rejects.toThrow(
      "Cannot generate schema-valid dry-run stub for node 'strict'"
    );
    expect(existsSync(path)).toBe(false);
  });

  test('owns prototype-named keys and coalesces compatible loop-body keys', async () => {
    const body = () => ({
      until: 'TODO',
      max_iterations: 1,
      nodes: [{ id: 'shared', prompt: 'work' }],
    });
    const workflow = makeTestWorkflow({
      name: 'shared-stub-keys',
      nodes: [
        { id: '__proto__', prompt: 'prototype' },
        { id: 'constructor', prompt: 'constructor' },
        { id: 'first', loop_group: body() },
        { id: 'second', loop_group: body() },
      ],
    });
    const directory = mkdtempSync(join(tmpdir(), 'archon-dry-run-scaffold-keys-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'stubs.yaml');

    const scaffold = await writeDryRunStubScaffold(workflow, path);
    const loaded = await loadDryRunStubs(path);
    const strict = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: loaded,
    });
    const sparse = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      defaultStubs: true,
    });

    expect(Object.keys(scaffold).sort()).toEqual(['__proto__', 'constructor', 'shared']);
    expect(scaffold.__proto__).toBe('TODO');
    expect(Object.getOwnPropertyDescriptor(scaffold, 'constructor')?.value).toBe('TODO');
    expect(Object.hasOwn(loaded, '__proto__')).toBe(true);
    expect(loaded.__proto__).toBe('TODO');
    expect(strict.outcome).toBe('completed');
    expect(strict.unusedStubs).toEqual([]);
    expect(sparse.outcome).toBe('completed');
    expect(sparse.trace.find(entry => entry.nodeId === '__proto__')?.output).toBe('TODO');
    expect(sparse.trace.filter(entry => entry.nodeId === 'shared')).toHaveLength(2);
  });

  test('selects a retained candidate after collecting every shared-key consumer', async () => {
    const body = (values: string[]) => ({
      until_bash: 'true',
      max_iterations: 1,
      nodes: [
        {
          id: 'shared',
          prompt: 'work',
          output_format: {
            type: 'object',
            properties: { kind: { type: 'string', enum: values } },
            required: ['kind'],
          },
        },
      ],
    });
    const workflow = makeTestWorkflow({
      name: 'retained-shared-candidate',
      nodes: [
        { id: 'first', loop_group: body(['A', 'B']) },
        { id: 'second', loop_group: body(['B', 'A', 'C']) },
        { id: 'third', loop_group: body(['C', 'B']) },
      ],
    });

    const scaffold = createDryRunStubScaffold(workflow);
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: scaffold,
    });

    expect(scaffold.shared).toEqual({ kind: 'B' });
    expect(result.outcome).toBe('completed');
    expect(result.unusedStubs).toEqual([]);
  });

  test('rejects only genuinely incompatible nodes sharing one raw stub key', () => {
    const body = (only: string) => ({
      until: 'TODO',
      max_iterations: 1,
      nodes: [
        {
          id: 'shared',
          prompt: 'work',
          output_format: {
            type: 'object',
            properties: { kind: { type: 'string', enum: [only] } },
            required: ['kind'],
          },
        },
      ],
    });
    const workflow = makeTestWorkflow({
      name: 'incompatible-stub-keys',
      nodes: [
        { id: 'first', loop_group: body('first') },
        { id: 'second', loop_group: body('second') },
      ],
    });

    expect(() => createDryRunStubScaffold(workflow)).toThrow(
      "nodes sharing stub key 'shared' require incompatible values"
    );
  });

  test('fails closed on asynchronous output schemas without an unhandled rejection', async () => {
    const workflow = makeTestWorkflow({
      name: 'async-schema',
      nodes: [
        {
          id: 'strict',
          prompt: 'strict',
          output_format: {
            $async: true,
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
          },
        },
      ],
    });
    const directory = mkdtempSync(join(tmpdir(), 'archon-dry-run-scaffold-async-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'stubs.yaml');

    await expect(writeDryRunStubScaffold(workflow, path)).rejects.toThrow(
      'asynchronous output_format schemas are unsupported'
    );
    const sparse = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      defaultStubs: true,
    });

    expect(existsSync(path)).toBe(false);
    expect(sparse.outcome).toBe('failed');
    expect(sparse.trace[0]).toMatchObject({
      nodeId: 'strict',
      state: 'failed',
      reason: expect.stringContaining('asynchronous output_format schemas are unsupported'),
    });
  });

  test('completes a 36-node composition with only three load-bearing overrides', async () => {
    const blockNodes = [
      {
        id: 'gate',
        prompt: 'gate',
        output_format: {
          type: 'object',
          properties: { verdict: { type: 'string', enum: ['go', 'stop'] } },
          required: ['verdict'],
        },
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `step-${String(index + 1)}`,
        prompt: `step ${String(index + 1)}`,
        depends_on: [index === 0 ? 'gate' : `step-${String(index)}`],
        ...(index === 0 ? { when: "$gate.output.verdict == 'go'" } : {}),
      })),
    ];
    const block = makeTestWorkflow({ name: 'large-block', nodes: blockNodes });
    const parent = makeTestWorkflow({
      name: 'large-parent',
      nodes: ['one', 'two', 'three'].map(id => ({ id, include: 'large-block' })),
    });
    const workflow = makeTestComposedWorkflow([block, parent], 'large-parent');
    expect(workflow.nodes).toHaveLength(36);
    const stubs = {
      one__gate: { verdict: 'go' },
      two__gate: { verdict: 'stop' },
      three__gate: { verdict: 'go' },
      never_reached: 'unused',
    };

    const sparse = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs,
      defaultStubs: true,
    });
    const strict = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs,
    });

    expect(sparse.outcome).toBe('completed');
    expect(sparse.missingStubs).toEqual([]);
    expect(sparse.unusedStubs).toEqual(['never_reached']);
    expect(sparse.trace.find(entry => entry.nodeId === 'one__step-1')?.state).toBe('stubbed');
    expect(sparse.trace.find(entry => entry.nodeId === 'two__step-1')?.state).toBe('skipped');
    expect(strict.outcome).toBe('failed');
    expect(strict.missingStubs).toEqual(['one__step-1', 'three__step-1']);
  });

  test('defaults loops to completion and still executes code under execCode', async () => {
    const workflow = makeTestWorkflow({
      name: 'default-loop-stubs',
      nodes: [
        { id: 'signal', loop: { prompt: 'work', until: 'DONE', max_iterations: 2 } },
        {
          id: 'field',
          loop: { prompt: 'work', until_field: 'done', max_iterations: 2 },
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          depends_on: ['signal'],
        },
        { id: 'code', bash: 'printf live', depends_on: ['field'] },
      ],
    });

    const scaffold = createDryRunStubScaffold(workflow);
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      defaultStubs: true,
      execCode: true,
    });

    expect(scaffold).toEqual({ signal: 'DONE', field: { done: true }, code: 'TODO' });
    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'signal')?.reason).toContain(
      'completion signal'
    );
    expect(result.trace.find(entry => entry.nodeId === 'field')?.reason).toContain(
      "'done' is true"
    );
    expect(result.trace.find(entry => entry.nodeId === 'code')).toMatchObject({
      state: 'completed',
      reason: 'executed locally',
      output: 'live',
    });
  });

  test('generates array-typed output_format stubs', () => {
    const workflow = makeTestWorkflow({
      name: 'array-output',
      nodes: [
        {
          id: 'items',
          prompt: 'List items',
          output_format: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
          },
        },
      ],
    });

    expect(createDryRunStubScaffold(workflow)).toEqual({ items: ['TODO', 'TODO'] });
  });

  test.each([
    ['boolean', { type: 'boolean' }, false],
    ['number', { type: 'number' }, 0],
    ['integer with minimum', { type: 'integer', minimum: 3 }, 3],
    ['null', { type: 'null' }, null],
    ['scalar const', { const: 5 }, 5],
  ])('generates %s-typed output_format stubs', (_name, outputFormat, expected) => {
    const workflow = makeTestWorkflow({
      name: 'scalar-output',
      nodes: [{ id: 'flag', prompt: 'Decide', output_format: outputFormat as never }],
    });

    expect(createDryRunStubScaffold(workflow)).toEqual({ flag: expected });
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

  test('skips every composed node when the include condition is false', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow(
        [{ id: 'gate', bash: 'echo gate' }],
        "$gate.output == 'run'"
      ),
      userMessage: '',
      cwd: process.cwd(),
      stubs: {
        gate: 'skip',
        review__synthesize: 'must not run',
        consumer: 'must not run',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states).toEqual({
      gate: 'stubbed',
      review__entry: 'skipped',
      review__optional: 'skipped',
      review__required: 'skipped',
      review__synthesize: 'skipped',
      consumer: 'skipped',
    });
  });

  test('skips every composed node when the include dependencies are ineligible', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow([
        { id: 'source', bash: 'echo source' },
        {
          id: 'gate',
          bash: 'echo gate',
          depends_on: ['source'],
          when: "$source.output == 'never'",
        },
      ]),
      userMessage: '',
      cwd: process.cwd(),
      stubs: {
        source: 'ready',
        review__synthesize: 'must not run',
        consumer: 'must not run',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states).toEqual({
      source: 'stubbed',
      gate: 'skipped',
      review__entry: 'skipped',
      review__optional: 'skipped',
      review__required: 'skipped',
      review__synthesize: 'skipped',
      consumer: 'skipped',
    });
  });

  test('keeps all_done active for intentionally skipped branches inside a running block', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow(
        [{ id: 'gate', bash: 'echo gate' }],
        "$gate.output == 'run'"
      ),
      userMessage: '',
      cwd: process.cwd(),
      stubs: {
        gate: 'run',
        review__entry: 'started',
        review__required: 'report',
        review__synthesize: 'ready',
        consumer: 'done',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states.review__optional).toBe('skipped');
    expect(states.review__synthesize).toBe('stubbed');
    expect(states.consumer).toBe('stubbed');
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

  // #2617 + #2619: exec'd nodes get a pre-created ARTIFACTS_DIR/STATE_DIR under
  // <ARCHON_HOME>/temp — never inside the simulated repo — removed when the run ends.
  test('exec-code writes land in an ephemeral ARCHON_HOME temp dir, not the repo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'archon-dry-run-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-repo-'));
    temporaryDirectories.push(home, cwd);
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const workflow = makeTestWorkflow({
        name: 'hermetic',
        nodes: [
          {
            id: 'code',
            bash: 'printf data > "$ARTIFACTS_DIR/out.txt"\nprintf s > "$STATE_DIR/s.txt"\ncat "$ARTIFACTS_DIR/out.txt"\necho\necho "$ARTIFACTS_DIR"',
          },
        ],
      });
      const result = await dryRunWorkflow({ workflow, userMessage: '', cwd, execCode: true });

      expect(result.outcome).toBe('completed');
      const [written, reportedDir] = (result.trace[0]?.output ?? '').split('\n');
      expect(written).toBe('data');
      expect(reportedDir?.startsWith(join(home, 'temp'))).toBe(true);
      expect(existsSync(join(cwd, '.archon'))).toBe(false);
      expect(readdirSync(join(home, 'temp'))).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  test('a dry run that executes nothing creates no temp directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'archon-dry-run-home-'));
    temporaryDirectories.push(home);
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const workflow = makeTestWorkflow({
        name: 'stub-only',
        nodes: [{ id: 'code', bash: 'printf never-runs' }],
      });
      const result = await dryRunWorkflow({
        workflow,
        userMessage: '',
        cwd: process.cwd(),
        stubs: { code: 'stubbed' },
        execCode: true,
      });

      expect(result.outcome).toBe('completed');
      expect(existsSync(join(home, 'temp'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
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

  test('reports a durable wait as a pause without AI resolution', async () => {
    const workflow = makeTestWorkflow({
      name: 'wait',
      nodes: [{ id: 'delay', wait: { duration_ms: 60_000 } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: {},
    });

    expect(result.outcome).toBe('paused');
    expect(createDryRunStubScaffold(workflow)).toEqual({});
    expect(result.trace).toEqual([
      {
        nodeId: 'delay',
        nodeType: 'wait',
        state: 'paused',
        reason: 'durable wait',
      },
    ]);
    expect(result.missingStubs).toEqual([]);
    expect(result.unusedStubs).toEqual([]);
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

  test('fails loud on a reachable composed fan-out node instead of simulating it', async () => {
    const workflow = makeTestWorkflow({
      name: 'compose-fan',
      nodes: [
        {
          id: 'fan',
          kind: 'compose_fan_out',
          include: 'some-block',
          fan_out: { items: "['a']", as: 'item', max_parallel: 1 },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.nodeType).toBe('compose_fan_out');
    expect(result.trace[0]?.reason).toContain('does not execute reachable compose_fan_out nodes');
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
// Declared inputs (#2610).
//
// The simulator resolves `$INPUTS.<name>` from the same effective map a real run
// builds: declared defaults layered under caller-supplied values, on every surface
// (prompt/command text, `when:`, exec-code env). The caller passes the gate-validated
// supplied map; defaults are derived here, mirroring the executor's split.
// ---------------------------------------------------------------------------

describe('dryRunWorkflow — declared inputs (#2610)', () => {
  const defaulted = makeTestWorkflow({
    name: 'inputs-defaulted',
    inputs: { work: { default: 'W' } },
    nodes: [{ id: 'impl', prompt: 'Do $INPUTS.work' }],
  });

  test('applies declared defaults when nothing is supplied', async () => {
    const result = await dryRunWorkflow({
      workflow: defaulted,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { impl: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Do W');
  });

  test('supplied values win over declared defaults', async () => {
    const result = await dryRunWorkflow({
      workflow: defaulted,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { impl: 'done' },
      inputs: { work: 'X' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Do X');
  });

  test('merges a supplied input with a defaulted companion — the #2123 bundle shape', async () => {
    // Multi-key layering is where the merge is observable: `supplied ?? defaults`
    // (all-or-nothing) would pass every single-key test while dropping 'style' here.
    const workflow = makeTestWorkflow({
      name: 'inputs-mixed',
      inputs: { diff: { required: true }, style: { default: 'strict' } },
      nodes: [{ id: 'review', prompt: 'Review $INPUTS.diff as $INPUTS.style' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { review: 'done' },
      inputs: { diff: 'D1' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Review D1 as strict');
  });

  test('keeps $INPUTS text literal in bash bodies — env vars are the only shell channel', async () => {
    // shellSafe must keep holding now that ctx.inputs is threaded into resolveText:
    // substituting user-controlled values into shell source is the injection class
    // INPUTS_<UPPER_SNAKE> env delivery exists to prevent (#2115).
    const workflow = makeTestWorkflow({
      name: 'inputs-shell-literal',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'code', bash: 'echo $INPUTS.work' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { code: 'stubbed' },
    });

    expect(result.trace[0]?.resolvedText).toBe('echo $INPUTS.work');
  });

  test('keeps passthrough semantics for a workflow that declares no inputs', async () => {
    // Parity with a real run: `--input` on a signature-less workflow forwards verbatim.
    const workflow = makeTestWorkflow({
      name: 'inputs-passthrough',
      nodes: [{ id: 'use', prompt: 'Got $INPUTS.a' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { use: 'done' },
      inputs: { a: 'b' },
    });

    expect(result.trace[0]?.resolvedText).toBe('Got b');
  });

  test('resolves $INPUTS in a loop.command body during simulated iterations', async () => {
    // The issue's repro shape: a defaulted signature whose loop command references it.
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-inputs-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'commands', 'loop-impl.md'), 'Work on $INPUTS.work');
    const workflow = makeTestWorkflow({
      name: 'inputs-loop-command',
      inputs: { work: { default: '' } },
      nodes: [{ id: 'impl', loop: { command: 'loop-impl', until: 'DONE', max_iterations: 2 } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd,
      stubs: { impl: '<promise>DONE</promise>' },
      inputs: { work: 'ship it' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Work on ship it');
  });

  test('uses the input-bound compiled prompt for a nested included loop command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-nested-inputs-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    // The raw source keeps the middle workflow's input name. Loading it at simulation time
    // reproduces #2629; the expanded node's compiled prompt has already rebound that name.
    writeFileSync(join(cwd, '.archon', 'commands', 'loop-impl.md'), 'Raw $INPUTS.work');

    const implement = makeTestWorkflow({
      name: 'implement',
      inputs: { work: { required: true } },
      nodes: [
        { id: 'implement', loop: { command: 'loop-impl', until: 'DONE', max_iterations: 1 } },
      ],
    });
    const deliver = makeTestWorkflow({
      name: 'deliver',
      inputs: { work: { required: true } },
      nodes: [{ id: 'impl', include: 'implement', with: { work: '$INPUTS.work' } }],
    });
    const fix = makeTestWorkflow({
      name: 'fix',
      inputs: { target: { required: true } },
      nodes: [{ id: 'deliver', include: 'deliver', with: { work: 'Fix $INPUTS.target' } }],
    });
    const { workflows, errors } = expandWorkflowIncludes(
      new Map([
        ['implement', implement],
        ['deliver', deliver],
        ['fix', fix],
      ]),
      new Map([['loop-impl', 'Work on $INPUTS.work']])
    );
    expect(errors).toHaveLength(0);

    const result = await dryRunWorkflow({
      workflow: workflows.get('fix')!,
      userMessage: '',
      cwd,
      stubs: { deliver__impl__implement: '<promise>DONE</promise>' },
      inputs: { target: 'issue 2629' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('Work on Fix issue 2629');
  });

  test('when: conditions branch on the effective input map', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-when',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'gated', prompt: 'go', when: "$INPUTS.work == 'X'" }],
    });

    const supplied = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { gated: 'ran' },
      inputs: { work: 'X' },
    });
    expect(supplied.trace[0]?.state).toBe('stubbed');

    const defaultOnly = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { gated: 'unused' },
    });
    expect(defaultOnly.trace[0]).toMatchObject({
      state: 'skipped',
      reason: 'when_condition_false',
    });
  });

  test('fails an unknown reference with the same message a real run produces', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-typo',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'impl', prompt: 'Do $INPUTS.typo' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { impl: 'unused' },
    });

    // Read the value before matching: Bun's toMatchObject leaves an asymmetric
    // matcher behind in the received object, corrupting later reads of the same field.
    const reason = result.trace[0]?.state === 'failed' ? result.trace[0].reason : '';
    expect(reason).toContain("Unknown input '$INPUTS.typo'");
    expect(reason).toContain('$INPUTS.work');
  });

  test('keeps the no-declared-inputs failure unchanged', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-none',
      nodes: [{ id: 'impl', prompt: 'Do $INPUTS.x' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { impl: 'unused' },
    });

    expect(result.trace[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('This run has no declared inputs.'),
    });
  });

  test('delivers INPUTS_<UPPER_SNAKE> env vars to exec-code nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'inputs-exec',
      inputs: { work: { default: 'W' } },
      nodes: [{ id: 'code', bash: 'printf "v=%s" "$INPUTS_WORK"' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      execCode: true,
    });

    expect(result.trace[0]).toMatchObject({ state: 'completed', output: 'v=W' });
  });
});

// ---------------------------------------------------------------------------
// Per-node resolution reporting (#1764 Task 3).
//
// The answer to "I can't tell what provider this node will run on", and the reason
// requiring provider+model on every node was rejected: legibility instead of redundancy.
// ---------------------------------------------------------------------------

describe('dryRunWorkflow — node-local with: bindings (#2637)', () => {
  const producer = {
    id: 'plan',
    prompt: 'Make a plan',
    output_format: { type: 'object', properties: { green: { type: 'boolean' } } },
  };

  test('delivers a command binding into the $INPUTS bag of the resolved text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-bindings-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'commands', 'deploy.md'), 'Deploy green=$INPUTS.flag');
    const workflow = makeTestWorkflow({
      name: 'binding-command',
      nodes: [
        producer,
        {
          id: 'deploy',
          command: 'deploy',
          depends_on: ['plan'],
          with: { flag: '$plan.output.green' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd,
      stubs: { plan: { green: true }, deploy: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.resolvedText).toBe('Deploy green=true');
  });

  test('a node-local binding wins over a run-level input of the same name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-dry-run-bindings-'));
    temporaryDirectories.push(cwd);
    mkdirSync(join(cwd, '.archon', 'commands'), { recursive: true });
    writeFileSync(join(cwd, '.archon', 'commands', 'report.md'), 'Mode: $INPUTS.mode');
    const workflow = makeTestWorkflow({
      name: 'binding-precedence',
      inputs: { mode: { default: 'run-level' } },
      nodes: [{ id: 'report', command: 'report', with: { mode: 'node-local' } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd,
      stubs: { report: 'done' },
    });

    // Without the nearest-wins merge the preview silently shows 'run-level' — the
    // wrong value, with no failure to notice it by.
    expect(result.trace[0]?.resolvedText).toBe('Mode: node-local');
  });

  test('delivers script bindings as INPUTS_* env under --exec-code', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-exec',
      nodes: [
        producer,
        {
          id: 'check',
          script: 'console.log(`green=${process.env.INPUTS_GREEN ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['plan'],
          with: { green: '$plan.output.green' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace[1]?.output).toBe('green=true');
  });

  test('fails the node with the executor error when a binding names an unknown producer', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-unknown',
      nodes: [
        producer,
        {
          id: 'check',
          script: 'console.log("never")',
          runtime: 'bun' as const,
          depends_on: ['plan'],
          with: { green: '$plann.output' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('failed');
    const failed = result.trace.find(t => t.nodeId === 'check');
    expect(failed?.state).toBe('failed');
    // The executor's own resolver produced this — preview and run share one error.
    expect(failed?.reason).toContain("references node 'plann'");
  });

  test('a directive on a skipped producer takes if_skipped, matching the real run', async () => {
    const workflow = makeTestWorkflow({
      name: 'binding-skipped',
      nodes: [
        producer,
        {
          id: 'maybe',
          prompt: 'Only sometimes',
          depends_on: ['plan'],
          when: "$plan.output.green == 'false'",
          output_format: { type: 'object', properties: { ready: { type: 'boolean' } } },
        },
        {
          id: 'gate',
          script: 'console.log(`ready=${process.env.INPUTS_READY ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['plan', 'maybe'],
          trigger_rule: 'all_done' as const,
          with: { ready: { from: '$maybe.output.ready', if_skipped: false } },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      stubs: { plan: { green: true } },
      execCode: true,
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(t => t.nodeId === 'gate')?.output).toBe('ready=false');
  });

  test('a directive on a failed producer fails the consumer, never taking if_skipped (#2696)', async () => {
    // Preview and the real run share resolveNodeBindings (see this file's docblock),
    // so the failed-producer guard added for #2696 must behave identically here.
    const workflow = makeTestWorkflow({
      name: 'binding-failed',
      nodes: [
        { id: 'corrections', bash: 'echo boom >&2; exit 1' },
        {
          id: 'gate-ready',
          script: 'console.log(`ready=${process.env.INPUTS_READY ?? "unset"}`)',
          runtime: 'bun' as const,
          depends_on: ['corrections'],
          trigger_rule: 'all_done' as const,
          with: { ready: { from: '$corrections.output', if_skipped: 'default' } },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      userMessage: '',
      cwd: process.cwd(),
      execCode: true,
    });

    expect(result.outcome).toBe('failed');
    const gate = result.trace.find(t => t.nodeId === 'gate-ready');
    // The binding rejected the failed producer outright — it never took if_skipped's default.
    expect(gate?.state).toBe('failed');
    expect(gate?.reason).toContain("'corrections' failed");
  });
});

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

  async function trace(nodes: unknown[]): Promise<Map<string, DryRunResolution | undefined>> {
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

  test('reports a provider/model conflict the real run would warn about', async () => {
    // The node names one provider while its tier ref resolves to another. A real run warns
    // and uses the resolved one; the dry run reports the outcome AND the reason.
    const byId = await trace([{ id: 'clash', prompt: 'p', provider: 'claude', model: 'large' }]);
    expect(byId.get('clash')).toMatchObject({
      provider: 'codex',
      providerConflict: { declared: 'claude', resolved: 'codex', modelRef: 'large' },
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

describe('resolveWorkflowModelScope — the origin names the value that won', () => {
  const assistantModels = { claude: 'claude-default', codex: 'codex-default' };
  const profile = buildAiProfile('claude', {
    repoTiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
  });

  test('a preset outranks a declared provider, and the origin says so', () => {
    // The workflow declares `provider: claude`, but `model: large` resolves to codex and
    // the preset's provider is what the run uses (the executor warns about the conflict).
    // Reporting the origin as 'workflow' would name the value that LOST.
    const scope = resolveWorkflowModelScope(
      { provider: 'claude', model: 'large' },
      'claude',
      assistantModels,
      profile
    );
    expect(scope.provider).toBe('codex');
    expect(scope.providerOrigin).toBe('model ref');
  });

  test('a declared provider with a literal model keeps the workflow origin', () => {
    const scope = resolveWorkflowModelScope(
      { provider: 'codex', model: 'gpt-5.6-sol' },
      'claude',
      assistantModels,
      profile
    );
    expect(scope.provider).toBe('codex');
    expect(scope.providerOrigin).toBe('workflow');
  });

  test('no provider and no model falls back to the default assistant', () => {
    const scope = resolveWorkflowModelScope({}, 'claude', assistantModels, profile);
    expect(scope.provider).toBe('claude');
    expect(scope.providerOrigin).toBe('default assistant');
  });
});
