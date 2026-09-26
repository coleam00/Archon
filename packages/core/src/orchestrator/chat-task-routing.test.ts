import { describe, expect, test } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import type { ChatTaskRoute } from '../config/chat-task-routing';
import {
  getProviderCredentialScope,
  hasDirectChatCredential,
  selectChatTaskRoute,
} from './chat-task-routing';

registerBuiltinProviders();
registerCommunityProviders();

describe('selectChatTaskRoute', () => {
  const route: ChatTaskRoute = { primary: 'large', fallbacks: ['@alternate', 'small'] };

  test('uses the configured primary while it is ready', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      () => 'ready'
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: { reference: 'large', request: 'large', kind: 'primary' },
    });
  });

  test('uses the first eligible configured fallback only after primary cooldown', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference) => (reference === 'large' ? 'cooldown' : 'ready')
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: {
        reference: '@alternate',
        request: '@alternate',
        kind: 'cooldown-fallback',
      },
    });
  });

  test('uses the first eligible configured fallback after a provider usage warning', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference) => (reference === 'large' ? 'usage-warning' : 'ready')
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: {
        reference: '@alternate',
        request: '@alternate',
        kind: 'usage-warning-fallback',
      },
    });
  });

  test('uses the first eligible configured fallback after an exhausted Copilot meter', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference, kind) =>
        reference === 'large' ? 'quota-exhausted' : kind === 'fallback' ? 'ready' : 'ready'
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: {
        reference: '@alternate',
        request: '@alternate',
        kind: 'copilot-quota-fallback',
      },
    });
  });

  test('uses the first eligible configured fallback after an exhausted Codex bucket', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference) => (reference === 'large' ? 'codex-rate-limit-exhausted' : 'ready')
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: {
        reference: '@alternate',
        request: '@alternate',
        kind: 'codex-rate-limit-fallback',
      },
    });
  });

  test('keeps the primary when provider usage is unknown', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      () => 'ready'
    );

    expect(result).toEqual({
      kind: 'selected',
      selection: { reference: 'large', request: 'large', kind: 'primary' },
    });
  });

  test('does not choose a fallback when Copilot quota is exhausted and none is eligible', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference) => (reference === 'large' ? 'quota-exhausted' : 'unusable')
    );

    expect(result).toEqual({ kind: 'no-usable-fallback', reference: 'large' });
  });

  test('reports the exact provider-native exhausted state when there is no fallback', () => {
    expect(
      selectChatTaskRoute(
        { primary: 'copilot-primary' },
        reference => reference,
        () => 'quota-exhausted'
      )
    ).toEqual({ kind: 'copilot-quota-exhausted-without-fallback', reference: 'copilot-primary' });
    expect(
      selectChatTaskRoute(
        { primary: 'codex-primary' },
        reference => reference,
        () => 'codex-rate-limit-exhausted'
      )
    ).toEqual({
      kind: 'codex-rate-limit-exhausted-without-fallback',
      reference: 'codex-primary',
    });
  });

  test('does not use fallbacks when the primary is unconfigured or unusable', () => {
    const result = selectChatTaskRoute(
      route,
      reference => (reference === 'large' ? undefined : reference),
      () => 'ready'
    );

    expect(result).toEqual({ kind: 'primary-unusable', reference: 'large' });
  });

  test('reports when every explicit fallback is unavailable', () => {
    const result = selectChatTaskRoute(
      route,
      reference => reference,
      (_request, reference) => (reference === 'large' ? 'cooldown' : 'unusable')
    );

    expect(result).toEqual({ kind: 'no-usable-fallback', reference: 'large' });
  });
});

describe('hasDirectChatCredential', () => {
  test('only accepts credentials delivered to this user in per-user mode', () => {
    expect(
      hasDirectChatCredential('codex', { OPENAI_API_KEY: 'user-key' }, true, {
        OPENAI_API_KEY: 'install-key',
      })
    ).toBe(true);
    expect(hasDirectChatCredential('codex', {}, true, { OPENAI_API_KEY: 'install-key' })).toBe(
      false
    );
  });

  test('does not treat Codex auth.json delivery as direct-chat credentials', () => {
    expect(hasDirectChatCredential('codex', { CODEX_HOME: '/tmp/user-codex' }, true, {})).toBe(
      false
    );
  });

  test('counts generic GitHub tokens for Copilot only when provider config opts in', () => {
    expect(hasDirectChatCredential('copilot', { GH_TOKEN: 'actor-token' }, true, {})).toBe(false);
    expect(
      hasDirectChatCredential(
        'copilot',
        { GH_TOKEN: 'actor-token' },
        true,
        { GH_TOKEN: 'install-token' },
        { useLoggedInUser: false }
      )
    ).toBe(true);
    expect(
      hasDirectChatCredential(
        'copilot',
        {},
        true,
        { GH_TOKEN: 'install-token' },
        {
          useLoggedInUser: false,
        }
      )
    ).toBe(false);
  });

  test('rejects dynamic providers whose credentials cannot be proven from the user bag', () => {
    expect(hasDirectChatCredential('opencode', { OPENCODE_API_KEY: 'user-key' }, true, {})).toBe(
      false
    );
  });
});

