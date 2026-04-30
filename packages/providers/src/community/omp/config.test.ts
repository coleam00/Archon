import { describe, expect, test } from 'bun:test';
import type { OmpProviderDefaults } from '../../types';

import { parseOmpConfig } from './config';

const validOmpConfigInput = {
  model: 'anthropic/claude-sonnet-4-5',
  agentDir: '/tmp/omp-agent',
  enableMCP: false,
  enableLsp: true,
  disableExtensionDiscovery: true,
  additionalExtensionPaths: ['/opt/omp/ext'],
  toolNames: ['read', 'search', 'bash'],
  interactive: false,
  extensionFlags: { plan: true, mode: 'strict' },
  env: { PLANNOTATOR_REMOTE: '1' },
  settings: {
    retry: { enabled: true, maxRetries: 3 },
    compaction: { enabled: false },
    contextPromotion: { enabled: true },
    modelRoles: {
      default: 'anthropic/claude-sonnet-4-5',
      task: 'anthropic/claude-haiku-4-5',
    },
    enabledModels: ['anthropic/*', 'openrouter/qwen/*'],
    modelProviderOrder: ['anthropic', 'openrouter'],
    disabledProviders: ['experimental-provider'],
    disabledExtensions: ['risky-extension'],
  },
} satisfies Record<string, unknown>;

const validOmpConfigOutput = structuredClone(validOmpConfigInput) as OmpProviderDefaults;

describe('parseOmpConfig', () => {
  test('parses approved fields', () => {
    expect(parseOmpConfig(validOmpConfigInput)).toEqual(validOmpConfigOutput);
  });

  test('drops invalid values silently', () => {
    expect(
      parseOmpConfig({
        model: 42,
        agentDir: false,
        enableMCP: 'yes',
        enableLsp: 1,
        disableExtensionDiscovery: null,
        interactive: 'no',
        additionalExtensionPaths: ['/ok', 1, false],
        toolNames: ['read', null, 'bash'],
        extensionFlags: { plan: true, mode: 'strict', attempts: 3, empty: null },
        env: { KEEP: 'yes', DROP: 1 },
        settings: {
          retry: { enabled: 'yes', maxRetries: -1 },
          compaction: { enabled: 'no' },
          contextPromotion: null,
          modelRoles: { default: 'anthropic/claude-sonnet-4-5', bad: false },
          enabledModels: ['anthropic/*', 7],
          modelProviderOrder: [false, 'anthropic'],
          disabledProviders: ['experimental-provider', null],
          disabledExtensions: ['risky-extension', 1],
        },
        futureField: 'ignored',
      })
    ).toEqual({
      additionalExtensionPaths: ['/ok'],
      toolNames: ['read', 'bash'],
      extensionFlags: { plan: true, mode: 'strict' },
      env: { KEEP: 'yes' },
      settings: {
        modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
        enabledModels: ['anthropic/*'],
        modelProviderOrder: ['anthropic'],
        disabledProviders: ['experimental-provider'],
        disabledExtensions: ['risky-extension'],
      },
    });
  });

  test('keeps valid partial nested settings', () => {
    expect(
      parseOmpConfig({
        settings: {
          retry: { enabled: false, maxRetries: 0 },
          compaction: { enabled: true },
        },
      })
    ).toEqual({
      settings: {
        retry: { enabled: false, maxRetries: 0 },
        compaction: { enabled: true },
      },
    });
  });

  test('drops empty arrays, records, and unknown keys', () => {
    expect(
      parseOmpConfig({
        additionalExtensionPaths: [1],
        toolNames: [],
        extensionFlags: { attempts: 3 },
        env: { DROP: 1 },
        settings: {
          retry: { enabled: 'yes' },
          compaction: {},
          contextPromotion: { enabled: 'true' },
          modelRoles: { bad: false },
          enabledModels: [],
          modelProviderOrder: [false],
          disabledProviders: [],
          disabledExtensions: [1],
        },
        x: 'y',
      })
    ).toEqual({});
  });
});
