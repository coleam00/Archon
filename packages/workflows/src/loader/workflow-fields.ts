import type { z } from 'zod';
import type { DagNode, IncludeDirective } from '../schemas';
import { effortLevelSchema, betasSchema } from '../schemas/dag-node';
import { INPUT_NAME_PATTERN, inputEnvKey } from '../schemas/node-bindings';
import type { EffortLevel } from '../schemas/effort';
import { modelRefSchema, type WorkflowModelRef } from '../schemas/model-binding';
import {
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowRunBudgetSchema,
  workflowDeprecationSchema,
  workflowInputSpecSchema,
  workflowContainerPolicySchema,
} from '../schemas/workflow';
import type {
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowRunBudget,
  WorkflowDeprecation,
  WorkflowInputSpec,
} from '../schemas/workflow';
import { getLog } from './log';

/**
 * A hard-reject field: its parsed value (undefined when absent), or the error that rejects the
 * whole workflow. Warn-and-drop fields return the value or undefined instead.
 */
export type ParsedField<T> = { readonly value: T | undefined } | { readonly error: string };

/**
 * Parse an optional, schema-validated workflow field with warn-and-drop
 * semantics: a present-but-invalid value is logged and dropped (returns
 * undefined) rather than rejecting the whole workflow, so a typo in one field
 * doesn't abort the discovery pass. Mirrors the policy used for `tags` /
 * `interactive`. `extra` merges into the warning payload (e.g. the list of
 * valid enum options).
 *
 * The return type is inferred from the schema (`z.output<S>`), so
 * preprocess-based schemas still resolve to their parsed output type rather
 * than their input type. zod v4 removed `ZodTypeDef` as the middle type parameter, so the
 * old `z.ZodType<T, z.ZodTypeDef, unknown>` form no longer compiles.
 */
export function parseOptionalField<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  filename: string,
  event: string,
  extra?: Record<string, unknown>
): z.output<S> | undefined {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  if (raw !== undefined) {
    getLog().warn({ filename, value: raw, ...extra }, event);
  }
  return undefined;
}

/**
 * Parse workflow-level worktree policy. Same warn-and-ignore pattern used
 * for `modelReasoningEffort` — invalid values are dropped
 * rather than rejected, so a typo in one workflow doesn't nuke the whole
 * discovery pass. Only `worktree.enabled` is recognised today.
 */
export function parseWorktreePolicy(
  raw: unknown,
  filename: string
): { enabled?: boolean } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    getLog().warn({ filename, value: raw }, 'invalid_worktree_block_ignored');
    return undefined;
  }
  const rawEnabled = (raw as Record<string, unknown>).enabled;
  if (typeof rawEnabled === 'boolean') return { enabled: rawEnabled };
  if (rawEnabled !== undefined) {
    getLog().warn({ filename, value: rawEnabled }, 'invalid_worktree_enabled_value_ignored');
  }
  return undefined;
}

/**
 * Parse workflow-level container policy (folder-project container backend).
 * Same warn-and-ignore pattern as `worktree`. `enabled` pins the container
 * backend on without `--container`; `write_back` chooses
 * whether the finished run's overlay diff pauses for review or applies directly.
 */
export function parseContainerPolicy(
  raw: unknown,
  filename: string
): z.infer<typeof workflowContainerPolicySchema> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    getLog().warn({ filename, value: raw }, 'invalid_container_block_ignored');
    return undefined;
  }
  const rawContainer = raw as Record<string, unknown>;
  const enabled = parseOptionalField(
    rawContainer.enabled,
    workflowContainerPolicySchema.shape.enabled,
    filename,
    'invalid_container_enabled_value_ignored'
  );
  const writeBack = parseOptionalField(
    rawContainer.write_back,
    workflowContainerPolicySchema.shape.write_back,
    filename,
    'invalid_container_write_back_value_ignored'
  );
  const policy: z.infer<typeof workflowContainerPolicySchema> = {};
  if (enabled !== undefined) policy.enabled = enabled;
  if (writeBack !== undefined) policy.write_back = writeBack;
  return policy.enabled !== undefined || policy.write_back !== undefined ? policy : undefined;
}

/**
 * Parse workflow-level evidence policy (#2230). Unlike the worktree/container
 * convenience policies, a malformed block REJECTS the workflow instead of
 * warn-and-ignore: silently dropping a declared terminal-success gate would
 * let a run complete ungated — not fail-safe. Same hard-reject posture as
 * unknown-provider and persist_session capability validation.
 */
