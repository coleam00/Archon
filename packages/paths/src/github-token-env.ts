/**
 * The env vars gh reads a token from, split by the host they authenticate:
 * github.com and GHE.com tenancies (`*.ghe.com`) use the first pair, a GitHub
 * Enterprise Server host the second. One owner, so the per-user scrub, the forge
 * credential selection and the pack's forge check agree on which names count.
 */
export const GH_DOTCOM_TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
export const GH_ENTERPRISE_TOKEN_KEYS = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

export function ghTokenKeysForHost(
  host: string
): typeof GH_DOTCOM_TOKEN_KEYS | typeof GH_ENTERPRISE_TOKEN_KEYS {
  return host === 'github.com' || host.endsWith('.ghe.com')
    ? GH_DOTCOM_TOKEN_KEYS
    : GH_ENTERPRISE_TOKEN_KEYS;
}
