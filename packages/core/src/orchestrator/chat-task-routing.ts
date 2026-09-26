import { createHash } from 'node:crypto';
import type { ChatTaskRoute } from '../config/chat-task-routing';
import { getRegistration, isRegisteredProvider, PI_PROVIDER_ENV_VARS } from '@archon/providers';

export type ChatRouteAvailability =
  | 'ready'
  | 'cooldown'
  | 'usage-warning'
  | 'quota-exhausted'
  | 'codex-rate-limit-exhausted'
  | 'unusable';

function directChatCredentialValues(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
  assistantConfig?: Readonly<Record<string, unknown>>
): string[] {
  if (provider === 'claude') {
    // Claude Code prefers ANTHROPIC_API_KEY over OAuth. CLAUDE_API_KEY is the
    // install alias mirrored by the provider only when neither credential above
    // is present. Fingerprint only the credential that actually takes effect.
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey) return [`ANTHROPIC_API_KEY:${apiKey}`];
    const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) return [`CLAUDE_CODE_OAUTH_TOKEN:${oauthToken}`];
    const claudeApiKey = env.CLAUDE_API_KEY;
    if (claudeApiKey) return [`CLAUDE_API_KEY:${claudeApiKey}`];
    return [];
  }

  if (!isRegisteredProvider(provider)) return [];
  const credentials = getRegistration(provider).credentials;
  if (credentials.kind !== 'static') return [];

  const values: string[] = [];
  for (const { vendor } of credentials.specs) {
    const envNames = [PI_PROVIDER_ENV_VARS[vendor]];
    // Anthropic OAuth is delivered as a usable direct-chat token under these
    // names; Codex's ChatGPT OAuth instead requires a file and stays ineligible.
    if (vendor === 'anthropic') {
      envNames.push('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'CLAUDE_API_KEY');
    }
    for (const name of envNames) {
      const value = typeof name === 'string' ? env[name]?.trim() : undefined;
      if (value) values.push(`${name}:${value}`);
    }
  }
  // Copilot deliberately ignores generic GitHub CLI tokens unless the
  // provider config opts into `useLoggedInUser: false`. Count those tokens
  // only under the same condition, so route eligibility matches the provider
  // auth resolver and still proves the token came from this execution identity.
  if (provider === 'copilot' && assistantConfig?.useLoggedInUser === false) {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const value = env[name]?.trim();
      if (value) values.push(`${name}:${value}`);
    }
  }
  return values.sort();
}

/**
 * Extend an owner scope with an in-memory-only fingerprint of direct-chat
 * credentials in the effective request environment. This prevents a rotated
 * token inheriting a warning recorded for its prior credential without storing
 * or logging the token itself. Providers backed by login files retain the
 * owner-only scope because their secret is not exposed through the environment.
 */
export function getProviderCredentialScope(
  provider: string,
  ownerScope: string,
  effectiveEnv: Readonly<Record<string, string | undefined>>,
  protectedEnvKeys: readonly string[] = []
): string {
  const env = { ...effectiveEnv };
  const protectedKeys = new Set(protectedEnvKeys);
  // The Claude provider removes these unprotected API-key aliases when a
  // protected per-user subscription token is present, because Claude Code
  // otherwise prefers the API key over OAuth. Exclude the same shadowed keys
  // here so warning state follows the credential that will actually be used.
  if (
    provider === 'claude' &&
    protectedKeys.has('CLAUDE_CODE_OAUTH_TOKEN') &&
    env.CLAUDE_CODE_OAUTH_TOKEN &&
    !protectedKeys.has('ANTHROPIC_API_KEY')
  ) {
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_API_KEY;
  }
  const values = directChatCredentialValues(provider, env);
  if (values.length === 0) return ownerScope;

  const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  return JSON.stringify([ownerScope, fingerprint]);
}

/**
 * Claude subscription warnings are meaningful only when the SDK will use a
 * protected per-user OAuth token. An API key can shadow OAuth unless it is
 * unprotected; the Claude provider removes that shadowed key only for this
 * protected-token case. Fail closed for install/global credentials because
 * their authentication posture is not proven by the direct-chat credential
 * delivery contract.
 */