export function parseEvidencePolicy(raw: unknown): ParsedField<WorkflowEvidencePolicy> {
  if (raw === undefined) return { value: undefined };
  const parsedEvidence = workflowEvidencePolicySchema.safeParse(raw);
  if (!parsedEvidence.success) {
    return {
      error:
        "Invalid evidence_policy: expected { required: boolean }. When required is true, the run is refused terminal 'completed' unless the conventional marker file $ARTIFACTS_DIR/evidence.json exists; its contents are not checked.",
    };
  }
  return { value: parsedEvidence.data };
}

/**
 * Parse workflow-level run budget (#2814). Malformed REJECTS, like
 * evidence_policy: a misspelt or invalid ceiling must not silently mean no
 * ceiling. The strict schema rejects unknown keys, so `budget` needs no
 * KNOWN_WORKFLOW_NESTED_KEYS entry.
 */
export function parseRunBudget(raw: unknown): ParsedField<WorkflowRunBudget> {
  if (raw === undefined) return { value: undefined };
  const parsedBudget = workflowRunBudgetSchema.safeParse(raw);
  if (!parsedBudget.success) {
    return {
      error: `Invalid budget: expected { max_work_units?: positive integer, max_spend_usd?: positive number } declaring at least one ceiling (${parsedBudget.error.issues[0]?.message ?? 'invalid value'}).`,
    };
  }
  return { value: parsedBudget.data };
}

/**
 * Parse workflow-level deprecation marker (#2781). Like evidence_policy, a
 * malformed block REJECTS the workflow instead of warn-and-ignore: silently
 * dropping it would ship a bundled default with no removal warning at all,
 * defeating the whole deprecation window.
 */
export function parseDeprecation(raw: unknown): ParsedField<WorkflowDeprecation> {
  if (raw === undefined) return { value: undefined };
  const parsedDeprecation = workflowDeprecationSchema.safeParse(raw);
  if (!parsedDeprecation.success) {
    return {
      error:
        'Invalid deprecated: expected { message: string } — the sentence carried in the run-start deprecation notice (#2781).',
    };
  }
  return { value: parsedDeprecation.data };
}

/**
 * Parse mutates_checkout — boolean, omitted means true (run the path-lock guard).
 * Invalid non-boolean values are dropped with a warning.
 * When false, the executor skips the path-lock guard and allows concurrent runs on the same checkout.
 */
export function parseMutatesCheckout(raw: unknown, filename: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  getLog().warn({ filename, value: raw }, 'invalid_mutates_checkout_value_ignored');
  return undefined;
}

/**
 * Parse optional tags — type-narrow, trim, and dedupe so authors can't
 * ship ["GitLab", "GitLab ", "gitlab"] as three distinct values.
 * An explicit empty array is preserved (suppresses keyword inference in the
 * UI); an absent or invalid block leaves `tags` undefined (falls back to
 * inference). Same warn-and-ignore pattern as the worktree block.
 */
export function parseTags(raw: unknown, filename: string): string[] | undefined {
  if (Array.isArray(raw)) {
    return [
      ...new Set(
        raw
          .filter((t): t is string => typeof t === 'string')
          .map(t => t.trim())
          .filter(t => t.length > 0)
      ),
    ];
  }
  if (raw !== undefined) {
    getLog().warn({ filename, value: raw }, 'invalid_tags_block_ignored');
  }
  return undefined;
}

/**
 * Parse optional requires — the external-capability enum list (today only
 * `github`) that hard-blocks invocation when the originating user hasn't connected
 * that identity (see assertWorkflowRequirementsMet). Same warn-and-drop policy as
 * `tags`: invalid entries are dropped with a warning; an absent/empty list leaves
 * `requires` undefined. Without this parser the field is silently discarded at load and
 * the capability gate can never fire for a discovered workflow.
 */
export function parseRequires(raw: unknown, filename: string): WorkflowRequirement[] | undefined {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      getLog().warn({ filename, value: raw }, 'invalid_workflow_requires_block_ignored');
    }
    return undefined;
  }
  const valid: WorkflowRequirement[] = [];
  for (const entry of raw) {
    const parsed = workflowRequirementSchema.safeParse(entry);
    if (parsed.success) valid.push(parsed.data);
    else getLog().warn({ filename, value: entry }, 'invalid_workflow_requires_entry_ignored');
  }
  const deduped = [...new Set(valid)];
  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Parse optional inputs — the declared signature (#2470). Per-key warn-and-drop:
 * an invalid spec, a non-identifier name (env mangling needs identifier names), or
 * a contradictory `required: true` + `default:` pair is dropped with a warning. The
 * surviving record is set only when non-empty. Absent/invalid block leaves `inputs`
 * undefined — a workflow with no declared inputs keeps Phase-1 behaviour untouched.
 */
export function parseInputs(
  raw: unknown,
  filename: string
): ParsedField<Record<string, WorkflowInputSpec>> {
  if (raw === undefined) return { value: undefined };
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
  ) {
    getLog().warn({ filename, value: raw }, 'invalid_workflow_inputs_block_ignored');
    return { value: undefined };
  }
  const valid = validInputSpecs(raw as Record<string, unknown>, filename);
  const collision = inputEnvKeyCollision(valid);
  if (collision !== null) return { error: collision };
  return { value: Object.keys(valid).length > 0 ? valid : undefined };
}

