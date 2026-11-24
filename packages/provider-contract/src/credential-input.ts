import { z } from 'zod';

/**
 * Which credential Archon handed a provider's runtime for one request. Diagnostic only:
 * nothing branches on it. It reports Archon's input, not the runtime's choice:
 *  - `delivered`  a per-user credential Archon delivered replaced every install-wide one.
 *  - `forwarded`  Archon passed install-wide credential, auth header or backend-selector
 *                 env keys (`credentialKeys`); the runtime picks among them and its own
 *                 settings.
 *  - `none`       Archon passed none of the provider's credential keys; the runtime's own
 *                 login, its settings, or a container image's environment decide.
 */
export const providerCredentialInputSchema = z.enum(['delivered', 'forwarded', 'none']);
export type ProviderCredentialInput = z.infer<typeof providerCredentialInputSchema>;

/**
 * The env key names a provider may report with a credential input, never their values.
 * Closed so a plugin cannot pass other text across the log boundary. A provider that
 * reports a new credential input adds its names here.
 */
export const providerCredentialKeySchema = z.enum([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_API_KEY_HELPER_FD',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
]);
export type ProviderCredentialKey = z.infer<typeof providerCredentialKeySchema>;

/** A reported key list, keeping only names in `providerCredentialKeySchema`. */
export const providerCredentialKeysSchema = z
  .array(z.json())
  .transform(keys =>
    keys.filter(
      (key): key is ProviderCredentialKey => providerCredentialKeySchema.safeParse(key).success
    )
  );
