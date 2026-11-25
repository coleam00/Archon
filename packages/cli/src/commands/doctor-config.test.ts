import { describe, it, expect } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { checkConfigFiles, checkCwdEnvIsolation, checkProviderDeprecation } from './doctor-config';

const trackTempRoot = trackTempRoots();
const tempRepo = (): string => trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-doctor-cwd-env-')));

describe('checkConfigFiles', () => {
  it('passes and names the resolved default assistant', async () => {
    const result = await checkConfigFiles('/repo', async () => ({ assistant: 'codex' }));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('codex');
  });

  it('fails with the loader message when assistants config is invalid', async () => {
    const result = await checkConfigFiles('/repo', async () => {
      throw new Error(
        "Invalid assistants config in '/repo/.archon/config.yaml': " +
          "'assistants.codex.modelReasoningEffort': expected minimal, low, medium, high, xhigh, max."
      );
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('assistants.codex.modelReasoningEffort');
  });
});

describe('checkProviderDeprecation', () => {
  it('warns with the registry notice when the default assistant is deprecated', async () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    const result = await checkProviderDeprecation('/repo', async () => ({ assistant: 'copilot' }));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Copilot is deprecated');
  });

  it('passes when the default assistant carries no notice', async () => {
    registerBuiltinProviders();
    const result = await checkProviderDeprecation('/repo', async () => ({ assistant: 'claude' }));
    expect(result.status).toBe('pass');
  });

  it('skips when the config does not load, leaving the failure to Config files', async () => {
    const result = await checkProviderDeprecation('/repo', async () => {
      throw new Error('bad config');
    });
    expect(result.status).toBe('skip');
  });
});

describe('checkCwdEnvIsolation', () => {
  it('names the stripped keys and files, never their values', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, '.env'), 'SECRET_KEY=value123\nOTHER_KEY=value456\n');
    writeFileSync(join(repo, '.env.local'), 'LOCAL_KEY=value789\n');
    const result = checkCwdEnvIsolation(repo);
    expect(result).toEqual({
      label: 'Target repo .env',
      status: 'pass',
      message:
        `3 keys from ${join(repo, '.env')}, ${join(repo, '.env.local')} are kept out of runs, ` +
        "so the target repo's secrets cannot reach Archon's processes: LOCAL_KEY, OTHER_KEY, SECRET_KEY",
    });
    expect(result.message).not.toContain('value');
  });

  it('skips a folder without .env keys', () => {
    const repo = tempRepo();
    expect(checkCwdEnvIsolation(repo).status).toBe('skip');
  });
});
