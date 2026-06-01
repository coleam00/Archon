import { describe, expect, test } from 'bun:test';

import { parseKiroConfig } from './config';

describe('parseKiroConfig', () => {
  test('keeps valid Kiro CLI defaults', () => {
    expect(
      parseKiroConfig({
        model: 'auto',
        binaryPath: '/usr/local/bin/kiro-cli',
        agent: 'architect',
        trustAllTools: true,
        trustTools: ['fs_read', 'fs_write'],
        requireMcpStartup: true,
        additionalArgs: ['--verbose'],
      })
    ).toEqual({
      model: 'auto',
      binaryPath: '/usr/local/bin/kiro-cli',
      agent: 'architect',
      trustAllTools: true,
      trustTools: ['fs_read', 'fs_write'],
      requireMcpStartup: true,
      additionalArgs: ['--verbose'],
    });
  });

  test('drops invalid fields defensively', () => {
    expect(
      parseKiroConfig({
        model: 42,
        trustAllTools: 'yes',
        trustTools: ['fs_read', 123],
        additionalArgs: [false],
      })
    ).toEqual({ trustTools: ['fs_read'] });
  });
});