function validInputSpecs(
  rawInputs: Record<string, unknown>,
  filename: string
): Record<string, WorkflowInputSpec> {
  const valid: Record<string, WorkflowInputSpec> = {};
  for (const [name, spec] of Object.entries(rawInputs)) {
    if (!INPUT_NAME_PATTERN.test(name)) {
      getLog().warn({ filename, name }, 'invalid_workflow_input_name_ignored');
      continue;
    }
    const parsed = workflowInputSpecSchema.safeParse(spec);
    if (!parsed.success) {
      getLog().warn({ filename, name, value: spec }, 'invalid_workflow_input_spec_ignored');
      continue;
    }
    if (parsed.data.required === true && parsed.data.default !== undefined) {
      getLog().warn(
        { filename, name },
        'contradictory_workflow_input_required_with_default_ignored'
      );
      continue;
    }
    valid[name] = parsed.data;
  }
  return valid;
}

/**
 * Reject env-key mangling collisions: two names that fold to the same
 * INPUTS_<UPPER_SNAKE> env key would silently clobber each other for
 * bash/script sub-run nodes (Task 17). Catch it here where all names are
 * visible; a colliding pair is a hard load error, not a warn-and-drop.
 */
function inputEnvKeyCollision(valid: Record<string, WorkflowInputSpec>): string | null {
  const envKeyOwners = new Map<string, string>();
  for (const name of Object.keys(valid)) {
    const envKey = inputEnvKey(name);
    const existing = envKeyOwners.get(envKey);
    if (existing !== undefined) {
      return `Workflow inputs '${existing}' and '${name}' both map to env var '${envKey}' — rename one so each input has a unique env key`;
    }
    envKeyOwners.set(envKey, name);
  }
  return null;
}

/**
 * Parse optional returns — the node id whose output IS this workflow's result
 * (#2470). Accept a non-empty string; reject every other present value. Silently
 * dropping an invalid selector would change the workflow result by falling back to
 * positional sink selection.
 *
 * `returns` must name a top-level node id. Checked here (not in validateDagStructure,
 * which takes nodes and is reused for loop_group bodies / the expander with no
 * `returns` in scope) against the parsed top-level nodes.
 */
export function parseReturns(
  raw: unknown,
  dagNodes: readonly (DagNode | IncludeDirective)[],
  filename: string
): ParsedField<string> {
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    getLog().debug({ filename, value: raw }, 'invalid_workflow_returns_value_rejected');
    return {
      error:
        "Invalid 'returns': expected the non-empty id of a top-level node whose output is this workflow's result",
    };
  }
  const returns = raw.trim();
  if (!dagNodes.some(n => n.id === returns)) {
    return {
      error: `Workflow declares returns: '${returns}' but no top-level node has that id`,
    };
  }
  return { value: returns };
}

/**
 * Authored run outcome (#2618). Unlike cosmetic or provider-default fields,
 * a malformed selector cannot be dropped: doing so would silently turn a
 * declared verdict into outcome=null. The node-schema relationship is
 * validated on the assembled workflow (and again after include
 * expansion when `returns:` names an include alias).
 */
export function parseOutcomeField(raw: unknown, filename: string): ParsedField<string> {
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    getLog().debug({ filename, value: raw }, 'invalid_workflow_outcome_field_value_rejected');
    return {
      error:
        "Invalid 'outcome_field': expected a non-empty required boolean property name relative to 'returns'",
    };
  }
  return { value: raw.trim() };
}

