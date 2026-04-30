import { describe, expect, test } from 'bun:test';

import { parseOmpConfig } from './config';

describe('parseOmpConfig', () => {
  test('parses approved fields', () => {
    expect(
      parseOmpConfig({
        model: 'anthropic/claude-sonnet-4-5',
        agentDir: '/tmp/omp-agent',
        enableMCP: false,
        enableLsp: true,
        disableExtensionDiscovery: true,
        additionalExtensionPaths: ['/opt/omp/ext'],
        toolNames: ['read', 'search', 'bash'],
      })
    ).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      agentDir: '/tmp/omp-agent',
      enableMCP: false,
      enableLsp: true,
      disableExtensionDiscovery: true,
      additionalExtensionPaths: ['/opt/omp/ext'],
      toolNames: ['read', 'search', 'bash'],
    });
  });

  test('drops invalid values silently', () => {
    expect(
      parseOmpConfig({
        model: 42,
        agentDir: false,
        enableMCP: 'yes',
        enableLsp: 1,
        disableExtensionDiscovery: null,
        additionalExtensionPaths: ['/ok', 1, false],
        toolNames: ['read', null, 'bash'],
        futureField: 'ignored',
      })
    ).toEqual({
      additionalExtensionPaths: ['/ok'],
      toolNames: ['read', 'bash'],
    });
  });

  test('drops empty arrays and unknown keys', () => {
    expect(parseOmpConfig({ additionalExtensionPaths: [1], toolNames: [], x: 'y' })).toEqual({});
  });
});
