import { missingProviderMessage } from '@archon/provider-contract';
/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type { ProviderRegistry } from '@archon/provider-contract';
import type { WorkflowDefinition, WorkflowLoadError, DagNode, IncludeDirective } from './schemas';
import {
  isLoopNode,
  isLoopGroupNode,
  isIncludeDirective,
  nodeUsesPersistedScope,
  persistedSessionHandling,
  isNodeContextResume,
} from './schemas';
import {
  KNOWN_DAG_NODE_KEYS,
  effortLevelSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './schemas/dag-node';
import {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowRunBudgetSchema,
  workflowDeprecationSchema,
  workflowInputSpecSchema,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
} from './schemas/workflow';
import type {
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowRunBudget,
  WorkflowDeprecation,
  WorkflowInputSpec,
} from './schemas/workflow';
import { INPUT_NAME_PATTERN, inputEnvKey } from './schemas/dag-node';
import { validateInlineExecInputs } from './exec-input-validation';
import { z } from 'zod';
import { getLog } from './loader/log';
import {
  validateLoopGroupProseCompletion,
  validateNodeOutputFormats,
  validateRunBudgetShape,
  validateWorkflowOutcomeDeclaration,
} from './loader/contracts';
import {
  collectConditionalJoinWarnings,
  collectLegacyPauseWarnings,
  collectUnknownConfigKeys,
  pushUnknownKeyWarning,
} from './loader/parse-warnings';
import { parseDagNode } from './loader/node-parse';
import { validateDagStructure } from './loader/dag-structure';

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
function parseOptionalField<S extends z.ZodType>(
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
 * Parse workflow YAML with Bun's parser. Every reader of a workflow file goes through here.
 * CRLF is normalized first: Bun keeps the line break of a multi-line quoted scalar in a CRLF
 * file where the YAML spec (and LF input) folds it to a space.
 */
export function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content.replaceAll('\r\n', '\n'));
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null; warnings: string[] }
  | { workflow: null; error: WorkflowLoadError; warnings?: never };

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(
  content: string,
  filename: string,
  providers: ProviderRegistry,
  configuredEnvNames?: ReadonlySet<string>
): ParseResult {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
      return {
        workflow: null,
        error: {
          filename,
          error: 'YAML file is empty or does not contain an object',
          errorType: 'validation_error',
        },
      };
    }

    if (Object.hasOwn(raw, 'thinking')) {
      return {
        workflow: null,
        error: {
          filename,
          error: "'thinking:' has been removed; use 'effort:' instead",
          errorType: 'validation_error',
        },
      };
    }

    // A load failure reaches the author through the returned `error`, which discovery
    // collects for `workflow list`, `validate workflows`, `workflow run`, and the API.
    // Like parse warnings, the log line is debug so a broken file is not repeated on
    // every discovery (#3444).
    if (!raw.name || typeof raw.name !== 'string') {
      getLog().debug({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().debug({ filename }, 'workflow_missing_description');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing required field 'description'",
          errorType: 'validation_error',
        },
      };
    }

    const errors: string[] = [];

    // Reject legacy steps-based workflows
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    if (hasSteps) {
      errors.push(
        '`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively. Your bundled defaults are already updated — custom workflows need manual migration. See docs/sequential-dag-migration-guide.md for conversion patterns, or run: claude "Read docs/sequential-dag-migration-guide.md then convert .archon/workflows/<file> to nodes: format"'
      );
    }

    const hasNodes = Array.isArray(raw.nodes) && (raw.nodes as unknown[]).length > 0;

    if (errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: errors.join('; '),
          errorType: 'validation_error',
        },
      };
    }

    if (!hasNodes) {
      getLog().debug({ filename }, 'workflow_missing_nodes');
      return {
        workflow: null,
        error: {
          filename,
          error: "Workflow must have 'nodes:' configuration",
          errorType: 'validation_error',
        },
      };
    }

    // Parse DAG nodes using dagNodeSchema
    const validationErrors: string[] = [];
    const parseWarnings: string[] = [];
    const dagNodes = (raw.nodes as unknown[])
      .map((n: unknown, i: number) => parseDagNode(n, i, validationErrors, parseWarnings))
      .filter((n): n is DagNode | IncludeDirective => n !== null);

    if (dagNodes.length !== (raw.nodes as unknown[]).length) {
      getLog().debug({ filename, validationErrors }, 'dag_node_validation_failed');
      return {
        workflow: null,
        error: {
          filename,
          error: `DAG node validation failed: ${validationErrors.join('; ')}`,
          errorType: 'validation_error',
        },
      };
    }

    const structureError = validateDagStructure(dagNodes);
    if (structureError) {
      getLog().debug({ filename, structureError }, 'dag_structure_invalid');
      return {
        workflow: null,
        error: { filename, error: structureError, errorType: 'validation_error' },
      };
    }

    const outputFormatError = validateNodeOutputFormats(dagNodes);
    if (outputFormatError) {
      getLog().debug({ filename, outputFormatError }, 'output_format_rejected');
      return {
        workflow: null,
        error: { filename, error: outputFormatError, errorType: 'validation_error' },
      };
    }

    const proseCompletionError = validateLoopGroupProseCompletion(dagNodes);
    if (proseCompletionError) {
      getLog().debug({ filename, proseCompletionError }, 'loop_group_prose_completion_rejected');
      return {
        workflow: null,
        error: { filename, error: proseCompletionError, errorType: 'validation_error' },
      };
    }

    collectConditionalJoinWarnings(dagNodes, parseWarnings);
    collectLegacyPauseWarnings(dagNodes, raw.nodes as unknown[], parseWarnings);

    if (raw.interactive !== undefined) {
      const message =
        `Workflow '${raw.name}': workflow-level 'interactive:' is deprecated and has no effect. ` +
        'Any workflow can start in the foreground, in the background or from a trigger; a ' +
        'pause waits in the attention queue until it is answered. Remove the line.';
      parseWarnings.push(message);
      getLog().debug({ filename, warning: message }, 'workflow_interactive_deprecated');
    }

    // Parse workflow-level fields using WorkflowBaseSchema for validation
    // Note: modelReasoningEffort and webSearchMode use warn-and-ignore for invalid values
    // (consistent with original behavior) rather than schema-level rejection.
    const provider =
      typeof raw.provider === 'string' && raw.provider.length > 0 ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;

    // Validate provider identity at load time, both at the workflow level and
    // per node. Model strings are NOT validated — they pass through to the SDK
    // at run time, which is the source of truth for what model names exist
    // (vendor SDKs ship new models faster than Archon can update).
    if (provider && !providers.get(provider)) {
      return {
        workflow: null,
        error: {
          filename,
          error: missingProviderMessage(providers, provider),
          errorType: 'validation_error',
        },
      };
    }
    for (const node of dagNodes) {
      if (isIncludeDirective(node)) continue;
      if (node.provider !== undefined && !providers.get(node.provider)) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}': ${missingProviderMessage(providers, node.provider)}`,
            errorType: 'validation_error',
          },
        };
      }
    }

    interface SessionNode {
      node: DagNode;
      provider: string | undefined;
    }
    const sessionConsumers: { consumer: SessionNode; sources: ReadonlyMap<string, SessionNode> }[] =
      [];
    const collectSessionNodes = (
      nodes: readonly (DagNode | IncludeDirective)[],
      inheritedProvider: string | undefined,
      enclosing = new Map<string, SessionNode>()
    ): void => {
      const scope = new Map(enclosing);
      for (const node of nodes) {
        if (!isIncludeDirective(node))
          scope.set(node.id, { node, provider: node.provider ?? inheritedProvider });
      }
      for (const node of nodes) {
        if (isIncludeDirective(node)) continue;
        const consumer = scope.get(node.id);
        if (consumer === undefined) continue;
        if (isNodeContextResume(node.context)) sessionConsumers.push({ consumer, sources: scope });
        if (isLoopGroupNode(node))
          collectSessionNodes(node.loop_group.nodes, consumer.provider, scope);
      }
    };
    collectSessionNodes(dagNodes, provider);
    for (const {
      consumer: { node, provider: consumerProvider },
      sources,
    } of sessionConsumers) {
      if (!isNodeContextResume(node.context)) continue;
      const sourceEntry = sources.get(node.context.resume);
      if (sourceEntry === undefined) continue;
      const source = sourceEntry.node;
      const sourceProvider = sourceEntry.provider;
      if (
        consumerProvider !== undefined &&
        sourceProvider !== undefined &&
        consumerProvider !== sourceProvider
      ) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}' context.resume source '${source.id}' uses provider '${sourceProvider}', but the consumer uses '${consumerProvider}'`,
            errorType: 'validation_error',
          },
        };
      }

      const knownProvider = consumerProvider ?? sourceProvider;
      const knownDescriptor =
        knownProvider === undefined ? undefined : providers.get(knownProvider);
      if (knownDescriptor) {
        const caps = knownDescriptor.capabilities;
        if (!caps.sessionResume || caps.sessionFork !== true) {
          return {
            workflow: null,
            error: {
              filename,
              error: `Node '${node.id}' context.resume requires immutable session forks, but provider '${knownProvider}' does not support sessionFork`,
              errorType: 'validation_error',
            },
          };
        }
      }
    }

    // persist_session capability gating: when the effective provider is known at
    // load time (explicit at node or workflow level), reject a provider without session
    // resume, and warn for one that cannot fork: the executor never continues its
    // persisted session, so each run of that node starts fresh. Both outcomes come from
    // `persistedSessionHandling`, the same answer the executor acts on. When the
    // provider is implicit (set via .archon/config.yaml defaults), the check defers to
    // runtime in agent dispatch (dag/nodes/agent/dispatch.ts).
    //
    // `nodeUsesPersistedScope` skips nodes that never use a persisted session (non-agent
    // nodes, context: 'fresh'), so workflow-level `persist_sessions: true` next to,
    // e.g., a bash node does not fail validation.
    const workflowPersistSessions = raw.persist_sessions === true;
    for (const node of dagNodes) {
      if (isIncludeDirective(node)) continue;
      if (!nodeUsesPersistedScope(node, workflowPersistSessions)) continue;

      const explicitProvider = ('provider' in node ? node.provider : undefined) ?? provider;
      const descriptor = explicitProvider ? providers.get(explicitProvider) : undefined;
      if (!descriptor) continue;
      const handling = persistedSessionHandling(descriptor.capabilities);
      if (handling === 'unsupported') {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}' has persist_session: true but provider '${explicitProvider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`,
            errorType: 'validation_error',
          },
        };
      }
      if (handling === 'fresh') {
        const message = `Node '${node.id}': provider '${explicitProvider}' cannot fork a session, so persist_session never continues an earlier run's session and every run starts fresh. Use a provider with sessionFork, or pass state between runs through artifacts.`;
        parseWarnings.push(message);
        getLog().debug(
          { id: node.id, provider: explicitProvider },
          'persist_session_not_continued'
        );
      }
    }

    // Validate modelReasoningEffort / webSearchMode — warn and ignore invalid values.
    const modelReasoningEffort = parseOptionalField(
      raw.modelReasoningEffort,
      modelReasoningEffortSchema,
      filename,
      'invalid_model_reasoning_effort',
      { valid: modelReasoningEffortSchema.options }
    );
    // Parsed here for validation only. The deprecation is RESOLVED far below,
    // next to `const effort = ...`, because translating needs `effort` too:
    // `modelReasoningEffort` becomes `effort` and is never carried forward.
    // Search `workflow_model_reasoning_effort_deprecated` for the other half.
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    // Warn (non-blocking) when signal_completes is set without interactive: the flag
    // only changes interactive-gate behavior — a non-interactive loop already
    // completes on the signal, so the author's intent is likely a missing
    // `interactive: true`. The workflow still loads.
    const hasSignalCompletesWithoutInteractive = (ns: (DagNode | IncludeDirective)[]): boolean =>
      ns.some(
        n =>
          !isIncludeDirective(n) &&
          ((isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
            (isLoopGroupNode(n) &&
              ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
                hasSignalCompletesWithoutInteractive(n.loop_group.nodes))))
      );
    if (hasSignalCompletesWithoutInteractive(dagNodes)) {
      getLog().warn({ filename }, 'signal_completes_without_interactive_ignored');
    }

    // Parse workflow-level worktree policy. Same warn-and-ignore pattern used
    // for `modelReasoningEffort` — invalid values are dropped
    // rather than rejected, so a typo in one workflow doesn't nuke the whole
    // discovery pass. Only `worktree.enabled` is recognised today.
    let worktreePolicy: { enabled?: boolean } | undefined;
    if (raw.worktree !== undefined) {
      if (
        typeof raw.worktree === 'object' &&
        raw.worktree !== null &&
        !Array.isArray(raw.worktree)
      ) {
        const rawEnabled = (raw.worktree as Record<string, unknown>).enabled;
        if (typeof rawEnabled === 'boolean') {
          worktreePolicy = { enabled: rawEnabled };
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_worktree_enabled_value_ignored');
        }
      } else {
        getLog().warn({ filename, value: raw.worktree }, 'invalid_worktree_block_ignored');
      }
    }

    // Parse workflow-level container policy (folder-project container backend).
    // Same warn-and-ignore pattern as `worktree`. `enabled` pins the container
    // backend on without `--container`; `write_back` ('approve' | 'auto') chooses
    // whether the finished run's overlay diff pauses for review or applies directly.
    let containerPolicy: { enabled?: boolean; write_back?: 'approve' | 'auto' } | undefined;
    if (raw.container !== undefined) {
      if (
        typeof raw.container === 'object' &&
        raw.container !== null &&
        !Array.isArray(raw.container)
      ) {
        const rawContainer = raw.container as Record<string, unknown>;
        const rawEnabled = rawContainer.enabled;
        const rawWriteBack = rawContainer.write_back;
        const policy: { enabled?: boolean; write_back?: 'approve' | 'auto' } = {};
        if (typeof rawEnabled === 'boolean') {
          policy.enabled = rawEnabled;
        } else if (rawEnabled !== undefined) {
          getLog().warn({ filename, value: rawEnabled }, 'invalid_container_enabled_value_ignored');
        }
        if (rawWriteBack === 'approve' || rawWriteBack === 'auto') {
          policy.write_back = rawWriteBack;
        } else if (rawWriteBack !== undefined) {
          getLog().warn(
            { filename, value: rawWriteBack },
            'invalid_container_write_back_value_ignored'
          );
        }
        if (policy.enabled !== undefined || policy.write_back !== undefined) {
          containerPolicy = policy;
        }
      } else {
        getLog().warn({ filename, value: raw.container }, 'invalid_container_block_ignored');
      }
    }

    // Parse workflow-level evidence policy (#2230). Unlike the worktree/container
    // convenience policies, a malformed block REJECTS the workflow instead of
    // warn-and-ignore: silently dropping a declared terminal-success gate would
    // let a run complete ungated — not fail-safe. Same hard-reject posture as
    // unknown-provider and persist_session capability validation above.
    let evidencePolicy: WorkflowEvidencePolicy | undefined;
    if (raw.evidence_policy !== undefined) {
      const parsedEvidence = workflowEvidencePolicySchema.safeParse(raw.evidence_policy);
      if (!parsedEvidence.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              "Invalid evidence_policy: expected { required: boolean }. When required is true, the run is refused terminal 'completed' unless the conventional marker file $ARTIFACTS_DIR/evidence.json exists; its contents are not checked.",
            errorType: 'validation_error',
          },
        };
      }
      evidencePolicy = parsedEvidence.data;
    }

    // Parse workflow-level run budget (#2814). Malformed REJECTS, like
    // evidence_policy: a misspelt or invalid ceiling must not silently mean no
    // ceiling. The strict schema rejects unknown keys, so `budget` needs no
    // KNOWN_WORKFLOW_NESTED_KEYS entry.
    let budget: WorkflowRunBudget | undefined;
    if (raw.budget !== undefined) {
      const parsedBudget = workflowRunBudgetSchema.safeParse(raw.budget);
      if (!parsedBudget.success) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Invalid budget: expected { max_work_units?: positive integer, max_spend_usd?: positive number } declaring at least one ceiling (${parsedBudget.error.issues[0]?.message ?? 'invalid value'}).`,
            errorType: 'validation_error',
          },
        };
      }
      budget = parsedBudget.data;
    }

    // Parse workflow-level deprecation marker (#2781). Like evidence_policy, a
    // malformed block REJECTS the workflow instead of warn-and-ignore: silently
    // dropping it would ship a bundled default with no removal warning at all,
    // defeating the whole deprecation window.
    let deprecated: WorkflowDeprecation | undefined;
    if (raw.deprecated !== undefined) {
      const parsedDeprecation = workflowDeprecationSchema.safeParse(raw.deprecated);
      if (!parsedDeprecation.success) {
        return {
          workflow: null,
          error: {
            filename,
            error:
              'Invalid deprecated: expected { message: string } — the sentence carried in the run-start deprecation notice (#2781).',
            errorType: 'validation_error',
          },
        };
      }
      deprecated = parsedDeprecation.data;
    }

    // Parse mutates_checkout — boolean, omitted means true (run the path-lock guard).
    // Invalid non-boolean values are dropped with a warning.
    // When false, the executor skips the path-lock guard and allows concurrent runs on the same checkout.
    let mutatesCheckout: boolean | undefined;
    if (raw.mutates_checkout !== undefined) {
      if (typeof raw.mutates_checkout === 'boolean') {
        mutatesCheckout = raw.mutates_checkout;
      } else {
        getLog().warn(
          { filename, value: raw.mutates_checkout },
          'invalid_mutates_checkout_value_ignored'
        );
      }
    }

    // Parse optional tags — type-narrow, trim, and dedupe so authors can't
    // ship ["GitLab", "GitLab ", "gitlab"] as three distinct values.
    // An explicit empty array is preserved (suppresses keyword inference in the
    // UI); an absent or invalid block leaves `tags` undefined (falls back to
    // inference). Same warn-and-ignore pattern as the worktree block above.
    let tags: string[] | undefined;
    if (Array.isArray(raw.tags)) {
      tags = [
        ...new Set(
          raw.tags
            .filter((t): t is string => typeof t === 'string')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        ),
      ];
    } else if (raw.tags !== undefined) {
      getLog().warn({ filename, value: raw.tags }, 'invalid_tags_block_ignored');
    }

    // Parse optional requires — the external-capability enum list (today only
    // `github`) that hard-blocks invocation when the originating user hasn't connected
    // that identity (see assertWorkflowRequirementsMet). Same warn-and-drop policy as
    // `tags`: invalid entries are dropped with a warning; an absent/empty list leaves
    // `requires` undefined. Without this block the field is silently discarded here and
    // the capability gate can never fire for a discovered workflow.
    let requires: WorkflowRequirement[] | undefined;
    if (Array.isArray(raw.requires)) {
      const valid: WorkflowRequirement[] = [];
      for (const entry of raw.requires) {
        const parsed = workflowRequirementSchema.safeParse(entry);
        if (parsed.success) valid.push(parsed.data);
        else getLog().warn({ filename, value: entry }, 'invalid_workflow_requires_entry_ignored');
      }
      const deduped = [...new Set(valid)];
      if (deduped.length > 0) requires = deduped;
    } else if (raw.requires !== undefined) {
      getLog().warn({ filename, value: raw.requires }, 'invalid_workflow_requires_block_ignored');
    }

    // Parse optional inputs — the declared signature (#2470). Per-key warn-and-drop:
    // an invalid spec, a non-identifier name (env mangling needs identifier names), or
    // a contradictory `required: true` + `default:` pair is dropped with a warning. The
    // surviving record is set only when non-empty. Absent/invalid block leaves `inputs`
    // undefined — a workflow with no declared inputs keeps Phase-1 behaviour untouched.
    let inputs: Record<string, WorkflowInputSpec> | undefined;
    const rawInputs = raw.inputs;
    if (rawInputs !== undefined) {
      if (
        typeof rawInputs === 'object' &&
        rawInputs !== null &&
        !Array.isArray(rawInputs) &&
        (Object.getPrototypeOf(rawInputs) === Object.prototype ||
          Object.getPrototypeOf(rawInputs) === null)
      ) {
        const valid: Record<string, WorkflowInputSpec> = {};
        for (const [name, spec] of Object.entries(rawInputs as Record<string, unknown>)) {
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
        // Reject env-key mangling collisions: two names that fold to the same
        // INPUTS_<UPPER_SNAKE> env key would silently clobber each other for
        // bash/script sub-run nodes (Task 17). Catch it here where all names are
        // visible; a colliding pair is a hard load error, not a warn-and-drop.
        const envKeyOwners = new Map<string, string>();
        for (const name of Object.keys(valid)) {
          const envKey = inputEnvKey(name);
          const existing = envKeyOwners.get(envKey);
          if (existing !== undefined) {
            return {
              workflow: null,
              error: {
                filename,
                error: `Workflow inputs '${existing}' and '${name}' both map to env var '${envKey}' — rename one so each input has a unique env key`,
                errorType: 'validation_error',
              },
            };
          }
          envKeyOwners.set(envKey, name);
        }
        if (Object.keys(valid).length > 0) inputs = valid;
      } else {
        getLog().warn({ filename, value: rawInputs }, 'invalid_workflow_inputs_block_ignored');
      }
    }

    // Parse optional returns — the node id whose output IS this workflow's result
    // (#2470). Accept a non-empty string; reject every other present value. Silently
    // dropping an invalid selector would change the workflow result by falling back to
    // positional sink selection. The referenced id
    // must name a top-level node — checked below once dagNodes is assembled.
    let returns: string | undefined;
    if (typeof raw.returns === 'string' && raw.returns.trim().length > 0) {
      returns = raw.returns.trim();
    } else if (raw.returns !== undefined) {
      getLog().debug({ filename, value: raw.returns }, 'invalid_workflow_returns_value_rejected');
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'returns': expected the non-empty id of a top-level node whose output is this workflow's result",
          errorType: 'validation_error',
        },
      };
    }
    // `returns` must name a top-level node id. Done here (not in validateDagStructure,
    // which takes nodes and is reused for loop_group bodies / the expander with no
    // `returns` in scope) now that dagNodes is computed.
    if (returns !== undefined && !dagNodes.some(n => n.id === returns)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Workflow declares returns: '${returns}' but no top-level node has that id`,
          errorType: 'validation_error',
        },
      };
    }

    // Authored run outcome (#2618). Unlike cosmetic or provider-default fields,
    // a malformed selector cannot be dropped: doing so would silently turn a
    // declared verdict into outcome=null. The node-schema relationship is
    // validated below on the assembled workflow (and again after include
    // expansion when `returns:` names an include alias).
    let outcomeField: string | undefined;
    if (typeof raw.outcome_field === 'string' && raw.outcome_field.trim().length > 0) {
      outcomeField = raw.outcome_field.trim();
    } else if (raw.outcome_field !== undefined) {
      getLog().debug(
        { filename, value: raw.outcome_field },
        'invalid_workflow_outcome_field_value_rejected'
      );
      return {
        workflow: null,
        error: {
          filename,
          error:
            "Invalid 'outcome_field': expected a non-empty required boolean property name relative to 'returns'",
          errorType: 'validation_error',
        },
      };
    }

    // Parse workflow-level fallback fields. Same warn-and-drop pattern as
    // `modelReasoningEffort` / `webSearchMode` above. These are declared on
    // `workflowBaseSchema` and consumed by the DAG executor's
    // `workflowLevelOptions` (the object literal at the top of
    // `executeDagWorkflow`, reading `workflow.effort` etc.) as defaults that
    // per-node options inherit when unset. Without this block, a workflow YAML
    // that sets e.g. `effort: high` at the root would be dropped here and the
    // executor would read undefined, so a node without its own `effort` would
    // never inherit the workflow-level default.
    const declaredEffort = parseOptionalField(
      raw.effort,
      effortLevelSchema,
      filename,
      'invalid_workflow_effort_value_ignored',
      { valid: effortLevelSchema.options }
    );

    // Deprecated by #2556: `modelReasoningEffort:` was a second, Codex-only
    // spelling of reasoning depth. It is TRANSLATED into `effort:` here rather
    // than carried onto the workflow, so nothing downstream ever sees it.
    //
    // Translating at load time (rather than honouring it at execution time) is
    // what makes the deprecation terminal instead of indefinite: `effort:` has a
    // node-level counterpart and `modelReasoningEffort:` does not, so any pass
    // that collapses workflow-level config onto nodes — #1764's Task 1 — can
    // handle the translated form and could never have handled the original.
    //
    // Every `modelReasoningEffort` value is a valid `effort` rung, so the
    // translation is total. When both are declared, `effort:` wins and the old
    // field is dropped: the loader cannot know which nodes resolve to Codex, so
    // preserving the old field's Codex-only precedence is not expressible here.
    const effort = declaredEffort ?? modelReasoningEffort;
    if (modelReasoningEffort !== undefined) {
      const message =
        declaredEffort === undefined
          ? `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and ` +
            `has been applied as 'effort: ${modelReasoningEffort}'. NOTE: 'effort:' applies to EVERY node ` +
            'in this workflow, including non-Codex ones, where the old Codex-only field applied to none. ' +
            "Set 'effort:' per node if only some nodes should reason that deeply."
          : `Workflow '${raw.name}': 'modelReasoningEffort: ${modelReasoningEffort}' is deprecated and was ` +
            `IGNORED because this workflow also declares 'effort: ${declaredEffort}', which now applies on ` +
            "every provider including Codex. Delete the 'modelReasoningEffort:' line.";
      parseWarnings.push(message);
      // Carry the prose, not just the payload, so the warning is legible on both
      // channels: the log stream, and `parseWarnings` — which `executeWorkflow`
      // persists verbatim as a `workflow_parse_warnings` event (#2213).
      getLog().debug({ filename, warning: message }, 'workflow_model_reasoning_effort_deprecated');
    }
    const sandbox = parseOptionalField(
      raw.sandbox,
      sandboxSettingsSchema,
      filename,
      'invalid_workflow_sandbox_value_ignored'
    );

    // fallbackModel: non-empty trimmed string. Inline trim rather than
    // `safeParse` so a stray surrounding space is normalised rather than rejected.
    const fallbackModelTrimmed =
      typeof raw.fallbackModel === 'string' ? raw.fallbackModel.trim() : '';
    const fallbackModel = fallbackModelTrimmed.length > 0 ? fallbackModelTrimmed : undefined;
    if (raw.fallbackModel !== undefined && fallbackModel === undefined) {
      getLog().warn(
        { filename, value: raw.fallbackModel, expected: 'non-empty string' },
        'invalid_workflow_fallback_model_value_ignored'
      );
    }

    // betas: trim, drop empties, then validate the cleaned list through
    // `betasSchema` (non-empty array of non-empty strings). An empty result
    // drops the field entirely — the Claude SDK expects a populated beta header
    // or none at all. The schema's `.nonempty()` enforces non-emptiness at
    // runtime, so the cleaned list reaches the SDK validated without a cast.
    let betas: string[] | undefined;
    if (raw.betas !== undefined) {
      const cleaned = Array.isArray(raw.betas)
        ? raw.betas
            .filter((b): b is string => typeof b === 'string')
            .map(b => b.trim())
            .filter(b => b.length > 0)
        : [];
      const betasResult = betasSchema.safeParse(cleaned);
      if (betasResult.success) {
        betas = betasResult.data;
      } else {
        getLog().warn({ filename, value: raw.betas }, 'invalid_workflow_betas_value_ignored');
      }
    }

    // Detect unknown workflow-level keys, and unknown keys inside the nested
    // workflow-level configs (#2213)
    const workflowName = raw.name;
    const workflowLabel = `Workflow '${workflowName}'`;
    for (const key of Object.keys(raw)) {
      if (key === 'interactive') continue; // deprecated, warned above
      if (!KNOWN_WORKFLOW_KEYS.has(key)) {
        const hint = KNOWN_DAG_NODE_KEYS.has(key)
          ? ` ('${key}' is valid on individual nodes, not at workflow level.)`
          : '';
        pushUnknownKeyWarning(
          workflowName,
          workflowLabel,
          key,
          hint,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
        continue;
      }
      const nested = KNOWN_WORKFLOW_NESTED_KEYS.get(key);
      if (nested) {
        collectUnknownConfigKeys(
          raw[key],
          nested,
          workflowName,
          workflowLabel,
          `${key}.`,
          'workflow_unknown_key_ignored',
          parseWarnings
        );
      }
    }

    const workflow: WorkflowDefinition = {
      name: raw.name,
      description: raw.description,
      provider,
      model,
      // `modelReasoningEffort` is deliberately absent — it was translated into
      // `effort` above, so nothing downstream ever sees the deprecated field.
      webSearchMode,
      ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fallbackModel !== undefined ? { fallbackModel } : {}),
      ...(betas !== undefined ? { betas } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      ...(workflowPersistSessions ? { persist_sessions: true } : {}),
      nodes: dagNodes,
      ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
      ...(containerPolicy ? { container: containerPolicy } : {}),
      ...(evidencePolicy !== undefined ? { evidence_policy: evidencePolicy } : {}),
      ...(budget !== undefined ? { budget } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(requires !== undefined ? { requires } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(returns !== undefined ? { returns } : {}),
      ...(outcomeField !== undefined ? { outcome_field: outcomeField } : {}),
      ...(deprecated !== undefined ? { deprecated } : {}),
    };
    const execInputValidation = validateInlineExecInputs(workflow, configuredEnvNames);
    parseWarnings.push(...execInputValidation.warnings);
    if (execInputValidation.errors.length > 0) {
      return {
        workflow: null,
        error: {
          filename,
          error: execInputValidation.errors.join(' '),
          errorType: 'validation_error',
        },
      };
    }
    const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
    if (outcomeDeclarationError !== null) {
      return {
        workflow: null,
        error: {
          filename,
          error: outcomeDeclarationError,
          errorType: 'validation_error',
        },
      };
    }
    const runBudgetShapeError = validateRunBudgetShape(workflow);
    if (runBudgetShapeError !== null) {
      return {
        workflow: null,
        error: { filename, error: runBudgetShapeError, errorType: 'validation_error' },
      };
    }

    return {
      workflow,
      error: null,
      warnings: parseWarnings,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    // Debug for the same reason as the validation failures above: the returned
    // parse_error is what the author sees, and discovery re-parses on every command.
    getLog().debug(
      {
        err,
        filename,
        lineInfo: lineInfo || undefined,
        contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
      },
      'workflow_parse_failed'
    );
    return {
      workflow: null,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${err.message}`,
        errorType: 'parse_error',
      },
    };
  }
}
