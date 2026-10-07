import { anthropicOAuthProvider } from './anthropic-oauth';
import { githubCopilotOAuthProvider } from './github-copilot-oauth';
import { normalizeCredentialVendor } from './delivery';
import type { OAuthProviderInterface } from './subscription-oauth';

const SUBSCRIPTION_OAUTH: Readonly<Record<string, OAuthProviderInterface>> = {
  anthropic: anthropicOAuthProvider,
  'github-copilot': githubCopilotOAuthProvider,
};

export const OPENAI_SUBSCRIPTION_VENDOR = 'openai';
export const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  ...Object.keys(SUBSCRIPTION_OAUTH),
  OPENAI_SUBSCRIPTION_VENDOR,
]);

/** OpenAI uses its separate exchange to retain Codex's required id_token. */
export function subscriptionOAuthProviderFor(provider: string): OAuthProviderInterface | undefined {
  return SUBSCRIPTION_OAUTH[normalizeCredentialVendor(provider)];
}
