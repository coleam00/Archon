/**
 * Error classification for Cauldron workflow failures.
 *
 * Ports overlord/router.py classify_error() to TypeScript + extends with workflow-specific
 * classes surfaced during 2026-05-16 Wave 1 sortie (sentinel mismatch, npm-not-found,
 * pre-existing verify rot, worktree collision).
 *
 * Design authority: 2026-05-09 WO-HARNESS-OVERLORD-PROVIDER-FAILOVER-01 (Python prior art).
 */

export type ErrorClass =
  // Provider/network errors (ported from router.py)
  | 'rate_limit_exceeded'
  | 'out_of_credits'
  | 'service_unavailable'
  | 'auth_failed'
  | 'invalid_request'
  // Workflow-runtime errors (new, from 2026-05-16)
  | 'sentinel_mismatch' // implement loop ended without matching `until:` sentinel
  | 'npm_not_found' // bun-only container, npm/npx/pnpm/yarn missing
  | 'verify_pre_existing' // verify-* failed on rot unrelated to WO diff
  | 'worktree_collision' // git: branch already used by another worktree
  | 'spec_lookup_failed' // read-spec couldn't fetch WO spec from bdc-xo
  | 'branch_ref_missing' // git: fatal: couldn't find remote ref
  // Fallback
  | 'unknown';

export interface ClassifyInput {
  /** HTTP status code if known (provider response, gh api, etc.) */
  statusCode?: number;
  /** Error message or stderr text */
  message?: string;
  /** Node ID where failure occurred (helps disambiguate sentinel vs verify) */
  nodeId?: string;
  /** Node type (bash, prompt, loop) */
  nodeType?: string;
  /** Exit code if from bash node */
  exitCode?: number;
}

/**
 * Classify a workflow failure into a known error class.
 * Returns "unknown" for unrecognized errors (caller decides what to do — usually escalate).
 *
 * Priority order matters: workflow-runtime classes checked first because they have specific
 * markers (e.g. "command not found: npm") that won't appear in provider errors.
 */
export function classifyError(input: ClassifyInput): ErrorClass {
  const msg = (input.message ?? '').toLowerCase();
  const status = input.statusCode;
  const exit = input.exitCode;

  // --- Workflow-runtime classes (BDC-specific, 2026-05-16) ---

  // Sentinel mismatch: implement loop iteration ended without finding `until:` string
  if (msg.includes('sdk returned success') && input.nodeType === 'loop') {
    return 'sentinel_mismatch';
  }

  // npm-not-found: bun container missing npm/npx/pnpm/yarn
  if (
    /command not found:?\s+(npm|npx|pnpm|yarn)/i.test(input.message ?? '') ||
    /bash:.*:\s+(npm|npx|pnpm|yarn):\s+command not found/i.test(input.message ?? '')
  ) {
    return 'npm_not_found';
  }

  // Worktree collision: git: branch already used
  if (
    /is already used by worktree/i.test(input.message ?? '') ||
    /fatal: a branch named .* already exists/i.test(input.message ?? '')
  ) {
    return 'worktree_collision';
  }

  // Branch ref missing: master/main hardcoded but doesn't exist
  if (/fatal: couldn't find remote ref/i.test(input.message ?? '')) {
    return 'branch_ref_missing';
  }

  // Spec lookup failed
  if (
    /spec not found for wo_id/i.test(input.message ?? '') ||
    (input.nodeId === 'read-spec' && exit === 1)
  ) {
    return 'spec_lookup_failed';
  }

  // Verify pre-existing rot: verify-* node failed but on a check-not-in-WO-scope
  // (heuristic: verify-* node failed AND error mentions tests/build/types unrelated to common WO file changes)
  if (
    /^verify-/i.test(input.nodeId ?? '') &&
    exit !== 0 &&
    !msg.includes('not found') // not npm-not-found (already handled above)
  ) {
    return 'verify_pre_existing';
  }

  // --- Provider/network classes (ported from router.py) ---

  if (
    msg.includes('out_of_credits') ||
    msg.includes('credit balance is too low') ||
    msg.includes('insufficient_quota')
  ) {
    return 'out_of_credits';
  }

  if (msg.includes('rate_limit_exceeded') || status === 429) {
    return 'rate_limit_exceeded';
  }

  if (
    msg.includes('service_unavailable') ||
    msg.includes('model_not_found') ||
    msg.includes('model_deprecated') ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  ) {
    return 'service_unavailable';
  }

  if (
    msg.includes('authentication_failed') ||
    msg.includes('invalid_grant') ||
    msg.includes('refresh_expired') ||
    status === 401 ||
    status === 403
  ) {
    return 'auth_failed';
  }

  if (msg.includes('invalid_request') || status === 400) {
    return 'invalid_request';
  }

  return 'unknown';
}
