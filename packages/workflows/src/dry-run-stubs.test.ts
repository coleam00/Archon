import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import { loadDryRunStubs } from './dry-run';
import {
  dryRunWorkflow,
  useDryRunFiles,
  createDryRunStubScaffold,
  writeDryRunStubScaffold,
} from './dry-run-test-utils';

const { temporaryDirectory, temporaryFile } = useDryRunFiles();

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
    const directory = temporaryDirectory();
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

  test('writes editable block YAML that round-trips and runs unchanged', async () => {
    const workflow = makeTestWorkflow({
      name: 'editable-stubs',
      nodes: [
        {
          id: 'a',
          prompt: 'check',
          output_format: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
        { id: 'b', prompt: 'work', depends_on: ['a'] },
      ],
    });
    const path = join(temporaryDirectory(), 'stubs.yaml');
    const written = await writeDryRunStubScaffold(workflow, path);
    const yaml = await Bun.file(path).text();

    expect(
      yaml
        .trim()
        .split('\n')
        .map(line => line.trimEnd())
    ).toEqual(['a:', '  ok: false', 'b: TODO']);
    expect(Bun.YAML.parse(yaml)).toEqual(written);
    const result = await dryRunWorkflow({ workflow, stubs: await loadDryRunStubs(path) });
    expect(result.outcome).toBe('completed');
    expect(result.missingStubs).toEqual([]);
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
    const directory = temporaryDirectory();
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
    const directory = temporaryDirectory();
    const path = join(directory, 'stubs.yaml');

    const scaffold = await writeDryRunStubScaffold(workflow, path);
    const loaded = await loadDryRunStubs(path);
    const strict = await dryRunWorkflow({
      workflow,
      stubs: loaded,
    });
    const sparse = await dryRunWorkflow({
      workflow,
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
    const directory = temporaryDirectory();
    const path = join(directory, 'stubs.yaml');

    await expect(writeDryRunStubScaffold(workflow, path)).rejects.toThrow(
      'asynchronous output_format schemas are unsupported'
    );
    const sparse = await dryRunWorkflow({
      workflow,
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

  test('holds an authored stub to the contract it stands in for', async () => {
    const workflow = makeTestWorkflow({
      name: 'stub-contract',
      nodes: [
        {
          id: 'certified',
          bash: 'echo hi',
          output_format: {
            type: 'object',
            properties: { pr_url: { type: 'string' } },
            required: ['pr_url'],
          },
        },
      ],
    });

    const missingField = await dryRunWorkflow({
      workflow,
      stubs: { certified: { url: 'https://example.test/pull/1' } },
    });
    expect(missingField.outcome).toBe('failed');
    expect(missingField.trace[0]).toMatchObject({
      nodeId: 'certified',
      state: 'failed',
      reason: expect.stringContaining('does not satisfy its output_format'),
    });

    const notJson = await dryRunWorkflow({
      workflow,
      stubs: { certified: 'https://example.test/pull/1' },
    });
    expect(notJson.outcome).toBe('failed');
    expect(notJson.trace[0]).toMatchObject({
      nodeId: 'certified',
      state: 'failed',
      reason: expect.stringContaining('is not one JSON document'),
    });

    const printed = await dryRunWorkflow({
      workflow,
      stubs: { certified: '{"pr_url":"https://example.test/pull/1"}' },
    });
    expect(printed.outcome).toBe('completed');
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
      stubs,
      defaultStubs: true,
    });
    const strict = await dryRunWorkflow({
      workflow,
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
