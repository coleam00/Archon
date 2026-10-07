import { expect, test } from 'bun:test';
import { z } from 'zod';
import document from '../../schema/provider-contract.schema.json';
import { credentialSpecSchema } from '../registration';
import { descriptor } from './fixtures/provider';
import { promptRequestSchema } from './wire';

function publishedSchema(name: string): z.ZodType {
  // JSON imports widen literal schema keywords such as type to string.
  return z.fromJSONSchema({
    ...document,
    $ref: `#/$defs/${name}`,
  } as unknown as z.core.JSONSchema.BaseSchema);
}

test.each(Object.keys(document.$defs))('published %s resolves its references', name => {
  expect(() => publishedSchema(name)).not.toThrow();
});

test('published descriptor accepts nested JSON config values', () => {
  const schema = publishedSchema('ProviderPluginDescriptor');
  expect(
    schema.safeParse({
      ...descriptor,
      configSchema: { nested: { values: [null, true, 1, 'text', { type: 'object' }] } },
    }).success
  ).toBe(true);
});

test('published credential kinds enforce the same non-empty list as the owner', () => {
  expect(document.$defs.CredentialSpec.properties.kinds).toMatchObject({ minItems: 1 });
  const schema = publishedSchema('CredentialSpec');
  for (const kinds of [[], ['api_key'], ['subscription', 'ambient'], ['invalid']]) {
    const value = { vendor: 'vendor', displayName: 'Vendor', kinds };
    expect(schema.safeParse(value).success).toBe(credentialSpecSchema.safeParse(value).success);
  }
});

test('published prompt request enforces the same single text block as the owner', () => {
  expect(document.$defs.ProviderPromptRequest.properties.prompt).toMatchObject({
    minItems: 1,
    maxItems: 1,
  });
  const schema = publishedSchema('ProviderPromptRequest');
  const text = { type: 'text', text: 'prompt' };
  for (const prompt of [[], [text], [text, text]]) {
    const value = { sessionId: 'session', prompt };
    expect(schema.safeParse(value).success).toBe(promptRequestSchema.safeParse(value).success);
  }
});

test('JSON Schema conversion preserves unknown keys without additionalProperties: false', () => {
  const schema = z.fromJSONSchema({ type: 'object', properties: { model: { type: 'string' } } });
  expect(schema.parse({ model: 'model', secret: 'private' })).toEqual({
    model: 'model',
    secret: 'private',
  });
});