/**
 * The workflow-level `effort:`, with the deprecated `modelReasoningEffort:` translated into it.
 *
 * `effort:` is a workflow-level fallback field, warn-and-drop like `modelReasoningEffort` /
 * `webSearchMode`. It is declared on `workflowBaseSchema` and consumed by the DAG executor's
 * `workflowLevelOptions` (the object literal at the top of `executeDagWorkflow`, reading
 * `workflow.effort` etc.) as a default that per-node options inherit when unset. Without this
 * parser, a workflow YAML that sets e.g. `effort: high` at the root would be dropped at load
 * and a node without its own `effort` would never inherit the workflow-level default.
 *
 * Deprecated by #2556: `modelReasoningEffort:` was a second, Codex-only
 * spelling of reasoning depth. It is TRANSLATED into `effort:` here rather
 * than carried onto the workflow, so nothing downstream ever sees it.
 *
 * Translating at load time (rather than honouring it at execution time) is
 * what makes the deprecation terminal instead of indefinite: `effort:` has a
 * node-level counterpart and `modelReasoningEffort:` does not, so any pass
 * that collapses workflow-level config onto nodes — #1764's Task 1 — can
 * handle the translated form and could never have handled the original.
 *
 * Every `modelReasoningEffort` value is a valid `effort` rung, so the
 * translation is total. When both are declared, `effort:` wins and the old
 * field is dropped: the loader cannot know which nodes resolve to Codex, so
 * preserving the old field's Codex-only precedence is not expressible here.
 */
export function resolveEffort(
  raw: unknown,
  modelReasoningEffort: EffortLevel | undefined,
  workflowName: string,
  filename: string,
  warnings: string[]
): EffortLevel | undefined {
  const declaredEffort = parseOptionalField(
    raw,
    effortLevelSchema,
    filename,
    'invalid_workflow_effort_value_ignored',
    { valid: effortLevelSchema.options }
  );
  const effort = declaredEffort ?? modelReasoningEffort;
  if (modelReasoningEffort !== undefined) {
    const message =
      declaredEffort === undefined
        ? `Workflow '${workflowName}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and ` +
          `has been applied as 'effort: ${modelReasoningEffort}'. NOTE: 'effort:' applies to EVERY node ` +
          'in this workflow, including non-Codex ones, where the old Codex-only field applied to none. ' +
          "Set 'effort:' per node if only some nodes should reason that deeply."
        : `Workflow '${workflowName}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and was ` +
          `IGNORED because this workflow also declares 'effort: ${declaredEffort}', which now applies on ` +
          "every provider including Codex. Delete the 'modelReasoningEffort:' line.";
    warnings.push(message);
    // Carry the prose, not just the payload, so the warning is legible on both
    // channels: the log stream, and `parseWarnings` — which `executeWorkflow`
    // persists verbatim as a `workflow_parse_warnings` event (#2213).
    getLog().debug({ filename, warning: message }, 'workflow_model_reasoning_effort_deprecated');
  }
  return effort;
}

/**
 * Workflow-level `model:`: one ref or a model preference list. A malformed value rejects the
 * workflow; dropping it would run every node on the config default without saying so.
 */
export function parseWorkflowModel(raw: unknown): ParsedField<WorkflowModelRef> {
  // A bare `model:` key parses as null and has always meant "no model".
  if (raw === undefined || raw === null) return { value: undefined };
  const parsed = modelRefSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data };
  // An array matches the list branch, whose issue names the broken entry. Anything else
  // fails both branches as a bare "Invalid input", so name the shapes that are accepted.
  const issue = parsed.error.issues[0];
  const reason =
    issue !== undefined && issue.code !== 'invalid_union'
      ? issue.message
      : 'expected a model ref string or a preference list of @aliases ending in a tier or model id';
  return { error: `Invalid workflow-level model: ${reason}.` };
}

/**
 * fallbackModel: non-empty trimmed string. Inline trim rather than
 * `safeParse` so a stray surrounding space is normalised rather than rejected.
 */
export function parseFallbackModel(raw: unknown, filename: string): string | undefined {
  const fallbackModelTrimmed = typeof raw === 'string' ? raw.trim() : '';
  const fallbackModel = fallbackModelTrimmed.length > 0 ? fallbackModelTrimmed : undefined;
  if (raw !== undefined && fallbackModel === undefined) {
    getLog().warn(
      { filename, value: raw, expected: 'non-empty string' },
      'invalid_workflow_fallback_model_value_ignored'
    );
  }
  return fallbackModel;
}

/**
 * betas: trim, drop empties, then validate the cleaned list through
 * `betasSchema` (non-empty array of non-empty strings). An empty result
 * drops the field entirely — the Claude SDK expects a populated beta header
 * or none at all. The schema's `.nonempty()` enforces non-emptiness at
 * runtime, so the cleaned list reaches the SDK validated without a cast.
 */
export function parseBetas(raw: unknown, filename: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const cleaned = Array.isArray(raw)
    ? raw
        .filter((b): b is string => typeof b === 'string')
        .map(b => b.trim())
        .filter(b => b.length > 0)
    : [];
  const betasResult = betasSchema.safeParse(cleaned);
  if (betasResult.success) return betasResult.data;
  getLog().warn({ filename, value: raw }, 'invalid_workflow_betas_value_ignored');
  return undefined;
}
