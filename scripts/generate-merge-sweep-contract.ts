import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SOURCE = '.archon/workflows/sdlc/merge-queue/archon-merge-queue.yaml';
const OUTPUT = '.archon/workflows/sdlc/.shared/merge-sweep.generated.ts';
const REGENERATE = 'bun run generate:merge-sweep-contract';

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${path}: expected a string array`);
  }
  return value;
}

export function sweepSchema(workflow: unknown): unknown {
  const nodes = object(workflow, 'workflow').nodes;
  if (!Array.isArray(nodes)) throw new Error('workflow.nodes: expected an array');
  const sweeps = nodes
    .map((node, index) => object(node, `nodes[${index}]`))
    .filter(node => node.id === 'sweep');
  if (sweeps.length !== 1 || sweeps[0]?.output_format === undefined) {
    throw new Error('expected exactly one sweep node with output_format');
  }
  return sweeps[0].output_format;
}

const CONSTRAINTS: Record<string, readonly string[]> = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
  string: ['enum', 'pattern', 'minLength', 'maxLength'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  boolean: [],
  null: [],
};

function schemaTypes(schema: Record<string, unknown>, path: string): string[] {
  const types =
    typeof schema.type === 'string' ? [schema.type] : strings(schema.type, `${path}.type`);
  if (types.length === 0 || new Set(types).size !== types.length) {
    throw new Error(`${path}.type: expected distinct types`);
  }
  const nonNull = types.filter(type => type !== 'null');
  if (nonNull.length > 1) throw new Error(`${path}.type: only nullable type unions are supported`);
  const type = nonNull[0] ?? 'null';
  const allowed = Object.hasOwn(CONSTRAINTS, type) ? CONSTRAINTS[type] : undefined;
  if (allowed === undefined) throw new Error(`${path}.type: unsupported type ${type}`);
  for (const key of Object.keys(schema)) {
    if (!['type', 'title', 'description', '$comment', ...allowed].includes(key)) {
      throw new Error(`${path}.${key}: unsupported schema keyword`);
    }
  }
  return types;
}

function emitObject(schema: Record<string, unknown>, path: string): string {
  const properties = object(schema.properties, `${path}.properties`);
  const required = strings(schema.required ?? [], `${path}.required`);
  for (const key of required) {
    if (!Object.hasOwn(properties, key))
      throw new Error(`${path}.required: unknown property ${key}`);
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  ) {
    throw new Error(`${path}.additionalProperties: schema-valued properties are unsupported`);
  }
  const fields = Object.entries(properties).map(([key, child]) => {
    const childType = emitType(child, `${path}.properties.${key}`).replaceAll('\n', '\n  ');
    return `  readonly ${JSON.stringify(key)}${required.includes(key) ? '' : '?'}: ${childType};`;
  });
  return `{\n${fields.join('\n')}\n}`;
}

function emitString(schema: Record<string, unknown>, path: string): string {
  if (schema.enum === undefined) return 'string';
  const values = strings(schema.enum, `${path}.enum`);
  if (values.length === 0) throw new Error(`${path}.enum: expected at least one value`);
  return values.map(value => JSON.stringify(value)).join(' | ');
}

/** Only the schema forms used by this contract are supported; new forms need an explicit translation. */
export function emitType(value: unknown, path = 'sweep.output_format'): string {
  const schema = object(value, path);
  const types = schemaTypes(schema, path);
  const type = types.find(type => type !== 'null') ?? 'null';
  let result: string;
  switch (type) {
    case 'object':
      result = emitObject(schema, path);
      break;
    case 'array':
      result = `ReadonlyArray<${emitType(schema.items, `${path}.items`)}>`;
      break;
    case 'string':
      result = emitString(schema, path);
      break;
    case 'integer':
    case 'number':
      result = 'number';
      break;
    default:
      result = type;
  }
  return types.includes('null') && type !== 'null' && schema.enum === undefined
    ? `${result} | null`
    : result;
}

function enumAt(schema: unknown, ...keys: string[]): string {
  let value = schema;
  for (const key of keys) value = object(value, keys.join('.'))[key];
  const values = strings(object(value, keys.join('.')).enum, `${keys.join('.')}.enum`);
  return `${JSON.stringify(values)} as const`;
}

export function generateContract(schema: unknown): string {
  const declaration = emitType(schema);
  const decision = ['properties', 'decisions', 'items'];
  const attention = [
    'properties',
    'attention',
    'properties',
    'choices',
    'items',
    'properties',
    'effect',
  ];
  const digest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
  return [
    `// Generated from ${SOURCE}, node sweep.`,
    `// Regenerate: ${REGENERATE}`,
    `// Schema SHA-256: ${digest}`,
    "import { nullableJson } from './io.ts';",
    '',
    `export type Sweep = ${declaration};`,
    "export type SweepDecision = Sweep['decisions'][number];",
    "export type MergeAttention = NonNullable<SweepDecision['attention']>;",
    "export type BaseAttention = NonNullable<Sweep['base']['attention']>;",
    "export type SweepAction = SweepDecision['action'];",
    "export type PolicyClass = SweepDecision['class'];",
    "export type MergeEffect = MergeAttention['choices'][number]['effect'];",
    `export const SWEEP_ACTIONS = ${enumAt(schema, ...decision, 'properties', 'action')};`,
    `export const POLICY_CLASSES = ${enumAt(schema, ...decision, 'properties', 'class')};`,
    `export const MERGE_EFFECTS = ${enumAt(schema, ...decision, ...attention)};`,
    `export const BASE_EFFECTS = ${enumAt(schema, 'properties', 'base', ...attention)};`,
    '',
    '/** Reads the engine-certified whole sweep output, or null when the sweep was skipped. */',
    'export function readSweep(value: string | undefined): Sweep | null {',
    '  return nullableJson(value) as Sweep | null;',
    '}',
    '',
  ].join('\n');
}

export async function writeContract(
  output: string,
  contents: string,
  check: boolean
): Promise<void> {
  if (!check) {
    await writeFile(output, contents, 'utf8');
    return;
  }
  let existing: string | undefined;
  try {
    existing = await readFile(output, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (existing !== contents) throw new Error(`${output} is missing or stale. Run: ${REGENERATE}`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const workflow: unknown = Bun.YAML.parse(await readFile(resolve(root, SOURCE), 'utf8'));
  await writeContract(
    resolve(root, OUTPUT),
    generateContract(sweepSchema(workflow)),
    process.argv.includes('--check')
  );
}
