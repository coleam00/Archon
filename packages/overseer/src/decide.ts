/**
 * Decision layer for Cauldron workflow failures.
 *
 * Given a classified error + attempt count, returns what the executor should do:
 *   - retry (with optional backoff hint)
 *   - skip (continue workflow, mark node as warning)
 *   - commit_and_push_anyway (work is good despite node failure — proceed to PR)
 *   - escalate (preserve current behavior — abort + log diagnostic)
 *
 * Design authority: 2026-05-09 WO-HARNESS-OVERLORD-ROUTING-INTEGRATION-01 §4.3.
 * Minimal v1 scope: classification-based decisions only. Future v2: per-WO-class rules,
 * provider failover routing, grader integration.
 */

import type { ErrorClass } from './classify.ts';

export type Decision = 'retry' | 'skip' | 'commit_and_push_anyway' | 'escalate';

export interface DecideInput {
  errorClass: ErrorClass;
  /** 1-based attempt counter for the current node */
  attempt: number;
  /** Optional: did the node produce any output before failing? (for sentinel-mismatch heuristic) */
  hasOutput?: boolean;
  /** Node ID — some decisions are node-type aware */
  nodeId?: string;
}

export interface DecisionResult {
  decision: Decision;
  reason: string;
  /** Suggested backoff in ms if decision is retry */
  backoffMs?: number;
}

/**
 * Decide what to do given an error class + attempt count.
 * Returns "escalate" for unknown classes (preserve old behavior — don't auto-recover unknowns).
 */
export function decide(input: DecideInput): DecisionResult {
  const { errorClass, attempt, hasOutput } = input;

  switch (errorClass) {
    case 'rate_limit_exceeded':
      if (attempt < 3) {
        return {
          decision: 'retry',
          reason: `rate limit on attempt ${attempt}/3, exponential backoff`,
          backoffMs: 1000 * Math.pow(2, attempt), // 2s, 4s, 8s
        };
      }
      return { decision: 'escalate', reason: 'rate limit persisted across 3 attempts' };

    case 'service_unavailable':
      if (attempt < 3) {
        return {
          decision: 'retry',
          reason: `service unavailable on attempt ${attempt}/3, linear backoff`,
          backoffMs: 5000 * attempt,
        };
      }
      return { decision: 'escalate', reason: 'service unavailable across 3 attempts' };

    case 'out_of_credits':
      // Provider failover would handle this in v2; for now escalate
      return {
        decision: 'escalate',
        reason: 'out of credits — provider failover not yet wired (deferred to Overseer v2)',
      };

    case 'auth_failed':
      // OAuth refresh runs on cron (deployed 2026-05-16). If we hit this, the timer hasn't caught it.
      return {
        decision: 'escalate',
        reason: 'auth failed — needs operator /login (refresh timer cycle may not have run yet)',
      };

    case 'invalid_request':
      return {
        decision: 'escalate',
        reason: 'invalid request shape — likely YAML/code bug, not transient',
      };

    // --- Workflow-runtime classes (BDC-specific 2026-05-16) ---

    case 'sentinel_mismatch':
      // Agent finished work but didn't emit the literal `until:` string.
      // Per Patch 3 (multi-sentinel), future loops emit all 3 standard sentinels.
      // For legacy loops: if agent produced output, the work is likely good — try to ship it.
      if (hasOutput) {
        return {
          decision: 'commit_and_push_anyway',
          reason: "agent produced output but didn't emit sentinel — work likely complete, ship it",
        };
      }
      return {
        decision: 'escalate',
        reason: 'loop ended without output AND without sentinel — likely real failure',
      };

    case 'npm_not_found':
      // Bun-only container. Per Rule 15 + WO-146 sweep, all bdc-* YAMLs are bun-only now.
      // If we still see this, it's a legacy YAML that escaped the sweep.
      return {
        decision: 'skip',
        reason:
          'node uses npm/npx/pnpm/yarn but container is bun-only — skip this verify-* style node, continue workflow',
      };

    case 'verify_pre_existing':
      // Verify failures unrelated to WO diff (e.g. pre-existing test failures in @archon/paths).
      // Per Patch 1, verify-* nodes were dropped from bdc-feature-development. If we still hit
      // this, it's a different workflow that still has verify-*. Skip the failure, continue.
      return {
        decision: 'skip',
        reason:
          'verify-* node failed on pre-existing rot, not WO change — skip, continue to commit + PR',
      };

    case 'worktree_collision':
      // Branch name already used by another worktree (parallel fire collision).
      // Could retry with timestamped branch name, but YAML Rule 17 already mandates that.
      // If we still hit this, it's a YAML that didn't follow Rule 17. Escalate.
      return {
        decision: 'escalate',
        reason:
          'worktree collision — YAML should use timestamped branch per Rule 17 (legacy YAML to patch)',
      };

    case 'branch_ref_missing':
      // master/main hardcoded but the target repo uses the other (or different default branch).
      // YAML Rule 16 mandates dynamic default-branch detection.
      return {
        decision: 'escalate',
        reason:
          'branch ref missing — YAML hardcodes master/main, should use dynamic default-branch detection (Rule 16)',
      };

    case 'spec_lookup_failed':
      // read-spec couldn't fetch the WO spec from bdc-xo main.
      // If attempt 1, possible the spec PR just landed and there's a propagation delay — retry once.
      if (attempt < 2) {
        return {
          decision: 'retry',
          reason:
            'spec lookup failed on first attempt — possible bdc-xo main propagation delay, retry once',
          backoffMs: 5000,
        };
      }
      return {
        decision: 'escalate',
        reason:
          'spec lookup failed on retry — WO_ID may not exist on bdc-xo main, operator must check',
      };

    case 'unknown':
    default:
      return {
        decision: 'escalate',
        reason: 'unknown error class — preserve current behavior (abort + log diagnostic)',
      };
  }
}
