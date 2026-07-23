/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import type { WorkflowDefinition, WorkflowLoadError, DagNode, WorkflowNodeHooks } from './schemas';
import {
  isBashNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isIncludeNode,
  isWorkflowNode,
  isPersistableNode,
} from './schemas';
import { createLogger } from '@archon/paths';
import {
  isRegisteredProvider,
  getRegisteredProviders,
  getProviderCapabilities,
} from '@archon/providers';
import {
  dagNodeSchema,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
  betasSchema,
} from './schemas/dag-node';
import {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  KNOWN_WORKFLOW_KEYS,
  WORKFLOW_ONLY_KEYS,
} from './schemas/workflow';
import type { WorkflowRequirement, WorkflowEvidencePolicy } from './schemas/workflow';
import { workflowNodeHooksSchema } from './schemas/hooks';
import { z } from '@hono/zod-openapi';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Parse an optional, schema-validated workflow field with warn-and-drop
 * semantics: a present-but-invalid value is logged and dropped (returns
 * undefined) rather than rejecting the whole workflow, so a typo in one field
 * doesn't abort the discovery pass. Mirrors the policy used for `tags` /
 * `interactive`. `extra` merges into the warning payload (e.g. the list of
 * valid enum options).
 *
 * The return type is inferred from the schema (`z.output<S>`), so
 * preprocess-based schemas (e.g. `thinkingConfigSchema`, whose input is
 * `unknown`) still resolve to their parsed output type rather than their
 * input type. zod v4 removed `ZodTypeDef` as the middle type parameter, so the
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
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Format a Zod validation error issue into a human-readable string for a named node.
 */
function formatNodeIssue(id: string, issue: z.ZodIssue): string {
  const pathStr = issue.path.length > 0 ? `'${issue.path.join('.')}' ` : '';
  return `Node '${id}': ${pathStr}${issue.message}`;
}

/**
 * Validate and parse a single DagNode from raw YAML data.
 * Replaces the former parseDagNode + parseRetryConfig + parseToolList +
 * parseNodeHooks + parseIdleTimeout functions.
 */
function parseDagNode(
  raw: unknown,
  index: number,
  errors: string[],
  warnings: string[]
): DagNode | null {
  // Extract id early for error messages (may be empty/invalid — schema will catch it)
  const rawId =
    raw !== null && typeof raw === 'object' && 'id' in raw
      ? String((raw as Record<string, unknown>).id)
      : '';
  const id = rawId.trim() || `#${String(index + 1)}`;

  const result = dagNodeSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(formatNodeIssue(id, issue));
    }
    return null;
  }

  const node = result.data;

  // Warn about unknown keys on the raw node that Zod silently stripped (#2213).
  // This catches misplaced workflow-level keys (e.g. `interactive:` on a command node)
  // and typos (e.g. `contxt:` instead of `context:`).
  if (raw !== null && typeof raw === 'object') {
    const rawKeys = Object.keys(raw as Record<string, unknown>);
    for (const key of rawKeys) {
      if (!KNOWN_DAG_NODE_KEYS.has(key)) {
        const hint = WORKFLOW_ONLY_KEYS.has(key)
          ? ` ('${key}' is valid at workflow level, not on individual nodes)`
          : '';
        warnings.push(`Node '${id}': unknown key '${key}' will be ignored${hint}`);
        getLog().warn({ id: node.id, key }, 'node_unknown_key_ignored');
      }
    }
  }

  // Warn about AI-specific fields on non-AI nodes (runtime behavior, not schema errors)
  let nonAiNode: { type: string; fields: readonly string[] } | undefined;
  if (isCancelNode(node)) {
    nonAiNode = { type: 'cancel', fields: BASH_NODE_AI_FIELDS };
  } else if (isIncludeNode(node)) {
    nonAiNode = { type: 'include', fields: INCLUDE_NODE_IGNORED_FIELDS };
  } else if (isWorkflowNode(node)) {
    nonAiNode = { type: 'workflow', fields: WORKFLOW_NODE_IGNORED_FIELDS };
  } else if (isApprovalNode(node)) {
    nonAiNode = { type: 'approval', fields: BASH_NODE_AI_FIELDS };
  } else if (isLoopNode(node)) {
    nonAiNode = { type: 'loop', fields: LOOP_NODE_AI_FIELDS };
  } else if (isLoopGroupNode(node)) {
    nonAiNode = { type: 'loop_group', fields: LOOP_GROUP_NODE_AI_FIELDS };
  } else if (isScriptNode(node)) {
    nonAiNode = { type: 'script', fields: SCRIPT_NODE_AI_FIELDS };
  } else if ('bash' in node && typeof node.bash === 'string') {
    nonAiNode = { type: 'bash', fields: BASH_NODE_AI_FIELDS };
  }
  if (nonAiNode) {
    const presentAiFields = nonAiNode.fields.filter(
      f => (raw as Record<string, unknown>)[f] !== undefined
    );
    if (presentAiFields.length > 0) {
      getLog().warn(
        { id: node.id, fields: presentAiFields },
        `${nonAiNode.type}_node_ai_fields_ignored`
      );
    }
  }

  return node;
}

