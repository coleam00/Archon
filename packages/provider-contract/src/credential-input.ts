import { z } from 'zod';

/**
 * Which credential Archon handed a provider's runtime for one request. Diagnostic only:
 * nothing branches on it. It reports Archon's input, not the runtime's choice:
 *  - `delivered`  a per-user credential Archon delivered replaced every install-wide one.
 *  - `forwarded`  Archon passed install-wide credential or backend-selector env keys
 *                 (`credentialKeys`); the runtime picks among them and its own settings.
 *  - `none`       Archon passed none; the runtime's own login, its settings, or a container
 *                 image's environment decide.
 */
export const providerCredentialInputSchema = z.enum(['delivered', 'forwarded', 'none']);
export type ProviderCredentialInput = z.infer<typeof providerCredentialInputSchema>;

/**
 * The env key names reported with a credential input, never their values. The host forwards
 * only names present in the env it gave the provider, so a plugin cannot pass other text.
 */
export const providerCredentialKeysSchema = z.array(z.string().min(1));
