import { expect, expectTypeOf, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Closure } from '../../workflows/sdlc/.shared/close';

type SchemaValue<S> =
  S extends { anyOf: readonly (infer V)[] } ? SchemaValue<V> :
  S extends { enum: readonly (infer V)[] } ? V :
  S extends { type: 'object'; properties: infer P; required: readonly (infer K)[] }
    ? { readonly [Key in keyof P as Key extends K ? Key : never]: SchemaValue<P[Key]> } :
  S extends { type: 'string' } ? string :
  S extends { type: 'integer' } ? number :
  never;

const closureSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['duplicate'] },
        url: { type: 'string', pattern: '\\S' },
        original: {
          type: 'object',
          additionalProperties: false,
          properties: {
            repo: {
              type: 'object',
              additionalProperties: false,
              properties: {
                host: { type: 'string', pattern: '\\S' },
                path: { type: 'string', pattern: '\\S' },
              },
              required: ['host', 'path'],
            },
            number: { type: 'integer', minimum: 1 },
          },
          required: ['repo', 'number'],
        },
      },
      required: ['kind', 'url', 'original'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['delivered'] },
        url: { type: 'string', pattern: '\\S' },
      },
      required: ['kind', 'url'],
    },
  ],
} as const;

test('triage decision and verdict closure schemas conform to the closure reader type', () => {
  expectTypeOf<SchemaValue<typeof closureSchema>>().toEqualTypeOf<Closure>();
  const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../workflows/sdlc/triage/archon-triage.yaml'), 'utf8')) as {
    nodes: { id: string; output_format: { properties: Record<string, { anyOf: unknown[] }> } }[];
  };
  const triage = workflow.nodes.find(node => node.id === 'triage')!;
  const decision = triage.output_format.properties.decision.anyOf as { properties: { contract: { enum: string[] }; closure?: unknown } }[];
  const noAction = decision.find(option => option.properties.contract.enum.includes('NO_ACTION'))!;
  expect(noAction.properties.closure).toEqual(closureSchema);
  const verdict = workflow.nodes.find(node => node.id === 'verdict')!;
  expect(verdict.output_format.properties.closure).toEqual({ anyOf: [{ type: 'null' }, ...closureSchema.anyOf] });
});