/**
 * Validate DAG structure: unique IDs, depends_on references exist, no cycles,
 * and $nodeId.output refs in when:/prompt: fields point to known nodes.
 * Returns error message or null if valid.
 *
 * Exported so the include-expander can re-run the same structural checks on the
 * fully-flattened, namespaced node list after inlining (duplicate-id collisions,
 * cycles introduced by rewired edges, unknown deps).
 */
export function validateDagStructure(
  nodes: DagNode[],
  enclosingIds?: ReadonlySet<string>
): string | null {
  // Check ID uniqueness
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      return `Duplicate node id: '${node.id}'`;
    }
    // A loop_group body node must not reuse an enclosing DAG's node id: the executor
    // seeds each iteration's scoped output map with the outer outputs, so a colliding
    // body node would silently shadow the outer node for $id.output refs.
    if (enclosingIds?.has(node.id)) {
      return `Node id '${node.id}' shadows a node id in the enclosing DAG`;
    }
    ids.add(node.id);
  }

  // Check depends_on references
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) {
        return `Node '${node.id}' depends_on unknown node '${dep}'`;
      }
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dep of node.depends_on ?? []) {
      const existing = dependents.get(dep) ?? [];
      existing.push(node.id);
      dependents.set(dep, existing);
    }
  }

  const queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
  let visited = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined) break;
    visited++;
    for (const dep of dependents.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  if (visited < nodes.length) {
    const cycleNodes = nodes.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
    return `Cycle detected among nodes: ${cycleNodes.join(', ')}`;
  }

  // Check $nodeId.output references across EVERY field the executor substitutes at
  // runtime: when:, and the text surfaces that flow through substituteNodeOutputRefs
  // (prompt, bash, script, approval.message, cancel, loop.prompt, loop.until_bash,
  // loop_group.until_bash, workflow.input). A dangling ref in any of them silently
  // substitutes to '' at run time, so all must be validated here.
  //
  // KEEP IN SYNC (three ref-surface enumerations must agree):
  //   1. this scan (loader validateDagStructure) — validates refs,
  //   2. rewriteNodeOutputRefs (include-expander.ts) — renames refs on inline,
  //   3. the substituteNodeOutputRefs call sites (dag-executor.ts) — resolves refs at run.
  // Adding a substituted field to one means updating all three.
  //
  // Prose fields (prompt / loop.prompt) may contain triple-backtick fenced blocks or
  // single-backtick inline code that are documentation meant to render literally to
  // the LLM (e.g. the workflow-builder shows authors how to write `$<other-node>.output`
  // inside a script-node example); strip those before scanning so they don't false-match.
  // The code/expression fields (bash / script / until_bash / cancel) and when: clauses
  // carry live refs (not documentation), so they are scanned verbatim.
  const outputRefPattern = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;
  const stripMarkdownCode = (s: string): string =>
    s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const node of nodes) {
    const sources: string[] = [];
    if (node.when) sources.push(node.when);
    if ('prompt' in node && typeof node.prompt === 'string') {
      sources.push(stripMarkdownCode(node.prompt));
    }
    if (isBashNode(node)) sources.push(node.bash);
    if (isScriptNode(node)) sources.push(node.script);
    // workflow.input is a live ref surface (a data string), scanned verbatim like
    // bash/script — not prose, so no markdown stripping.
    if (isWorkflowNode(node) && node.input) sources.push(node.input);
    if (isCancelNode(node)) sources.push(node.cancel);
    if (isApprovalNode(node)) sources.push(node.approval.message);
    if (isLoopNode(node)) {
      // Only inline `loop.prompt` is scanned for `$nodeId.output` refs. A
      // command-backed loop (`loop.command`) loads its prompt text from a file
      // at runtime; that file's contents are the author's responsibility, the
      // same way a `command:` node's body is not scanned at parse time.
      if (typeof node.loop.prompt === 'string') {
        sources.push(stripMarkdownCode(node.loop.prompt));
      }
      if (node.loop.until_bash) sources.push(node.loop.until_bash);
    }
    if (isLoopGroupNode(node) && node.loop_group.until_bash) {
      sources.push(node.loop_group.until_bash);
    }
    for (const source of sources) {
      let m: RegExpExecArray | null;
      outputRefPattern.lastIndex = 0; // reset stateful g-flag regex before each new source string
      while ((m = outputRefPattern.exec(source)) !== null) {
        const refNodeId = m[1];
        // Output refs (unlike depends_on) may also reach ENCLOSING-scope nodes: the
        // executor seeds a loop_group iteration's scoped output map with the outer
        // DAG's outputs, so `$outerNode.output` inside a body prompt is valid.
        if (refNodeId !== undefined && !ids.has(refNodeId) && !enclosingIds?.has(refNodeId)) {
          return `Node '${node.id}' references unknown node '$${refNodeId}.output'`;
        }
      }
    }
  }

  // Recursively validate loop_group bodies as scoped sub-DAGs. A loop_group body is
  // sealed for GRAPH edges: its depends_on edges resolve within the body (not the
  // outer DAG), and the body is itself a DAG (unique ids, no cycles). $nodeId.output
  // refs are wider — the accumulated enclosing-scope ids are passed down so body
  // prompts may reference outer nodes (mirrors the executor seeding the scoped output
  // map with outer outputs). Nested loop_groups recurse naturally, accumulating scope.
  // Outer-DAG cycle/depends_on checks above operate on the flattened top-level node
  // list and treat each loop_group as one outer node.
  for (const node of nodes) {
    if (isLoopGroupNode(node)) {
      // `include` inside a loop_group body is rejected in v1 (bounds the interaction
      // surface — see the plan's NOT Building). An include is a load-time inlining
      // directive; nesting it inside a per-iteration sub-DAG body is not yet supported.
      const includeInBody = node.loop_group.nodes.find(isIncludeNode);
      if (includeInBody) {
        return `loop_group '${node.id}' body: 'include' is not supported inside a loop_group body`;
      }
      // `workflow:` (sub-run) inside a loop_group body is rejected in slice 1 (bounds
      // the interaction surface — see the plan's NOT Building). A sub-run per
      // iteration needs the fan-out semantics deferred to slice 2.
      const workflowInBody = node.loop_group.nodes.find(isWorkflowNode);
      if (workflowInBody) {
        return `loop_group '${node.id}' body: 'workflow' (sub-run) is not supported inside a loop_group body`;
      }
      const scopeIds = new Set([...(enclosingIds ?? []), ...ids]);
      const bodyError = validateDagStructure(node.loop_group.nodes, scopeIds);
      if (bodyError) {
        return `loop_group '${node.id}' body: ${bodyError}`;
      }
    }
  }

  return null; // valid
}

