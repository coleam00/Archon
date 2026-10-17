import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Discovery } from '../.archon/workflows/sdlc/validate/scripts/run-checks';

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type SchemaFor<T> = [T] extends [string]
  ? { type: 'string' }
  : [T] extends [(infer Item)[]]
    ? { type: 'array'; items: SchemaFor<Item>; minItems?: number }
    : [T] extends [object]
      ? {
          type: 'object';
          properties: { [K in keyof T]-?: SchemaFor<Required<T>[K]> };
          required: RequiredKeys<T>[];
        }
      : never;

// TypeScript checks the runner side; equality checks the YAML runtime owner.
const discoverySchema = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
          group: { type: 'string' },
        },
        required: ['name', 'argv', 'group'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['checks', 'notes'],
} satisfies SchemaFor<Discovery>;

it('binds the validate discovery schema to the runner input type', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, '../.archon/workflows/sdlc/validate/archon-validate.yaml'),
      'utf8'
    )
  ) as { nodes: { id: string; output_format?: unknown }[] };
  expect(workflow.nodes.find(node => node.id === 'discover')?.output_format).toEqual(
    discoverySchema
  );
});
