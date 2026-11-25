import { describe, expect, test } from 'bun:test';
import {
  safeConfigSchema,
  tierEntrySchema,
  updateAliasesBodySchema,
  updateTiersBodySchema,
} from './config.schemas';
import {
  updateUserAliasesBodySchema,
  updateUserTiersBodySchema,
  userAiPrefsResponseSchema,
} from './user-ai-prefs.schemas';

const safeConfig = {
  botName: 'Archon',
  assistant: 'claude',
  assistants: {},
  streaming: {
    telegram: 'stream',
    discord: 'batch',
    slack: 'batch',
    'matrix-chat': 'stream',
    'other-chat': 'batch',
  },
  concurrency: { maxConversations: 10 },
  defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
} as const;

test('config API retains legacy and new platform streaming keys', () => {
  expect(safeConfigSchema.parse(safeConfig).streaming).toEqual(safeConfig.streaming);
  expect(safeConfigSchema.parse({ ...safeConfig, streaming: {} }).streaming).toEqual({});
});

const entry = { provider: 'claude', model: 'opus', effort: 'high' } as const;

for (const [name, schema, field, key] of [
  ['config tiers', updateTiersBodySchema, 'tiers', 'large'],
  ['config aliases', updateAliasesBodySchema, 'aliases', '@review'],
  ['user tiers', updateUserTiersBodySchema, 'tiers', 'large'],
  ['user aliases', updateUserAliasesBodySchema, 'aliases', '@review'],
] as const) {
  describe(name, () => {
    test('accepts entries, null unsets and sparse updates', () => {
      for (const value of [entry, null]) {
        const body = { [field]: { [key]: value } };
        const parsed: unknown = schema.parse(body);
        expect(parsed).toEqual(body);
      }
      const sparse: unknown = schema.parse({ [field]: {} });
      expect(sparse).toEqual({ [field]: {} });
    });

    test('rejects scalars and invalid entries', () => {
      for (const value of [
        42,
        'opus',
        {},
        { ...entry, provider: '' },
        { ...entry, effort: 'bogus' },
      ]) {
        expect(schema.safeParse({ [field]: { [key]: value } }).success).toBe(false);
      }
    });

    test('retains the retired thinking diagnostic', () => {
      const result = schema.safeParse({
        [field]: { [key]: { ...entry, thinking: 'adaptive' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('effort:');
    });
  });
}

test('read schemas retain nonnullable entries', () => {
  expect(tierEntrySchema.safeParse(null).success).toBe(false);
  for (const field of ['tiers', 'aliases']) {
    const values = { [field]: { [field === 'tiers' ? 'large' : '@review']: null } };
    expect(safeConfigSchema.safeParse({ ...safeConfig, ...values }).success).toBe(false);
    expect(userAiPrefsResponseSchema.safeParse(values).success).toBe(false);
  }
});
