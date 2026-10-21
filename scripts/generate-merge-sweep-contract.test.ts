import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import ts from 'typescript';
import {
  emitType,
  generateContract,
  sweepSchema,
  writeContract,
} from '../.archon/workflows/sdlc/.shared/generate-merge-sweep-contract.ts';

const track = trackTempRoots();

function diagnostics(source: string): string[] {
  const file = resolve('synthetic-merge-contract.ts');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) =>
    name === file
      ? ts.createSourceFile(name, source, version, true)
      : getSourceFile(name, version, onError, fresh);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([file], options, host))
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

function fixture() {
  const attention = {
    type: ['object', 'null'],
    properties: {
      choices: {
        type: 'array',
        items: {
          type: 'object',
          properties: { effect: { type: 'string', enum: ['hold'] }, detail: { type: 'string' } },
          required: ['effect'],
        },
      },
    },
    required: ['choices'],
  };
  return {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['wait', 'ask'] },
            class: { type: 'string', enum: ['clear'] },
            attention: structuredClone(attention),
          },
          required: ['action', 'class', 'attention'],
        },
      },
      base: { type: 'object', properties: { attention }, required: ['attention'] },
    },
    required: ['decisions', 'base'],
  };
}

describe('merge sweep contract generation', () => {
  test('a copied pack checks and regenerates its own customized contract from any working directory', async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'copied-sweep-')));
    const pack = join(root, 'custom pack');
    await cp(resolve(import.meta.dir, '../.archon/workflows/sdlc'), pack, { recursive: true });
    const generator = join(pack, '.shared/generate-merge-sweep-contract.ts');
    const output = join(pack, '.shared/merge-sweep.generated.ts');
    const source = join(pack, 'merge-queue/archon-merge-queue.yaml');
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, generator, ...args], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    expect(run('--check').exitCode).toBe(0);
    await writeFile(
      source,
      Bun.YAML.stringify({
        nodes: [{ id: 'sweep', output_format: fixture() }],
      })
    );
    const stale = run('--check');
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr.toString()).toContain('missing or stale');
    expect(run().exitCode).toBe(0);
    expect(await readFile(output, 'utf8')).toBe(generateContract(fixture()));
    expect(run('--check').exitCode).toBe(0);
    await writeFile(output, `${await readFile(output, 'utf8')}\n// manual edit\n`);
    expect(run('--check').exitCode).not.toBe(0);
    expect(run().exitCode).toBe(0);
    expect(run('--check').exitCode).toBe(0);
  });

  test('types required, optional, nullable and nested values, including readonly arrays and enums', () => {
    const declaration = emitType({
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1 },
        optional: { type: 'number' },
        nothing: { type: 'null' },
        nullableText: { type: ['string', 'null'] },
        nullableEnum: { type: ['string', 'null'], enum: ['yes', 'no'] },
        nested: {
          type: ['object', 'null'],
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  label: { type: 'string', enum: ['yes', 'no'] },
                },
                required: ['ok', 'label'],
              },
            },
          },
          required: ['rows'],
        },
      },
      required: ['count', 'nothing', 'nested'],
    });
    expect(
      diagnostics(`type Value = ${declaration};
const valid: Value = { count: 1, nothing: null, nested: { rows: [{ ok: true, label: 'yes' }] } };
const nullable: Value = { count: 1, nothing: null, nested: null };
const optional: Value = { ...valid, optional: 2, nullableText: null, nullableEnum: 'yes' };
// @ts-expect-error enum excludes null even if type allows it
const enumNull: Value = { ...valid, nullableEnum: null };
// @ts-expect-error required property omitted
const missing: Value = { nothing: null, nested: null };
// @ts-expect-error count is non-nullable
const badNull: Value = { ...valid, count: null };
// @ts-expect-error nested array member is checked
const badNested: Value = { ...valid, nested: { rows: [{ ok: 'true', label: 'yes' }] } };
// @ts-expect-error enum is checked
const badEnum: Value = { ...valid, nested: { rows: [{ ok: true, label: 'maybe' }] } };
// @ts-expect-error nested required field is checked
const missingNested: Value = { ...valid, nested: {} };
// @ts-expect-error property is readonly
valid.count = 2;
if (valid.nested) {
  // @ts-expect-error array is readonly
  valid.nested.rows.push({ ok: true, label: 'no' });
}
`)
    ).toEqual([]);
  });

  test('generated aliases and reader compile with the schema-derived shape', () => {
    const generated = generateContract(fixture()).replace(
      "import { nullableJson } from './io.ts';",
      'declare function nullableJson(value: string | undefined): unknown;'
    );
    expect(
      diagnostics(`${generated}
const decision: SweepDecision = { action: 'wait', class: 'clear', attention: null };
const sweep: Sweep = { decisions: [decision], base: { attention: { choices: [{ effect: 'hold' }] } } };
const read: Sweep | null = readSweep(JSON.stringify(sweep));
const merge: MergeAttention = { choices: [{ effect: MERGE_EFFECTS[0] }] };
const base: BaseAttention = { choices: [{ effect: BASE_EFFECTS[0] }] };
const action: SweepAction = SWEEP_ACTIONS[0];
const policy: PolicyClass = POLICY_CLASSES[0];
const effect: MergeEffect = 'hold';
// @ts-expect-error required field cannot be omitted
const missing: Sweep = { base: { attention: null } };
// @ts-expect-error array cannot be null
const nullable: Sweep = { ...sweep, decisions: null };
// @ts-expect-error nested choice effect is checked
const nested: BaseAttention = { choices: [{ effect: 'other' }] };
`)
    ).toEqual([]);
  });

  test.each([
    { type: 'string', oneOf: [{ type: 'string' }] },
    { type: 'object', properties: {}, patternProperties: {} },
    { type: 'array', items: { type: 'string' }, prefixItems: [] },
    { type: 'string', const: 'fixed' },
    { type: 'string', $ref: '#/other' },
    { type: ['string', 'number'] },
    { type: 'unknown' },
    { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
  ])('rejects unsupported type-affecting constructs: %j', schema => {
    expect(() => emitType({ type: 'object', properties: { child: schema } })).toThrow(
      'sweep.output_format.properties.child'
    );
  });

  test('rejects malformed supported forms instead of emitting a wider type', () => {
    for (const schema of [
      { type: 'string', enum: [] },
      { type: 'string', enum: [1] },
      { type: 'array' },
      { type: 'object', properties: {}, required: ['missing'] },
      { type: ['null', 'null'] },
    ])
      expect(() => emitType(schema)).toThrow();
  });

  test('selects the sweep schema and rejects a missing or ambiguous owner', () => {
    const schema = fixture();
    expect(
      sweepSchema({ nodes: [{ id: 'other' }, { id: 'sweep', output_format: schema }] })
    ).toEqual(schema);
    for (const workflow of [
      {},
      { nodes: [] },
      { nodes: [{ id: 'sweep' }] },
      { nodes: [{ id: 'sweep' }, { id: 'sweep' }] },
    ]) {
      expect(() => sweepSchema(workflow)).toThrow();
    }
  });

  test('schema-only mutations fail freshness, regenerate deterministically and change consumer types', async () => {
    const output = join(track(await mkdtemp(join(tmpdir(), 'merge-contract-'))), 'contract.ts');
    const original = fixture();
    const contents = generateContract(original);
    await expect(writeContract(output, contents, true)).rejects.toThrow('missing or stale');
    await writeContract(output, contents, false);
    await writeContract(output, contents, true);
    const mutations = [
      (schema: ReturnType<typeof fixture>) => {
        schema.required = ['base'];
      },
      (schema: ReturnType<typeof fixture>) => {
        schema.properties.base.properties.attention.type = ['object'];
      },
      (schema: ReturnType<typeof fixture>) => {
        schema.properties.decisions.items.properties.action.enum.push('return');
      },
      (schema: ReturnType<typeof fixture>) => {
        schema.properties.base.properties.attention.properties.choices.items.properties.detail.type =
          'boolean';
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      const generated = generateContract(changed);
      expect(emitType(changed)).not.toBe(emitType(original));
      await expect(writeContract(output, generated, true)).rejects.toThrow('missing or stale');
      await writeContract(output, generated, false);
      await writeContract(output, generateContract(changed), true);
      await writeContract(output, contents, false);
    }
    await writeFile(output, `${contents}\n// manual edit\n`);
    await expect(writeContract(output, contents, true)).rejects.toThrow('missing or stale');
    await writeContract(output, contents, false);
    await writeContract(output, contents, false);
    expect(await readFile(output, 'utf8')).toBe(contents);
    await writeContract(output, contents, true);
  });

  test('validation-only changes invalidate freshness even when the TypeScript shape is unchanged', async () => {
    const schema = fixture();
    const constrained = {
      ...schema,
      properties: { ...schema.properties, extra: { type: 'string', pattern: '\\S' } },
    };
    const changed = structuredClone(constrained);
    changed.properties.extra.pattern = '^ok$';
    expect(emitType(changed)).toBe(emitType(constrained));
    const output = join(track(await mkdtemp(join(tmpdir(), 'merge-contract-'))), 'contract.ts');
    await writeContract(output, generateContract(constrained), false);
    await expect(writeContract(output, generateContract(changed), true)).rejects.toThrow(
      'missing or stale'
    );
  });
});