describe('getProviderCredentialScope', () => {
  test('keeps the same credential stable and gives a rotated key a separate state scope', () => {
    const ownerScope = JSON.stringify(['user', 'user-a']);
    const prior = getProviderCredentialScope('claude', ownerScope, {
      ANTHROPIC_API_KEY: 'credential-one',
    });
    const same = getProviderCredentialScope('claude', ownerScope, {
      ANTHROPIC_API_KEY: 'credential-one',
    });
    const rotated = getProviderCredentialScope('claude', ownerScope, {
      ANTHROPIC_API_KEY: 'credential-two',
    });

    expect(same).toBe(prior);
    expect(rotated).not.toBe(prior);
    expect(prior).not.toContain('credential-one');
    expect(rotated).not.toContain('credential-two');
  });

  test('fingerprints shared install credentials in the effective request environment', () => {
    const ownerScope = JSON.stringify(['user', 'user-a']);

    expect(getProviderCredentialScope('claude', ownerScope, {})).toBe(ownerScope);
    expect(
      getProviderCredentialScope('claude', ownerScope, { ANTHROPIC_API_KEY: 'install-key' })
    ).not.toBe(ownerScope);
  });

  test('ignores a shadowed install API key when a protected per-user OAuth token is effective', () => {
    const ownerScope = JSON.stringify(['user', 'user-a']);
    const protectedEnvKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'];
    const prior = getProviderCredentialScope(
      'claude',
      ownerScope,
      {
        ANTHROPIC_API_KEY: 'install-key-one',
        CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth',
        ANTHROPIC_OAUTH_TOKEN: 'user-oauth',
      },
      protectedEnvKeys
    );

    expect(
      getProviderCredentialScope(
        'claude',
        ownerScope,
        {
          ANTHROPIC_API_KEY: 'install-key-two',
          CLAUDE_CODE_OAUTH_TOKEN: 'user-oauth',
          ANTHROPIC_OAUTH_TOKEN: 'user-oauth',
        },
        protectedEnvKeys
      )
    ).toBe(prior);
    expect(
      getProviderCredentialScope(
        'claude',
        ownerScope,
        {
          ANTHROPIC_API_KEY: 'install-key-one',
          CLAUDE_CODE_OAUTH_TOKEN: 'rotated-user-oauth',
          ANTHROPIC_OAUTH_TOKEN: 'rotated-user-oauth',
        },
        protectedEnvKeys
      )
    ).not.toBe(prior);
  });

  test('fingerprints Claude API-key precedence when an OAuth token is also present', () => {
    const ownerScope = JSON.stringify(['user', 'user-a']);
    const prior = getProviderCredentialScope('claude', ownerScope, {
      ANTHROPIC_API_KEY: 'active-api-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-before-rotation',
    });

    expect(
      getProviderCredentialScope('claude', ownerScope, {
        ANTHROPIC_API_KEY: 'active-api-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-after-rotation',
      })
    ).toBe(prior);
    expect(
      getProviderCredentialScope('claude', ownerScope, {
        ANTHROPIC_API_KEY: 'rotated-api-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-after-rotation',
      })
    ).not.toBe(prior);

    const malformedApiKeyScope = getProviderCredentialScope('claude', ownerScope, {
      ANTHROPIC_API_KEY: ' ',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-before-rotation',
    });
    expect(
      getProviderCredentialScope('claude', ownerScope, {
        ANTHROPIC_API_KEY: ' ',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-after-rotation',
      })
    ).toBe(malformedApiKeyScope);
  });

  test('keeps file-backed and unregistered providers on the owner scope', () => {
    const ownerScope = JSON.stringify(['user', 'user-a']);

    expect(getProviderCredentialScope('codex', ownerScope, { CODEX_HOME: '/tmp/codex' })).toBe(
      ownerScope
    );
    expect(getProviderCredentialScope('unknown-provider', ownerScope, { API_KEY: 'secret' })).toBe(
      ownerScope
    );
  });
});
