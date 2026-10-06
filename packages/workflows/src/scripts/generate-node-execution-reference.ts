#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  nodeExecutionRecordSchema,
  nodeExecutionMetadataSchema,
  nodeCacheRecordSchema,
} from '../schemas/node-execution';
import { serializedNodeDataSchema } from '../node-record-serialization';

export const referencePath = resolve(
  import.meta.dir,
  '../../../docs-web/src/content/docs/reference/node-execution.md'
);
const BEGIN = '<!-- BEGIN GENERATED NODE EXECUTION TABLES -->';
const END = '<!-- END GENERATED NODE EXECUTION TABLES -->';
type JsonSchema = z.core.JSONSchema.JSONSchema;
type Row = [string, string, string, string];

function schemaObject(schema: JsonSchema | boolean): JsonSchema {
  if (typeof schema === 'boolean') {
    if (schema) return {};
    throw new Error('Unsupported false schema');
  }
  return schema;
}

function fieldType(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) return [...new Set(alternatives.map(fieldType))].join(' | ');
  if (schema.type === 'array') {
    if (!schema.items || Array.isArray(schema.items)) throw new Error('Unsupported array items');
    return `array<${fieldType(schemaObject(schema.items))}>`;
  }
  return schema.type ?? 'unknown';
}

function walk(
  schema: JsonSchema,
  path: string,
  presence: string,
  condition: string,
  rows: Row[]
): void {
  for (const keyword of [
    '$ref',
    '$defs',
    'allOf',
    'not',
    'if',
    'prefixItems',
    'patternProperties',
  ]) {
    if (keyword in schema)
      throw new Error(`Unsupported JSON Schema construct: ${keyword} at ${path}`);
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    for (const [index, alternative] of alternatives.entries()) {
      const discriminants = Object.entries(alternative.properties ?? {})
        .filter(([, value]) => typeof value !== 'boolean' && value.const !== undefined)
        .map(([key, value]) => `${path}.${key} = ${fieldType(schemaObject(value))}`);
      const branch = discriminants.join(', ') || `${path} alternative ${String(index + 1)}`;
      walk(alternative, path, presence, [condition, branch].filter(Boolean).join('; '), rows);
    }
    return;
  }
  if (path) rows.push([path, fieldType(schema), presence, condition || '—']);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    walk(
      schemaObject(property),
      path ? `${path}.${key}` : key,
      schema.required?.includes(key) ? 'required' : 'optional',
      condition,
      rows
    );
  }
  if (schema.type === 'array') {
    if (!schema.items || Array.isArray(schema.items)) throw new Error('Unsupported array items');
    walk(schemaObject(schema.items), `${path}[]`, 'item', condition, rows);
  }
  if (typeof schema.additionalProperties === 'object') {
    walk(schema.additionalProperties, `${path}.*`, 'entry', condition, rows);
  }
}

function table(rows: Row[]): string {
  const cells = [
    ['Field path', 'Type / values', 'Presence', 'Alternative'],
    ...rows.map(([path, type, presence, condition]) => [
      `\`${path}\``,
      `\`${type}\``,
      presence,
      condition === '—' ? condition : `\`${condition}\``,
    ]),
  ].map(row => row.map(cell => cell.replaceAll('|', '\\|').replaceAll('\n', ' ')));
  const widths = cells[0].map((_, index) => Math.max(3, ...cells.map(row => row[index].length)));
  const line = (row: string[]): string =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;
  return [
    line(cells[0]),
    line(widths.map(width => '-'.repeat(width))),
    ...cells.slice(1).map(line),
  ].join('\n');
}

export function renderSchemaTable(schema: z.ZodType, grouped = false): string {
  const rows: Row[] = [];
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' });
  walk(json, '', 'required', '', rows);
  if (!grouped) return table(rows);
  return Object.keys(json.properties ?? {})
    .map(key => {
      const fields = rows.filter(
        ([path]) => path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[]`)
      );
      return [`#### ${key}`, '', table(fields)].join('\n');
    })
    .join('\n\n');
}

export function renderReferenceTables(): string {
  const schemas = {
    'Execution record': nodeExecutionRecordSchema,
    'Execution metadata': nodeExecutionMetadataSchema,
    'Cache record': nodeCacheRecordSchema,
    'Persisted event data': serializedNodeDataSchema,
  };
  return [
    BEGIN,
    '',
    'Generated from the owning Zod schemas with `z.toJSONSchema` (input mode). Regenerate with `bun run generate:node-execution-reference`; verify with `bun run check:node-execution-reference`. The workflows conformance test enforces this block in the repository test suite.',
    '',
    'Presence is relative to the containing object: a required child of an optional parent exists only when that parent exists. Array items use `[]`; union rows state their alternative. `unknown` is unconstrained data. These tables describe fields and alternatives, not every validation constraint.',
    '',
    ...Object.entries(schemas).flatMap(([title, schema]) => [
      `### ${title}`,
      '',
      renderSchemaTable(schema, title === 'Execution record' || title === 'Execution metadata'),
      '',
    ]),
    END,
  ].join('\n');
}

export function updateReference(contents: string): string {
  const normalized = contents.replaceAll('\r\n', '\n');
  if (normalized.split(BEGIN).length !== 2 || normalized.split(END).length !== 2) {
    throw new Error('Expected exactly one generated table marker pair');
  }
  const start = normalized.indexOf(BEGIN);
  const end = normalized.indexOf(END);
  if (end < start) throw new Error('Generated table markers are reversed');
  return normalized.slice(0, start) + renderReferenceTables() + normalized.slice(end + END.length);
}

export async function generateReference(path = referencePath, check = false): Promise<void> {
  const current = await readFile(path, 'utf8');
  const next = updateReference(current);
  if (check) {
    if (current.replaceAll('\r\n', '\n') !== next) {
      throw new Error(
        'Node execution reference is stale. Run: bun run generate:node-execution-reference'
      );
    }
  } else {
    await writeFile(path, next, 'utf8');
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    throw new Error('Usage: generate-node-execution-reference.ts [--check]');
  }
  await generateReference(referencePath, args.includes('--check'));
}