export type ParseResult =
  | { workflow: WorkflowDefinition; error: null; warnings: string[] }
  | { workflow: null; error: WorkflowLoadError; warnings?: never };

/**
 * Parse and validate a workflow YAML file
 */
export function parseWorkflow(content: string, filename: string): ParseResult {
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

    if (!raw.name || typeof raw.name !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_description');
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
      getLog().warn({ filename }, 'workflow_missing_nodes');
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
      .filter((n): n is DagNode => n !== null);

    if (dagNodes.length !== (raw.nodes as unknown[]).length) {
      getLog().warn({ filename, validationErrors }, 'dag_node_validation_failed');
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
      getLog().warn({ filename, structureError }, 'dag_structure_invalid');
      return {
        workflow: null,
        error: { filename, error: structureError, errorType: 'validation_error' },
      };
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
    if (provider && !isRegisteredProvider(provider)) {
      return {
        workflow: null,
        error: {
          filename,
          error: `Unknown provider '${provider}'. Registered: ${getRegisteredProviders()
            .map(p => p.id)
            .join(', ')}`,
          errorType: 'validation_error',
        },
      };
    }
    for (const node of dagNodes) {
      if (node.provider !== undefined && !isRegisteredProvider(node.provider)) {
        return {
          workflow: null,
          error: {
            filename,
            error: `Node '${node.id}': unknown provider '${node.provider}'. Registered: ${getRegisteredProviders()
              .map(p => p.id)
              .join(', ')}`,
            errorType: 'validation_error',
          },
        };
      }
    }

    // persist_session capability gating: when the effective provider is known at
    // load time (explicit at node or workflow level), reject the workflow if the
    // provider doesn't support session resume. When the provider is implicit (set
    // via .archon/config.yaml defaults), the check defers to runtime in
    // dag-executor.
    //
    // Only command + prompt nodes participate in cross-run session persistence today
    // (see `isPersistableNode` for the exclusion list):
    //   - bash / script / approval / cancel nodes don't invoke a provider at all.
    //   - loop nodes manage their own per-iteration session threading; cross-run
    //     persistence for loops isn't wired. `parseDagNode` emits a
    //     `loop_node_ai_fields_ignored` warning when `persist_session` appears on one.
    //   - context:'fresh' nodes explicitly bypass persistence in the executor.
    // Skipping these here prevents false validation failures when a workflow opts
    // in via workflow-level `persist_sessions: true` and contains, e.g., a bash node.
    const workflowPersistSessions = raw.persist_sessions === true;
    for (const node of dagNodes) {
      if (!isPersistableNode(node)) continue;
      if ('context' in node && node.context === 'fresh') continue;

      const nodePersist = 'persist_session' in node ? node.persist_session : undefined;
      const effectivePersist = nodePersist ?? workflowPersistSessions;
      if (!effectivePersist) continue;

      const explicitProvider = ('provider' in node ? node.provider : undefined) ?? provider;
      if (explicitProvider && isRegisteredProvider(explicitProvider)) {
        const caps = getProviderCapabilities(explicitProvider);
        if (!caps.sessionResume) {
          return {
            workflow: null,
            error: {
              filename,
              error: `Node '${node.id}' has persist_session: true but provider '${explicitProvider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`,
              errorType: 'validation_error',
            },
          };
        }
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
    const webSearchMode = parseOptionalField(
      raw.webSearchMode,
      webSearchModeSchema,
      filename,
      'invalid_web_search_mode',
      { valid: webSearchModeSchema.options }
    );

    const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : undefined;
    if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') {
      getLog().warn({ filename, value: raw.interactive }, 'invalid_interactive_value_ignored');
    }

    // Warn if any interactive loop node exists in a non-interactive workflow
    // (approval messages won't reach the user in web background runs)
    if (!interactive) {
      // Covers loop: and loop_group: gates, including loops nested inside loop_group bodies.
      const hasInteractiveLoop = (ns: DagNode[]): boolean =>
        ns.some(
          n =>
            (isLoopNode(n) && n.loop.interactive === true) ||
            (isLoopGroupNode(n) &&
              (n.loop_group.interactive === true || hasInteractiveLoop(n.loop_group.nodes)))
        );
      if (hasInteractiveLoop(dagNodes)) {
        getLog().warn({ filename }, 'interactive_loop_in_non_interactive_workflow');
      }
    }

    // Warn (non-blocking) when signal_completes is set without interactive: the flag
    // only changes interactive-gate behavior — a non-interactive loop already
    // completes on the signal, so the author's intent is likely a missing
    // `interactive: true`. The workflow still loads.
    const hasSignalCompletesWithoutInteractive = (ns: DagNode[]): boolean =>
      ns.some(
        n =>
          (isLoopNode(n) && n.loop.signal_completes === true && n.loop.interactive !== true) ||
          (isLoopGroupNode(n) &&
            ((n.loop_group.signal_completes === true && n.loop_group.interactive !== true) ||
              hasSignalCompletesWithoutInteractive(n.loop_group.nodes)))
      );
    if (hasSignalCompletesWithoutInteractive(dagNodes)) {
      getLog().warn({ filename }, 'signal_completes_without_interactive_ignored');
    }

    // Parse workflow-level worktree policy. Same warn-and-ignore pattern used
    // for `interactive` / `modelReasoningEffort` — invalid values are dropped
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
              "Invalid evidence_policy: expected { required: boolean }. When required is true, the run is refused terminal 'completed' unless $ARTIFACTS_DIR/evidence.json exists.",
            errorType: 'validation_error',
          },
        };
      }
      evidencePolicy = parsedEvidence.data;
    }

    // Parse mutates_checkout — boolean, omitted means true (run the path-lock guard).
    // Same parse/warn pattern as `interactive` (invalid non-boolean values are dropped).
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

    // Parse workflow-level fallback fields. Same warn-and-drop pattern as
    // `modelReasoningEffort` / `webSearchMode` above. These are declared on
    // `workflowBaseSchema` and consumed by the DAG executor's
    // `workflowLevelOptions` (the object literal at the top of
    // `executeDagWorkflow`, reading `workflow.effort` etc.) as defaults that
    // per-node options inherit when unset. Without this block, a workflow YAML
    // that sets e.g. `effort: high` at the root would be dropped here and the
    // executor would read undefined, so a node without its own `effort` would
    // never inherit the workflow-level default.
    const effort = parseOptionalField(
      raw.effort,
      effortLevelSchema,
      filename,
      'invalid_workflow_effort_value_ignored',
      { valid: effortLevelSchema.options }
    );
    const thinking = parseOptionalField(
      raw.thinking,
      thinkingConfigSchema,
      filename,
      'invalid_workflow_thinking_value_ignored'
    );
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

    // Detect unknown workflow-level keys (#2213)
    const rawKeys = Object.keys(raw);
    for (const key of rawKeys) {
      if (!KNOWN_WORKFLOW_KEYS.has(key)) {
        parseWarnings.push(
          `Workflow '${raw.name as string}': unknown key '${key}' will be ignored`
        );
        getLog().warn({ workflowName: raw.name, key }, 'workflow_unknown_key_ignored');
      }
    }

    return {
      workflow: {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        modelReasoningEffort,
        webSearchMode,
        interactive,
        ...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fallbackModel !== undefined ? { fallbackModel } : {}),
        ...(betas !== undefined ? { betas } : {}),
        ...(sandbox !== undefined ? { sandbox } : {}),
        ...(workflowPersistSessions ? { persist_sessions: true } : {}),
        nodes: dagNodes,
        ...(worktreePolicy ? { worktree: worktreePolicy } : {}),
        ...(containerPolicy ? { container: containerPolicy } : {}),
        ...(evidencePolicy !== undefined ? { evidence_policy: evidencePolicy } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(requires !== undefined ? { requires } : {}),
      },
      error: null,
      warnings: parseWarnings,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    getLog().error(
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

// ---------------------------------------------------------------------------
// parseNodeHooks is preserved as an export for backward compatibility
// (used by hooks.test.ts). The implementation now uses workflowNodeHooksSchema.
// ---------------------------------------------------------------------------

/**
 * Parse and validate per-node hooks from raw YAML input.
 * Uses workflowNodeHooksSchema internally.
 * Returns undefined for absent, empty, or invalid hooks.
 */
export function parseNodeHooks(
  raw: unknown,
  context: { id: string; errors: string[] }
): WorkflowNodeHooks | undefined {
  if (raw === undefined) return undefined;

  const result = workflowNodeHooksSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const pathStr = issue.path.length > 0 ? `'${issue.path.join('.')}' ` : '';
      context.errors.push(`'${context.id}': hooks ${pathStr}${issue.message}`);
    }
    return undefined;
  }

  // Filter out events with empty matcher arrays and return undefined for empty result
  // (preserves original behavior: hooks is only set when there are actual matchers)
  const filtered = Object.fromEntries(
    Object.entries(result.data).filter(
      ([, matchers]) => Array.isArray(matchers) && matchers.length > 0
    )
  ) as WorkflowNodeHooks;

  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
