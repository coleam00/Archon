import { requestJson, HttpError } from '../lib/http';

/**
 * Marketplace Submission verb (PR-4). Response types are inlined (mirroring
 * `skills/github.ts`) because the marketplace-submit schemas are not yet in
 * `@/lib/api.generated`, and `@/lib/api` is eslint-blocked for the console.
 */

export interface MarketplaceSubmitAttestation {
  noExfiltration: boolean;
  noDestructiveOps: boolean;
  rightToShare: boolean;
  shaReviewed: boolean;
}

export interface MarketplaceSubmitParams {
  workflowName: string;
  cwd: string;
  attestation: MarketplaceSubmitAttestation;
}

export interface MarketplaceSubmitResult {
  prUrl: string;
  slug: string;
  sha: string;
  bundleCommitSha: string;
  action: 'append' | 'update';
}

export function submitToMarketplace(
  params: MarketplaceSubmitParams
): Promise<MarketplaceSubmitResult> {
  return requestJson<MarketplaceSubmitResult>('/api/marketplace/submit', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/** `HttpError.bodySnippet` may be truncated JSON — always guard the parse. */
function tryParseErrorBody(bodySnippet: string): { error?: string; detail?: string } | null {
  try {
    return JSON.parse(bodySnippet) as { error?: string; detail?: string };
  } catch {
    return null;
  }
}

/**
 * Pure status -> user-facing message mapping for a failed submission. 401 ->
 * sign-in; 409 -> slug owned by another author; 422 -> the server's message
 * verbatim (it already carries the actionable guidance — credential/origin/
 * preflight/bundle); everything else -> a generic message plus the server's
 * `detail` when the body parses (e.g. the landed-bundle note on a 500 after
 * the commit already happened).
 */
export function httpErrorToMessage(err: unknown): string {
  if (!(err instanceof HttpError)) {
    return err instanceof Error ? err.message : 'Marketplace submission failed (unknown error).';
  }

  if (err.status === 401) {
    return 'Sign in to submit to the marketplace.';
  }
  if (err.status === 409) {
    return 'This workflow name is already registered in the marketplace by a different author. Choose a different name.';
  }
  if (err.status === 422) {
    const parsed = tryParseErrorBody(err.bodySnippet);
    return parsed?.error ?? 'Submission blocked — see details below.';
  }

  const parsed = tryParseErrorBody(err.bodySnippet);
  if (parsed?.detail) return `${parsed.error ?? 'Submission failed'}: ${parsed.detail}`;
  return parsed?.error ?? `Marketplace submission failed (HTTP ${String(err.status)}).`;
}
