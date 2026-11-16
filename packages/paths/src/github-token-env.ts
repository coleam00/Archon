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

/**
 * Set to `1` by an engine that spawns the Archon CLI with a run's resolved GitHub
 * identity before the run has a `WORKFLOW_ID` (the start-time forge check). CLI
 * startup then keeps that identity over Archon's env files, as it does inside a run.
 */
export const RUN_GITHUB_IDENTITY_HANDOFF_ENV = 'ARCHON_RUN_GITHUB_IDENTITY';
