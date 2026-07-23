/**
 * Deterministic decision truth table for the marketplace auto-review workflow.
 *
 * This gates an irreversible action (auto-merge, and auto-close of a
 * contributor's PR), so the mapping is a pure, unit-tested function rather than
 * an inline block. The `decide` node reads the scan/schema/AI/scope/draft inputs
 * and calls this; the `act` node consumes { decision, reason, close }.
 *
 * `close` policy: a reject only auto-closes the PR when a DETERMINISTIC signal
 * justified it — a scope violation or a critical/high security-scan severity.
 * An AI-only reject (the model recommended reject while the deterministic checks
 * are clean) still posts the request-changes review but leaves `close` false, so
 * the PR stays open and is flagged for a maintainer instead of being closed on a
 * single model opinion. Setting `close` at each branch keeps one source of truth.
 */

export interface ScanResult {
  severity: string;
  findings?: Array<{ category: string; context: string }>;
}

export interface SchemaResult {
  valid: boolean;
  files?: Array<{ valid: boolean }>;
}

export interface AiReview {
  recommendation?: string;
  reasoning?: string;
}

export type Decision = 'auto_merge' | 'auto_approve' | 'request_changes' | 'reject';

export interface DecideInput {
  scopeOk: boolean;
  isDraft: boolean;
  scan: ScanResult;
  schema: SchemaResult;
  ai: AiReview;
}

export interface DecideResult {
  decision: Decision;
  reason: string;
  close: boolean;
}

export function decideMarketplace(input: DecideInput): DecideResult {
  const { scopeOk, isDraft, scan, schema, ai } = input;
  const scanHigh = scan.severity === 'critical' || scan.severity === 'high';
  const noWorkflowFiles = !schema.files || schema.files.length === 0;
  const aiReason = ai.reasoning ?? '(no reasoning was provided by the AI reviewer)';

  if (!scopeOk) {
    return {
      decision: 'reject',
      reason:
        'PR modifies files outside packages/docs-web/src/data/marketplace.ts. Only marketplace.ts additions are accepted.',
      close: true,
    };
  }

  if (isDraft) {
    return {
      decision: 'request_changes',
      reason: 'PR is in draft state. Mark as ready for review when complete.',
      close: false,
    };
  }

  if (scanHigh) {
    const findings = (scan.findings ?? []).map((f) => `${f.category} in ${f.context}`).join('; ');
    return {
      decision: 'reject',
      reason: `Security scan found ${String(scan.severity)} severity issues: ${findings}`,
      close: true,
    };
  }

  if (noWorkflowFiles) {
    // A marketplace entry must contain at least one workflow. validate-schema
    // emits { valid: true, files: [] } when the pinned SHA yields no source dir
    // / no YAML / no workflow-shaped YAML (top-level `nodes:`). Guard it here or
    // an empty submission scans clean and reaches auto-merge — a fail-open.
    return {
      decision: 'request_changes',
      reason:
        'Submission contains no workflow YAML at the pinned SHA. A marketplace entry must include at least one workflow definition (a YAML file with a top-level `nodes:` block).',
      close: false,
    };
  }

  if (ai.recommendation === 'reject') {
    // AI-only reject: deterministic checks are clean, so post the review but
    // leave the PR open (close:false) and flag it for a maintainer.
    return { decision: 'reject', reason: aiReason, close: false };
  }

  if (!schema.valid) {
    // Reached only when files is non-empty (the empty case is handled above).
    return {
      decision: 'request_changes',
      reason: 'Workflow YAML failed schema validation. Fix structural errors before merging.',
      close: false,
    };
  }

  if (scan.severity === 'medium' || ai.recommendation === 'request_changes') {
    return { decision: 'request_changes', reason: aiReason, close: false };
  }

  if (scan.severity === 'none' && (ai.recommendation === 'auto_merge' || ai.recommendation === 'auto_approve')) {
    return { decision: 'auto_merge', reason: aiReason, close: false };
  }

  return { decision: 'auto_approve', reason: aiReason, close: false };
}
