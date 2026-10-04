import { expect, test } from 'bun:test';
import { safeConfigSchema } from './config.schemas';
import { platformStreamingSchema } from '@archon/core/config';

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
  defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
} as const;

test('config API retains legacy and new platform streaming keys', () => {
  expect(safeConfigSchema.parse(safeConfig).streaming).toEqual(safeConfig.streaming);
  expect(safeConfigSchema.parse({ ...safeConfig, streaming: {} }).streaming).toEqual({});
});

test('API streaming validation derives from the owning shared schema', () => {
  for (const streaming of [
    { 'matrix-chat': 'invalid' },
    { Matrix: 'stream' },
    { 'matrix-chat': 'batch' },
  ]) {
    expect(safeConfigSchema.safeParse({ ...safeConfig, streaming }).success).toBe(
      platformStreamingSchema.safeParse(streaming).success
    );
  }
});