export function hasProtectedClaudeOAuthCredential(
  effectiveEnv: Readonly<Record<string, string | undefined>>,
  protectedEnvKeys: readonly string[]
): boolean {
  const protectedKeys = new Set(protectedEnvKeys);
  return (
    Boolean(effectiveEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()) &&
    protectedKeys.has('CLAUDE_CODE_OAUTH_TOKEN') &&
    !protectedKeys.has('ANTHROPIC_API_KEY')
  );
}

/**
 * Prove a candidate provider can receive credentials owned by this execution
 * identity through direct chat. Per-user mode only counts the current user's
 * env-only delivery; install mode may use the process env. File deliveries
 * such as Codex `auth.json` are not represented here and cannot qualify.
 */
export function hasDirectChatCredential(
  provider: string,
  userEnv: Record<string, string>,
  perUserKeysEnabled: boolean,
  installEnv: NodeJS.ProcessEnv = process.env,
  assistantConfig?: Readonly<Record<string, unknown>>
): boolean {
  const env = perUserKeysEnabled ? userEnv : installEnv;
  return directChatCredentialValues(provider, env, assistantConfig).length > 0;
}

export interface SelectedChatTaskRoute<T> {
  reference: string;
  request: T;
  kind:
    | 'primary'
    | 'cooldown-fallback'
    | 'usage-warning-fallback'
    | 'copilot-quota-fallback'
    | 'codex-rate-limit-fallback';
}

export type ChatTaskRouteSelection<T> =
  | { kind: 'selected'; selection: SelectedChatTaskRoute<T> }
  | { kind: 'primary-unusable'; reference: string }
  | { kind: 'cooldown-without-fallback'; reference: string }
  | { kind: 'usage-warning-without-fallback'; reference: string }
  | { kind: 'copilot-quota-exhausted-without-fallback'; reference: string }
  | { kind: 'codex-rate-limit-exhausted-without-fallback'; reference: string }
  | { kind: 'no-usable-fallback'; reference: string };

/**
 * Resolve one explicit route. Fallbacks are considered only after the primary
 * has a recognized native cooldown or an explicitly configured provider usage
 * signal. Callers keep a primary when its usage is unknown and reject fallback
 * candidates whose configured usage state is unknown. Missing config or
 * credentials never silently turns into a different provider choice.
 */
export function selectChatTaskRoute<T>(
  route: ChatTaskRoute,
  resolve: (reference: string) => T | undefined,
  availability: (
    request: T,
    reference: string,
    kind: 'primary' | 'fallback'
  ) => ChatRouteAvailability
): ChatTaskRouteSelection<T> {
  const primary = resolve(route.primary);
  if (primary === undefined) {
    return { kind: 'primary-unusable', reference: route.primary };
  }

  const primaryAvailability = availability(primary, route.primary, 'primary');
  if (primaryAvailability === 'unusable') {
    return { kind: 'primary-unusable', reference: route.primary };
  }
  if (primaryAvailability === 'ready') {
    return {
      kind: 'selected',
      selection: { reference: route.primary, request: primary, kind: 'primary' },
    };
  }

  const fallbacks = route.fallbacks ?? [];
  if (fallbacks.length === 0) {
    if (primaryAvailability === 'cooldown') {
      return { kind: 'cooldown-without-fallback', reference: route.primary };
    }
    if (primaryAvailability === 'quota-exhausted') {
      return { kind: 'copilot-quota-exhausted-without-fallback', reference: route.primary };
    }
    if (primaryAvailability === 'codex-rate-limit-exhausted') {
      return { kind: 'codex-rate-limit-exhausted-without-fallback', reference: route.primary };
    }
    return { kind: 'usage-warning-without-fallback', reference: route.primary };
  }
  const fallbackKind =
    primaryAvailability === 'cooldown'
      ? 'cooldown-fallback'
      : primaryAvailability === 'quota-exhausted'
        ? 'copilot-quota-fallback'
        : primaryAvailability === 'codex-rate-limit-exhausted'
          ? 'codex-rate-limit-fallback'
          : 'usage-warning-fallback';

  for (const reference of fallbacks) {
    const request = resolve(reference);
    if (request === undefined || availability(request, reference, 'fallback') !== 'ready') continue;
    return {
      kind: 'selected',
      selection: { reference, request, kind: fallbackKind },
    };
  }

  return { kind: 'no-usable-fallback', reference: route.primary };
}
