import { describe, test, expect, beforeEach, afterAll, spyOn, mock } from 'bun:test';
import * as fsPromises from 'fs/promises';
import * as providers from '@archon/providers';
import * as configLoader from './config-loader';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: () => mockLogger,
}));

import { resolveDefaultAssistant } from './resolve-assistant';

let spyAccess: ReturnType<typeof spyOn>;
let spyProviders: ReturnType<typeof spyOn>;
let spyLoadConfig: ReturnType<typeof spyOn>;

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

beforeEach(() => {
  spyAccess?.mockRestore();
  spyAccess = spyOn(fsPromises, 'access').mockRejectedValue(enoent());

  spyProviders?.mockRestore();
  spyProviders = spyOn(providers, 'getRegisteredProviders').mockReturnValue([]);

  spyLoadConfig?.mockRestore();
  spyLoadConfig = spyOn(configLoader, 'loadConfig').mockResolvedValue({
    assistant: 'claude',
  } as Awaited<ReturnType<typeof configLoader.loadConfig>>);
});

afterAll(() => {
  spyAccess?.mockRestore();
  spyProviders?.mockRestore();
  spyLoadConfig?.mockRestore();
});

describe('resolveDefaultAssistant', () => {
  test('returns codex when .codex folder exists', async () => {
    spyAccess.mockImplementation((p: string) =>
      p.endsWith('.codex') ? Promise.resolve(undefined) : Promise.reject(enoent())
    );

    expect(await resolveDefaultAssistant('/repo')).toBe('codex');
  });

  test('returns claude when .claude folder exists and .codex does not', async () => {
    spyAccess.mockImplementation((p: string) =>
      p.endsWith('.claude') ? Promise.resolve(undefined) : Promise.reject(enoent())
    );

    expect(await resolveDefaultAssistant('/repo')).toBe('claude');
  });

  test('.codex wins over .claude when both folders exist', async () => {
    spyAccess.mockResolvedValue(undefined);

    expect(await resolveDefaultAssistant('/repo')).toBe('codex');
  });

  test('uses configured assistant when no SDK folder exists', async () => {
    spyLoadConfig.mockResolvedValue({ assistant: 'pi' } as Awaited<
      ReturnType<typeof configLoader.loadConfig>
    >);

    expect(await resolveDefaultAssistant('/repo')).toBe('pi');
    // Contract: must pass repoPath so the repo's own .archon/config.yaml is merged.
    expect(spyLoadConfig).toHaveBeenCalledWith('/repo');
  });

  test('falls back to first built-in provider when loadConfig fails and no SDK folder exists', async () => {
    spyLoadConfig.mockRejectedValue(new Error('no config'));
    spyProviders.mockReturnValue([
      { id: 'pi', builtIn: true },
      { id: 'codex', builtIn: true },
    ]);

    expect(await resolveDefaultAssistant('/repo')).toBe('pi');
  });

  test('falls back to claude when loadConfig fails and registry is empty', async () => {
    spyLoadConfig.mockRejectedValue(new Error('no config'));
    spyProviders.mockReturnValue([]);

    expect(await resolveDefaultAssistant('/repo')).toBe('claude');
  });

  test('falls back to claude when config returns no assistant and registry has only community providers', async () => {
    spyLoadConfig.mockResolvedValue({} as Awaited<ReturnType<typeof configLoader.loadConfig>>);
    spyProviders.mockReturnValue([{ id: 'oh-my-pi', builtIn: false }]);

    expect(await resolveDefaultAssistant('/repo')).toBe('claude');
  });

  test('SDK folder detection bypasses config — checked-in .codex wins over configured claude', async () => {
    spyLoadConfig.mockResolvedValue({ assistant: 'claude' } as Awaited<
      ReturnType<typeof configLoader.loadConfig>
    >);
    spyAccess.mockImplementation((p: string) =>
      p.endsWith('.codex') ? Promise.resolve(undefined) : Promise.reject(enoent())
    );

    expect(await resolveDefaultAssistant('/repo')).toBe('codex');
  });
});
