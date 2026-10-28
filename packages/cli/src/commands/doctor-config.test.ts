import { describe, it, expect } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { checkConfigFiles, checkProviderDeprecation } from './doctor-config';

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
