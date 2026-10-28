import { z } from 'zod';
import { AGENT_ID_REGEX, dagNodeBaseSchema } from './dag-node-base';

/** Schema for the `on_reject` sub-object on approval nodes. */
export const approvalOnRejectSchema = z.object({
  prompt: z.string().min(1, "'on_reject.prompt' must be a non-empty string"),
  max_attempts: z.number().int().min(1).max(10).optional(),
});

export type ApprovalOnReject = z.infer<typeof approvalOnRejectSchema>;

/**
 * An author-declared decision on the `approval.decisions:` surface (#2707
 * step 1). `id` is an author-chosen identifier — reachable from every drive
 * surface via `workflow respond <run-id> <decision> [text]` (#2707 step 2);
 * `approve`/`reject` remain the default-vocabulary sugar every surface's
 * dedicated approve/reject path still speaks when those ids are declared. `label` is
 * purely cosmetic display text; the wire value the gate outputs as
 * `$<id>.output.decision` is always the `id`, never the label.
 *
 * `id` is constrained to `AGENT_ID_REGEX`'s kebab-case grammar (no embedded
 * whitespace) rather than an open string: the CLI's `respond` command takes
 * `decision` as one whitespace-delimited positional token, so an id like
 * `'needs revision'` would parse as `decision='needs'`, `text='revision'` —
 * not the declared id — on every unquoted invocation. `label` already exists
 * to carry a spaced, human-readable form for display.
 */
export const approvalDecisionConfigSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "'approval.decisions[].id' must not be empty")
    .regex(
      AGENT_ID_REGEX,
      "'approval.decisions[].id' must be kebab-case (lowercase letters, digits, single hyphens — e.g. 'approve', 'needs-revision')"
    ),
  label: z.string().min(1).optional(),
});

type ApprovalDecisionConfig = z.infer<typeof approvalDecisionConfigSchema>;

export function getApprovalDecisions(approval: {
  decisions?: ApprovalDecisionConfig[];
}): ApprovalDecisionConfig[] {
  return approval.decisions ?? [{ id: 'approve' }, { id: 'reject' }];
}

/**
 * Schema for the `approval:` config object. Named (rather than inlined at both
 * use sites) so its shape is reachable for the unknown-key check in the loader.
 *
 * `decisions` and `on_reject` are mutually exclusive: `on_reject` is the
 * deprecated legacy mechanism (a stored rework template with a private
 * attempt counter, kept working byte-for-byte for backward compatibility —
 * see `decisionOptionSchema`'s doc); `decisions` is its replacement (ordinary
 * structured `{decision,text}` output, with any rework/revise flow wired by
 * the author as an explicit `when:` edge to their own node). Declaring both
 * would leave it ambiguous which mechanism resolves the gate — validated in
 * `dagNodeSchema`'s superRefine (`validateApprovalNode`, node-validation.ts), not
 * here, so this stays a plain `z.object` and keeps its precise `.shape` for
 * `KNOWN_NODE_NESTED_KEYS`'s compile-time-checked child-key map (a
 * `.superRefine()`-wrapped schema would erase that precision — see
 * `loopGroupShape`'s cast in dag-node.ts for what that costs).
 */
export const approvalConfigSchema = z.object({
  message: z.string().min(1, "'approval.message' must not be empty"),
  decisions: z
    .array(approvalDecisionConfigSchema)
    .min(1, "'approval.decisions' must declare at least one decision")
    .optional(),
  capture_response: z.boolean().optional(),
  on_reject: approvalOnRejectSchema.optional(),
});

/**
 * A decision a resolved gate node can produce. `rework` carries the legacy
 * `on_reject` behavior (a rework prompt with a max-attempts counter) as a
 * per-decision continuation — it is populated EXCLUSIVELY by `dagNodeSchema`'s
 * transform when translating a deprecated `on_reject:` config, and is never
 * part of the new `approval.decisions:` authoring surface
 * (`approvalDecisionConfigSchema` has no `rework` field, so an author cannot
 * write one directly).
 */
export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  rework: z
    .object({
      prompt: z.string().min(1),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;

/**
 * Gate node schema (formerly `approval:`) — pauses the workflow for human review.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 *
 * `decisionsAuthored` is the ONE signal that switches a gate into the new
 * structured-output mechanism (#2707 step 1): true only when the author wrote
 * `approval.decisions:` explicitly in YAML. `decisions` itself is always
 * populated (synthesized default pair, `on_reject`-translated pair, or the
 * authored array), so it stays uniform for message-building/preflight/
 * substitution code that doesn't care which mode produced it — only
 * approve/reject resolution branches on `decisionsAuthored`.
 *
 * This is deliberately narrower than "no `on_reject` configured": before this
 * PR, `approval.decisions:` did not exist, so no already-authored workflow —
 * bundled or custom — can have written it. Keying the new output shape and
 * reject's non-terminal resolution on this exact field is what guarantees
 * every pre-existing gate (the omitted-decisions default, with or without
 * `capture_response`) keeps its EXACT pre-PR behavior: plain/empty output,
 * reject always cancels. Only a gate an author positively rewrites to declare
 * `decisions:` gets the new mechanism.
 */
export const gateNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('gate'),
  message: z.string(),
  decisions: z.array(decisionOptionSchema),
  decisionsAuthored: z.boolean(),
  captureResponse: z.boolean(),
});

/** DAG node that pauses workflow execution for human approval */
export type GateNode = z.infer<typeof gateNodeSchema>;
