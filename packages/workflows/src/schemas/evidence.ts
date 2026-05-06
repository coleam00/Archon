/**
 * Zod schemas for the real-execution proof contract (ROADMAP P3-A).
 *
 * `executionEvidenceSchema` is a discriminated union on `kind`:
 *   - `kind: 'planning'`  — explicit marker that an artifact is planning-only.
 *                           Schema parses this shape but the integrity validator
 *                           rejects it; planning evidence MUST NEVER pass as
 *                           execution proof.
 *   - `kind: 'execution'` — full set of fields a PR-producing run leaves
 *                           behind (commit SHA, pushed branch, PR URL, changed
 *                           files, test commands/output, provider/run IDs).
 *
 * `evidencePolicySchema` is the workflow-level opt-in. When `required: true`,
 * the engine refuses to mark the run `completed` unless `$ARTIFACTS_DIR/<path>`
 * (default `evidence.json`) parses against `executionEvidenceSchema` and
 * (when `verify === 'reality'`) the claimed SHA/branch/PR are reachable in
 * git/origin/GitHub.
 *
 * `evidenceValidationIssueSchema` mirrors `ValidationIssue` from validator.ts.
 * `evidenceValidationResultSchema` is a `valid`-discriminated union — callers
 * narrow via `result.valid === true` to access `evidence`, or `false` to
 * access `issues`.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// ExecutionEvidence — discriminated union on `kind`
// ---------------------------------------------------------------------------

/**
 * Planning-only artifact. Authors MAY emit this to explicitly mark a run as
 * non-execution. The integrity check rejects it as execution proof.
 */
const planningEvidenceSchema = z.object({
  kind: z.literal('planning'),
  workflow_run_id: z.string().min(1),
  provider: z.string().min(1),
  summary: z.string().min(1),
});

/**
 * Real-execution proof. Every field is required and structurally meaningful:
 *   - `commit_sha` is canonical 40-char lowercase hex (git's only canonical form)
 *   - `pr_url` is restricted to `https://github.com/<owner>/<repo>/pull/<number>`
 *   - `provider_run_ids` and `changed_files` are non-empty (a run that produced
 *     no session and changed no files cannot be claiming PR delivery)
 *   - `test_commands` MAY be empty (some PRs are doc-only) but the field MUST
 *     be present so absence is explicit, not implicit
 */
const realExecutionEvidenceSchema = z.object({
  kind: z.literal('execution'),
  workflow_run_id: z.string().min(1),
  provider: z.string().min(1),
  provider_run_ids: z.array(z.string().min(1)).nonempty(),
  changed_files: z.array(z.string().min(1)).nonempty(),
  diff_command: z.string().min(1),
  test_commands: z.array(z.string().min(1)),
  test_output_summary: z.string(),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/, 'commit_sha must be 40-char lowercase hex'),
  pushed_branch: z.string().min(1),
  pr_url: z
    .string()
    .url()
    .regex(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
      'pr_url must be https://github.com/<owner>/<repo>/pull/<number>'
    ),
  pr_number: z.number().int().positive(),
});

export const executionEvidenceSchema = z.discriminatedUnion('kind', [
  planningEvidenceSchema,
  realExecutionEvidenceSchema,
]);

export type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

/**
 * Field names required on the `kind: 'execution'` branch. Derived from the
 * schema shape so the list cannot drift from the contract.
 */
export const EXECUTION_EVIDENCE_REQUIRED_FIELDS: readonly string[] = Object.freeze(
  Object.keys(realExecutionEvidenceSchema.shape)
);

// ---------------------------------------------------------------------------
// EvidencePolicy — workflow-level opt-in
// ---------------------------------------------------------------------------

export const evidencePolicySchema = z.object({
  /**
   * When `true`, the engine refuses to mark the workflow run `completed`
   * unless evidence validation passes. Defaults to `false` when omitted at the
   * workflow level so existing workflows without the flag remain unaffected.
   */
  required: z.boolean().optional(),
  /**
   * Validation depth:
   *   - `'shape'`   — Zod parse + cross-field integrity (no I/O)
   *   - `'reality'` — also verify commit SHA, pushed branch, and PR URL via
   *                   git/gh. Requires `gh` on PATH and authenticated.
   * Default `'shape'` keeps CI hermetic; operators opt in to reality per
   * workflow.
   */
  verify: z.enum(['shape', 'reality']).default('shape'),
  /**
   * Path to the evidence JSON file, relative to `$ARTIFACTS_DIR`.
   * Absolute paths and `..` segments are rejected by the validator before
   * any read occurs (path-traversal defense). Empty / directory-like values
   * are rejected at parse time so author errors fail fast instead of
   * surfacing as cryptic ENOENT/EISDIR runtime errors.
   */
  path: z
    .string()
    .trim()
    .min(1, 'evidence_policy.path cannot be empty')
    .refine(
      p => p !== '.' && !p.endsWith('/'),
      'evidence_policy.path must be a file, not a directory'
    )
    .default('evidence.json'),
});

export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;

// ---------------------------------------------------------------------------
// EvidenceValidationIssue — actionable per-field error
// ---------------------------------------------------------------------------

export const evidenceValidationIssueSchema = z.object({
  // Only 'error' is currently emitted. Add 'warning' here when a producer
  // exists alongside an explicit gate-semantics decision (today the gate
  // would treat warnings as failures because validateEvidence returns
  // valid: false on any issue).
  level: z.enum(['error']),
  field: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

export type EvidenceValidationIssue = z.infer<typeof evidenceValidationIssueSchema>;

// ---------------------------------------------------------------------------
// EvidenceValidationResult — discriminated union on `valid`
// ---------------------------------------------------------------------------

export const evidenceValidationResultSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    evidence: executionEvidenceSchema,
  }),
  z.object({
    valid: z.literal(false),
    issues: z.array(evidenceValidationIssueSchema),
  }),
]);

export type EvidenceValidationResult = z.infer<typeof evidenceValidationResultSchema>;
