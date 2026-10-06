import { expect, test } from 'bun:test';
import Ajv from 'ajv/dist/2020';
import { providerChunkSchema, type ProviderChunk } from '@archon/provider-contract';
import contract from '../../../provider-contract/schema/provider-contract.schema.json';

const validate = new Ajv({ strict: false }).compile({
  ...contract,
  $ref: '#/$defs/ProviderChunk',
});

test.each(
  ['text', 0, false, null, ['a', 1], { nested: { values: [null, false] } }].map(
    value => [value] as const
  )
)('published schema and runtime preserve JSON tool input %j', rawInput => {
  const event = {
    type: 'tool_call',
    toolCallId: 't1',
    name: 'tool',
    rawInput,
  } satisfies ProviderChunk;
  expect(providerChunkSchema.parse(event)).toEqual(event);
  expect(validate(event)).toBe(true);
});
